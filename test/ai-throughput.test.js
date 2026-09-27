'use strict';

// Regression tests for the two reported production symptoms:
//   1. An uploaded PDF imports with "no questions to use".
//   2. Generating a paper takes many minutes.
//
// Both traced to the AI transport layer, not to the PDF parser:
//   - A 429 was logged as "retrying" but thrown immediately when the caller
//     passed maxRetries: 0 (every extraction block does), so a rate-limited
//     primary dropped whole blocks of questions.
//   - The primary provider was exempt from the circuit breaker, and a 429 never
//     counted as a provider failure, so a rate-limited provider was re-hammered
//     on every block instead of being backed off.
//   - Diagram generation was strictly sequential: up to ~64 serial AI calls.
require('./helpers/isolate');

const test = require('node:test');
const assert = require('node:assert');
const config = require('../src/config');
const ai = require('../src/services/ai');

function okResponse(payload) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

function contentResponse(text) {
  return okResponse({ choices: [{ message: { content: text } }] });
}

function rateLimited() {
  return {
    ok: false,
    status: 429,
    headers: { get: () => null },
    text: async () => 'Rate limit reached for requests',
  };
}

function usePrimaryOnly() {
  ai.resetCircuitBreakers();
  config.ai.baseUrl = 'https://primary.test/v1';
  config.ai.apiKey = 'sk-test-primary-key-000000000000';
  config.ai.model = 'test-model';
  config.claude.baseUrl = '';
  config.claude.apiKey = '';
  config.claude.model = '';
  config.xai.apiKey = '';
  config.xai.baseUrl = '';
}

const TINY_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600">' +
  '<rect width="800" height="600" fill="#FFFFFF"/>' +
  '<text x="40" y="60" font-size="24" fill="#111111">Test diagram</text>' +
  '</svg>';

test('a 429 is retried even when the caller disabled generic retries', async () => {
  usePrimaryOnly();
  let calls = 0;
  global.fetch = async () => {
    calls++;
    return calls === 1 ? rateLimited() : contentResponse('{"ok":true}');
  };

  // maxRetries: 0 is exactly what every PDF extraction block passes.
  const out = await ai.chatJSON([{ role: 'user', content: 'hi' }], { maxRetries: 0 });

  assert.deepEqual(out, { ok: true });
  assert.ok(
    calls >= 2,
    `a 429 must be retried rather than failing the caller outright (saw ${calls} call(s))`
  );
});

test('a billing-exhausted 429 fails immediately instead of burning retries', async () => {
  usePrimaryOnly();
  let calls = 0;
  global.fetch = async () => {
    calls++;
    return {
      ok: false,
      status: 429,
      headers: { get: () => null },
      text: async () =>
        JSON.stringify({
          error: {
            code: 'insufficient_quota',
            type: 'insufficient_quota',
            message: 'You have no credits remaining.',
          },
        }),
    };
  };

  await assert.rejects(
    () => ai.chatJSON([{ role: 'user', content: 'hi' }], { maxRetries: 0 }),
    /quota|credit|billing/i
  );
  // A billing failure cannot be fixed by repeating the request, so the retry
  // budget is pure waste. It is also paid in full before the fallback is even
  // reached, because providers are now tried one at a time.
  assert.equal(
    calls,
    1,
    `an exhausted-quota 429 must fail fast (expected 1 call, saw ${calls})`
  );
});

test('a provider that keeps returning 429 is dropped from the race, primary included', async () => {
  config.ai.baseUrl = 'https://primary.test/v1';
  config.ai.apiKey = 'sk-test-primary-key-000000000000';
  config.ai.model = 'test-model';
  config.claude.baseUrl = 'https://secondary.test/v1';
  config.claude.apiKey = 'secondary-test-key';
  config.claude.model = 'test-secondary';
  config.claude.timeoutMs = 0;
  config.xai.apiKey = '';
  config.xai.baseUrl = '';

  let primaryCalls = 0;
  global.fetch = async (url) => {
    if (String(url).includes('primary.test')) {
      primaryCalls++;
      return rateLimited();
    }
    return contentResponse('{"ok":true}');
  };

  const call = () => ai.chatJSON([{ role: 'user', content: 'hi' }], { maxRetries: 0 });

  // Trip the breaker on the rate-limited primary.
  for (let i = 0; i < 3; i++) await call();

  // Promise.any does not abort the losing provider, so the primary keeps backing
  // off in the background after the secondary has already answered. Let those
  // orphaned attempts drain before counting, otherwise the assertion is racy.
  await new Promise((r) => setTimeout(r, 5000));

  const before = primaryCalls;
  assert.ok(before > 0, 'sanity: the primary was called at least once');

  // A healthy secondary serves these, so the primary must be skipped.
  await call();
  await call();
  await new Promise((r) => setTimeout(r, 500));

  assert.equal(
    primaryCalls,
    before,
    'a rate-limited primary must not be re-hammered once its breaker is open'
  );
});

test('a persistently failing provider backs off further each time it is retried', () => {
  // A hard 429 does not clear in 30s. With a flat skip window the primary was
  // re-probed every 30s, and every probe counted against the very rate limit
  // that was rejecting it, so a saturated account never recovered - measured as
  // 69 rate-limit events across a single import. The window must escalate and
  // stay bounded.
  assert.equal(ai.providerCooldownMs(1), 30000, 'below the threshold there is no skip');
  assert.equal(ai.providerCooldownMs(2), 30000, 'below the threshold there is no skip');
  assert.equal(ai.providerCooldownMs(3), 30000, 'the first skip is one step');
  assert.equal(ai.providerCooldownMs(4), 60000, 'a further failure doubles the wait');
  assert.equal(ai.providerCooldownMs(5), 120000, 'and doubles again');
  assert.equal(ai.providerCooldownMs(9), 300000, 'escalation is capped');
  assert.equal(ai.providerCooldownMs(50), 300000, 'a long outage must not park the provider for hours');
});

test('diagram generation runs concurrently instead of one question at a time', async () => {
  usePrimaryOnly();

  // Every question must contain a distinct "use the ..." cue so
  // shouldHaveDiagram() fires, and the wordings must stay far enough apart
  // that deduplicateAgainstHistory() keeps all of them.
  const stems = [
    'Use the table to state how many visitors arrived in Harare during June.',
    'Examine the graph and identify the month when rainfall peaked in Limbe.',
    'Study the chart to work out the ratio of imports to exports last year.',
    'Refer to the table and calculate the mean of the four recorded yields.',
  ];
  const questionCount = stems.length;
  const questions = stems.map((text, i) => ({
    type: 'objective',
    number: i + 1,
    text,
    options: [
      { key: 'A', text: `option ${i}a` },
      { key: 'B', text: `option ${i}b` },
      { key: 'C', text: `option ${i}c` },
      { key: 'D', text: `option ${i}d` },
    ],
    correct_index: 0,
    marks: 1,
  }));

  let diagramCalls = 0;
  let inFlight = 0;
  let peakInFlight = 0;
  global.fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body || '{}'));
    const system = String(body.messages?.[0]?.content || '');
    if (system.includes('SVG') || system.includes('svg')) {
      diagramCalls++;
      inFlight++;
      peakInFlight = Math.max(peakInFlight, inFlight);
      try {
        await new Promise((r) => setTimeout(r, 200));
        return contentResponse(TINY_SVG);
      } finally {
        inFlight--;
      }
    }
    return contentResponse(JSON.stringify({ questions }));
  };

  // shouldHaveDiagram() is gated on a 0.8 roll; make the roll deterministic.
  const realRandom = Math.random;
  Math.random = () => 0;

  try {
    await ai.generateQuestions({
      subject: 'Mathematics',
      topics: ['Data handling'],
      count: questionCount,
      objectiveCount: questionCount,
      theoryCount: 0,
      types: ['objective'],
      difficulty: 'medium',
      instructions: '',
      poolSize: questionCount,
    });
  } finally {
    Math.random = realRandom;
  }

  assert.ok(diagramCalls > 0, 'sanity: diagrams were requested');
  assert.ok(
    peakInFlight > 1,
    `diagram generation must overlap requests; peak concurrency was ${peakInFlight} across ${diagramCalls} diagrams`
  );
});

test('one failing diagram neither aborts the paper nor escapes as an unhandled rejection', async () => {
  // Diagrams now run concurrently through mapLimit, which awaits Promise.all
  // over its workers with no per-task catch. If a single diagram task rejects,
  // Promise.all rejects but the sibling workers keep running - so a later
  // sibling rejection has no handler, and Node >=15 terminates the process on an
  // unhandled rejection. That turns "one missing diagram" into a server crash
  // mid-generation, and leaves PNGs orphaned in uploadsDir. Every diagram task
  // must therefore be unable to reject at all.
  usePrimaryOnly();

  const questionCount = 6;
  // The wordings must be genuinely distinct: history dedup collapses paraphrases
  // at a 0.65 similarity threshold, so six stems that differed by one digit would
  // (correctly) be reduced to a single question and this test would measure
  // nothing but the deduper.
  const stems = [
    'Use the table to state how many visitors arrived in Harare during June.',
    'Examine the graph and identify the month when rainfall peaked in Limbe.',
    'Study the chart to work out the ratio of imports to exports last year.',
    'Refer to the table and calculate the mean of the four recorded yields.',
    'Consult the diagram and determine the angle marked at vertex P.',
    'Read the graph and estimate the population growth between the two censuses.',
  ];
  const questions = stems.map((text, i) => ({
    type: 'objective',
    number: i + 1,
    text,
    options: [
      { key: 'A', text: `option ${i}a` },
      { key: 'B', text: `option ${i}b` },
      { key: 'C', text: `option ${i}c` },
      { key: 'D', text: `option ${i}d` },
    ],
    correct_index: 0,
    marks: 1,
  }));

  let diagramSeen = 0;
  global.fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body || '{}'));
    const system = String(body.messages?.[0]?.content || '');
    if (system.includes('SVG') || system.includes('svg')) {
      const n = diagramSeen++;
      try {
        // Vary the delay so a failing task and its siblings interleave: the
        // rejection must land while other diagrams are still in flight.
        await new Promise((r) => setTimeout(r, 20 + n * 15));
        // Every third diagram fails hard, as a provider outage would.
        if (n % 3 === 1) return { ok: false, status: 500, headers: { get: () => null }, text: async () => 'upstream boom' };
        return contentResponse(TINY_SVG);
      } finally {
        void 0;
      }
    }
    return contentResponse(JSON.stringify({ questions }));
  };

  const rejections = [];
  const onUnhandled = (err) => rejections.push(err);
  process.on('unhandledRejection', onUnhandled);

  const realRandom = Math.random;
  Math.random = () => 0;
  let generated;
  try {
    generated = await ai.generateQuestions({
      subject: 'Mathematics',
      topics: ['Data handling'],
      count: questionCount,
      objectiveCount: questionCount,
      theoryCount: 0,
      types: ['objective'],
      difficulty: 'medium',
      instructions: '',
      poolSize: questionCount,
    });
  } finally {
    Math.random = realRandom;
    process.off('unhandledRejection', onUnhandled);
  }

  // Give any orphaned sibling task time to reject after the fact.
  await new Promise((r) => setTimeout(r, 300));

  assert.deepEqual(
    rejections.map((e) => e && e.message),
    [],
    'a failing diagram must never surface as an unhandled rejection (it would kill the process)'
  );
  assert.ok(Array.isArray(generated), 'generation must still return the paper');
  assert.equal(generated.length, questionCount, 'no question may be lost because a sibling diagram failed');
});

// ---------------------------------------------------------------------------
// The primary provider is the main AI, not one of several racers.
// ---------------------------------------------------------------------------

test('the primary answers alone; the secondary is only used after it fails', async () => {
  usePrimaryOnly();
  config.claude.baseUrl = 'https://secondary.test/v1';
  config.claude.apiKey = 'sk-test-secondary-key-000000000';
  config.claude.model = 'test-secondary-model';

  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    calls.push(String(url));
    if (url.includes('secondary.test')) {
      return contentResponse('{"ok":"from secondary"}');
    }
    return contentResponse('{"ok":"from primary"}');
  };
  try {
    const out = await ai.chatJSON([{ role: 'user', content: 'hi' }]);
    // The primary answered, so nothing else should have been spent.
    assert.equal(out.ok, 'from primary');
    assert.equal(calls.length, 1, 'secondary must not be called when the primary succeeds');
    assert.ok(calls[0].includes('primary.test'), 'the primary must be tried first');
  } finally {
    global.fetch = realFetch;
  }
});

test('the secondary takes over when the primary is rate limited', async () => {
  usePrimaryOnly();
  config.claude.baseUrl = 'https://secondary.test/v1';
  config.claude.apiKey = 'sk-test-secondary-key-000000000';
  config.claude.model = 'test-secondary-model';

  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    calls.push(String(url));
    if (url.includes('secondary.test')) {
      return contentResponse('{"ok":"from secondary"}');
    }
    return rateLimited();
  };
  try {
    const out = await ai.chatJSON(
      [{ role: 'user', content: 'hi' }],
      { maxRetries: 0, maxTokens: 100 }
    );
    assert.equal(out.ok, 'from secondary');
    assert.ok(calls[0].includes('primary.test'), 'the primary is still tried first');
    assert.ok(calls.some((u) => u.includes('secondary.test')), 'the secondary covers the failure');
  } finally {
    global.fetch = realFetch;
  }
});

test('reasoning models are sent reasoning effort and no temperature', async () => {
  usePrimaryOnly();
  config.ai.model = 'gpt-5.6-terra';
  config.ai.reasoningEffort = 'none';

  let sentBody = null;
  const realFetch = global.fetch;
  global.fetch = async (_url, init) => {
    sentBody = JSON.parse(init.body);
    return contentResponse('{"ok":true}');
  };
  try {
    await ai.chatJSON([{ role: 'user', content: 'hi' }], { temperature: 0.3, maxTokens: 50 });
  } finally {
    global.fetch = realFetch;
  }
  assert.equal(sentBody.model, 'gpt-5.6-terra');
  // Reasoning-family models reject a non-default temperature outright, which
  // would fail every single call rather than degrade gracefully.
  assert.equal(sentBody.temperature, undefined, 'temperature must be omitted for reasoning models');
  // The Chat Completions surface takes a FLAT `reasoning_effort`. The nested
  // `reasoning: { effort }` object is the Responses API shape and is not part
  // of this endpoint's contract, so sending it here is a malformed request.
  assert.equal(sentBody.reasoning_effort, 'none');
  assert.equal(sentBody.reasoning, undefined, 'nested reasoning is Responses-only, not Chat Completions');
});

test('non-reasoning models keep their temperature', async () => {
  usePrimaryOnly();
  config.ai.model = 'gpt-4o-mini';
  config.ai.reasoningEffort = '';

  let sentBody = null;
  const realFetch = global.fetch;
  global.fetch = async (_url, init) => {
    sentBody = JSON.parse(init.body);
    return contentResponse('{"ok":true}');
  };
  try {
    await ai.chatJSON([{ role: 'user', content: 'hi' }], { temperature: 0.3, maxTokens: 50 });
  } finally {
    global.fetch = realFetch;
  }
  assert.equal(sentBody.temperature, 0.3);
  assert.equal(sentBody.reasoning, undefined);
  assert.equal(sentBody.reasoning_effort, undefined);
});

test('the default model is the current OpenAI generation', () => {
  const fresh = require('../src/config');
  // Read through a fresh require of the module's own default, not the mutated
  // singleton other tests in this file poke at.
  assert.equal(fresh.ai.defaultModel, 'gpt-5.6-terra');
});

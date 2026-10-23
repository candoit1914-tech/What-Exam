'use strict';
require('./helpers/isolate');

// An out-of-credit provider used to be invisible to the circuit breaker:
// only 429s counted as failures, so a dead primary (401/402/403, exhausted
// quota) was re-tried on EVERY call of a long generation, each time paying a
// full failed round-trip (or the whole AI_TIMEOUT_MS when it hangs) before
// the fallback answered. That is most of "generation is very slow".
//
// These tests pin the fix: fatal responses open the breaker on the FIRST
// strike so the dead endpoint stops being probed, while ordinary blips still
// need the full threshold so a healthy provider is never parked early.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const config = require('../src/config');
const ai = require('../src/services/ai');

function saveCfg() {
  return {
    ai: { baseUrl: config.ai.baseUrl, apiKey: config.ai.apiKey, model: config.ai.model },
    claude: {
      baseUrl: config.claude.baseUrl,
      apiKey: config.claude.apiKey,
      model: config.claude.model,
      timeoutMs: config.claude.timeoutMs,
    },
  };
}

function restoreCfg(s) {
  Object.assign(config.ai, s.ai);
  Object.assign(config.claude, s.claude);
}

function configureDeadAndAlive() {
  config.ai.baseUrl = 'https://dead.test/v1';
  config.ai.apiKey = 'sk-test-dead-key-000000000000';
  config.ai.model = 'dead-model';
  config.claude.baseUrl = 'https://alive.test/v1';
  config.claude.apiKey = 'sk-test-alive-key-000000000000';
  config.claude.model = 'alive-model';
  config.claude.timeoutMs = 5000;
}

const resp = (status, text, json) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null },
  text: async () => text,
  json: async () => json,
});

const resp401 = () =>
  resp(
    401,
    JSON.stringify({ error: { message: 'Incorrect API key provided', code: 'invalid_api_key' } }),
    {}
  );
const resp500 = () => resp(500, 'upstream exploded', {});
const respOK = () =>
  resp(200, '', { choices: [{ message: { content: '{"ok":1}' } }] });

test('one fatal failure opens the breaker (ordinary failures still need three)', () => {
  ai.resetCircuitBreakers();
  try {
    assert.ok(ai.isProviderAvailable('primary'), 'sanity: the provider starts available');

    ai.recordProviderFailure('primary');
    ai.recordProviderFailure('primary');
    assert.ok(ai.isProviderAvailable('primary'), 'two ordinary failures are not enough');

    ai.recordProviderFailure('primary');
    assert.ok(!ai.isProviderAvailable('primary'), 'the third ordinary failure opens the breaker');
  } finally {
    ai.resetCircuitBreakers();
  }

  ai.resetCircuitBreakers();
  try {
    ai.recordProviderFailure('primary', { fatal: true });
    assert.ok(!ai.isProviderAvailable('primary'), 'a fatal failure skips the provider immediately');
  } finally {
    ai.resetCircuitBreakers();
  }
});

test('a 401 primary is rescued once, then never probed again', async () => {
  const saved = saveCfg();
  configureDeadAndAlive();
  ai.resetCircuitBreakers();
  const realFetch = global.fetch;
  let primaryCalls = 0;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('dead.test')) { primaryCalls++; return resp401(); }
    if (u.includes('alive.test')) return respOK();
    throw new Error(`unexpected fetch: ${u}`);
  };
  try {
    const first = await ai.chatJSON([{ role: 'user', content: 'hi' }], { maxRetries: 0, timeoutMs: 5000 });
    assert.equal(first.ok, 1, 'the fallback answers while the primary is being tried');
    assert.equal(primaryCalls, 1);
    assert.ok(!ai.isProviderAvailable('primary'), 'the fatal 401 opened the breaker');

    const second = await ai.chatJSON([{ role: 'user', content: 'hi' }], { maxRetries: 0, timeoutMs: 5000 });
    assert.equal(second.ok, 1, 'the fallback keeps answering');
    assert.equal(primaryCalls, 1, 'the dead provider must not receive a second call');
  } finally {
    global.fetch = realFetch;
    ai.resetCircuitBreakers();
    restoreCfg(saved);
  }
});

test('an ordinary 500 does not park the provider after a single strike', async () => {
  const saved = saveCfg();
  configureDeadAndAlive();
  ai.resetCircuitBreakers();
  const realFetch = global.fetch;
  let primaryCalls = 0;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('dead.test')) { primaryCalls++; return resp500(); }
    if (u.includes('alive.test')) return respOK();
    throw new Error(`unexpected fetch: ${u}`);
  };
  try {
    await ai.chatJSON([{ role: 'user', content: 'hi' }], { maxRetries: 0, timeoutMs: 5000 });
    assert.equal(primaryCalls, 1);
    assert.ok(ai.isProviderAvailable('primary'), 'one transient failure must not open the breaker');

    await ai.chatJSON([{ role: 'user', content: 'hi' }], { maxRetries: 0, timeoutMs: 5000 });
    assert.equal(primaryCalls, 2, 'a still-available primary is retried on the next call');
  } finally {
    global.fetch = realFetch;
    ai.resetCircuitBreakers();
    restoreCfg(saved);
  }
});

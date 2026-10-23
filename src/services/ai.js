const config = require('../config');
const db = require('../db');
const { stripSourceWatermarks, stripMarkers } = require('./textClean');

class AIError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AIError';
  }
}

function aiConfigured() {
  return !!(config.ai.apiKey || config.ai.baseUrl);
}

/**
 * The admin's own paid OpenAI account (OPENAI_API_KEY). Separate from
 * `aiConfigured` because it answers a different question: not "can chat run"
 * but "can a voice note be transcribed, a photo answer read, and the chat
 * primary's failure rescued" — three jobs a chat gateway alone cannot do.
 * Config-level only: the key is read at load, tests stub the functions that
 * use it.
 */
function openaiConfigured() {
  return !!(config.openai && config.openai.apiKey);
}

/**
 * Whether a vision pass can be attempted at all: AI_VISION must be on AND some
 * provider must be able to see. The chat primary counts (AI_BASE_URL is set
 * even when it is only a gateway, and a gateway model may well do vision), and
 * so does the admin's paid OpenAI account on its own — a deployment that set
 * nothing but OPENAI_API_KEY has a working vision model, and gating this on
 * the chat primary alone is what left figure rescue switched off there while
 * the paid credit sat unused.
 */
function visionConfigured() {
  return !!config.ai.vision && (aiConfigured() || openaiConfigured());
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Reject with an AIError after `ms` if `promise` has not settled. This is a
 * HARD timeout: some Node/undici versions keep an aborted request pending
 * indefinitely, so AbortController alone cannot be relied on to unblock a
 * stuck AI call. Racing the promise against a timer guarantees a hanging
 * endpoint can never stall a job forever.
 *
 * `onTimeout`, when given, fires as soon as the timer wins — the race only
 * abandons the caller's await, so the caller uses it to abort the request and
 * release the socket instead of leaving it open for a full TCP timeout.
 */
function withHardTimeout(promise, ms, onTimeout) {
  if (!ms || ms <= 0) return promise;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      // Fire the abort hook too: the race rejects the caller's await, but the
      // underlying fetch would otherwise keep its socket open for the full TCP
      // timeout.
      try { if (onTimeout) onTimeout(); } catch { /* ignore */ }
      const e = new AIError(`AI request timed out after ${Math.round(ms / 1000)}s.`);
      e.name = 'AIError';
      reject(e);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// OpenAI reasoning-family models (gpt-5*, gpt-6*, o1/o3/o4*) reject a
// non-default `temperature` outright - the request fails with a 400 rather
// than degrading. They also accept a reasoning-effort control, where 'none'
// skips reasoning tokens entirely, which is what keeps a ~80-call paper fast.
// On /chat/completions that control is the flat `reasoning_effort` field.
// Non-reasoning models keep temperature and must not receive a
// `reasoning_effort` they do not understand.
const REASONING_MODEL_RE = /^(gpt-5|gpt-6|o[134])/i;

/**
 * Whether a model id belongs to OpenAI's reasoning family.
 * @param {string} model
 * @returns {boolean}
 */
function isReasoningModel(model) {
  return REASONING_MODEL_RE.test(String(model || ''));
}

/**
 * Build the JSON body for a chat request, adapting to the model's family.
 * @returns {object}
 */
function buildChatBody({ model, messages, temperature, maxTokens, reasoningEffort }) {
  const body = { model, messages, max_tokens: maxTokens };
  if (isReasoningModel(model)) {
    // temperature omitted deliberately - see note above.
    const effort = reasoningEffort === undefined ? config.ai.reasoningEffort : reasoningEffort;
    // This endpoint is /chat/completions, whose contract is a FLAT
    // `reasoning_effort` field. The nested `reasoning: { effort }` object is
    // the Responses API shape; sending it here is not part of this endpoint's
    // parameters. Effort values are model-dependent (gpt-6-astra rejects
    // 'none' with a 400), which is why AI_REASONING_EFFORT is configurable.
    if (effort) body.reasoning_effort = effort;
  } else {
    if (typeof temperature === 'number') body.temperature = temperature;
  }
  return body;
}

/**
 * POST one chat request to an OpenAI-compatible endpoint and parse the JSON
 * content from the response. Exactly one attempt — no retry or backoff here;
 * callers that want those use callEndpoint (a separate function, not a wrapper
 * around this one). A hard timeout surfaces immediately so a hanging endpoint
 * can never stall a job forever.
 */
async function callEndpointRaw({ baseUrl, apiKey, model, messages, temperature, maxTokens, timeoutMs, reasoningEffort }) {
  const body = buildChatBody({ model, messages, temperature, maxTokens, reasoningEffort });
  const controller = new AbortController();
  const res = await withHardTimeout(
    fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    }),
    timeoutMs,
    () => controller.abort()
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new AIError(`AI request failed (${res.status}): ${text.slice(0, 300)}`);
  }
  // A 200 with a non-JSON body (an HTML error page, or an empty body from a
  // proxy) must fail as an AIError like every other provider failure above —
  // a raw SyntaxError would surface to callers as if the app itself were broken.
  const data = await res.json().catch(() => { throw new AIError('AI returned a non-JSON response'); });
  // Gemini wraps errors in a 200 OK as an array: [{error: {code: 429, ...}}]
  if (Array.isArray(data) && data[0]?.error) {
    const e = data[0].error;
    throw new AIError(`AI request failed (${e.code || 'error'}): ${e.message || JSON.stringify(e).slice(0, 200)}`);
  }
  if (data?.error) {
    throw new AIError(`AI request failed (${data.error.code || 'error'}): ${data.error.message || JSON.stringify(data.error).slice(0, 200)}`);
  }
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new AIError('AI returned empty response — no choices in payload');
  return content;
}

// How many times a single request may be repeated after a 429 before it is
// treated as a provider failure. Kept small so a genuinely saturated account
// fails over to the next provider quickly instead of stalling the caller.
const RATE_LIMIT_RETRIES = 2;

// 429s that report a billing/quota condition rather than a temporary rate
// limit. These are permanent until the account is topped up, so they must not
// consume the rate-limit retry budget.
const QUOTA_429_RE = /insufficient_quota|credit_balance_exhausted|quota_exceeded|billing_hard_limit_reached|billing_not_active/i;

// Responses that mean the account or key can never serve ANY request: bad
// key, out of credit, revoked access. Waiting does not fix these the way it
// fixes a rate limit, so they are tagged `fatal`: the call fails without
// spending retry budget AND the provider's circuit breaker opens on the very
// first one. Before this, an out-of-credit primary was re-tried on every
// single call of a long generation because only 429s counted as failures -
// each call paying a full failed round-trip (or the whole AI_TIMEOUT_MS when
// the dead endpoint just hangs), which is most of "generation is very slow".
const FATAL_HTTP_RE = /^(401|402|403)$/;
const FATAL_BODY_RE =
  /insufficient_quota|credit_balance_exhausted|billing_hard_limit_reached|billing_not_active|invalid_api_key|incorrect_api_key|invalid authentication|payment required|no credits|out of (?:credit|quota)/i;

async function callEndpoint({ baseUrl, apiKey, model, messages, temperature, maxTokens, timeoutMs, maxRetries }) {
  const body = buildChatBody({ model, messages, temperature, maxTokens });

  // Log which endpoint we're calling. Never print any part of the key itself:
  // this line runs on every single request (150+ per exam generation), so even a
  // prefix ends up all over the logs. A real key always starts "sk-", which is
  // not identifying, so report presence only.
  const maskedKey = apiKey ? 'present' : 'NONE';
  console.log(`[ai] Calling ${model} @ ${baseUrl} (key: ${maskedKey})`);

  let lastErr;
  // Rate limiting gets its own budget, independent of `maxRetries`. A 429 means
  // the request was rejected before any output was produced, so waiting and
  // repeating it is always worth it - and callers that deliberately disable
  // generic retries (every PDF extraction block passes maxRetries: 0) must
  // still survive a burst. Previously the 429 branch logged "retrying" and then
  // fell straight through to the throw whenever maxRetries was 0, so a single
  // rate-limited response silently dropped a whole block of questions.
  let rateLimitAttempts = 0;
  // `attempt` counts GENERIC failures only and is incremented explicitly, never
  // by a loop expression: a 429 retry must not spend a generic attempt, or a
  // caller that passed maxRetries: 0 (every PDF extraction block does) would
  // exit the loop on the first rate-limited response and throw `undefined`.
  let attempt = 0;
  while (attempt <= maxRetries) {
    try {
      const controller = new AbortController();
      const res = await withHardTimeout(
        fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        }),
        timeoutMs,
        () => controller.abort()
      );

      // Handle 429 rate-limit with exponential backoff + retry
      if (res.status === 429) {
        // Not every 429 is a temporary rate limit. An exhausted billing balance
        // also arrives as 429 (`insufficient_quota` /
        // `credit_balance_exhausted`) and can never be fixed by repeating the
        // request - only a billing change can. Retrying those spends the whole
        // backoff budget to reach the same answer, and because providers are
        // now tried one at a time that delay is paid in full before the
        // fallback is even reached. On a ~80-call paper this turned an
        // out-of-credits primary into minutes of pure delay.
        const errText = await res.text().catch(() => '');
        if (QUOTA_429_RE.test(errText)) {
          console.error(
            `[ai] Quota exhausted for ${model} @ ${baseUrl} (not retryable): ${errText.slice(0, 200)}`
          );
          const quotaErr = new AIError(
            `AI request failed (429): ${model} account has no remaining quota — top up billing or switch provider`
          );
          // Still tagged rateLimited so the circuit breaker trips and stops
          // sending requests to an account that cannot serve them; `fatal`
          // opens that breaker immediately instead of after three strikes.
          quotaErr.rateLimited = true;
          quotaErr.permanent = true;
          quotaErr.fatal = true;
          throw quotaErr;
        }
        const retryAfterHeader = res.headers.get('retry-after');
        const retryAfterSec = parseInt(retryAfterHeader, 10);
        const backoffMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0
          ? retryAfterSec * 1000
          : Math.min(1000 * Math.pow(2, rateLimitAttempts), 15000);
        if (rateLimitAttempts < RATE_LIMIT_RETRIES) {
          rateLimitAttempts++;
          console.warn(`[ai] Rate limited (429) by ${model} @ ${baseUrl}, retrying in ${backoffMs}ms (rate-limit attempt ${rateLimitAttempts}/${RATE_LIMIT_RETRIES})`);
          await delay(backoffMs);
          continue;
        }
        console.error(`[ai] Rate limited (429) by ${model} @ ${baseUrl} after ${rateLimitAttempts} retry attempt(s)`);
        const limited = new AIError(`AI request failed (429): ${model} is rate limiting this account`);
        // Tagged so chatJSON can trip the provider's circuit breaker instead of
        // re-hammering an endpoint that has already said "no" several times.
        limited.rateLimited = true;
        throw limited;
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        console.error(`[ai] HTTP ${res.status} from ${model} @ ${baseUrl}: ${text.slice(0, 300)}`);
        const httpErr = new AIError(`AI request failed (${res.status}): ${text.slice(0, 300)}`);
        if (FATAL_HTTP_RE.test(String(res.status)) || FATAL_BODY_RE.test(text)) {
          // Bad key / exhausted credit: repeating the identical request can
          // only fail again. `permanent` skips the in-call retries, `fatal`
          // opens the provider's breaker at once (see recordProviderFailure).
          httpErr.permanent = true;
          httpErr.fatal = true;
        }
        throw httpErr;
      }

      const data = await res.json().catch(() => { throw new AIError('AI returned a non-JSON response'); });
      // Gemini wraps errors in a 200 OK as an array: [{error: {code: 429, ...}}]
      if (Array.isArray(data) && data[0]?.error) {
        const e = data[0].error;
        throw new AIError(`AI request failed (${e.code || 'error'}): ${e.message || JSON.stringify(e).slice(0, 200)}`);
      }
      if (data?.error) {
        throw new AIError(`AI request failed (${data.error.code || 'error'}): ${data.error.message || JSON.stringify(data.error).slice(0, 200)}`);
      }
      const content = data?.choices?.[0]?.message?.content;
      if (!content) throw new AIError('AI returned empty response — no choices in payload');

      return parseJSON(content);
    } catch (err) {
      lastErr = err;
      // A hard timeout must surface (never retry) so an exam question never
      // hangs the flow indefinitely waiting on an unresponsive AI endpoint.
      if (err instanceof AIError && /timed out/i.test(err.message)) {
        console.error(`[ai] Timeout calling ${model} @ ${baseUrl} after ${Math.round(timeoutMs / 1000)}s`);
        throw new AIError(`AI request timed out after ${Math.round(timeoutMs / 1000)}s.`);
      }
      // Log network errors for debugging
      if (err instanceof TypeError) {
        console.error(`[ai] Network error calling ${model} @ ${baseUrl}: ${err.message}`);
      }
      // A permanent failure (exhausted quota) can never be resolved by
      // repeating the identical request, so it must not spend retry budget.
      if (err && err.permanent) throw err;
      // Retry transient network failures (ECONNRESET etc.) and HTTP errors with
      // exponential backoff; concurrent extraction blocks make these more likely.
      const retryable = err instanceof AIError || err instanceof TypeError;
      if (retryable && attempt < maxRetries) {
        const backoff = Math.min(500 * Math.pow(2, attempt), 10000);
        console.warn(`[ai] Retrying ${model} in ${backoff}ms (attempt ${attempt + 1}/${maxRetries})`);
        await delay(backoff);
        attempt++;
        continue;
      }
      throw err;
    }
  }
  throw lastErr || new AIError(`AI request to ${model} @ ${baseUrl} failed without a usable response`);
}

/**
 * Whether a second OpenAI-compatible provider (CLAUDE_*) is configured. When
 * it is, `chatJSON` uses it as a fallback for the primary: the primary is
 * tried alone, and this is only reached if the primary fails.
 */
function secondaryConfigured() {
  return !!(config.claude.apiKey && config.claude.baseUrl);
}

/**
 * Whether a third OpenAI-compatible provider (XAI_*) is configured. When
 * it's configured, `chatJSON` uses it as a last-resort fallback, tried only
 * after both the primary and the secondary have failed.
 */
function tertiaryConfigured() {
  return !!(config.xai && config.xai.apiKey && config.xai.baseUrl);
}

// Circuit breaker: track consecutive failures per provider to skip unreliable ones.
// The primary is tracked too. A rate-limited primary used to be exempt, so a
// saturated account kept receiving every request and every one of them 429'd.
//
// The skip window escalates instead of staying flat. A provider that is hard
// limited (the measured OpenAI account returned 429 for 69 of 69 calls) is not
// going to recover in 30s, and every request sent into that window counts
// against its rate limit, so a fixed 30s skip meant the primary was re-hammered
// on a loop and stayed permanently throttled - the self-reinforcing part of the
// "generation is very slow" report. A sustained failure backs off up to
// PROVIDER_COOLDOWN_MAX_MS, and any success resets it immediately so a recovered
// provider is used again at once.
const PROVIDER_COOLDOWN_STEP_MS = 30000;
const PROVIDER_COOLDOWN_MAX_MS = 300000;
const PROVIDER_FAILURE_THRESHOLD = 3;

const circuitBreaker = {
  primary: { fails: 0, skipUntil: 0 },
  secondary: { fails: 0, skipUntil: 0 },
  openai: { fails: 0, skipUntil: 0 },
  tertiary: { fails: 0, skipUntil: 0 },
};

/** Escalating skip window for a provider that has failed `fails` times in a row. */
function providerCooldownMs(fails) {
  const steps = Math.max(0, fails - PROVIDER_FAILURE_THRESHOLD);
  return Math.min(PROVIDER_COOLDOWN_STEP_MS * Math.pow(2, steps), PROVIDER_COOLDOWN_MAX_MS);
}

function isProviderAvailable(name) {
  const cb = circuitBreaker[name];
  if (!cb) return true;
  if (cb.skipUntil && Date.now() < cb.skipUntil) return false;
  return true;
}

function recordProviderFailure(name, { fatal = false } = {}) {
  const cb = circuitBreaker[name];
  if (!cb) return;
  cb.fails++;
  // A fatal rejection (401/402/403, exhausted quota) cannot heal by waiting
  // out a rate limit — only a key or billing change fixes it — so ONE is
  // enough to skip the provider. Non-fatal failures still need the usual
  // threshold so a transient blip never parks a healthy endpoint.
  const opens = fatal ? cb.fails >= 1 : cb.fails >= PROVIDER_FAILURE_THRESHOLD;
  if (opens) {
    // Fatal failures enter the same escalating ladder from its first rung
    // (behave as if the ordinary threshold were already met), so a dead
    // provider is skipped for 30s, then 60s, 120s… instead of being probed
    // on every call of a long generation.
    const ladderFails = fatal ? cb.fails + PROVIDER_FAILURE_THRESHOLD - 1 : cb.fails;
    const ms = providerCooldownMs(ladderFails);
    cb.skipUntil = Date.now() + ms;
    console.warn(
      `[ai] Circuit breaker: ${name} failed ${cb.fails} time(s)${fatal ? ' (fatal)' : ''}, skipping for ${Math.round(ms / 1000)}s`
    );
  }
}

function recordProviderSuccess(name) {
  const cb = circuitBreaker[name];
  if (!cb) return;
  cb.fails = 0;
  cb.skipUntil = 0;
}

/**
 * Clear all circuit-breaker state. The breaker is module-global by design, so
 * tests need a way to start from a known state - otherwise a test that
 * deliberately fails the primary leaves the next test's primary skipped, and
 * the suite's pass/fail result depends on execution order.
 */
function resetCircuitBreakers() {
  for (const cb of Object.values(circuitBreaker)) {
    cb.fails = 0;
    cb.skipUntil = 0;
  }
}

function puterConfigured() {
  const puter = require('./puter');
  return puter.isConfigured();
}

async function chatJSON(messages, { temperature = 0.4, maxRetries = 2, timeoutMs = config.ai.timeoutMs, maxTokens = 8192, prefer = '' } = {}) {
  // A paid OpenAI key on its own IS a configured AI. The guard used to name
  // the chat primary only, so a deployment with nothing but OPENAI_API_KEY
  // threw "AI is not configured" from the very call the paid account exists
  // to answer.
  if (!aiConfigured() && !puterConfigured() && !openaiConfigured()) {
    throw new AIError('AI is not configured. Set AI_API_KEY and AI_BASE_URL in .env');
  }

  // Log configuration status
  console.log(`[ai] Config: primary=${config.ai.model} @ ${config.ai.baseUrl} (key: ${config.ai.apiKey ? 'present' : 'NONE'})`);
  if (secondaryConfigured()) {
    console.log(`[ai] Config: secondary=${config.claude.model} @ ${config.claude.baseUrl} (key: ${config.claude.apiKey ? 'present' : 'NONE'})`);
  } else {
    console.log('[ai] Config: secondary=NOT configured');
  }
  if (openaiConfigured()) {
    console.log(`[ai] Config: openai-fallback=${config.openai.model} @ ${config.openai.baseUrl} (key: present)`);
  }

  // Ensure every provider always has a timeout so a hanging endpoint can
  // never block the whole flow. 0 means "no timeout" in withHardTimeout.
  const effectiveTimeout = Math.max(timeoutMs, 60000);
  const common = { messages, temperature, maxRetries, maxTokens, timeoutMs: effectiveTimeout };

  // Puter.js is only used as a standalone fallback when no other provider is
  // configured.  It is NOT raced with other providers because its internal
  // xhr polyfill can crash the process via unhandled rejections on error
  // responses (see @heyputer/puter.js xhrshim.js:190).
  if (!aiConfigured() && !openaiConfigured() && puterConfigured()) {
    console.log('[ai] Using Puter.js as sole provider');
    return require('./puter').chat(messages, { temperature, maxTokens }).then((res) => {
      if (!res) throw new AIError('Puter.js returned empty response');
      return parseJSON(res);
    });
  }

  const primary = aiConfigured() ? () =>
    callEndpoint({
      baseUrl: config.ai.baseUrl,
      apiKey: config.ai.apiKey,
      model: config.ai.model,
      ...common,
    }) : null;

  if (!secondaryConfigured() && !tertiaryConfigured() && !openaiConfigured()) {
    console.log('[ai] Using single provider:', config.ai.model);
    return primary();
  }

  const secondary = () =>
    callEndpoint({
      baseUrl: config.claude.baseUrl,
      apiKey: config.claude.apiKey,
      model: config.claude.model || config.ai.model,
      ...common,
      // Per-provider override wins; note spread order — common would clobber it.
      timeoutMs: config.claude.timeoutMs || effectiveTimeout,
    });

  // The admin's own paid OpenAI account as a CHAT fallback. It is only ever
  // reached when the primary fails (or is cooling off on the breaker), so the
  // gateway answer is still preferred and OpenAI is never billed for a call
  // the primary would have made. This is the line between "the AI provider
  // did not answer in time" killing an import and that same import quietly
  // finishing on the account the admin already pays for.
  //
  // `prefer: 'openai'` turns that around for the calls that need SIGHT: figure
  // localisation is asked for on the vision model and goes first, because a
  // text-only gateway model answers 200 with no boxes and the figure simply
  // never reaches the chat. The primary stays queued behind it, so a paid key
  // that is absent changes nothing about the ordinary order.
  const openaiModel = prefer === 'openai'
    ? (config.openai.visionModel || config.openai.model)
    : config.openai.model;
  const openaiFallback = () =>
    callEndpoint({
      baseUrl: config.openai.baseUrl,
      apiKey: config.openai.apiKey,
      model: openaiModel,
      ...common,
    });

  const tertiary = () =>
    callEndpoint({
      baseUrl: config.xai.baseUrl,
      apiKey: config.xai.apiKey,
      model: config.xai.model,
      ...common,
      timeoutMs: config.xai.timeoutMs || effectiveTimeout,
    });

  // Ordered list of candidates: the primary first, then fallbacks. They are
  // tried one at a time in this order. Providers on the circuit breaker are
  // skipped; the last resort below still reaches the primary.
  const providers = [];
  const providerNames = [];
  const openaiFirst = prefer === 'openai' && openaiConfigured();
  if (openaiFirst && isProviderAvailable('openai')) {
    providers.push({ fn: openaiFallback, name: 'openai' });
    providerNames.push(openaiModel || 'openai');
  }
  if (primary && isProviderAvailable('primary')) {
    providers.push({ fn: primary, name: 'primary' });
    providerNames.push(config.ai.model);
  }
  if (secondaryConfigured() && isProviderAvailable('secondary')) {
    providers.push({ fn: secondary, name: 'secondary' });
    providerNames.push(config.claude.model || 'secondary');
  }
  if (openaiConfigured() && !openaiFirst && isProviderAvailable('openai')) {
    providers.push({ fn: openaiFallback, name: 'openai' });
    providerNames.push(config.openai.model || 'openai');
  }
  if (tertiaryConfigured() && isProviderAvailable('tertiary')) {
    providers.push({ fn: tertiary, name: 'tertiary' });
    providerNames.push(config.xai.model || 'tertiary');
  }

  // Last resort: if every provider's breaker is open we would otherwise fail
  // every request for the next 30s. The primary is the only endpoint the user
  // is guaranteed to have, so always fall back to it rather than serving an
  // avoidable outage.
  if (!providers.length && primary) {
    providers.push({ fn: primary, name: 'primary' });
    providerNames.push(config.ai.model);
    console.warn('[ai] All provider breakers are open; falling back to the primary endpoint');
  }

  if (!providers.length) {
    throw new AIError('No AI providers configured');
  }

  const startTime = Date.now();
  const [first, ...fallbacks] = providers;

  // The primary is the main AI, not one of several racers. It is tried alone
  // and the fallbacks are only reached after it fails.
  //
  // Racing every configured provider sent the same prompt to all of them at
  // once, so every call cost full price on every endpoint and every request
  // counted against every provider's rate limit - the primary included. That
  // is what drove the primary into sustained 429s during a large import. It
  // also made the slower fallback the thing that actually answered whenever
  // the primary was briefly saturated, so "the main AI" was not even the one
  // producing the result.
  console.log(
    `[ai] Using ${first.name} (${providerNames[0]})${fallbacks.length ? `, fallbacks: ${fallbacks.map((p) => p.name).join(', ')}` : ''}`
  );

  const attemptProvider = async (p) => {
    try {
      const result = await p.fn();
      recordProviderSuccess(p.name);
      return result;
    } catch (err) {
      // Every provider failure counts toward the breaker, not just rate
      // limits. A provider that hung (hard timeout) or answered 401/402/403
      // forever used to be exempt, so it kept receiving every call of a long
      // generation and every one of them paid its failure latency first.
      // Fatal errors (bad key, exhausted credit) open the breaker immediately.
      if (err) recordProviderFailure(p.name, { fatal: !!err.fatal });
      throw err;
    }
  };

  let firstErr = null;
  for (const p of providers) {
    try {
      const result = await attemptProvider(p);
      const elapsed = Date.now() - startTime;
      console.log(`[ai] Provider responded in ${elapsed}ms (${p.name})`);
      return result;
    } catch (err) {
      if (!firstErr) firstErr = err;
      console.warn(
        `[ai] ${p.name} failed (${err.message}); ${providers.indexOf(p) === providers.length - 1 ? 'no fallbacks left' : 'trying the next provider'}`
      );
    }
  }

  const elapsed = Date.now() - startTime;
  console.error(`[ai] All providers failed after ${elapsed}ms:`, firstErr && firstErr.message);
  throw firstErr instanceof Error ? firstErr : new AIError('All AI providers failed');
}

/**
 * A slow model occasionally hits the output-token cap mid-object, leaving a
 * JSON payload that ends mid-value (often with an unterminated string, since
 * the final closing quotes are cut off). Close the dangling value and the
 * enclosing brackets so every question the model DID finish is recovered
 * instead of losing the whole block. Example: `... "text": "The oxen ___`
 * becomes `... "text": "The oxen ___"]}`.
 */
function repairTruncatedJSON(text) {
  const out = text.replace(/[,\s]+$/, '');
  const last = out[out.length - 1];
  // 1. Ends mid-string → close the string first.
  let patched = last === '"' ? out + '"' : out;
  // 2. Close every still-open bracket in the order they were opened.
  const stack = [];
  for (const ch of patched) {
    if (ch === '{' || ch === '[') stack.push(ch);
    else if ((ch === '}' || ch === ']') && stack.length && ((ch === '}' && stack[stack.length - 1] === '{') || (ch === ']' && stack[stack.length - 1] === '['))) {
      stack.pop();
    }
  }
  for (let i = stack.length - 1; i >= 0; i--) {
    patched += stack[i] === '{' ? '}' : ']';
  }
  try {
    return JSON.parse(patched);
  } catch { /* continue */ }
  return null;
}

// Counters for JSON parsing outcomes. `parseRepaired` is the important one: a
// block whose output hit the token cap is salvaged by repairTruncatedJSON, so it
// SUCCEEDS while silently returning fewer questions than were asked for. A
// repair therefore hides question loss that no failure count would reveal.
// Plain increments are race-safe here because Node runs this single-threaded.
const parseCounters = { ok: 0, repaired: 0, failed: 0 };

/** Snapshot of JSON parse outcomes. Used to explain silent question loss. */
function parseStats() {
  return { ...parseCounters };
}

/**
 * Parse outcomes since `baseline`, so a per-import log line reports that
 * import's numbers. `parseCounters` is a module singleton and is never reset,
 * so a raw `parseStats()` read would print totals accumulated since process
 * boot and grow on every import - wrong for a line whose whole purpose is
 * attributing question loss to one import.
 */
function parseStatsSince(baseline) {
  const now = parseCounters;
  return {
    ok: now.ok - baseline.ok,
    repaired: now.repaired - baseline.repaired,
    failed: now.failed - baseline.failed,
  };
}

function parseJSON(content) {
  let text = String(content).trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence) text = fence[1].trim();
  const start = text.indexOf('[');
  const objStart = text.indexOf('{');
  const candidates = [text];
  if (start !== -1 && objStart !== -1) {
    candidates.push(text.slice(Math.min(start, objStart)));
  }
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c);
      parseCounters.ok++;
      return parsed;
    } catch { /* try next */ }
  }
  // Last resort: the payload may have been truncated mid-question by the token
  // cap. Salvage what the model finished.
  for (const c of candidates) {
    const repaired = repairTruncatedJSON(c);
    if (repaired) {
      parseCounters.repaired++;
      return repaired;
    }
  }
  parseCounters.failed++;
  throw new AIError('AI response was not valid JSON: ' + text.slice(0, 200));
}

const SYSTEM_BASE =
  'You are an expert examination setter and examiner. Always answer with valid JSON only. ' +
  'Never include markdown, code fences, or commentary. Respond with ONLY the JSON object, nothing else.';

const EXAMINER_PERSONA =
  'You are a genuine, sincere, objective professional teacher and chief examiner with more than 40 years of experience, deeply well-versed in national examinations (including the Ghana BECE). You grade fairly, honestly, and consistently: you give full credit where it is due, partial credit for partially correct work, and no credit only where nothing was earned. You never mark down out of strictness or mark up out of sympathy.';

/** Wrap any grading/scheme system prompt with the shared examiner persona. */
function examinerPrompt(base) {
  return `${EXAMINER_PERSONA}\n\n${base}`;
}

// Slow/commercial AI endpoints (e.g. huge 100B+ models) can take well over a
// minute to structure a full exam paper. Bulk admin operations (PDF upload /
// question extraction) get a generous window; the default timeout applies to
// everything else.
const BULK_TIMEOUT_MS = 5 * 60 * 1000;

// PDF/paper extraction runs in question-aligned blocks so every AI call
// stays manageable. Each block generates at most BLOCK_MAX_TOKENS of output;
// the cap is set high enough that theory model answers (rubric, key points,
// model answer) fit inside one block and are not truncated. Larger blocks
// reduce the number of AI calls and the chance of questions being dropped
// when a block fails.
const BLOCK_QUESTIONS = 15;
const BLOCK_MAX_CHARS = 12000;
// Blocks run several at a time: enough parallelism to collapse a long paper's
// wall-clock time, so a slow block does not stall the whole wave. The cap is
// still bounded so a single upload never floods a shared endpoint.
// Every block asks for up to BLOCK_MAX_TOKENS output, so concurrency here is
// really a token-throughput knob: 6 blocks in flight is ~100k output tokens
// demanded at once, which is what drove the account into 429s. Tunable via
// AI_BLOCK_CONCURRENCY for accounts on a tighter rate limit. The default is
// 4 — the level measured with zero 429s on the gateway — and chatJSON's
// retry-with-backoff absorbs anything a faster endpoint does not.
const DIAGRAM_CONCURRENCY = 4;
const BLOCK_CONCURRENCY = Math.max(1, parseInt(process.env.AI_BLOCK_CONCURRENCY, 10) || 4);

// Workers for one question-generation run. Never exceeds the number of batches:
// extra workers would sit idle and buy nothing. Bounded below so a bad
// AI_GENERATE_CONCURRENCY cannot collapse to zero workers and hang the run
// forever - the previous hardcoded cap of 2 did the opposite, serializing work
// the provider absorbs in parallel (4 and 8 concurrent batches both finished in
// ~30s against a ~19s single batch, with no 429s).
function batchConcurrencyFor(batchCount) {
  const configured = Math.max(1, parseInt(config.ai.generateConcurrency, 10) || 6);
  return Math.max(1, Math.min(configured, batchCount));
}

// Launch stagger between batches, in ms. This is a rate-limit guard, so it is a
// flat constant: it used to be delay(idx * 500), which made the last batch in a
// run wait several seconds before it even started, adding to the very latency
// concurrency was meant to remove.
function batchLaunchStaggerMs() {
  return 0;
}
// 16k tokens is enough for a block of 15 questions with full theory rubrics.
// Previous 6k limit caused truncation on theory-heavy blocks, producing
// invalid JSON that dropped entire blocks of questions.
const BLOCK_MAX_TOKENS = 16000;
// A single extraction block runs on its own clock with retries. A block that
// still fails after retries is SKIPPED - never fails the whole paper - so
// this bounds how long one stubborn block can stall the import.
//
// The budget is per BLOCK and comes from config (AI_BLOCK_TIMEOUT_MS) because
// it is the single knob that decides whether a slow provider costs the user
// questions. A block that overruns is not retried indefinitely, it is dropped:
// with a 90s ceiling against a provider measured at 28s-89s, ordinary slow
// responses were being converted into silently missing questions.
const BLOCK_RETRIES = 1;
// The parallel wave gets a single attempt per block; retries are spent on the
// serial recovery pass instead, where the endpoint is no longer flooded.
const BLOCK_WAVE_RETRIES = 0;

/** Hard per-block budget, read at call time so config/env changes apply. */
function blockTimeoutMs() {
  const ms = Number(config.ai.blockTimeoutMs);
  return Number.isFinite(ms) && ms > 0 ? ms : 240000;
}

/** Run fn over items with at most `limit` promises in flight (like a semaphore). */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const idx = next++;
      out[idx] = await fn(items[idx]);
    }
  };
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, worker));
  return out;
}

/**
 * A question that talks about a picture it was never given.
 *
 * The extractor is told to preserve every [IMG:n] marker in the question it
 * belongs to, but a model that rewrites the line drops the marker with it —
 * and a marker nothing names verbatim is an orphan. "Study the diagram below"
 * is the fingerprint of the question it actually belongs to, so an orphan is
 * matched to the questions that reference a figure rather than to whatever
 * happens to sit first in the block.
 */
const ORPHAN_FIGURE_REF =
  /\b(?:figure|diagram|illustration|graph|chart|picture|photograph|drawing|plate|map|table)\b/i;
const ORPHAN_FIGURE_CONTEXT =
  /\b(?:above|below|shown|shows|given|overleaf|opposite|labelled|labeled|study|studies|examine|refer|referred|depicted|illustrat\w*)\b/i;

function namesAFigure(q) {
  const text = `${q.text || ''} ${q.passage || ''}`;
  return ORPHAN_FIGURE_REF.test(text) && ORPHAN_FIGURE_CONTEXT.test(text);
}

/**
 * Where an orphaned figure goes: a question that references a figure, chosen by
 * round-robin.
 *
 * Piling every orphan onto the block's first question is how a paper ends up
 * with five diagrams stacked over question 1 and four questions answered blind.
 * The round-robin spreads them, and a question that has already been given a
 * figure is passed over — a second picture on a question that has one is
 * usually the next question's, and the question with none is the one being
 * answered blind. Only when no question in the block mentions a figure at all
 * does the old first-question fallback apply.
 */
function orphanFigureTarget(qs, gifts) {
  const candidates = qs.filter(namesAFigure);
  const pool = candidates.length ? candidates : [qs[0]];
  const bare = pool.filter((q) => !(q.figureIndices || []).length);
  const choices = bare.length ? bare : pool;
  let best = choices[0];
  for (const q of choices) {
    if ((gifts.get(q) || 0) < (gifts.get(best) || 0)) best = q;
  }
  gifts.set(best, (gifts.get(best) || 0) + 1);
  return best;
}

/**
 * Attach figure and math markers to questions after extraction.
 *
 * `questionsByBlock[b]` is the list of questions parsed from block `b`;
 * `markersByBlock[b]` is the list of `{idx}` [IMG:n] markers that survived
 * inside that block; `mathByBlock[b]` the matching `[MATH:n]` markers. A
 * marker is gifted to the question whose `text`/`passage` (for figures) or
 * `text`/`passage`/`options` (for math, which can ride inside option text)
 * contains its verbatim marker line — the AI is told to preserve them. A
 * marker no question kept is an ORPHAN: it goes to a question that references
 * a figure, spread across them (see orphanFigureTarget), rather than all
 * landing on the block's first question. Figures attach as `q.markerIndex`
 * (the first one, kept for every caller that means "the figure") plus
 * `q.figureIndices` — a paper can put a map AND a timetable under one question,
 * and dropping the second leaves the student answering half a question they
 * cannot see. Math markers are recorded as `q.markerIndices` in document
 * order. Attach is recorded on the question object only — never as a stored
 * text field.
 *
 * Returns { used:Set, unused:[], unusedMath:[] } — `unused`/`unusedMath` hold
 * markers whose block yielded no questions at all (skipped blocks), so the
 * caller can warn.
 */
function attachMarkers(questionsByBlock, markersByBlock, mathByBlock) {
  const used = new Set();
  const usedMath = new Set();
  const allMarkers = [];
  const allMath = [];
  for (let b = 0; b < questionsByBlock.length; b++) {
    const qs = questionsByBlock[b] || [];
    // Orphan gifts reset per block: the spread is within a block, which is
    // where the markers and the questions they belong to actually live.
    const orphanGifts = new Map();
    for (const m of markersByBlock[b] || []) {
      allMarkers.push(m);
      let target = null;
      for (const q of qs) {
        const textQ = String(q.text || '') + ' ' + String(q.passage || '');
        if (textQ.includes(`[IMG:${m.idx}]`)) { target = q; break; }
      }
      if (!target && qs.length) target = orphanFigureTarget(qs, orphanGifts);
      if (target) {
        // Every figure the question names, in document order. `markerIndex`
        // stays the first one — a single field cannot hold a second figure,
        // and overwriting it (the old behaviour) silently lost the first.
        const figures = (target.figureIndices = target.figureIndices || []);
        if (!figures.includes(m.idx)) figures.push(m.idx);
        if (target.markerIndex == null) target.markerIndex = m.idx;
        used.add(m.idx);
      }
    }
    for (const m of mathByBlock[b] || []) {
      allMath.push(m);
      let target = null;
      for (const q of qs) {
        const textQ =
          String(q.text || '') + ' ' + String(q.passage || '') + ' ' +
          (Array.isArray(q.options) ? q.options.join(' ') : String(q.options || ''));
        if (textQ.includes(`[MATH:${m.idx}]`)) { target = q; break; }
      }
      if (!target && qs.length) target = qs[0];
      if (target) {
        (target.markerIndices = target.markerIndices || []).push(m.idx);
        usedMath.add(m.idx);
      }
    }
  }
  return {
    used,
    unused: allMarkers.filter((m) => !used.has(m.idx)),
    unusedMath: allMath.filter((m) => !usedMath.has(m.idx)),
  };
}

// ── Diagram generation for theory questions ─────────────────────────────

const DIAGRAM_TYPES = [
  'bar_chart', 'pie_chart', 'line_graph', 'data_table', 'scientific_diagram',
  'map', 'flowchart', 'venn_diagram', 'coordinate_plane', 'geometric_figure',
  'number_line', 'angle_diagram', 'table_with_data',
];

/**
 * Determine if a question should have a diagram based on its content.
 * Covers all subjects — maths, science, geography, economics, etc.
 * Questions involving data, measurements, comparisons, visual references,
 * geometric concepts, or processes are good candidates.
 */
function shouldHaveDiagram(question) {
  const text = String(question.text || '').toLowerCase();
  const passage = String(question.passage || '').toLowerCase();
  const combined = text + ' ' + passage;

  // Direct visual-reference keywords — the question explicitly points to something to look at
  const directRef = [
    'use the table', 'use the chart', 'use the graph', 'use the diagram',
    'use the map', 'use the figure', 'use the illustration', 'refer to',
    'study the', 'examine the', 'from the table', 'from the chart',
    'from the graph', 'from the diagram', 'from the map', 'from the figure',
    'based on the table', 'based on the chart', 'based on the graph',
    'based on the diagram', 'based on the data', 'based on the information',
    'shown in', 'given in', 'presented in', 'below shows',
    'the table below', 'the chart below', 'the graph below',
    'the diagram below', 'the figure below', 'the map below',
    'the information below', 'the data below',
  ];

  // Data/analysis keywords — question involves interpreting data
  const dataKeywords = [
    'chart', 'graph', 'table', 'data', 'diagram', 'figure', 'plot',
    'compare', 'comparison', 'measure', 'measurement', 'interpret',
    'analyze', 'analyse', 'show', 'illustrate', 'describe the',
    'what does the', 'which region', 'which month', 'highest', 'lowest',
    'trend', 'increase', 'decrease', 'fluctuation', 'pattern',
    'draw', 'sketch', 'label', 'construct', 'plot the',
  ];

  // Subject-specific: Mathematics
  const mathsKeywords = [
    'angle', 'triangle', 'circle', 'rectangle', 'square', 'polygon',
    'coordinate', 'axes', 'x-axis', 'y-axis', 'origin', 'quadrant',
    'gradient', 'slope', 'intercept', 'vertex', 'vertices',
    'perimeter', 'area', 'volume', 'surface area', 'circumference',
    'diameter', 'radius', 'hypotenuse', 'pythagoras', 'theorem',
    'symmetry', 'rotation', 'reflection', 'translation', 'enlargement',
    'scale', 'bearing', 'compass', 'north', 'east', 'west', 'south',
    'number line', 'inequality', 'equation', 'simultaneous',
    'frequency', 'mode', 'median', 'mean', 'range', 'histogram',
    'pie chart', 'bar chart', 'line graph', 'probability',
    'set', 'venn', 'union', 'intersection', 'complement',
    'sequence', 'pattern', 'nth term', 'arithmetic', 'geometric',
    'bearing', 'scale drawing', 'net', 'cross section', 'elevation',
    'plan', 'front view', 'side view', 'isometric',
  ];

  // Subject-specific: Science / Geography / Social Studies
  const scienceKeywords = [
    'circuit', 'cell', 'battery', 'resistor', 'voltage', 'current',
    'ohm', 'ammeter', 'voltmeter', 'magnetic', 'magnet',
    'ecosystem', 'food chain', 'food web', 'habitat', 'biome',
    'weather', 'climate', 'rainfall', 'temperature', 'humidity',
    'erosion', 'deposition', 'weathering', 'river', 'tributary',
    'mountain', 'valley', 'plateau', 'plain', 'coast',
    'continent', 'ocean', 'island', 'peninsula', 'strait',
    'population', 'density', 'migration', 'settlement',
    'solar system', 'planet', 'orbit', 'revolution', 'rotation',
    'photosynthesis', 'respiration', 'digestion', 'circulation',
    'atom', 'molecule', 'element', 'compound', 'mixture',
    'acid', 'alkali', 'base', 'salt', 'indicator',
    'force', 'energy', 'work', 'power', 'moment',
    'pulley', 'lever', 'gear', 'spring', 'extension',
    'wave', 'frequency', 'amplitude', 'wavelength',
    'skeleton', 'muscle', 'organ', 'system',
    'longitude', 'latitude', 'equator', 'meridian', 'timezone',
    'volcano', 'earthquake', 'tectonic', 'fault', 'plate',
  ];

  // Subject-specific: Economics / Business
  const economicsKeywords = [
    'supply', 'demand', 'price', 'inflation', 'deflation',
    'budget', 'revenue', 'expenditure', 'profit', 'loss',
    'tax', 'subsidy', 'tariff', 'import', 'export',
    'gdp', 'GNP', 'national income', 'per capita',
    'market', 'monopoly', 'oligopoly', 'competition',
    'exchange rate', 'interest rate', 'credit', 'debit',
    'cost', 'sales', 'revenue', 'total', 'average',
    'production', 'consumption', 'distribution',
  ];

  // All diagram types combined
  const allDiagramKeywords = [
    ...directRef, ...dataKeywords, ...mathsKeywords,
    ...scienceKeywords, ...economicsKeywords,
  ];

  return allDiagramKeywords.some(kw => combined.includes(kw));
}

/**
 * Generate an SVG diagram for a question.
 * Returns the SVG string or null if generation fails.
 */
async function generateDiagram({ subject, topic, questionText, diagramType }) {
  const system = `You are an educational diagram generator for exam questions across ALL subjects — Mathematics, Science, Geography, Economics, Social Studies, ICT, and more.
Generate an SVG diagram that illustrates the given exam question.
Return ONLY the raw SVG code — no markdown fences, no explanation, no commentary.

CRITICAL RULES:
- The SVG must be exactly 800x600 pixels
- Use a white (#FFFFFF) background
- All text must use Arial, Helvetica, or sans-serif fonts
- Use clear, large labels (font-size 14-18px minimum for axis labels, 20-24px for titles)
- Use high-contrast colors: dark text on white, distinct fills for different elements
- Include a title/legend when applicable
- Draw clean, sharp lines with stroke-width 2-3px
- Use rounded corners on rectangles (rx="6")
- Charts must have clear axis labels, tick marks, and data values
- Geometric figures must have labeled vertices, sides, and angles where relevant
- Maps must have a compass rose and scale bar
- Venn diagrams must have clearly labeled overlapping circles
- Scientific diagrams must have labeled parts with clear arrows

STYLE GUIDE:
- Bar charts: alternating fills (#2563EB, #3B82F6, #60A5FA, #93C5FD), white borders, value labels on top
- Pie charts: distinct sector colors (#2563EB, #DC2626, #16A34A, #F59E0B, #8B5CF6, #EC4899), percentage labels
- Line graphs: blue stroke (#2563EB), filled area below, clear data points (circles r=4)
- Data tables: alternating row colors (#F8FAFC, #EFF6FF), bold headers, clear borders
- Geometric figures: blue outlines (#1E40AF), light blue fills (#DBEAFE), labeled angles with arcs
- Coordinate planes: grid lines (#E5E7EB), bold axes (#000000), plotted points (#DC2626)
- Venn diagrams: semi-transparent overlapping circles (opacity 0.3), labeled regions
- Scientific diagrams: clear labeled parts with arrows, clean line art
- Maps: green land (#22C55E), blue water (#3B82F6), red markers (#DC2626)
- Flowcharts: rounded rectangles (#2563EB fill, white text), diamond decisions (#F59E0B), arrow connectors
- Number lines: bold axis, clear tick marks, colored points for values
- Angle diagrams: arc for angle measurement, labeled degree values`;

  const user = `Subject: ${subject || 'General'}
Topic: ${topic || 'general'}
Question: ${questionText}
Diagram type: ${diagramType || 'best_fit'}

Generate an SVG diagram that:
1. Directly relates to the question — a student should be able to answer the question by reading the diagram
2. Contains realistic, plausible data that matches the question context
3. Is visually clean and professional — suitable for an examination paper
4. Has clear labels, a title, and a legend where needed
5. Uses the exact diagram type specified above`;

  try {
    const svg = await chatJSON(
      [{ role: 'system', content: system }, { role: 'user', content: user }],
      { temperature: 0.7, maxRetries: 1, maxTokens: 8192 }
    );
    // The AI might return the SVG wrapped in an object or as a string
    if (typeof svg === 'string') return svg;
    if (svg && svg.svg) return svg.svg;
    if (svg && svg.diagram) return svg.diagram;
    return null;
  } catch (err) {
    console.error('[ai] diagram generation failed:', err.message);
    return null;
  }
}

/**
 * Generate 2-3 follow-up questions for a diagram-based theory question.
 * Returns an array of follow-up objects.
 */
async function generateFollowUpQuestions({ subject, topic, questionText, diagramType }) {
  const system = `You are an expert exam question writer. Generate 2-3 follow-up questions based on the given question and diagram type.
Return: {"follow_ups": [{"text": "question text", "marks": 2, "difficulty": "easy|medium|hard"}]}

Rules:
- Each follow-up must require students to INTERPRET the diagram (not just recall facts)
- Include a mix of difficulties (at least one easy, one medium)
- Marks should be 2-4 per question
- Questions should be specific and test data interpretation skills
- Use clear, age-appropriate English (JHS/Ghana BECE level)`;

  const user = `Subject: ${subject || 'General'}
Topic: ${topic || 'general'}
Main question: ${questionText}
Diagram type: ${diagramType || 'chart'}

Generate 2-3 follow-up questions that require students to read and interpret the diagram.`;

  try {
    const result = await chatJSON(
      [{ role: 'system', content: system }, { role: 'user', content: user }],
      { temperature: 0.7, maxRetries: 1, maxTokens: 2048 }
    );
    const followUps = result?.follow_ups || result;
    if (Array.isArray(followUps)) return followUps.slice(0, 3);
    return [];
  } catch (err) {
    console.error('[ai] follow-up generation failed:', err.message);
    return [];
  }
}

/**
 * Select the best diagram type for a question based on its content.
 * Covers maths, science, geography, economics, and general data interpretation.
 */
function selectDiagramType(questionText) {
  const text = String(questionText || '').toLowerCase();

  // ── Charts / Data visualization ──────────────────────────────────────
  if (text.includes('pie') || text.includes('proportion') || text.includes('share') || text.includes('sector')) return 'pie_chart';
  if (text.includes('trend') || text.includes('over time') || text.includes('monthly') || text.includes('yearly') || text.includes('annual') || text.includes('weekly')) return 'line_graph';
  if (text.includes('bar chart') || text.includes('bar graph') || text.includes('histogram') || text.includes('frequency') || text.includes('number of') || text.includes('how many')) return 'bar_chart';
  if (text.includes('table') || text.includes('data') || text.includes('list') || text.includes('tabulate')) return 'data_table';

  // ── Geography / Maps ─────────────────────────────────────────────────
  if (text.includes('map') || text.includes('region') || text.includes('location') || text.includes('country') || text.includes('continent') || text.includes('ocean') || text.includes('river') || text.includes('latitude') || text.includes('longitude') || text.includes('equator') || text.includes('bearing') || text.includes('compass') || text.includes('scale drawing')) return 'map';

  // ── Processes / Flowcharts ───────────────────────────────────────────
  if (text.includes('flow') || text.includes('process') || text.includes('cycle') || text.includes('stages') || text.includes('steps') || text.includes('sequence of')) return 'flowchart';

  // ── Venn Diagrams (sets, logic, probability) ─────────────────────────
  if (text.includes('venn') || text.includes('set') || text.includes('union') || text.includes('intersection') || text.includes('complement') || (text.includes('both') && text.includes('either')) || (text.includes('neither') && text.includes('either'))) return 'venn_diagram';

  // ── Coordinate Plane / Graphs (algebra, functions) ───────────────────
  if (text.includes('coordinate') || text.includes('plot') || text.includes('x-axis') || text.includes('y-axis') || text.includes('origin') || text.includes('quadrant') || text.includes('gradient') || text.includes('slope') || text.includes('intercept') || text.includes('linear') || text.includes('quadratic') || text.includes('parabola') || text.includes('function') || text.includes('simultaneous') || text.includes('inequality')) return 'coordinate_plane';

  // ── Geometric Figures (shape, angle, area, volume) ───────────────────
  if (text.includes('triangle') || text.includes('angle') || text.includes('perimeter') || text.includes('area') || text.includes('volume') || text.includes('surface area') || text.includes('circumference') || text.includes('diameter') || text.includes('radius') || text.includes('circle') || text.includes('rectangle') || text.includes('square') || text.includes('polygon') || text.includes('hypotenuse') || text.includes('pythagoras') || text.includes('symmetry') || text.includes('rotation') || text.includes('reflection') || text.includes('translation') || text.includes('net') || text.includes('cross section') || text.includes('elevation') || text.includes('isometric')) return 'geometric_figure';

  // ── Number Lines ─────────────────────────────────────────────────────
  if (text.includes('number line') || text.includes('inequality') || text.includes('range of') || text.includes('between') && text.includes('on a')) return 'number_line';

  // ── Angle Diagrams ───────────────────────────────────────────────────
  if (text.includes('angle') || text.includes('degree') || text.includes('protract') || text.includes('complementary') || text.includes('supplementary') || text.includes('vertically opposite') || text.includes('acute') || text.includes('obtuse') || text.includes('reflex')) return 'angle_diagram';

  // ── Science / Circuit / Diagram ──────────────────────────────────────
  if (text.includes('circuit') || text.includes('cell') || text.includes('battery') || text.includes('resistor') || text.includes('voltage') || text.includes('current') || text.includes('ammeter') || text.includes('voltmeter') || text.includes('magnetic') || text.includes('magnet')) return 'scientific_diagram';
  if (text.includes('food chain') || text.includes('food web') || text.includes('ecosystem') || text.includes('habitat') || text.includes('photosynthesis') || text.includes('digestion') || text.includes('circulation') || text.includes('skeleton') || text.includes('organ')) return 'scientific_diagram';
  if (text.includes('atom') || text.includes('molecule') || text.includes('electron') || text.includes('proton') || text.includes('neutron') || text.includes('nucleus') || text.includes('orbit') || text.includes('energy level')) return 'scientific_diagram';
  if (text.includes('solar system') || text.includes('planet') || text.includes('orbit') || text.includes('revolution') || text.includes('rotation') && text.includes('earth')) return 'scientific_diagram';
  if (text.includes('wave') || text.includes('amplitude') || text.includes('wavelength') || text.includes('frequency') && text.includes('transverse')) return 'scientific_diagram';
  if (text.includes('pulley') || text.includes('lever') || text.includes('gear') || text.includes('spring') || text.includes('force') && text.includes('diagram')) return 'scientific_diagram';

  // ── Economics / Tables ───────────────────────────────────────────────
  if (text.includes('budget') || text.includes('expenditure') || text.includes('revenue') || text.includes('profit') || text.includes('loss') || text.includes('supply') && text.includes('demand') || text.includes('price') && text.includes('quantity')) return 'table_with_data';

  return 'bar_chart'; // default fallback
}

/**
 * Generate a full exam question set with automatic marking scheme.
 * When poolSize is greater than count, produces up to poolSize DISTINCT
 * questions over several calls so each attempt can draw a fresh set.
 *
 * The batch calls run CONCURRENTLY (concurrency-capped). The dominant cost is
 * the round trip to the AI endpoint, so parallelizing collapses the wall-clock
 * time from "sum of all batches" to "one slowest batch × few rounds".
 */
async function generateQuestions({ subject, topics, count, objectiveCount, theoryCount, types, difficulty, instructions, poolSize, avoid = [] }) {
  const typeList = Array.isArray(types) && types.length ? types : ['objective', 'theory'];
  const hasObjective = typeList.includes('objective');
  const hasTheory = typeList.includes('theory');

  // Explicit per-type counts win (the admin can choose them); otherwise fall
  // back to the legacy even split of `count` across the selected types.
  //
  // A type the admin did NOT select stays at zero. `Math.max(1, ...)` used to
  // force one objective question into a theory-only paper, and because the
  // caller sliced the result flat back down to the requested total, that stray
  // objective displaced a real one: "5 theory questions" came back as 1
  // objective + 4 theory.
  let objN = !hasObjective
    ? 0
    : objectiveCount != null
      ? Math.max(0, Math.round(Number(objectiveCount) || 0))
      : Math.max(1, Math.round(count / typeList.length));
  let theoN = !hasTheory
    ? 0
    : theoryCount != null
      ? Math.max(0, Math.round(Number(theoryCount) || 0))
      : Math.max(0, count - objN);
  // Never build an empty paper: a legacy count-only call still has to produce
  // something even when no type resolved.
  if (objN + theoN === 0) objN = 1;
  const total = objN + theoN;

  const target = Math.min(Math.max(parseInt(poolSize) || total, total), 150);
  // Larger batches = fewer total API calls. 10 questions per batch keeps
  // output within token limits while cutting the number of requests in half.
  const batchSize = Math.max(1, Math.min(target, 10));
  const maxCalls = Math.min(Math.ceil(target / batchSize), 15);

  // Keep the same objective/theory split within each smaller batch so the
  // per-batch counts stay consistent with the overall request.
  const ratio = total > 0 ? batchSize / total : 1;
  const perBatchTheory = theoN > 0 ? Math.max(0, Math.round(theoN * ratio)) : 0;
  // When a type is not requested (count=0), its per-batch count must be 0.
  // Math.max(1, ...) would force at least 1 question of the wrong type.
  const perBatchObjective = objN > 0 ? Math.max(1, Math.round(objN * ratio)) : 0;

  // Per-type bookkeeping for the whole run: the paper is exactly `objN`
  // objective and `theoN` theory questions, never "about total".
  const countOf = (arr, type) =>
    arr.reduce((n, q) => n + ((q.type === 'theory' ? 'theory' : 'objective') === type ? 1 : 0), 0);
  const shortfall = (active, rest) => ({
    obj: Math.max(0, objN - countOf(active, 'objective')),
    theo: Math.max(0, theoN - countOf(active, 'theory')),
    pool: Math.max(0, target - total - rest.length),
  });

  // ── Build the avoid list from current exam + global history ──────────
  // Merge caller-provided `avoid` (existing questions in this exam) with
  // the full history of AI-generated questions for this subject/topic so
  // the AI never repeats questions it has produced before across exams.
  const historicalTexts = getHistoricalQuestions(subject, topics, 200);
  const allAvoid = [...new Set([...avoid, ...historicalTexts])];
  console.log(`[generate] avoid list: ${avoid.length} exam + ${historicalTexts.length} historical = ${allAvoid.length} total`);

  const NOVELTY_RULE =
    'NOVELTY (non-negotiable): every question must be ORIGINAL and UNPREDICTABLE.\n' +
    '- A student who reads only the subject and topic list must NOT be able to guess these questions.\n' +
    '- Do NOT use classic textbook questions, well-known past-exam questions, or anything a student could have seen in another AI-generated exam.\n' +
    '- Approach every topic from a fresh angle: invent a believable context, scenario, dataset, or situation, then ask a question about it.\n' +
    '- Never reuse the same facts, figures, names, examples, or scenarios across questions or across batches.\n' +
    '- Vary stems and framing so no two questions feel alike.';

  const VARIETY_TAGS =
    'VARY QUESTION STRUCTURES across the set. Use a mix of:\n' +
    '- Direct recall ("What is...?", "Which of these...?")\n' +
    '- Scenario-based ("A farmer notices...", "Kofi measures...")\n' +
    "- If/Then predictions ('If X happens, what will Y be?')\n" +
    '- Compare and contrast ("How does A differ from B?")\n' +
    '- Data interpretation (table, chart description, measurements)\n' +
    '- Cause and effect ("Why does...?", "What causes...?")\n' +
    '- True/False with justification (objective: "Which statement is correct?")\n' +
    '- Fill in the missing piece ("Complete the following...")\n' +
    'Do NOT use the same structure for consecutive questions.';

  const SPINS = [
    'Frame every question as a concrete real-world situation (a farmer, shopkeeper, school science club, health worker, community, market, lab) with a specific detail the student must reason about. No abstract, definition-style, or fill-in-the-blank stems.',
    'Make every question an application or analysis task: present a short scenario, measurement, or data snippet and ask the student to apply the concept. Never ask for a memorised definition, list, or label.',
    'Use fresh, believable but uncommon contexts and numbers. Rotate the setting so no two questions share a setting, and avoid familiar examples and standard figures.',
    'Ask from a decision or problem-solving angle: each question presents a mini-case and asks what happens, why, or what should be done, with exam-appropriate clarity for a JHS candidate.',
    'Present data-driven questions: include a small table, chart description, or measurement set and ask the student to read, calculate, or interpret from it. Vary the data type (prices, distances, temperatures, population, scores).',
    'Use chronological or sequencing reasoning: place events, steps, or measurements in time order and ask what comes before, after, or during. Avoid simple "first/last" framing.',
    'Frame questions as compare-and-contrast tasks: present two similar items, methods, or situations and ask the student to identify the difference, advantage, or relationship between them.',
    'Use cause-and-effect framing: describe an outcome or observation and ask the student to identify the cause, or describe a cause and ask for the predicted effect. Ground it in a believable scenario.',
    'Pose questions from a "what if" counterfactual angle: change one variable in a familiar scenario and ask the student to predict the new outcome. This tests deep understanding, not memorisation.',
    'Frame questions around a short dialogue, announcement, or notice (a school notice, market price list, health poster) and ask the student to extract, calculate, or infer from it.',
  ];
  const spin = SPINS[Math.floor(Math.random() * SPINS.length)];

  // Build the avoid block: limit to 80 entries (each truncated to 140 chars)
  // so the prompt doesn't blow up. The AI still gets the full picture.
  const avoidDisplay = allAvoid.slice(0, 80);
  const avoidBlock =
    avoidDisplay.length > 0
      ? 'ABSOLUTELY DO NOT generate, reuse, or closely paraphrase any of these previously used questions:\n' +
        avoidDisplay.map((t, i) => `${i + 1}. ${String(t).slice(0, 140)}`).join('\n') +
        (allAvoid.length > 80 ? `\n... and ${allAvoid.length - 80} more similar questions to avoid.` : '')
      : '';

  const system = (objN, theoN, variety) => {
    const parts = [SYSTEM_BASE];

    // Build type-specific instructions based on what's actually requested
    if (objN > 0 && theoN > 0) {
      // Both types requested
      parts.push(`Generate EXACTLY ${objN} objective questions and EXACTLY ${theoN} theory questions. Return: {"questions": [...]}.`);

      parts.push(`Objective question schema:
{
  "type": "objective",
  "text": "question stem",
  "options": ["option1", "option2", "option3", "option4"],
  "correct_index": 0,
  "marks": 1,
  "difficulty": "easy|medium|hard",
  "learning_objective": "what skill this tests",
  "explanation": "why the answer is correct"
}`);

      parts.push(`Theory question schema:
{
  "type": "theory",
  "text": "question stem",
  "marks": 5,
  "difficulty": "easy|medium|hard",
  "learning_objective": "what skill this tests",
  "model_answer": "a complete model answer",
  "key_points": ["point 1", "point 2", ...],
  "rubric": [{"point": "key idea a student must state", "marks": 2, "explanation": "what is expected"}],
  "presentation_marks": 1,
  "grammar_marks": 1
}`);

      parts.push(`CRITICAL RULES:
- You MUST return EXACTLY ${objN} objective questions and EXACTLY ${theoN} theory questions. Count them before returning. If you return fewer, the exam is broken.
- ORDER: List ALL objective questions FIRST, then ALL theory questions. Do NOT mix them. The output MUST start with objective questions and end with theory questions.`);
    } else if (objN > 0) {
      // Only objectives requested
      parts.push(`Generate EXACTLY ${objN} objective questions ONLY. Return: {"questions": [...]}. DO NOT generate any theory questions.`);

      parts.push(`Objective question schema:
{
  "type": "objective",
  "text": "question stem",
  "options": ["option1", "option2", "option3", "option4"],
  "correct_index": 0,
  "marks": 1,
  "difficulty": "easy|medium|hard",
  "learning_objective": "what skill this tests",
  "explanation": "why the answer is correct"
}`);

      parts.push(`CRITICAL RULES:
- You MUST return EXACTLY ${objN} objective questions. Count them before returning.
- DO NOT generate any theory questions — only objective (multiple choice).
- Every question MUST have type "objective".`);
    } else {
      // Only theory requested
      parts.push(`Generate EXACTLY ${theoN} theory questions ONLY. Return: {"questions": [...]}. DO NOT generate any objective questions.`);

      parts.push(`Theory question schema:
{
  "type": "theory",
  "text": "question stem",
  "marks": 5,
  "difficulty": "easy|medium|hard",
  "learning_objective": "what skill this tests",
  "model_answer": "a complete model answer",
  "key_points": ["point 1", "point 2", ...],
  "rubric": [{"point": "key idea a student must state", "marks": 2, "explanation": "what is expected"}],
  "presentation_marks": 1,
  "grammar_marks": 1
}`);

      parts.push(`CRITICAL RULES:
- You MUST return EXACTLY ${theoN} theory questions. Count them before returning.
- DO NOT generate any objective questions — only theory (open-ended).
- Every question MUST have type "theory".`);
    }

    parts.push(`- Options must have exactly one correct answer; distractors must be plausible.
- correct_index is the 0-based index of the correct option.
- CORRECTNESS IS NON-NEGOTIABLE: the option at correct_index must be the ONLY defensible correct answer. These keys are used to grade students, so a wrong key marks innocent students wrong.
- Theory rubric points must sum to (marks - presentation_marks - grammar_marks) or less.
- Difficulty overall: ${difficulty || 'mixed'}.
- Style: write like the Ghana BECE for a JHS candidate. Use clear, age-appropriate English.
${NOVELTY_RULE}
${VARIETY_TAGS}
${spin}
${variety || ''}
${avoidBlock}`);

    return parts.join('\n\n');
  };

  const user = (pObj, pTheo) => {
    const lines = [
      `Subject: ${subject || 'General'}`,
      topics ? `Topics: ${topics}` : 'Topics: general',
      instructions ? `Additional instructions: ${instructions}` : '',
    ];
    if (pObj > 0 && pTheo > 0) {
      lines.push(`Generate EXACTLY ${pObj} objective questions and EXACTLY ${pTheo} theory questions. Return them all in one JSON array.`);
    } else if (pObj > 0) {
      lines.push(`Generate EXACTLY ${pObj} objective (multiple choice) questions. DO NOT generate any theory questions. Return them in one JSON array.`);
    } else {
      lines.push(`Generate EXACTLY ${pTheo} theory (open-ended) questions. DO NOT generate any objective questions. Return them in one JSON array.`);
    }
    return lines.filter(Boolean).join('\n');
  };

  const variety =
    maxCalls > 1
      ? `- These questions are one batch of ${maxCalls} batches that together form ONE large pool on this exact subject and topic list. Every question in the WHOLE pool must be distinct: no repeats, no close paraphrases, and no reused facts, figures, or examples across batches.`
      : '- Produce a diverse set; avoid reusing the same facts, figures, or classic textbook examples across questions.';

  // ── Run generation with retry on insufficient unique results ────────
  // If the first pass produces too few unique questions (because many hit
  // the avoid list), retry with a fresh spin and stricter dedup guidance.
  const MAX_RETRIES = 2;
  const TOP_UP_ROUNDS = 2;
  let finalActive = [];
  let finalRest = [];

  // Dedupe a raw batch against the questions already used, then fill the paper
  // PER TYPE.
  //
  // The old fill was a flat `slice(0, needed)`, which took whatever came back
  // in whatever order: a provider asked for 40 objective + 5 theory that
  // answered 43 + 2 produced a 43/2 paper. It had the right total and every
  // per-type count wrong - "nothing less, nothing more" only holds per type,
  // since that is how the admin asks for it. A type the paper already has
  // enough of now overflows into the pool instead of displacing the type that
  // is still missing.
  const absorb = (rawBatch, label) => {
    const combinedAvoid = [...allAvoid, ...finalActive.map((q) => q.text), ...finalRest.map((q) => q.text)];
    const uniqueBatch = deduplicateAgainstHistory(rawBatch, combinedAvoid, 0.65);
    console.log(`[generate] ${label}: ${uniqueBatch.length} survived history dedup`);

    const bucket = { objective: [], theory: [] };
    for (const q of uniqueBatch) bucket[q.type === 'theory' ? 'theory' : 'objective'].push(q);
    const roomObj = Math.max(0, objN - countOf(finalActive, 'objective'));
    const roomTheo = Math.max(0, theoN - countOf(finalActive, 'theory'));
    finalActive.push(...bucket.objective.splice(0, roomObj), ...bucket.theory.splice(0, roomTheo));

    const leftovers = bucket.objective.concat(bucket.theory);
    const poolRoom = Math.max(0, target - total - finalRest.length);
    finalRest.push(...leftovers.slice(0, poolRoom));

    // Filter rest against active to avoid paraphrases in pool
    const filteredRest = [];
    for (const q of finalRest) {
      const dupActive = finalActive.some((a) => textSimilarity(a.text, q.text) > 0.8);
      const dupRest = filteredRest.some((p) => textSimilarity(p.text, q.text) > 0.8);
      if (!dupActive && !dupRest) filteredRest.push(q);
    }
    finalRest = filteredRest;
  };

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const left = shortfall(finalActive, finalRest);
      console.log(`[generate] retry attempt ${attempt}: need ${left.obj} objective + ${left.theo} theory more unique questions`);
    }

    // Re-roll spin on retry so the AI gets a different creative angle
    const currentSpin = attempt === 0 ? spin : SPINS[Math.floor(Math.random() * SPINS.length)];
    const retryVariety = attempt > 0
      ? variety + '\n- IMPORTANT: You already generated some questions that were rejected for being too similar to past questions. Generate ONLY completely new, unseen questions with different contexts, names, numbers, and scenarios.'
      : variety;

    const tasks = Array.from({ length: maxCalls }, (_, i) => () =>
      chatJSON(
        [
          { role: 'system', content: system(perBatchObjective, perBatchTheory, retryVariety).replace(spin, currentSpin) },
          { role: 'user', content: user(perBatchObjective, perBatchTheory) },
        ],
        { temperature: 0.95, maxRetries: 2, maxTokens: 16384 }
      )
    );
    // Batch concurrency. This was `Math.min(maxCalls, 2)`, which serialized a
    // 15-call paper into 8 sequential waves of ~19s - the single largest
    // contributor to "generation is slow". Measured on the gateway, 4 and 8
    // concurrent batches both completed in ~30s with no 429s, because the
    // batches run in parallel with the provider's own latency in parallel too.
    // A 429 is still handled where it belongs: chatJSON retries with backoff
    // (maxRetries: 2 above), so a rate limit now costs a retry rather than a
    // permanently crippled scheduler.
    const concurrency = batchConcurrencyFor(maxCalls);
    console.log(`[generate] attempt ${attempt}: launching ${maxCalls} batches with concurrency ${concurrency}`);
    const settled = await mapLimit(tasks, concurrency, async (run, idx) => {
      try {
        const stagger = batchLaunchStaggerMs();
        if (stagger > 0) await delay(idx * stagger);
        const result = await run();
        return result;
      } catch (err) {
        console.error(`[generate] batch ${idx} failed:`, err.message);
        return null;
      }
    });

    // Collect unique questions from this attempt
    const seen = new Set();
    const batchAll = [];
    for (const result of settled) {
      if (!result) continue;
      const batch = Array.isArray(result) ? result : result.questions;
      for (const q of batch || []) {
        const t = String(q && q.text || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        if (t && !seen.has(t)) {
          seen.add(t);
          batchAll.push(q);
        }
      }
    }
    console.log(`[generate] attempt ${attempt}: collected ${batchAll.length} raw unique questions`);

    absorb(batchAll, `attempt ${attempt}`);

    // Stop once the paper is exactly right and the pool is topped up. Because
    // absorb() caps each type at its own quota, length >= total is only
    // reachable when BOTH quotas are met — a lopsided batch can no longer
    // satisfy it.
    const left = shortfall(finalActive, finalRest);
    if (left.obj + left.theo + left.pool === 0) break;
  }

  // ── Top-up rounds ────────────────────────────────────────────────────
  // The batch plan above is fixed for the whole pass, so re-running it asks
  // for ten more of whatever the first pass over-delivered and never for the
  // type that came up short. These rounds ask for the exact shortfall alone —
  // a handful of questions, one cheap batch — which is what turns "about 40"
  // into exactly 40.
  for (let round = 1; round <= TOP_UP_ROUNDS; round++) {
    const missing = shortfall(finalActive, finalRest);
    if (missing.obj + missing.theo <= 0) break;
    console.log(`[generate] top-up ${round}: still missing ${missing.obj} objective + ${missing.theo} theory`);
    const topUpVariety = variety
      + '\n- IMPORTANT: this is a top-up round for a paper that is almost complete. Produce ONLY the questions asked for, with brand new contexts, names, numbers and scenarios.';
    try {
      const answer = await chatJSON(
        [
          { role: 'system', content: system(missing.obj, missing.theo, topUpVariety) },
          { role: 'user', content: user(missing.obj, missing.theo) },
        ],
        { temperature: 0.95, maxRetries: 2, maxTokens: 16384 }
      );
      absorb(Array.isArray(answer) ? answer : (answer && answer.questions) || [], `top-up ${round}`);
    } catch (err) {
      console.error(`[generate] top-up ${round} failed:`, err.message);
    }
  }

  // ── Exactness guarantee ──────────────────────────────────────────────
  // The dashboard promises exactly N objective and exactly M theory questions.
  // Silently returning 43/2 for a 40/5 paper rewrites that promise behind the
  // admin's back, so fail loudly instead: the generate route turns this into a
  // 502 that names the shortfall, and nothing gets inserted.
  const stillShort = shortfall(finalActive, finalRest);
  if (stillShort.obj + stillShort.theo > 0) {
    throw new Error(
      `the AI returned ${countOf(finalActive, 'objective')} of ${objN} objective and `
      + `${countOf(finalActive, 'theory')} of ${theoN} theory questions after ${MAX_RETRIES + 1} passes `
      + `and ${TOP_UP_ROUNDS} top-up rounds. Nothing was saved — try generating again.`
    );
  }

  // ── Sort and return ─────────────────────────────────────────────────
  const sortFn = (a, b) => {
    if (a.type !== b.type) return a.type === 'objective' ? -1 : 1;
    return 0;
  };
  finalActive.sort(sortFn);
  finalRest.sort(sortFn);
  const result = finalActive.concat(finalRest).slice(0, target);

  // ── Generate diagrams and follow-up questions for theory questions ──
  // Add diagrams to ~80% of questions (both theory and objective) that need them.
  // Objective questions referencing charts, tables, maps, diagrams, or geometric
  // figures also get diagrams so students can see the visual data on WhatsApp.
  const { svgToPng } = require('./svgToPng');
  const fs = require('fs');
  const path = require('path');

  // Diagrams used to be generated one question at a time in a plain for-loop.
  // A full paper asks for up to ~80 questions, so that was up to ~80 serial AI
  // calls (plus a second one for theory follow-ups) dominating the entire
  // wall-clock time of a generation. Bounded parallelism overlaps them.
  // Concurrency is kept modest because the batch phase runs first and the
  // account is already close to its rate limit.
  //
  // Every task below is total: it can never reject. mapLimit awaits
  // Promise.all over its workers without catching per-task errors, so a rejected
  // task would reject the whole batch while its siblings kept running
  // unsupervised - the paper would come back truncated, and a sibling rejecting
  // afterwards would be an unhandled rejection, which terminates the process on
  // Node >=15. generateDiagram() does catch its own failures and return null
  // today, so this is defence in depth rather than a live bug: it keeps the
  // guarantee local to the concurrency change instead of depending on a
  // function several layers down to keep swallowing its errors, and it also
  // covers selectDiagramType and any future change to generateDiagram. A
  // missing diagram is a cosmetic loss; it must never cost the questions or
  // the server.
  const diagramTasks = result
    .filter((q) => q && shouldHaveDiagram(q) && Math.random() < 0.8)
    .map((q) => async () => {
      try {
        const diagramType = selectDiagramType(q.text + ' ' + (q.passage || ''));
        console.log(`[generate] generating ${diagramType} diagram for ${q.type} question: "${q.text.slice(0, 50)}..."`);

        const svg = await generateDiagram({ subject, topics, questionText: q.text, diagramType });
        if (!svg) return;
        const pngBuffer = await svgToPng(svg);
        const filename = `diagram-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`;
        fs.writeFileSync(path.join(config.uploadsDir, filename), pngBuffer);
        q.image = filename;
        console.log(`[generate] saved diagram: ${filename}`);

        // Generate follow-up questions for theory questions with diagrams
        if (q.type === 'theory') {
          const followUps = await generateFollowUpQuestions({ subject, topics, questionText: q.text, diagramType });
          if (followUps.length > 0) {
            q.follow_ups = JSON.stringify(followUps);
            console.log(`[generate] generated ${followUps.length} follow-up questions`);
          }
        }
      } catch (err) {
        // Logged and swallowed on purpose: see the note above. The question
        // stays in the paper, just without its figure.
        console.error('[generate] diagram failed for question, continuing without it:', err.message);
      }
    });

  if (diagramTasks.length) {
    console.log(`[generate] rendering ${diagramTasks.length} diagram(s) with concurrency ${DIAGRAM_CONCURRENCY}`);
    await mapLimit(diagramTasks, DIAGRAM_CONCURRENCY, (run) => run());
  }

  // ── Log to global history so future generations avoid these ──────────
  if (result.length > 0) {
    logGeneratedQuestions(result, subject, topics);
    console.log(`[generate] logged ${result.length} questions to history`);
  }

  return result;
}

/** Jaccard similarity over significant tokens; used to drop near-duplicate stems. */
function textSimilarity(a, b) {
  const ta = new Set(String(a).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2));
  const tb = new Set(String(b).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

/**
 * Fetch previously generated question texts from the global history table.
 * Returns up to `limit` texts matching the subject (and optionally topics),
 * ordered by most recent first. Used to build the `avoid` list so the AI
 * never regenerates questions it has produced before.
 */
function getHistoricalQuestions(subject, topics, limit = 100) {
  try {
    if (topics) {
      return db
        .prepare(
          `SELECT question_text FROM generated_questions_history
           WHERE subject = ? AND topics = ?
           ORDER BY created_at DESC LIMIT ?`
        )
        .all(subject, topics, limit)
        .map((r) => r.question_text);
    }
    return db
      .prepare(
        `SELECT question_text FROM generated_questions_history
         WHERE subject = ?
         ORDER BY created_at DESC LIMIT ?`
      )
      .all(subject, limit)
      .map((r) => r.question_text);
  } catch (err) {
    console.error('[generate] failed to fetch history:', err.message);
    return [];
  }
}

/**
 * Record newly generated question texts into the global history table.
 * Called after a successful generation so future runs can avoid repeats.
 */
function logGeneratedQuestions(questions, subject, topics) {
  try {
    const insert = db.prepare(
      `INSERT INTO generated_questions_history (subject, topics, question_text, type, difficulty)
       VALUES (?, ?, ?, ?, ?)`
    );
    const insertMany = db.transaction((rows) => {
      for (const row of rows) insert.run(...row);
    });
    insertMany(
      questions.map((q) => [
        subject || '',
        topics || '',
        q.text || '',
        q.type || 'objective',
        q.difficulty || 'medium',
      ])
    );
  } catch (err) {
    console.error('[generate] failed to log history:', err.message);
  }
}

/**
 * Check a batch of newly generated questions against the full history and
 * existing questions. Returns only genuinely unique questions, dropping any
 * that are too similar (>similarityThreshold) to an existing one.
 */
function deduplicateAgainstHistory(newQuestions, existingTexts, similarityThreshold = 0.65) {
  const combined = [...existingTexts];
  const unique = [];
  for (const q of newQuestions) {
    const text = String(q.text || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!text) continue;
    let isDup = false;
    for (const existing of combined) {
      if (textSimilarity(q.text, existing) > similarityThreshold) {
        isDup = true;
        break;
      }
    }
    if (!isDup) {
      unique.push(q);
      combined.push(q.text);
    }
  }
  return unique;
}

/**
 * One sentence naming WHY extraction blocks failed, from the reasons the run
 * actually recorded. The zero-question failure message used to guess "the AI
 * provider did not answer in time" for EVERY case — including a provider that
 * answered instantly with nothing in it — and an admin sent to raise a
 * timeout knob for a failure that was not a timeout fixes nothing.
 */
function blockFailureSentence(reasons) {
  const entries = Object.entries(reasons || {}).filter(([k, v]) => k !== 'short' && v > 0);
  if (!entries.length) return '';
  entries.sort((a, b) => b[1] - a[1]);
  const [reason, n] = entries[0];
  const attempts = entries.reduce((s, [, v]) => s + v, 0);
  const scope = n === attempts ? 'every attempt' : `${n} of ${attempts} attempt(s)`;
  const what = {
    timeout: `the AI provider timed out on ${scope}`,
    'empty-block': `the AI provider answered but returned no questions (${scope})`,
    'invalid-json': `the AI provider returned unreadable output (${scope})`,
    'rate-limited-429': `the AI provider rate-limited the import (${scope})`,
    'quota-exhausted': `the AI provider account ran out of quota (${scope})`,
    network: `the AI provider could not be reached (${scope})`,
  }[reason] || (reason.startsWith('http-')
    ? `the AI provider answered with an HTTP ${reason.slice(5)} error (${scope})`
    : `the AI provider failed — ${reason} (${scope})`);
  return ` The cause: ${what}.`;
}

/**
 * Extract structured questions from raw exam text (from PDF or pasted document).
 * Detects options and answer keys; generates schemes where missing.
 *
 * The document is split into question-aligned blocks and each block is
 * extracted by a SEPARATE small AI call, run concurrently. A single call that
 * must parse and emit the entire paper (often >8000 output tokens) easily
 * exceeds the bulk timeout on slow models (e.g. huge 100B+ endpoints), which
 * is what made PDF uploads time out. Small blocks keep every call fast.
 */
async function extractQuestionsFromText(rawText, onProgress, onWarning, opts = {}) {
  // Read the export so tests can stub it.
  const chatJSON = module.exports.chatJSON;
  const text = String(rawText || '').trim();
  if (!text) {
    // Returning [] in silence here is what made a scanned PDF report "the
    // document may not contain exam questions": no blocks were ever built, so
    // no block could fail, so no warning was raised, and the caller fell
    // through to its generic "wrong format" message. Say what actually
    // happened - there was nothing to read.
    if (onWarning) onWarning('No readable text could be extracted from this PDF');
    return [];
  }

  const { cleanText, answerMap, answerKey, modelSolutions: markingScheme } =
    splitSolutionSections(text);
  const blocks = splitIntoBlocks(cleanText);
  // [IMG:n] marker lines ride inside rawText, so the surviving markers are the
  // ones still present per block after solutions/section splitting. opts.markers
  // (array of {idx, page} from textWithMarkers) only tells us markers SHOULD
  // exist — without it a pasted document is never warned about "missing"
  // figures it never had.
  const markersPresent = Array.isArray(opts.markers) && opts.markers.length > 0;
  const mathMarkersPresent = Array.isArray(opts.mathMarkers) && opts.mathMarkers.length > 0;
  const markersByBlock = markersPresent
    ? blocks.map((blk) => [...blk.matchAll(/\[IMG:(\d+)\]/g)].map((mm) => ({ idx: Number(mm[1]) })))
    : null;
  const mathByBlock = mathMarkersPresent
    ? blocks.map((blk) => [...blk.matchAll(/\[MATH:(\d+)\]/g)].map((mm) => ({ idx: Number(mm[1]) })))
    : null;
  const questionsByBlock = blocks.map(() => []);

  const system = SYSTEM_BASE + `
You are given the raw text of an examination document. Extract every question.

Return: {"questions": [...]}. Each question is one of:

Objective:
{
  "type": "objective",
  "number": 12,            // original question number from the paper, as an integer
  "section": "SECTION B",  // the section heading this question sits under, verbatim; "" if the paper has no sections
  "compulsory": false,     // true ONLY if the paper forces this exact question
  "text": "stem (options already removed)",
  "options": ["A. Kumasi", "B. Accra", ...]  // KEEP the original letter prefixes (A., B., C., D.) exactly as written on the paper
  "correct_answer": "B",   // the option LETTER if the document has an answer key, else "" (empty string)
  "correct_index": 1,      // 0-based position of the correct option IN the options array you return (matches correct_answer); set to null (NOT 0) when the document has no answer key
  "passage": "",           // full passage/context this question is based on, else ""
  "marks": 1,
  "difficulty": "easy|medium|hard",
  "learning_objective": "",
  "explanation": ""   // leave empty if the document has no answer key
}

Theory:
{
  "type": "theory",
  "number": 1,            // original question number from the paper, as an integer
  "section": "SECTION B",  // the section heading this question sits under, verbatim; "" if the paper has no sections
  "compulsory": false,     // true ONLY if the paper forces this exact question
  "text": "stem",
  "follow_ups": [          // the numbered question's OWN parts — (a), (b), (c) or (i), (ii) — with the label removed from text
    { "text": "part text", "marks": 2 }
  ],
  "passage": "",     // full passage/context this question is based on, else ""
  "marks": 5,
  "difficulty": "easy|medium|hard",
  "learning_objective": "",
  "model_answer": "",
  "key_points": [],
  "rubric": [],
  "presentation_marks": 0,
  "grammar_marks": 0
}

Rules:
- Preserve each question's original number from the paper in the "number" field (as an integer, e.g. "number": 1) and DROP the number from the text. Keep any instruction that is part of the question stem (e.g. "Read the passage below and answer questions 1 to 5.") inside text when it belongs to a single question, otherwise it stays as context.
- SUB-QUESTIONS: the parts of a numbered question — "(a) …", "(b) …", "(c) …" or "(i) …", "(ii) …" — are NOT questions of their own and must NEVER be returned as separate entries with their own "number". Put them in the parent question's "follow_ups" array, with the letter or roman label removed from each text, keeping every mark allocation. Only a question with no numbered question above it (a comprehension passage's lettered questions) is an entry of its own.
- If the document contains an answer key (e.g. "Answers: 1-B, 2-C" or similar), use it to fill correct_answer (the option LETTER) AND correct_index (the 0-based position of that option in the options array you return).
- If options are numbered 1-4 with possible answers, infer the letter as A-D.
- KEEP the options in the exact order and with the exact letters they have on the paper.
- PASSAGES: Reading-comprehension questions are based on a passage that appears before them in the document. If a question depends on such a passage, set its "passage" field to the full passage text VERBATIM on the FIRST question that uses that passage, and leave "passage": "" on the LATER questions that use the SAME passage (the system attaches it to the whole group). Preserve instructions that introduce the passage ("Read the following passage carefully and answer questions 1 to 5.") as part of that first question's passage.
- SECTION INSTRUCTIONS: Preserve section-level instructions students need to answer the questions (e.g. "Answer ONE question in this section", "Your answer should be between 250 and 300 words", "Answer ALL questions", "Write a letter", "Translate into English"). Attach them to the "passage" field of the FIRST question of that section — for BOTH objective and theory questions — and leave "passage": "" on the later questions of the same section. Never drop instructions that appear in the document.
- AN INSTRUCTION IS NEVER A QUESTION: a line that addresses or directs the candidate — "Answer all questions in this section.", "INSTRUCTIONS: Answer all questions in Part A.", "Read the passage and answer the questions that follows.", "Attempt THREE questions.", "SECTION B", "Each question carries 20 marks." — is NOT a question entry of its own, no matter what number sits beside it. NEVER return one as an entry with its own "number", and never return it as an entry with an empty text. It belongs to the first question it governs: put it in that question's "passage" (prepended if that question already has one) and move on to the next real question. A question ASKS something — "Write a letter to your father…" is a question, "Write your answers in the answer booklet" is not. When a line and the questions it introduces are inseparable, the line is context, not content.
- SECTION: "section" is the heading the question sits under, VERBATIM (e.g. "SECTION B", "Part II"), or "" when the paper has no sections. It must be IDENTICAL for every question of the same section — grouping on this value is how the platform reconstructs sections.
- COMPULSORY: "compulsory" is true ONLY for questions the document itself forces ("Answer ALL questions in Section A", "Questions 1 and 2 are compulsory", "Question 3 is compulsory"). A question that merely sits in a section with a limit is NOT compulsory — do not mark it true because it shares a section with compulsory questions. When in doubt, leave it false.
- MARKING SCHEME: If a marking scheme / model answer / suggested answers section for the questions is quoted in the prompt, use it VERBATIM to fill model_answer, key_points and rubric for the matching theory questions (do not regenerate or paraphrase it).
- For theory questions with no rubric in the source, leave rubric/model_answer empty (the system will generate them).
- Do NOT invent answer keys that are not in the document. Leave correct_answer as "" and correct_index as null when unknown.
- WATERMARK LINES: Never copy watermark, source, or download footer/header lines (e.g. "Downloaded from sronu.com", "Source: www.example.com", "DOWNLOADED FROM SRONU") into text, passage, or instructions. Always drop such lines.
- PAGE FURNITURE: The paper's own furniture is never content. Never copy it into "text" or "passage": the running header/footer ("2027 BECE French Mock | Original practice material Page 8", "Page 8"), the paper's title block ("PAPER 2: WRITTEN AND COMMUNICATIVE SKILLS"), its time and marks lines ("Time: 1 hour 25 minutes", "Suggested raw marks: 100"), a printed "INSTRUCTIONS: …" block addressed to the whole paper, or the "Question 1 [40 marks]" label above a question (the number already goes in "number" — drop the label and keep the stem). Keep the READING TEXT itself verbatim, and keep section-level instructions in the first question's passage exactly as rule "SECTION INSTRUCTIONS" above requires: only the printed furniture is dropped. A heading or directive line standing on its own ("SECTION B", "Answer all questions in this section.") is furniture in exactly this sense — it becomes that rule's context in the first question's passage, never an entry of its own.
- FIGURE MARKERS: Raw text may contain lines like "[IMG:5]" — those are real figure markers from the paper. If a marker belongs to this question's stem or its figure caption, PRESERVE it verbatim in the "text" or "passage" field of that question (never invent or move markers).
- MATH MARKERS: Raw text may contain inline markers like "[MATH:3]" — those are real math-expression bubbles (fractions, powers, matrices, surd stacks) that cannot be typeset as text. PRESERVE them verbatim wherever they appear: in the "text" field, inside the "passage" field, AND inside option strings (e.g. "A. [MATH:3] + 4"). Never invent, renumber, or drop markers, and never move a marker from one option to another.
- COMPACT OUTPUT: keep option text short, leave explanation and learning_objective empty, and do not repeat the passage for later questions. Output ONLY the JSON object.
`;

  // The marking scheme is only useful to a block whose questions it describes.
  // Quoting it to EVERY block is what made a 300-character literature extract
  // answer with the solutions of the writing section instead: the model, handed
  // a large "Question 1 — Letter to your father" quote next to two lines about a
  // play, returned the quote as question 1. Two conditions keep it where it
  // belongs — the block must contain a NUMBERED question (a paper's model
  // answers are keyed by number, and a block of only "(a)"…"(j)" parts cannot
  // match one), and it must not be an MCQ block (objective answers come from the
  // answer key above, so the scheme there is pure noise).
  const schemeApplies = (block) => {
    if (!markingScheme) return false;
    if (!/(^|\n)\s*\d{1,3}[.)]/.test(block)) return false;
    return (block.match(/(^|\n)\s*[A-D][.)]\s/g) || []).length < 4;
  };

  const user = (block, shared) => [
    'Extract every question from the document block below.',
    answerKey
      ? `\nThe document includes this answer key (use it to fill correct_answer — the option LETTER — and correct_index for the matching questions):\n${answerKey}`
      : '',
    schemeApplies(block)
      ? `\nThe document includes this marking scheme / model answers (use it VERBATIM to fill model_answer, key_points and rubric for the matching theory questions):\n${markingScheme}`
      : '',
    shared
      ? `\nThe questions in this block are based on the following passage/context (quoted from earlier in the document). Use it to answer comprehension questions and preserve it VERBATIM in the passage field of the first question that uses it (and attach any section instructions such as "Answer ONE question in this section" to that first question's passage as well):\n${shared}`
      : '',
    `\n--- Document block ---\n${block}`,
  ].join('\n');

  // A block's leading context is the passage and/or section instructions that
  // sit in front of its first question (the splitter breaks blocks at
  // instruction lines precisely so this is the group's own context). A leading
  // section header ("SECTION C", "PART B ORAL LANGUAGE", "UNIT II") is lifted
  // out and prepended to the first question of the block, so each group keeps
  // its section name even when the AI would otherwise drop it. Leading title
  // lines ("ENGLISH LANGUAGE", "BIG EXAM PAPER") are dropped so they are not
  // attached to every question.
  //
  // Context is carried block-to-block ONLY when the block has no context of
  // its own (e.g. a reading passage split across two size-limited blocks). A
  // block that opens with its own section header resets the carry, so a
  // previous section's instructions never bleed into the next section.
  const blockPrompts = [];
  let lastPassage = '';
  for (const block of blocks) {
    const lead = leadingContext(block.split(/\r?\n/));
    const header = leadingSectionHeader(lead);
    let start = 0;
    while (start < lead.length) {
      const l = lead[start].trim();
      if (header && l === header) {
        start++;
        break;
      }
      if (CONTEXT_START.test(l) || l.length >= 40) break;
      start++; // skip title-like lines
    }
    const own = lead.slice(start).join('\n').trim();
    const shared = own || (header ? '' : lastPassage);
    if (own || header) lastPassage = own || '';
    blockPrompts.push({ block, shared, header });
  }

  let completed = 0;
  // Instrumentation only. `blockStats` accumulates what each block cost and why
  // it failed so a slow or lossy import can be explained from real numbers
  // instead of inferred from a comment. It changes no control flow.
  const blockStats = { blocks: 0, ok: 0, dropped: 0, toppedUp: 0, requested: 0, returned: 0, reasons: {} };
  // `parseCounters` is a never-reset module singleton, so the import's own
  // parse outcomes have to be read as a delta from here, not as a total.
  const parseBaseline = parseStats();

  /** Classify a block failure so the log says WHY, not just "skipped". */
  function classifyBlockFailure(err) {
    if (!err) return 'unknown';
    if (err.permanent) return 'quota-exhausted';
    if (err.rateLimited) return 'rate-limited-429';
    if (typeof err.message === 'string' && /timed out/i.test(err.message)) return 'timeout';
    if (typeof err.message === 'string' && /not valid JSON/i.test(err.message)) return 'invalid-json';
    if (typeof err.message === 'string' && /no questions/i.test(err.message)) return 'empty-block';
    if (typeof err.message === 'string' && /AI request failed \((\d+)\)/.exec(err.message)) {
      return `http-${/AI request failed \((\d+)\)/.exec(err.message)[1]}`;
    }
    if (err.name === 'TypeError') return 'network';
    return 'other';
  }

  // A single block runs on its own shorter clock with a couple of retries. If
  // it still fails (timeout, HTTP error, bad JSON) the block is re-run
  // serially after the wave (flaky shared endpoints usually succeed once they
  // are no longer flooded); only then is it dropped and reported.
  // Retries are split across the two passes so a block is never retried more
  // than BLOCK_WAVE_RETRIES + 1 + BLOCK_RETRIES times in total. The previous
  // shape (3 attempts in the wave, then 3 more serially) meant up to 6 calls
  // per block; multiplied by block count and raced providers that is what
  // produced 429 storms and multi-minute imports.
  const runBlock = async (bp, maxRetries) => {
    const retries = maxRetries === undefined ? BLOCK_WAVE_RETRIES : maxRetries;
    const label = `block${bp.index != null ? `#${bp.index}` : ''}`;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const startedAt = Date.now();
      try {
        const result = await chatJSON(
          [
            { role: 'system', content: system },
            { role: 'user', content: user(bp.block, bp.shared) },
          ],
          // Internal retries are disabled: the block wrapper owns retries, and
          // the hard timeout guarantees a stuck fetch cannot stall the import.
          { timeoutMs: blockTimeoutMs(), maxTokens: BLOCK_MAX_TOKENS, maxRetries: 0 }
        );
        // A block is ~15 questions of text, so an empty list is never a valid
        // answer: the model bailed, truncated, or returned a shape we could
        // not read. Treating it as a SUCCESS silently dropped every question
        // in the block and the paper imported as "no questions" with no
        // warning at all. Fail it so it retries and is eventually reported.
        const list = Array.isArray(result) ? result : result?.questions;
        if (!Array.isArray(list) || list.length === 0) {
          throw new AIError('block returned no questions');
        }
        const took = Date.now() - startedAt;
        const short = list.length < BLOCK_QUESTIONS;
        blockStats.ok++;
        blockStats.returned += list.length;
        if (short) blockStats.reasons.short = (blockStats.reasons.short || 0) + 1;
        console.log(
          `[ai] ${label} ok in ${took}ms (attempt ${attempt + 1}/${retries + 1}) returned ${list.length}`
        );
        return result;
      } catch (err) {
        const isTimeout = err && err.name === 'AIError' && /timed out/i.test(err.message);
        const reason = classifyBlockFailure(err);
        const took = Date.now() - startedAt;
        if (attempt < retries) {
          console.warn(
            `[ai] ${label} failed in ${took}ms (attempt ${attempt + 1}/${retries + 1}) reason=${reason}` +
            ` - ${isTimeout ? 'timeout' : err.message}`
          );
          await delay(500 * (attempt + 1));
          continue;
        }
        blockStats.dropped++;
        blockStats.reasons[reason] = (blockStats.reasons[reason] || 0) + 1;
        console.error(
          `[ai] extraction block skipped: ${reason} after ${took}ms and ${attempt + 1} attempt(s) -` +
          ` ${isTimeout ? 'timeout' : err.message}`
        );
        return null;
      }
    }
    return null;
  };

  const tasks = blockPrompts.map((bp) => async () => {
    try {
      return await runBlock(bp);
    } finally {
      // Progress counts COMPLETED blocks, not started ones: the dashboard
      // must only show "(N/N)" once the last block has actually settled,
      // otherwise the UI freezes on the final count while a slow block
      // (and its retries) are still running.
      completed++;
      if (onProgress) onProgress(completed, blocks.length);
    }
  });

  const settled = await mapLimit(tasks, BLOCK_CONCURRENCY, (run) => run());
  blockStats.blocks = blockPrompts.length;
  blockStats.requested = blockStats.blocks * BLOCK_QUESTIONS;

  // Re-run every failed block serially (concurrency 1). This recovers most
  // transient failures and is what stops a whole theory section disappearing.
  const failed = [];
  for (let i = 0; i < settled.length; i++) if (!settled[i]) failed.push(i);
  if (failed.length) {
    const rerun = await mapLimit(failed.map((i) => blockPrompts[i]), 1, (bp) => runBlock(bp, BLOCK_RETRIES));
    for (let k = 0; k < rerun.length; k++) if (rerun[k]) settled[failed[k]] = rerun[k];
  }

  // ── Last-resort recovery: an uploaded paper never loses a block ──────
  //
  // Above, a block that fails every AI call used to be DROPPED — up to 15
  // questions gone from the import with one apology line. Nothing of an
  // uploaded exam is disposable, so a block that is still missing after both
  // passes is recovered in two steps:
  //   1. split it at its own question boundaries and parse the halves, each a
  //      much smaller ask (the usual failure is "this block is too big / too
  //      weird", which half a block fixes);
  //   2. parse whatever is left with the deterministic parser below — no AI
  //      required, so a provider outage costs quality, never questions.
  // Step 1 is skipped when NOT ONE block parsed: the endpoint is down, and
  // more calls against it would only stall the import before step 2 anyway.
  const stillFailed = [];
  for (let i = 0; i < settled.length; i++) if (!settled[i]) stillFailed.push(i);
  let recoveredBlocks = 0;
  let recoveredLocally = 0;
  if (stillFailed.length) {
    const endpointAlive = blockStats.ok > 0;
    const recovered = await mapLimit(stillFailed.map((i) => blockPrompts[i]), 2, async (bp) => {
      if (endpointAlive) {
        const parts = splitBlockInHalf(bp.block);
        if (parts.length === 2) {
          const questions = [];
          let viaLocal = false;
          for (const part of parts) {
            const half = await runBlock({ ...bp, block: part }, 1);
            if (half) {
              questions.push(...(Array.isArray(half) ? half : half.questions || []));
            } else {
              const local = parseQuestionsLocally(part, bp.header);
              if (local.length) {
                questions.push(...local);
                viaLocal = true;
              }
            }
          }
          if (questions.length) return { questions, local: viaLocal };
        }
      }
      const local = parseQuestionsLocally(bp.block, bp.header);
      if (local.length) return { questions: local, local: true };
      return null;
    });
    for (let k = 0; k < recovered.length; k++) {
      if (!recovered[k]) continue;
      settled[stillFailed[k]] = recovered[k];
      recoveredBlocks++;
      if (recovered[k].local) recoveredLocally += recovered[k].questions.length;
    }
    const gone = stillFailed.filter((_, k) => !recovered[k]);
    if (gone.length && onWarning) {
      onWarning(
        `${gone.length} question block(s) could not be parsed — some questions may be missing. ` +
        `Retry the upload to recover them.${blockFailureSentence(blockStats.reasons)}`
      );
    } else if (recoveredLocally && onWarning) {
      onWarning(
        `${recoveredLocally} question(s) were recovered with basic text parsing — review them after import.`
      );
    }
  }

  // One summary line per import. `parseStats.repaired` is the honest truncation
  // signal: repairTruncatedJSON only runs when a response hit the output token
  // cap, and a repaired block SUCCEEDS while silently returning fewer questions.
  // Block return counts are logged but deliberately NOT used to warn - a block
  // holding 15 questions is a cap, not an expectation, so a short block may be
  // perfectly normal. The user-facing loss detector stays completenessWarning(),
  // which compares the estimated question count against what was extracted.
  {
    const ps = parseStatsSince(parseBaseline);
    const reasonStr = Object.entries(blockStats.reasons)
      .map(([k, v]) => `${k}=${v}`).join(' ') || 'none';
    console.log(
      `[ai] extraction summary: blocks=${blockStats.blocks} ok=${blockStats.ok} dropped=${blockStats.dropped} ` +
      `recovered=${recoveredBlocks} (basicParse=${recoveredLocally}) toppedUp=${blockStats.toppedUp} ` +
      `shortBlocks=${blockStats.reasons.short || 0} ` +
      `questions=${blockStats.returned}/${blockStats.requested} ` +
      `parse(ok=${ps.ok} repaired=${ps.repaired} failed=${ps.failed}) reasons: ${reasonStr}`
    );
  }

  /**
   * The questions THIS block's model pass came back missing, recovered from
   * the block's own text.
   *
   * A block can fail loudly (handled above) or quietly: a truncated response
   * that repaired into fewer questions, a section the model skimmed, a theory
   * half it summarised. The block still holds every numbered question it was
   * given, so the difference between the numbers printed on the paper and the
   * numbers handed back is the exact set of questions to recover — anything
   * whose number the model already returned is never added twice.
   *
   * Guarded three ways, because a question invented here would be a question
   * the admin never uploaded: only runs when the model returned numbers to
   * compare against, never adds more than the deficit, and only accepts a
   * local candidate whose stem is a sentence and says nothing the block
   * already says.
   */
  const topUpMissingQuestions = (bp, list) => {
    if (!Array.isArray(list) || !list.length) return list;
    const haveNumbers = new Set(
      list.map((q) => Number(q && q.number)).filter((n) => Number.isFinite(n) && n > 0)
    );
    if (!haveNumbers.size) return list;
    const deficit = estimateNumberedQuestions(bp.block) - list.length;
    if (deficit <= 0) return list;
    const haveText = list.map((q) => String((q && q.text) || '').replace(/\s+/g, ' ').trim().toLowerCase());
    const extras = [];
    for (const q of parseQuestionsLocally(bp.block, bp.header)) {
      if (extras.length >= deficit) break;
      const n = Number(q.number);
      if (n && haveNumbers.has(n)) continue;
      const text = String(q.text || '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (text.length < 8) continue;
      if (haveText.some((t) => t && textSimilarity(text, t) > 0.55)) continue;
      extras.push(q);
      if (n) haveNumbers.add(n);
      haveText.push(text);
    }
    if (extras.length) blockStats.toppedUp += extras.length;
    return extras.length ? [...list, ...extras] : list;
  };

  // ── The marking scheme is not a source of questions ──────────────────
  //
  // The prompt quotes the document's own model answers so the model can fill
  // model_answer/key_points VERBATIM. It still happens that the model hands
  // those SOLUTIONS back as if they were questions — "Letter to your father"
  // arrived as question 1 of a literature block, complete with the writing
  // section's header, while its passage was a play extract.
  //
  // The test is block-local, which makes it precise where a test against the
  // whole paper is not: "letter to your father" occurs in the PAPER too (inside
  // the real Question 1 stem), so a paper-wide check would have let the leak
  // through. A question returned from a block must be written IN that block;
  // text that is not, but IS one of the quoted solutions, was read out of the
  // prompt itself and is not a question of this exam.
  const squash = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const solutionBody = squash(markingScheme);
  const isSolutionLeak = (text, block) => {
    const t = squash(text);
    if (t.length < 12) return false;                 // too short to judge; limbs decide
    if (squash(block).includes(t)) return false;     // written in this block -> real
    return solutionBody.includes(t);
  };

  const seen = new Set();
  const all = [];
  for (let i = 0; i < settled.length; i++) {
    const result = settled[i];
    if (!result) continue; // skipped block (timed out / failed) — keep the rest
    const bp = blockPrompts[i];
    const list = topUpMissingQuestions(bp, Array.isArray(result) ? result : result.questions);
    let cur = bp.shared;
    let headerDone = false;
    for (const q of list || []) {
      if (q && typeof q === 'object') {
        // Strip solution text out of the limbs too, then drop an entry whose
        // stem is a solution line (and, once its limbs are gone, has nothing
        // left to ask).
        if (Array.isArray(q.follow_ups)) {
          const stem = squash(q.text);
          q.follow_ups = q.follow_ups.filter((fu) => {
            const ft = squash(fu && fu.text);
            if (!ft) return false;              // an empty limb renders nothing
            if (stem && ft === stem) return false; // the stem repeated as its own part
            return !isSolutionLeak(fu && fu.text, bp.block);
          });
        }
        if (isSolutionLeak(q.text, bp.block)) {
          continue; // a line of the ANSWER, not a question of the exam
        }
        // A literature/extract group is printed as:
        //   "AUTHOR: Title"
        //   "Read the following extract carefully and answer Questions 5(c) and 5(d). <extract>"
        //   "(c) <question>"
        //   "(d) <question>"
        // The model is split about which of the first two lines is the "stem": it
        // sometimes returns the AUTHOR: Title line as text and buries every real
        // question in the limbs. AUTHOR: Title is a label, not a question — it
        // never ends in ? or a verb a student could act on — so when it lands as
        // the stem, promote the extract's own instruction line to the stem. The
        // questions already survive as limbs either way.
        if (q.type === 'theory' && Array.isArray(q.follow_ups) && q.follow_ups.length) {
          const stem = String(q.text || '').replace(/\s+/g, ' ').trim();
          const isLabel = stem.length > 0 && !/[?]/.test(stem) && /^[^:]{1,60}:\s*\S/.test(stem);
          if (isLabel && bp.block) {
            const m = String(bp.block).match(/(Read the following extract[^\n]*)/i);
            if (m && m[1] && squash(m[1]) !== squash(stem)) q.text = m[1].trim();
          }
        }
        // Attach passage/instructions to every question. Prefer the passage the
        // AI attached (first question of a group), then carry that forward to
        // the following questions of the group, and fall back to this block's
        // shared context so instructions are never lost even if the AI omitted
        // them. This is authoritative: students always see what they need.
        const p = q.passage && String(q.passage).trim();
        if (p) cur = p;
        if (!cur && bp.shared) cur = bp.shared;
        if (!q.passage || !String(q.passage).trim()) q.passage = cur;
        // The block's leading section header is prepended to its first
        // question, so each group keeps its section name.
        if (bp.header && !headerDone) {
          q.passage = q.passage ? bp.header + '\n' + q.passage : bp.header;
          headerDone = true;
        }
        // Splice deterministic answers from the paper's answer key onto the
        // matching question. The AI may already have used the key; this
        // overrides with the paper's own answer, which is authoritative.
        if (q.type === 'objective' && q.number != null) {
          const letter = answerMap[Number(q.number)];
          if (letter) {
            q.correct_answer = letter;
            const idx = optionLetterIndex(q.options, letter);
            if (idx >= 0) q.correct_index = idx;
          }
        }
      }
      const t = String((q && q.text) || '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
      // A gap-fill paper repeats the SAME carrier sentence for every blank
      // ("One can also watch videos of -34-, … -35- …"), so keying the dedupe
      // on the text alone silently deleted every later question that shared
      // its wording — Q35 vanished because Q34 said the same sentence. The
      // number is what makes two identically-worded entries different
      // questions, so it joins the key. An entry with no stem still has its
      // limbs to identify it and must be kept: the model folds a heading's
      // sub-questions under an empty heading, and dropping those threw the
      // real questions away.
      const limbs = Array.isArray(q && q.follow_ups) ? q.follow_ups : [];
      const limbKey = limbs
        .map((fu) => String((fu && fu.text) || '').replace(/\s+/g, ' ').trim().toLowerCase())
        .join('');
      const identity = t || (limbKey ? `limbs:${limbKey}` : '');
      if (identity) {
        const dedupeKey = `${q && q.type ? q.type : ''}|${Number(q && q.number) || 0}|${identity}`;
        if (!seen.has(dedupeKey)) {
          seen.add(dedupeKey);
          all.push(q);
          questionsByBlock[i].push(q);
        }
      }
    }
  }

  // Hand every figure and math marker to the question that kept it, with a
  // fallback to the first question of its block; then markers never leak into
  // stored text/passage/options whether or not any were attached.
  if (markersPresent || mathMarkersPresent) {
    const { unused, unusedMath } = attachMarkers(questionsByBlock, markersByBlock || blocks.map(() => []), mathByBlock || blocks.map(() => []));
    const warnings = [];
    if (unused.length) {
      warnings.push(`Detected ${unused.length} diagram(s) that could not be matched to a question - check them after import.`);
    }
    if (unusedMath.length) {
      warnings.push(`Detected ${unusedMath.length} math expression(s) that could not be matched to a question - check them after import.`);
    }
    if (warnings.length && onWarning) onWarning(warnings.join(' '));
  }
  for (const q of all) {
    q.text = stripMarkers(q.text);
    q.passage = stripMarkers(q.passage);
    if (Array.isArray(q.options)) q.options = q.options.map((o) => (typeof o === 'string' ? stripMarkers(o) : o));
  }
  // Fold "(a) / (b) / (c)" limbs back under the question that carries their
  // number, so they are delivered as 1a, 1b, 1c in one bubble instead of
  // being numbered 2, 3, 4 as questions of their own. Last, so every figure
  // has already been attached to the entry that holds it and travels up.
  return mergeSubQuestions(all);
}

// A numbered question line, e.g. "1. What is..." or "12) State...". Also
// matches a bare number on its own line (essay stems like "1." followed by a
// blank line then the prompt) and lettered sub-questions ("(a) According...",
// "(i) the mode of dressing"). Option lines ("A. ...") and section headers do
// not match.
const QUESTION_START =
  /^\s*(?:\d{1,3}\s*[.)](?:\s+\S|\s*$)|\(\s*[a-j]\s*\)(?:\s+\S|\s*$))/;

// ── Sub-questions ───────────────────────────────────────────────────────
//
// A paper spreads one numbered question over parts — "(a) Define…", "(b)
// Explain…", or "(i)…", "(ii)…". The extractor is asked for one entry per
// QUESTION, and the splitter counts every lettered line as a question start
// (QUESTION_START), so a model that follows the paper literally hands back
// each part as its own entry. Left alone, WhatsApp numbers them 1, 2, 3 and
// the student answers one limb per message — which is what "don't give the
// sub-questions their own question numbers" is about.
//
// The parts belong to the number that carries them, so they are folded back
// into that question here as `follow_ups` and later printed as 1a, 1b, 1c in
// the parent's own bubble.

// "(a) Define…" / "a) Define…" / "a. Define…" — the label must be closed by a
// paren or a separator, so prose that merely starts with a letter ("a
// phenomenon", "acid rain") never reads as a part.
const LETTER_PART = /^\s*(?:\(\s*)?([a-hA-H])(?:\s*\)|[.:-])\s*(?=\S)/;
// Roman limbs are matched apart from letters: "i" would otherwise read as the
// letter i and "(ii)" would not match at all.
const ROMAN_PART = /^\s*\(\s*(i{1,3}|iv|v)\s*\)\s*[.:-]?\s*(?=\S)/i;
const ROMANS = ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x'];

/** The part label a follow-up of this kind carries next, or null when the run is done. */
function nextSubLabel(kind, label) {
  if (kind === 'letter') {
    const next = String(label).toLowerCase().charCodeAt(0) + 1;
    return next <= 'h'.charCodeAt(0) ? String.fromCharCode(next) : null;
  }
  const i = ROMANS.indexOf(String(label).toLowerCase());
  return i >= 0 && i + 1 < ROMANS.length ? ROMANS[i + 1] : null;
}

/** `{kind, label, rest}` when the text opens with a part label, else null. */
function subLabelOf(text) {
  const s = String(text || '');
  const letter = s.match(LETTER_PART);
  if (letter) return { kind: 'letter', label: letter[1].toLowerCase(), rest: s.slice(letter[0].length).trim() };
  const roman = s.match(ROMAN_PART);
  if (roman) return { kind: 'roman', label: roman[1].toLowerCase(), rest: s.slice(roman[0].length).trim() };
  return null;
}

/** `follow_ups` in whatever shape it arrived, as a clean array. Never throws. */
function normalizeFollowUps(raw) {
  let value = raw;
  if (typeof value === 'string') {
    if (!value.trim()) return [];
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  return value
    .map((fu) => ({
      text: String((fu && fu.text) || '').trim(),
      marks: Number(fu && fu.marks) > 0 ? Number(fu.marks) : 0,
      difficulty: String((fu && fu.difficulty) || 'medium'),
    }))
    .filter((fu) => fu.text);
}

/**
 * Fold a question's parts back under the question that carries their number.
 *
 * Two signals, because models disagree about how to hand the parts over:
 *   1. the label run — the parent's next part is "(a)" then "(b)" then "(c)";
 *   2. the printed number — an entry the model re-issued under its parent's
 *      own number is that question's part even when it dropped the label.
 *
 * Only a numbered, label-free THEORY stem opens a run, so a passage's own
 * lettered comprehension questions (which have no numbered question above
 * them) are never collapsed into one another.
 */
function mergeSubQuestions(list) {
  const out = [];
  let parent = null;   // the question currently accepting parts
  let stage = null;    // null = closed, 'first' = any label, else {kind, label}

  const accepts = (q, part) => {
    if (!parent || parent.type !== 'theory' || q.type !== 'theory') return false;
    if (stage === 'first') return !!part;
    if (!stage || !part) return false;
    return stage.kind === part.kind && stage.label === part.label;
  };

  const sameNumber = (q) => {
    if (!parent || parent.type !== 'theory' || q.type !== 'theory') return false;
    const a = Number(parent.number);
    const b = Number(q.number);
    if (!a || !b || a !== b) return false;
    const sec = (x) => String((x && x.section) || '').trim();
    return sec(q) === sec(parent);
  };

  for (const q of Array.isArray(list) ? list : []) {
    if (!q || typeof q !== 'object') {
      out.push(q);
      parent = null;
      stage = null;
      continue;
    }
    const part = subLabelOf(q.text);
    if ((part && accepts(q, part)) || (!part && sameNumber(q))) {
      const parts = normalizeFollowUps(parent.follow_ups);
      parts.push({
        text: part ? part.rest : String(q.text || '').trim(),
        marks: Number(q.marks) > 0 ? Number(q.marks) : 0,
        difficulty: String(q.difficulty || 'medium'),
      });
      parent.follow_ups = parts;
      // The parts are read against the figure — a photo or diagram the model
      // handed to one of them travels up with the group, or the student is
      // asked to answer a question they cannot see.
      if (!parent.image && q.image) parent.image = q.image;
      if (parent.markerIndex == null && q.markerIndex != null) parent.markerIndex = q.markerIndex;
      if (q.figureIndices && q.figureIndices.length) {
        const figures = (parent.figureIndices = parent.figureIndices || []);
        for (const idx of q.figureIndices) if (!figures.includes(idx)) figures.push(idx);
      }
      if (part && stage === 'first') stage = { kind: part.kind, label: nextSubLabel(part.kind, part.label) };
      else if (part && stage) stage = { kind: stage.kind, label: nextSubLabel(stage.kind, stage.label) };
      if (stage && stage.label == null) stage = null; // ran past the last letter/roman
      // Its marks belong to the question now: a student answers the parts in
      // one message, so the question has to be worth what its parts add up to.
      const partsTotal = parts.reduce((sum, fu) => sum + (Number(fu.marks) || 0), 0);
      if (partsTotal > (Number(parent.marks) || 0)) parent.marks = partsTotal;
      continue;
    }

    out.push(q);
    // A label-free theory stem may open a run of parts; a question that is
    // itself lettered is a part of something that was never seen, so it stays
    // a question of its own (comprehension (a)–(f) with no number above them).
    parent = q.type === 'theory' && !part ? q : null;
    stage = parent ? 'first' : null;
  }
  return out;
}

// An answer-option line, e.g. "A. Accra", "B) Gold", "(C) Yes". Requires a
// real separator after the letter so a prose word like "Accra" or "Cape
// Coast" is not mistaken for an option.
const OPTION_START = /^\s*\(?[A-Da-d]\)?[.\-:\])]/;

// An instruction / context header line (e.g. "Section A: Comprehension",
// "Read the following passage below and answer questions 1 to 5", "Answer ONE
// question in this section", "Your answer should be between 250 and 300
// words"). These start a new context for the questions that follow, so the
// splitter breaks the document at them and each group keeps its own passage
// and instructions instead of inheriting the previous section's.
// Also matches French paper wording (English Language / French / Ghanaian
// Language comprehension sections), e.g. "Lisez le texte", "Répondez à toutes
// les questions", "Traduisez en anglais", "Écrivez une composition".
const CONTEXT_START =
  /^\s*(?:section\s*[A-Za-z0-9]|instruction|note\s*:|read\s+the|study\s+the|use\s+the|answer\s+all\s+(?:the\s+)?questions|answer\s+(?:any\s+)?(?:one|two|three)\s+(?:question|questions)|write\s+(?:an?\s+)?(?:essay|story|composition|letter)|your\s+answer\s+(?:should|must)|in\s+not\s+(?:less|more)\s+than|between\s+\d+\s+and\s+\d+\s+words|lisez\s+(?:le\s+)?(?:texte|passage)|lis\s+le\s+(?:texte|passage)|lisez\s+attentivement|r[ée]pondez?\s+(?:[àa]\s+)?toutes\s+les\s+questions|r[ée]pondez\s+aux\s+questions|r[ée]pondez\s+[àa]\s+toutes|traduis(?:ez)?\s+(?:en|into)|e?[çc]ri(?:vez|s|re)\s+(?:une|la)|compl[ée]tez|choisiss(?:ez|s))/i;

/**
 * Extract the run of trailing non-question lines from a block (passage text,
 * section headers). Answer-option lines belong to their question, so they are
 * NOT treated as trailing context: a reading passage that follows a group of
 * questions is carried to the next block, but Q5's own options stay with Q5.
 */
// A section/part/paper header — the line that means "something new starts
// here", so it is never part of the stem of the number above it.
const NEW_SECTION_LINE =
  /^\s*(?:part\s+[A-Za-z]|section\s+[A-Za-z0-9]|unit\s+[ivxIVX0-9]+|paper\s+\d|end of paper)\b/i;

function trailingContext(lines) {
  let i = lines.length;
  while (i > 0) {
    const line = lines[i - 1];
    if (QUESTION_START.test(line) || OPTION_START.test(line)) break;
    i--;
  }
  // A paper often prints the question NUMBER on its own line ("3.") and the
  // stem on the line after it. The walk above stops at the bare number — which
  // matches QUESTION_START — so the stem reads as "trailing context" and is
  // handed to the NEXT block, orphaning the number. The model is then asked to
  // fill a number that has no question, and it answers from the marking scheme
  // quoted in the prompt (or invents a stem), which is how one question becomes
  // a duplicate and another turns into a line of the ANSWER. Keep the stem with
  // its number: only a header/instruction that clearly starts something new is
  // allowed to travel forward.
  if (i > 0 && /^\s*\d{1,3}\s*[.)]\s*$/.test(lines[i - 1])) {
    while (i < lines.length && !lines[i].trim()) i++; // blank lines after the number
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim()) break;
      if (QUESTION_START.test(l) || CONTEXT_START.test(l) || NEW_SECTION_LINE.test(l)) break;
      i++;
    }
  }
  return lines.slice(i);
}

/**
 * Lines that open a numbered question ("1." / "2)" / "Q3.") — the paper's own
 * question numbering, counted WITHOUT its sub-questions: "(a) …" and "(i) …"
 * are parts of the numbered question above them, and the extractor folds them
 * into that question, so counting them here would make every well-parsed
 * theory paper look half-extracted.
 */
const NUMBERED_QUESTION_LINE = /^\s*(?:Q\s*)?\d{1,3}\s*[.)](?:\s+\S|\s*$)/i;

/**
 * Rough count of how many questions a document contains, based on the paper's
 * own question numbers ("1." / "2)" style) at line starts. Used to warn when
 * an import extracts far fewer questions than the paper clearly holds.
 */
function estimateQuestionCount(text) {
  const lines = String(text || '').split(/\r?\n/);
  return lines.filter((l) => NUMBERED_QUESTION_LINE.test(l)).length;
}

/** The same count for one block — how many questions this block must yield. */
function estimateNumberedQuestions(text) {
  return estimateQuestionCount(text);
}

/** Human-readable warning, or null when the extraction looks complete. */
function completenessWarning(estimate, extracted) {
  const count = Array.isArray(extracted) ? extracted.length : 0;
  if (estimate < 3 || count >= estimate) return null;
  // Warn when fewer questions were extracted than the document holds.
  // Threshold: anything under 90% of the paper, or more than 5 questions
  // missing outright. The 90% line is what "every question of an uploaded PDF
  // is imported" means in practice — a paper that lost a question or two of a
  // long list is not reported (unusual numbering and section furniture can
  // nudge the estimate), but a paper that lost a slice of itself always is.
  const ratio = count / estimate;
  const missing = estimate - count;
  if (ratio >= 0.9 && missing <= 5) return null;
  return `Extracted ${count} questions, but the document appears to contain ~${estimate}. Some questions (often the theory section) may have been missed.`;
}

/** Detect a leading passage/context run at the start of a block. */
function leadingContext(lines) {
  let i = 0;
  while (i < lines.length && !QUESTION_START.test(lines[i])) i++;
  return lines.slice(0, i);
}

/**
 * The first section/part/unit header line ("SECTION C", "PART B ORAL
 * LANGUAGE", "UNIT II") in a block's leading context, or '' if there is none.
 * Lifted out of the context and prepended to the block's first question so
 * each section keeps its name.
 */
function leadingSectionHeader(lines) {
  for (const line of lines) {
    const l = String(line || '').trim();
    if (/^\s*(?:part\s+[A-Za-z]|section\s+[A-Za-z0-9]|unit\s+[ivxIVX0-9]+)\b.*$/i.test(l)) {
      return l;
    }
  }
  return '';
}

/**
 * Find the 0-based index of the option whose letter prefix matches `letter`,
 * or -1 when none does. Options look like "A. Kumasi" / "(C) Yes" / "B) Gold".
 */
function optionLetterIndex(options, letter) {
  const want = String(letter || '').toUpperCase();
  const list = Array.isArray(options) ? options : [];
  for (let i = 0; i < list.length; i++) {
    const o = String(list[i] || '').trim();
    const m = o.match(/^\s*\(?\s*([A-Da-d])\s*[).:\-]\s*/);
    if (m && m[1].toUpperCase() === want) return i;
  }
  return -1;
}

/**
 * Split document text into blocks that only break BETWEEN questions (or at
 * section/instruction boundaries).
 *
 * Reading-comprehension papers put a passage (and instructions) in front of a
 * group of questions, and a fresh instruction line starts each new section
 * (e.g. "Read the following passage...", "Section B: Essay", "Answer ONE
 * question in this section"). Rules:
 *  - A block is never flushed before it contains its first question, so a
 *    leading passage always stays with the questions that follow it.
 *  - When a block is flushed, any trailing non-question lines (a passage or
 *    section instructions) travel WITH the next block, not the one being flushed.
 *  - A new instruction/context line after a question starts a fresh block, so
 *    the next group's passage and instructions become that block's leading
 *    context and are never glued onto the previous group.
 */
function splitIntoBlocks(text, perBlock = BLOCK_QUESTIONS, maxChars = BLOCK_MAX_CHARS) {
  const lines = text.split(/\r?\n/);
  const blocks = [];
  let cur = [];
  let qCount = 0;
  let totalChars = 0;
  const flush = () => {
    if (cur.length) {
      blocks.push(cur.join('\n'));
    }
    cur = [];
    qCount = 0;
    totalChars = 0;
  };
  const startNewBlock = () => {
    const ctx = trailingContext(cur);
    cur = cur.slice(0, cur.length - ctx.length);
    flush();
    cur = ctx; // passage / instructions lead the next block
    totalChars = ctx.reduce((s, l) => s + l.length + 1, 0);
  };
  for (const line of lines) {
    const isQuestion = QUESTION_START.test(line);
    const isContext = CONTEXT_START.test(line);
    const tooBig = qCount > 0 && totalChars + line.length >= maxChars;
    const tooMany = qCount >= perBlock;
    if (tooBig || tooMany) {
      if (isQuestion) startNewBlock();
    } else if (isContext && qCount > 0) {
      // New section / passage intro after some questions: break the block here
      // so the following questions keep their own context as leading text.
      startNewBlock();
    }
    cur.push(line);
    totalChars += line.length + 1;
    if (isQuestion) qCount++;
  }
  flush();
  // Post-process blocks: if the last line of a block does not end a sentence,
  // move it to the next block so questions are never split mid-sentence.
  for (let i = 0; i < blocks.length - 1; i++) {
    const blockLines = blocks[i].split('\n');
    const lastLine = blockLines[blockLines.length - 1].trim();
    if (lastLine && !/[.!?;:]\s*$/.test(lastLine) && !/^\d{1,3}\s*[.)]/.test(lastLine) && !/^\(?[A-Da-d]\)?[.\-:\])]/.test(lastLine)) {
      // Last line looks like a sentence fragment — move it to the next block
      const fragment = blockLines.pop();
      blocks[i] = blockLines.join('\n');
      const nextLines = blocks[i + 1].split('\n');
      nextLines.unshift(fragment);
      blocks[i + 1] = nextLines.join('\n');
    }
  }
  return blocks;
}

// ── Deterministic question parser (AI-free) ────────────────────────────
//
// The AI is the parser of record. This is the floor underneath it: it reads a
// block the way the paper is printed — a number opens a question, lettered
// lines are its options, "(a)"/"(i)" lines its parts — and returns the same
// shape the AI returns. It exists so that a block the model refuses (a
// timeout, a quota, a provider outage, a response too large to read) is still
// PARSED rather than dropped: an uploaded exam loses at most the model's
// wording, never its questions. It is also what tops up a block the model
// answered for only some of its numbered questions.

/** One line carrying several options: "A. one B. two C. three D. four". */
const OPTION_RUN = /(^|\s)\(?([A-H])\s*[).:-]\s*(?=\S)/g;
/** A numbered question line: "1. What is…", "Q2) State…", lone "1." stems. */
const LOCAL_NUMBERED = /^\s*(?:Q\s*)?(\d{1,3})\s*[.)]\s*(.*)$/i;
/** A lettered part of the numbered question above: "(a) Define…", "b) Give…". */
const LOCAL_PART = /^\s*(?:\(\s*)?([a-h])(?:\s*\)|[.:-])\s*(?=\S)(.*)$/;
/** A roman part: "(ii) Explain…". */
const LOCAL_ROMAN = /^\s*\(\s*(i{1,3}|iv|v)\s*\)\s*(.*)$/i;
/** A printed mark allocation: "[4 marks]", "(2 marks)", "5 marks". */
const MARKS_ON_LINE = /\[(\d+)\s*marks?\]|\((\d+)\s*marks?\)|\b(\d+)\s*marks?\b/i;
/** Section headers are structure, never question text. */
const LOCAL_SECTION_LINE = /^(?:section|part|unit|paper|objective|theory|answers?|marking\s+scheme)\s*[A-Za-z0-9]/i;

function marksOnLine(line) {
  const m = String(line || '').match(MARKS_ON_LINE);
  return m ? Number(m[1] || m[2] || m[3]) || 0 : 0;
}

/**
 * Split a line into the option strings it carries, or null when it is not an
 * option line. `{ prefix, options }` — the prefix is the stem the run hangs
 * on ("1. Which instrument measures current?").
 *
 * Options run in the paper's own order (A, B, C, D), and that ordering is the
 * whole check: a stem that happens to name a capital letter — "1. Ask Dr.
 * Smith about it? A. yes B. no" — reads D, A, B, which is not an option run
 * and is left alone as the sentence it is. A line that does not OPEN with an
 * option also has to show a full ordered run and a stem that has finished
 * speaking, so ordinary prose never parses into options.
 */
function splitOptionRun(line) {
  const text = String(line || '').trim();
  if (!text) return null;
  OPTION_RUN.lastIndex = 0;
  const hits = [];
  let m;
  while ((m = OPTION_RUN.exec(text))) {
    hits.push({ letter: m[2], at: m.index + m[1].length, textAt: OPTION_RUN.lastIndex });
  }
  if (!hits.length) return null;
  const startsLine = hits[0].at === 0;
  const ordered = () => {
    for (let i = 1; i < hits.length; i++) {
      if (hits[i].letter.charCodeAt(0) <= hits[i - 1].letter.charCodeAt(0)) return false;
    }
    return true;
  };
  if (!startsLine) {
    if (hits.length < 2 || !ordered()) return null;
    const stem = text
      .slice(0, hits[0].at)
      .replace(/^\s*(?:Q\s*)?\d{1,3}\s*[.)]\s*/i, '')
      .trim();
    if (stem && !/[.!?;:)\]]$/.test(stem)) return null;
  } else if (!ordered()) {
    return null;
  }
  const options = hits
    .map((h, i) => `${h.letter}. ${text.slice(h.textAt, i + 1 < hits.length ? hits[i + 1].at : text.length).trim()}`)
    .filter((o) => o.length > 3);
  if (!options.length || (hits.length > 1 && options.length < 2)) return null;
  return { prefix: startsLine ? '' : text.slice(0, hits[0].at), options };
}

/**
 * Parse a block of exam text into questions without any AI call.
 *
 * Returns the same question objects the extractor's prompt asks for, so a
 * recovered question flows through the rest of the import (answer keys,
 * figures, marking schemes, section grouping) exactly like a parsed one.
 * `section` is the block's own leading header, so recovered questions keep
 * the section they were printed under.
 */
function parseQuestionsLocally(text, section = '') {
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  let cur = null;

  const flush = () => {
    if (!cur) return;
    const stem = cur.stem.join(' ').replace(/\s+/g, ' ').trim();
    if (cur.options.length >= 2 && stem.length >= 2) {
      out.push({
        type: 'objective',
        number: cur.number,
        section,
        compulsory: false,
        text: stem,
        options: cur.options,
        correct_answer: '',
        correct_index: null,
        passage: '',
        marks: cur.marks || 1,
        difficulty: 'medium',
        learning_objective: '',
        explanation: '',
      });
      cur = null;
      return;
    }
    if (stem.length >= 2 && /[A-Za-z]{2}/.test(stem)) {
      const parts = cur.parts.filter((p) => p.text.trim());
      const partMarks = parts.map((p) => p.marks);
      let total;
      if (!parts.length) {
        total = cur.marks || 5;
      } else if (partMarks.some((v) => v > 0)) {
        total = partMarks.reduce((s, v) => s + v, 0);
      } else {
        // The paper printed no marks per part: give the question its default
        // and split it evenly, so a recovered question is still worth marks.
        total = cur.marks || 5;
        const base = Math.floor(total / parts.length);
        let rest = total - base * parts.length;
        for (let i = 0; i < parts.length; i++) {
          parts[i].marks = base + (rest > 0 ? 1 : 0);
          if (rest > 0) rest--;
        }
      }
      out.push({
        type: 'theory',
        number: cur.number,
        section,
        compulsory: false,
        text: stem,
        follow_ups: parts.map((p) => ({
          text: p.text.replace(/\s+/g, ' ').trim(),
          marks: p.marks,
        })),
        passage: '',
        marks: total,
        difficulty: 'medium',
        learning_objective: '',
        model_answer: '',
        key_points: [],
        rubric: [],
        presentation_marks: 0,
        grammar_marks: 0,
      });
    }
    cur = null;
  };

  const append = (chunk) => {
    const value = String(chunk || '').trim();
    if (!value || !cur) return;
    if (cur.target === 'stem') cur.stem.push(value);
    else if (cur.target.startsWith('part:')) cur.parts[Number(cur.target.slice(5))].text += ' ' + value;
    else {
      const i = Number(cur.target.slice(7));
      if (cur.options[i]) cur.options[i] = `${cur.options[i]} ${value}`;
    }
  };

  for (const raw of lines) {
    const line = String(raw || '').trim();
    if (!line) continue;

    const num = line.match(LOCAL_NUMBERED);
    const run = splitOptionRun(line);

    if (num && !(run && run.prefix === '')) {
      // A number opens a question — unless the line IS an option line, which
      // can only happen when it does not start with a digit.
      flush();
      const inline = run && run.prefix !== '' ? run : null;
      const stem = inline
        ? inline.prefix.replace(/^\s*(?:Q\s*)?\d{1,3}\s*[.)]\s*/i, '').trim()
        : num[2].trim();
      cur = {
        number: Number(num[1]),
        stem: stem ? [stem] : [],
        parts: [],
        options: inline ? [...inline.options] : [],
        marks: marksOnLine(line),
        target: 'stem',
      };
      cur.target = cur.options.length ? `option:${cur.options.length - 1}` : 'stem';
      continue;
    }

    if (run && run.prefix === '') {
      // A line that opens with an option extends the current question's run —
      // the paper prints each option on its own line (possibly wrapped).
      if (!cur) continue; // orphan options with no question above them
      cur.options.push(...run.options);
      cur.target = `option:${cur.options.length - 1}`;
      continue;
    }

    if (!cur) continue;              // leading context / headers: not a question

    if (LOCAL_SECTION_LINE.test(line)) continue;

    if (!cur.options.length) {
      const part = line.match(LOCAL_PART) || line.match(LOCAL_ROMAN);
      if (part && (cur.stem.join(' ').trim() || cur.parts.length)) {
        cur.parts.push({ text: part[2] ? part[2].trim() : '', marks: marksOnLine(line) });
        cur.target = `part:${cur.parts.length - 1}`;
        continue;
      }
    }
    append(line);
  }
  flush();
  return out;
}

/**
 * Cut a block in half at its own question boundaries, so a block the model
 * could not handle becomes two smaller asks. Returns [] when the block holds
 * fewer than two questions (nothing to halve) or when a half would be empty.
 */
function splitBlockInHalf(block) {
  const lines = String(block || '').split(/\r?\n/);
  const starts = [];
  for (let i = 0; i < lines.length; i++) if (QUESTION_START.test(lines[i])) starts.push(i);
  if (starts.length < 2) return [];
  const cut = starts[Math.floor(starts.length / 2)];
  const a = lines.slice(0, cut).join('\n').trim();
  const b = lines.slice(cut).join('\n').trim();
  return a && b ? [a, b] : [];
}

// ── Solutions / answer-key section handling ─────────────────────────────
//
// Papers routinely end with a solutions section ("Part A Solutions", "Part B
// — Model Solutions", "ANSWERS", "MARKING SCHEME", ...). Its lines match the
// question-start pattern ("1. B. with"), so if it is left in the parseable
// text it is parsed as fake questions, inflates the completeness estimate, and
// forces the AI to re-answer questions that the paper already answered — the
// main cause of slow, bloated PDF imports. The section is split OUT of the
// parseable text, the objective answers ("1. B", "2. D", ...) are spliced back
// onto their questions deterministically, and the model-solutions prose is
// offered to the AI as marking-scheme context.

// A solutions-section header line ("Part A Solutions", "Part B — Model
// Solutions", "ANSWER KEY", "ANSWERS", "MARKING SCHEME", ...). Anything from
// this line until the next "PAPER n" header (or the end of the document) is
// treated as solution content and removed from the parseable text.
const SOLUTION_HEADER =
  /^\s*(?:part\s+[a-z]+(?:\s+[a-z]+)*\s*(?:[-–—]\s*)?(?:model\s+)?(?:solutions?|answers?)|(?:model\s+)?solutions?|(?:answer\s*key|key)|answers?|marking\s+(?:scheme|guide)|suggested\s+answers?)\s*[:.\-]?\s*$/i;

// An objective answer line inside a solutions section, e.g. "1. B. with",
// "14. B. him then but would call him later", "21. B." → number 1 → letter B.
const ANSWER_KEY_LINE = /^\s*(\d{1,3})\s*[.)\-]\s+([A-Da-d])\s*(?:\.|\b)/;

// A "PAPER 2"-style boundary. A solutions section never swallows a following
// paper in a multi-paper document (e.g. a Paper 1 that ends with solutions and
// is followed by Paper 2 in the same upload).
const PAPER_HEADER = /^\s*paper\s+\d+\s*$/i;

/**
 * Split the answer-key / model-solutions sections out of a raw exam document.
 * Returns { cleanText, answerMap, answerKey, modelSolutions }:
 *  - cleanText: the document with every solutions section removed
 *  - answerMap: {questionNumber: 'A'|'B'|'C'|'D'} parsed from answer lines
 *  - answerKey: compact "1. B / 2. D / ..." text for the AI prompt
 *  - modelSolutions: the paper's own model answers / marking guidance (cleaned)
 */
function splitSolutionSections(text) {
  const lines = String(text || '').split(/\r?\n/);
  const answerMap = {};
  const modelParts = [];
  let inRun = false;
  let runIsModel = false;
  const kept = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (inRun) {
      // A new paper starts fresh content; the solutions section ends there.
      if (PAPER_HEADER.test(line)) {
        inRun = false;
        kept.push(raw);
        continue;
      }
      const m = line.match(ANSWER_KEY_LINE);
      if (m) {
        answerMap[Number(m[1])] = m[2].toUpperCase();
        continue; // answer lines are never parseable text
      }
      // Model-solutions prose is kept for the marking-scheme prompt; everything
      // else in a run (answer continuations, vertical watermark letters, bare
      // artifact numbers) is dropped.
      if (runIsModel && !/^[A-Za-z.]{1,3}$/.test(line) && !/^\d{1,3}\s*\.?\s*$/.test(line)) {
        modelParts.push(line);
      }
      continue;
    }
    if (SOLUTION_HEADER.test(line)) {
      inRun = true;
      runIsModel = /model\s+solutions?|marking\s+(?:scheme|guide)|suggested\s+answers?/i.test(line);
      continue; // the header line itself is dropped
    }
    kept.push(raw);
  }
  const cleanText = stripSourceWatermarks(kept.join('\n'));
  const modelSolutions = stripSourceWatermarks(modelParts.join('\n')).slice(0, 6000);
  const answerKey = Object.keys(answerMap)
    .sort((a, b) => Number(a) - Number(b))
    .map((n) => `${n}. ${answerMap[n]}`)
    .join('\n');
  return { cleanText, answerMap, answerKey, modelSolutions };
}

/** The parseable text of an exam document with watermark and solutions sections removed. */
function cleanExamText(text) {
  return splitSolutionSections(text).cleanText;
}

/** Find the answer-key section ("Answers: 1-B, 2-C ...") near the end of the doc. */
function extractAnswerKeySection(text) {
  return splitSolutionSections(text).answerKey;
}

/**
 * Find a marking scheme / model answers section (e.g. "MARKING SCHEME",
 * "MARKING GUIDE", "SUGGESTED ANSWERS", "MODEL ANSWERS", "SOLUTIONS"). Used to
 * reuse the paper's own rubric/model answers instead of regenerating them.
 */
function extractMarkingSchemeSection(text) {
  return splitSolutionSections(text).modelSolutions;
}

/**
 * Generate a marking scheme for a single theory question.
 */
async function generateTheoryScheme({ text, marks, difficulty }) {
  const system = examinerPrompt(SYSTEM_BASE + `
Create a marking scheme for a theory question. Return an object:
{
  "model_answer": "complete model answer a top student would give",
  "key_points": ["must-mention point 1", "point 2", ...],
  "rubric": [{"point": "key idea", "marks": 2, "explanation": "what earns these marks"}],
  "presentation_marks": 1,
  "grammar_marks": 1
}
Rules:
- Total scoring equals the question's marks (${marks || 5}). Adjust presentation/grammar marks to fit.
- Rubric points are specific and checkable.
`);

  return chatJSON([
    { role: 'system', content: system },
    {
      role: 'user',
      content: `Question (difficulty: ${difficulty || 'medium'}):\n${text}`,
    },
  ]);
}

/**
 * Determine the correct answers for objective questions that have no answer key.
 * questions: [{index, text, options:[{key,text}]}]
 * Returns: [{index, correct_index, explanation}]
 *
 * Answers the self-verification pass cannot CONFIRM come back with
 * correct_index: -1 — callers must leave the answer unset and flag the
 * question for review rather than store a guess that marks students wrong.
 *
 * The questions are answered in SMALL AI batches (the same strategy as PDF
 * extraction): a single request that must answer dozens of questions is slow,
 * easily truncated, and one failure loses every answer. Batching means a
 * flaky/slow endpoint loses only a handful of questions, never the whole paper.
 */
const ANSWER_BATCH = 15;
const ANSWER_CONCURRENCY = 12;
const ANSWER_TIMEOUT_MS = 3 * 60 * 1000;
const ANSWER_MAX_TOKENS = 3000;

async function answerObjectiveQuestions(questions, { skipVerify = false } = {}) {
  if (!questions.length) return [];
  const system = examinerPrompt(SYSTEM_BASE + `
For each question, determine the single correct answer option. Return:
{"answers":[{"index": 0, "correct_index": 2, "explanation": "short reason"}]}
Rules:
- correct_index is the 0-based index into the options array.
- CORRECTNESS IS NON-NEGOTIABLE: only pick an answer you are CERTAIN is correct. These keys are used to grade students, so a wrong key marks innocent students wrong.
- If a question is ambiguous, has more than one defensible answer, or you are not certain, set correct_index to -1 and explain why. NEVER guess.
- Pick the objectively correct answer only when exactly one option is clearly right.
- Provide a one-sentence explanation for each.
- COMPACT OUTPUT: keep explanations to a single short sentence. Output ONLY the JSON object.
`);

  const chunks = [];
  for (let i = 0; i < questions.length; i += ANSWER_BATCH) chunks.push(questions.slice(i, i + ANSWER_BATCH));

  const answerBatch = (chunk) => async () => {
    const user = chunk
      .map((q, i) => {
        const opts = (q.options || []).map((o, j) => {
          const text = typeof o === 'string' ? o : (o && (o.text ?? o.key)) || '';
          return `  ${j}. ${text}`;
        });
        return `Q${i} (index ${q.index}):\n${q.text}\nOptions:\n${opts.join('\n')}`;
      })
      .join('\n\n');
      for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await chatJSON(
          [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          { timeoutMs: ANSWER_TIMEOUT_MS, maxTokens: ANSWER_MAX_TOKENS, maxRetries: 0, temperature: 0.2 }
        );
        const byIndex = {};
        for (const a of result.answers || result) byIndex[a.index] = a;
        return chunk.map((q) => ({
          index: q.index,
          correct_index: byIndex[q.index] ? Number(byIndex[q.index].correct_index) : -1,
          explanation: byIndex[q.index]?.explanation || '',
        }));
      } catch (err) {
        if (attempt === 0) {
          await delay(500);
          continue;
        }
        console.error('[ai] answer batch skipped:', err.message);
        return chunk.map((q) => ({ index: q.index, correct_index: -1, explanation: '' }));
      }
    }
  };

  const settled = await mapLimit(chunks.map(answerBatch), ANSWER_CONCURRENCY, (run) => run());
  const byIndex = {};
  for (const batch of settled) for (const a of batch) byIndex[a.index] = a;

  // Self-verification pass: independently re-check every first-pass answer.
  // This is authoritative — a second look that cannot confirm an answer voids
  // it (correct_index: -1) so the question is flagged for review, not guessed.
  // Skip when skipVerify is true (e.g., answer key was already in the PDF).
  if (skipVerify) {
    return questions.map((q) => {
      const a = byIndex[q.index];
      return {
        index: q.index,
        correct_index: a ? Number(a.correct_index) : -1,
        explanation: a?.explanation || '',
      };
    });
  }
  const toVerify = questions
    .map((q) => ({ q, a: byIndex[q.index] }))
    .filter((x) => x.a && Number(x.a.correct_index) >= 0)
    .map((x) => ({ index: x.q.index, correct_index: x.a.correct_index, explanation: x.a.explanation || '' }));
  if (toVerify.length) {
    try {
      const verified = await verifyObjectiveAnswers(questions, toVerify);
      for (const v of verified) byIndex[v.index] = v;
    } catch (err) {
      // Verification failure keeps the first-pass answers; never fatal.
      console.error('[ai] objective answer verification failed (keeping first-pass answers):', err.message);
    }
  }

  return questions.map((q) => {
    const a = byIndex[q.index];
    return {
      index: q.index,
      correct_index: a ? Number(a.correct_index) : -1,
      explanation: a?.explanation || '',
    };
  });
}

/**
 * Determine the correct answer for a SINGLE objective question at answer time.
 * Used when a question reached a student with no stored answer key. One
 * question per call keeps latency low mid-exam. Returns correct_index: -1
 * when the examiner is not certain or the AI call fails — callers must never
 * store a guess that would mark innocent students wrong.
 */
async function resolveObjectiveAnswer({ questionText, passage, options = [] }) {
  const system = examinerPrompt(SYSTEM_BASE + `
For the single question below, determine the single correct answer option. Return:
{"correct_index": 2, "explanation": "one short sentence"}
Rules:
- correct_index is the 0-based index into the options array.
- CORRECTNESS IS NON-NEGOTIABLE: only pick an answer you are CERTAIN is correct.
- If the question is ambiguous, has more than one defensible answer, or you are not certain, set correct_index to -1 and explain why. NEVER guess.
- COMPACT OUTPUT: Output ONLY the JSON object.
`);
  const opts = options.map((o, j) => {
    const text = typeof o === 'string' ? o : (o && (o.text ?? o.key)) || '';
    return `  ${j}. ${text}`;
  });
  const user = [
    passage ? `PASSAGE:\n${passage}` : '',
    `QUESTION:\n${questionText}`,
    `Options:\n${opts.join('\n')}`,
  ].filter(Boolean).join('\n\n');

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await chatJSON(
        [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        { timeoutMs: ANSWER_TIMEOUT_MS, maxTokens: ANSWER_MAX_TOKENS, maxRetries: 0, temperature: 0.1 }
      );
      const idx = Number(result.correct_index);
      const valid = Number.isInteger(idx) && idx >= 0 && idx < options.length;
      return { correct_index: valid ? idx : -1, explanation: result.explanation || '' };
    } catch (err) {
      if (attempt === 0) {
        await delay(500);
        continue;
      }
      console.error('[ai] resolveObjectiveAnswer failed:', err.message);
      return { correct_index: -1, explanation: '' };
    }
  }
}

/**
 * Second-pass verification of AI-generated objective answers. Confirms each
 * answer against its question and options. Answers that cannot be confirmed
 * are returned with correct_index: -1 (never guessed).
 *
 * Runs in small AI batches (like answerObjectiveQuestions): a single request
 * that must verify dozens of answers is slow, easily truncated, and a lone
 * failure voids every answer.
 */
const VERIFY_BATCH = 10;

async function verifyObjectiveAnswers(questions, answers) {
  if (!answers.length) return [];
  const system = examinerPrompt(SYSTEM_BASE + `
You are verifying an exam answer key before it is used to grade students. For each question, confirm whether the proposed correct option is genuinely and unambiguously correct.
Return:
{"answers":[{"index": 0, "correct_index": 2, "confirmed": true}]}
Rules:
- confirmed must be true ONLY when the proposed answer is certainly correct AND every other option is clearly wrong.
- If the proposed answer is wrong, ambiguous, or you are not certain, set confirmed to false and correct_index to -1.
- A wrong key marks innocent students wrong, so when in doubt, do NOT confirm.
`);

  const chunks = [];
  for (let i = 0; i < answers.length; i += VERIFY_BATCH) chunks.push(answers.slice(i, i + VERIFY_BATCH));

  const verifyBatch = (chunk) => async () => {
    const user = chunk
      .map((a) => {
        const q = questions.find((qq) => qq.index === a.index);
        const opts = (q ? q.options : []).map((o, j) => {
          const text = typeof o === 'string' ? o : (o && (o.text ?? o.key)) || '';
          return `  ${j}. ${text}`;
        });
        return (
          `Q (index ${a.index}):\n${q ? q.text : '?'}\n` +
          `Options:\n${opts.join('\n') || '(none)'}\n` +
          `Proposed correct: index ${a.correct_index}\n` +
          `Reason given: ${a.explanation || ''}`
        );
      })
      .join('\n\n');
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await chatJSON(
          [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          { timeoutMs: ANSWER_TIMEOUT_MS, maxTokens: ANSWER_MAX_TOKENS, maxRetries: 0, temperature: 0.1 }
        );
        const byIndex = {};
        for (const v of result.answers || result) byIndex[v.index] = v;
        return chunk.map((a) => {
          const v = byIndex[a.index];
          const confirmed = !!(v && v.confirmed);
          return {
            index: a.index,
            correct_index: confirmed ? a.correct_index : -1,
            explanation: a.explanation || '',
          };
        });
      } catch (err) {
        if (attempt === 0) {
          await delay(500);
          continue;
        }
        console.error('[ai] verify batch skipped:', err.message);
        return chunk.map((a) => ({ index: a.index, correct_index: -1, explanation: a.explanation || '' }));
      }
    }
  };

  const settled = await mapLimit(chunks.map(verifyBatch), ANSWER_CONCURRENCY, (run) => run());
  const merged = [];
  for (const batch of settled) merged.push(...batch);
  return merged;
}

/**
 * Detect whether a theory answer was likely written or copied from an AI
 * assistant (ChatGPT, Gemini, Claude, ...). Returns { ai_generated, ai_reason }.
 * Conservative: when unsure, ai_generated is false (benefit of the doubt —
 * accusing a genuine student is worse than missing a cheater).
 */
async function detectAiGeneratedAnswer({ questionText, studentAnswer }) {
  const system = SYSTEM_BASE + `
You detect whether a student's theory exam answer was written by the student themselves or copied from an AI assistant (e.g. ChatGPT, Gemini, Claude).

Return exactly:
{"ai_generated": boolean, "ai_reason": "short explanation"}

Signs the answer was produced by an AI:
- Suspiciously perfect: no spelling or grammar errors at all, polished generic phrasing.
- Generic AI-typical vocabulary and structure ("In conclusion", "Moreover", "It is important to note", perfectly balanced paragraphs).
- Does not reflect the specific question's wording or a student's own reasoning and voice.
- Uniformly fluent, with no signs of the student's own working or genuine attempt.

Signs it was written by the student:
- Natural unevenness, personal wording, minor imperfections, first-person reasoning, concrete personal examples.
- The answer paraphrases the question or textbook in the student's own words.

Rules:
- Be CONSERVATIVE. Only set ai_generated=true when it is MORE LIKELY THAN NOT that the text was produced or copied from an AI.
- When in doubt, set ai_generated=false. Never decide based on the answer being correct or well-written alone.
`;

  const user = `QUESTION:\n${questionText}\n\nSTUDENT ANSWER:\n${studentAnswer}`;

  const result = await chatJSON(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    { temperature: 0.1 }
  );

  return {
    ai_generated: !!result.ai_generated,
    ai_reason: String(result.ai_reason || '').slice(0, 300),
  };
}

/**
 * Mark a theory answer delivered as a photo (written/drawn work). Vision
 * endpoints accept the image as an image_url content item. Called only when
 * config.ai.vision is enabled; text-only providers never reach this.
 */
async function markImageTheory({ questionText, passage, modelAnswer, keyPoints, rubric, presentationMarks, grammarMarks, maxMarks, studentAnswer, imageBase64 }) {
  // The gate must not be the chat primary's to give: grading a PHOTO of an
  // answer is a vision job, and a deployment running on nothing but
  // OPENAI_API_KEY can do it as well as the gateway can. Gating on chat
  // alone threw "AI is not configured" from the very feature the paid
  // account exists to serve.
  if (!aiConfigured() && !openaiConfigured()) {
    throw new AIError('AI is not configured. Set AI_API_KEY or OPENAI_API_KEY in .env to mark theory questions.');
  }
  const user = [
    'Grade the student attempt below against the model answer and rubric.',
    '',
    'QUESTION:',
    [passage, questionText].filter(Boolean).join('\n\n'),
    '',
    `MODEL ANSWER: ${modelAnswer || '(not available)'}`,
    keyPoints && keyPoints.length ? `KEY POINTS: ${keyPoints.join('; ')}` : 'KEY POINTS: (none)',
    rubric && rubric.length ? `RUBRIC: ${rubric.join('; ')}` : 'RUBRIC: (none)',
    `PRESENTATION MARKS: ${presentationMarks}`,
    `GRAMMAR MARKS: ${grammarMarks}`,
    `MAX MARKS: ${maxMarks}`,
    '',
    'STUDENT ATTEMPT (the attached photo of their written/drawn work):',
    studentAnswer ? `Caption: ${studentAnswer}` : '',
    '',
    'Return JSON with: marksAwarded (number, 0..maxMarks), breakdown (array of {criterion, marks, comment}), feedback (string for the student), aiGenerated (true only if the photo clearly contains AI-produced text).',
  ].filter((l) => typeof l === 'string').join('\n');

  const messages = [
    { role: 'system', content: SYSTEM_BASE + '\nYou grade written/drawn answers shown in photos, fairly and strictly per the rubric.' },
    {
      role: 'user',
      content: [
        { type: 'text', text: user },
        imageBase64
          ? { type: 'image_url', image_url: { url: `data:image/png;base64,${imageBase64}` } }
          : null,
      ].filter(Boolean),
    },
  ];
  // prefer: 'openai' — for the same reason figure vision leads with it: a
  // gateway model that cannot SEE answers this call with a plausible grade
  // for a photo it never read, while the account that can see sits unused.
  // The primary stays queued behind the paid account, so a deployment
  // without the key grades through the gateway exactly as before.
  return chatJSON(messages, { temperature: 0.2, prefer: 'openai' });
}

/**
 * Mark a theory answer against the scheme + rubric using AI.
 */
async function markTheory({ questionText, modelAnswer, keyPoints, rubric, presentationMarks, grammarMarks, maxMarks, studentAnswer, hasScheme }) {
  // When no scheme is available, use a simpler prompt that grades based on
  // general knowledge of the subject — instead of failing with 0 marks.
  if (!hasScheme) {
    const system = examinerPrompt(SYSTEM_BASE + `
You are marking a student's answer where NO MARKING SCHEME is available.
Grade based on your general knowledge of the subject and the question.
Assess correctness, completeness, relevance, and quality of explanation.

Return exactly:
{
  "marks_awarded": number,
  "max_marks": number,
  "breakdown": [{"criterion": "...", "marks": number, "comment": "..."}],
  "feedback": "2-3 sentences of constructive feedback",
  "ai_generated": boolean,
  "ai_reason": "short explanation"
}

Rules:
- marks_awarded MUST be between 0 and max_marks (${maxMarks}).
- Be fair and generous: award credit for correct, relevant content even if it differs from a specific textbook answer.
- Award partial marks for partially correct answers.
- Set ai_generated=true ONLY if the answer is clearly AI-generated (suspiciously perfect, generic AI phrasing).
`);
    const user = [
      `QUESTION:\n${questionText}`,
      `\nMAX MARKS: ${maxMarks}`,
      `\nSTUDENT ANSWER:\n${studentAnswer}`,
    ].join('\n');
    const result = await chatJSON([
      { role: 'system', content: system },
      { role: 'user', content: user },
    ], { temperature: 0.2 });
    return {
      marksAwarded: clamp(result.marks_awarded, maxMarks),
      maxMarks,
      breakdown: result.breakdown || [],
      feedback: (result.feedback || '') + ' [No marking scheme available — graded on general knowledge]',
      aiGenerated: !!result.ai_generated,
      aiReason: String(result.ai_reason || '').slice(0, 300),
    };
  }

  const system = examinerPrompt(SYSTEM_BASE + `
You are a strict but fair examiner. Mark a student's theory answer against the marking scheme.

Return exactly:
{
  "marks_awarded": number,
  "max_marks": number,
  "breakdown": [{"criterion": "...", "marks": number, "comment": "..."}],
  "feedback": "2-3 sentences of constructive feedback",
  "ai_generated": boolean,
  "ai_reason": "short explanation"
}

Rules:
- Award marks based on correctness, completeness, accuracy, relevance, use of keywords, and logical explanation.
- Award PARTIAL marks generously but fairly. Be consistent: if a rubric point is partially addressed, give partial marks.
- Presentation and grammar marks are awarded only if the writing is clear/organized and grammatically acceptable.
- marks_awarded MUST be an integer or half-integer between 0 and max_marks.
- AI-COPIED ANSWERS: Also assess whether the student answer was likely written or copied from an AI assistant (ChatGPT, Gemini, Claude). Set ai_generated=true ONLY when it is MORE LIKELY THAN NOT that it is AI-produced (suspiciously perfect, no errors, generic AI phrasing, no personal reasoning). When ai_generated is true, marks_awarded MUST be 0 and ai_reason must explain. When unsure, set ai_generated=false (benefit of the doubt).
`);

  const rubricText = Array.isArray(rubric) && rubric.length
    ? rubric.map((r, i) => `${i + 1}. ${r.point} (${r.marks} marks) ${r.explanation ? '- ' + r.explanation : ''}`).join('\n')
    : '(no per-point rubric)';

  const user = [
    `QUESTION:\n${questionText}`,
    `\nMODEL ANSWER:\n${modelAnswer || '(not provided)'}`,
    `\nKEY POINTS EXPECTED:\n${(keyPoints || []).join('\n') || '(none)'}`,
    `\nRUBRIC:\n${rubricText}`,
    `\nPRESENTATION MARKS AVAILABLE: ${presentationMarks || 0}`,
    `\nGRAMMAR MARKS AVAILABLE: ${grammarMarks || 0}`,
    `\nMAX MARKS: ${maxMarks}`,
    `\nSTUDENT ANSWER:\n${studentAnswer}`,
  ].join('\n');

  const result = await chatJSON(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    { temperature: 0.2 }
  );

  return {
    marksAwarded: clamp(result.marks_awarded, maxMarks),
    maxMarks,
    breakdown: result.breakdown || [],
    feedback: result.feedback || '',
    aiGenerated: !!result.ai_generated,
    aiReason: String(result.ai_reason || '').slice(0, 300),
  };
}

function clamp(n, max) {
  n = Math.round(Number(n) * 2) / 2;
  if (isNaN(n)) return 0;
  return Math.max(0, Math.min(n, max));
}

/**
 * Read a handwritten photo answer using the existing AI provider.
 * Tries every configured provider — the paid OpenAI account first (when set),
 * then primary, secondary, tertiary — since the primary model may not support
 * vision.
 */
async function readPhotoAnswer(imagePath, questionText) {
  if (!aiConfigured() && !openaiConfigured()) {
    throw new AIError('AI is not configured');
  }

  const fs = require('fs');
  const pathMod = require('path');
  const uploadsDir = require('../config').uploadsDir;

  const fullPath = (() => {
    // Confine reads to the uploads directory — reject absolute paths elsewhere
    // and any ../ escape in a relative name.
    const root = pathMod.resolve(uploadsDir);
    const resolved = pathMod.resolve(root, imagePath);
    if (resolved !== root && !resolved.startsWith(root + pathMod.sep)) {
      throw new AIError(`Image path outside uploads directory: ${imagePath}`);
    }
    return resolved;
  })();
  if (!fs.existsSync(fullPath)) {
    throw new AIError(`Image file not found: ${imagePath}`);
  }

  const imageBuffer = fs.readFileSync(fullPath);
  const ext = pathMod.extname(fullPath).toLowerCase().replace('.', '');
  const mimeType = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
  const base64 = imageBuffer.toString('base64');

  const messages = [
    {
      role: 'system',
      content: 'You are an exam answer reader. Read handwritten text from photos accurately and return ONLY the transcribed text.',
    },
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `Read EXACTLY what is written in this photo of a student's exam answer.

Question: ${questionText}

RULES:
- Return ONLY the student's actual answer text as written
- Do NOT correct spelling or grammar
- Do NOT summarize or paraphrase
- Do NOT add any explanation or prefix
- If the handwriting is unclear, transcribe what you can read and mark unclear parts with [?]
- If it's a drawing/diagram, describe what you see
- If you cannot read anything, return exactly: [unreadable]`,
        },
        {
          type: 'image_url',
          image_url: { url: `data:${mimeType};base64,${base64}` },
        },
      ],
    },
  ];

  const effectiveTimeout = Math.max(config.ai.timeoutMs, 60000);

  // Vision-capable providers ONLY — Nvidia Nemotron does NOT support image
  // inputs, so it must be skipped for photo reads.  OpenAI gpt-4o-mini and
  // gpt-4o both support vision natively.
  const providers = [];
  // The admin's own paid OpenAI account goes FIRST when it is configured: a
  // photo answer is the one read that cannot fall back to text, the gateway
  // primary is not guaranteed to be vision-capable, and a paid platform key
  // sitting unused while photos fail is exactly what OPENAI_API_KEY exists to
  // prevent. Every other provider stays behind it as fallback.
  if (openaiConfigured()) {
    providers.push({
      baseUrl: config.openai.baseUrl,
      apiKey: config.openai.apiKey,
      model: config.openai.visionModel,
      name: 'openai',
    });
  }
  providers.push(
    { baseUrl: config.ai.baseUrl, apiKey: config.ai.apiKey, model: config.ai.model, name: 'primary' },
  );
  // Only add secondary/tertiary if they look like vision-capable models
  if (secondaryConfigured() && !config.claude.model?.includes('nemotron')) {
    providers.push({ baseUrl: config.claude.baseUrl, apiKey: config.claude.apiKey, model: config.claude.model || config.ai.model, name: 'secondary' });
  }
  if (tertiaryConfigured()) {
    providers.push({ baseUrl: config.xai.baseUrl, apiKey: config.xai.apiKey, model: config.xai.model, name: 'tertiary' });
  }

  let lastErr;
  for (const p of providers) {
    try {
      console.log(`[ai] Trying ${p.name} provider (${p.model}) for photo read...`);
      const text = await callEndpointRaw({
        baseUrl: p.baseUrl,
        apiKey: p.apiKey,
        model: p.model,
        messages,
        temperature: 0.1,
        maxTokens: 1000,
        timeoutMs: effectiveTimeout,
      });
      console.log(`[ai] Photo read via ${p.name}: "${text.slice(0, 150)}..."`);
      return text.trim();
    } catch (err) {
      console.error(`[ai] ${p.name} provider failed for photo read: ${err.message}`);
      lastErr = err;
    }
  }

  // Fallback: Puter.js vision (GPT-4o-mini) — always supports vision
  if (puterConfigured()) {
    try {
      const puter = require('./puter');
      console.log('[ai] Trying Puter.js vision for photo read...');
      const puterText = await puter.readPhotoAnswer(imagePath, questionText);
      if (puterText && puterText !== '[unreadable]') {
        console.log(`[ai] Photo read via puter.js: "${puterText.slice(0, 150)}..."`);
        return puterText.trim();
      }
    } catch (err) {
      console.error(`[ai] Puter.js vision failed: ${err.message}`);
    }
  }

  throw lastErr || new AIError('All providers failed for photo read');
}

/**
 * Ask the configured vision model where the figures are on ONE rendered exam
 * page. This is a rescue, never a source: the page has already been scanned
 * geometrically and came back empty, while the page text tells a student to
 * "study the diagram above" — so something printed is there that the path
 * scanner did not assemble. The model is asked only to POINT at what is
 * already on the page; it never writes, redraws or describes a figure, so the
 * worst it can do is hand back a box we then validate.
 *
 * Returns pixel boxes at the handed-in page size, or [] when vision is off,
 * the provider is missing, the model is unsure, or nothing passes validation.
 */
async function locateFigures({ imageBase64, mimeType = 'image/png', pageWidth, pageHeight, hint = '' }) {
  // AI_VISION on, and a provider that can SEE — the chat primary or the paid
  // OpenAI account alone. Gating on the chat primary alone is why a paid key
  // with no gateway produced no figures at all.
  if (!visionConfigured() || !imageBase64) return [];
  if (!(pageWidth > 0) || !(pageHeight > 0)) return [];
  // Read the export so tests can stub it, as extractQuestionsFromText does.
  const chatJSON = module.exports.chatJSON;

  const system =
    'You locate printed figures on exam pages. You never create, redraw or ' +
    'describe them — you only report where an existing one is. Answer with JSON only.';
  const user = [
    'This is one page of a school exam paper. Return the bounding boxes of every FIGURE on it:',
    'a diagram, labelled drawing, graph, chart, map, photograph or illustration.',
    '',
    'Do NOT box: tables of numbers/words, blocks of question text, headers, footers,',
    'school crests, stamps, page numbers, or ruled lines on their own.',
    '',
    'Return JSON exactly like {"figures":[{"x":0.12,"y":0.30,"w":0.45,"h":0.22}]}',
    'with x, y, w, h as fractions of the page (0 to 1), origin at the TOP-LEFT,',
    'x/y the top-left corner of the box, w/h its size. Keep the box tight around the',
    'figure and its own labels, not the question text around it.',
    'If the page has no figure, return {"figures":[]}.',
    hint ? `\nThe page text that refers to a figure reads:\n${hint}` : '',
  ].join('\n');

  let result;
  try {
    result = await chatJSON(
      [
        { role: 'system', content: system },
        {
          role: 'user',
          content: [
            { type: 'text', text: user },
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
          ],
        },
      ],
      // prefer: 'openai' — the paid account's vision model leads, the chat
      // primary waits behind it. A gateway model that cannot read an image
      // used to answer this call with "no figures" and lose the page's
      // diagram for good, while the account the admin pays for sat unused.
      { temperature: 0, maxRetries: 1, maxTokens: 1200, prefer: 'openai' }
    );
  } catch (err) {
    console.warn('[ai] figure localisation failed', { error: err && err.message });
    return [];
  }

  const raw = (Array.isArray(result) ? result : result && (result.figures || result.boxes)) || [];
  const boxes = [];
  for (const b of raw) {
    if (!b || typeof b !== 'object') continue;
    const nums = ['x', 'y', 'w', 'h'].map((k) => Number(b[k]));
    if (!nums.every((n) => Number.isFinite(n))) continue;
    let [x, y, w, h] = nums;
    // Models answer in fractions or in pixels; accept both rather than throw
    // away a correct answer over its units.
    const fractional = Math.max(x + w, y + h) <= 1.001;
    if (fractional) { x *= pageWidth; y *= pageHeight; w *= pageWidth; h *= pageHeight; }
    x = Math.max(0, Math.round(x));
    y = Math.max(0, Math.round(y));
    w = Math.round(w);
    h = Math.round(h);
    if (x + w > pageWidth) w = pageWidth - x;
    if (y + h > pageHeight) h = pageHeight - y;
    if (w < 8 || h < 8) continue;
    // Area floors: under this it is a fleck of ink; over it the "figure" is the
    // page itself (a frame, a scan of the whole sheet, or the model giving up
    // and boxing everything). Both would be handed to a student as a diagram.
    const area = (w * h) / (pageWidth * pageHeight);
    if (area < 0.005 || area > 0.45) continue;
    boxes.push({ x, y, w, h });
  }
  return boxes;
}

/**
 * ONE attempt at an OpenAI-compatible /audio/transcriptions endpoint.
 * Returns the trimmed transcript or throws — the caller decides whether the
 * next provider gets a turn. Shared by every speech provider below so the
 * paid account and a dedicated key run the exact same request shape.
 */
async function whisperTranscribe({ baseUrl, apiKey, model }, audioBuffer, { ext, mimeType, prompt, timeoutMs }) {
  // Node 18+ has built-in FormData and Blob
  const formData = new FormData();
  const blob = new Blob([audioBuffer], { type: mimeType });
  formData.append('file', blob, `audio.${ext}`);
  formData.append('model', model);
  formData.append('language', 'en');
  formData.append('response_format', 'text');
  formData.append('prompt', prompt);

  const controller = new AbortController();
  const res = await withHardTimeout(
    fetch(`${baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: formData,
      signal: controller.signal,
    }),
    timeoutMs,
    () => controller.abort()
  );
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new AIError(`transcription endpoint returned ${res.status}: ${errText.slice(0, 200)}`);
  }
  const text = await res.text();
  // A 200 with an empty body means the endpoint accepted the file but could
  // not decode it. Falling through to input_audio would then try a chat model,
  // which on a gateway answers 200 with no transcript too.
  if (!text || !text.trim() || text.trim() === '[inaudible]') {
    throw new AIError(`${model} returned an empty transcript`);
  }
  return text.trim();
}

/**
 * Transcribe an audio file (voice message) to text.
 * Strategy 1: speech providers in order — a dedicated key, then the paid
 * OpenAI account; then provider chat endpoints with input_audio; then Gemini
 * native.
 */
async function transcribeAudio(audioPath, questionText) {
  // Entry depends on EITHER provider, not the chat one: audio can be fully
  // transcribable by a speech endpoint even while the chat provider is
  // missing or misconfigured, and gating on chat alone would reject that.
  // The paid OpenAI account counts as speech configured too — its Whisper is
  // a speech endpoint by definition, and it is the only provider that can
  // answer when the dedicated key is the thing that is broken.
  const sttConfigured = !!(config.aiTranscribe && config.aiTranscribe.enabled && config.aiTranscribe.apiKey)
    || !!(config.openai && config.openai.apiKey);
  if (!sttConfigured && !aiConfigured()) {
    throw new AIError(
      'No provider configured for audio transcription. Set OPENAI_API_KEY (a paid ' +
      'OpenAI platform key — Whisper comes with it) or AI_TRANSCRIBE_API_KEY to a ' +
      'speech-to-text endpoint, or configure a chat provider.'
    );
  }

  const fs = require('fs');
  const pathMod = require('path');

  const fullPath = pathMod.isAbsolute(audioPath) ? audioPath : pathMod.join(require('../config').uploadsDir, audioPath);
  if (!fs.existsSync(fullPath)) {
    throw new AIError(`Audio file not found: ${audioPath}`);
  }

  const audioBuffer = fs.readFileSync(fullPath);
  const ext = pathMod.extname(fullPath).toLowerCase().replace('.', '');
  const mimeType = ext === 'mp3' ? 'audio/mpeg' : ext === 'wav' ? 'audio/wav' : 'audio/ogg';
  const base64 = audioBuffer.toString('base64');

  const prompt = `Transcribe EXACTLY what the student says in this audio recording of their exam answer. This is a voice note sent via WhatsApp for an exam question.

Question: ${questionText}

RULES:
- Return ONLY the student's actual spoken answer as plain text
- Do NOT correct spelling or grammar
- Do NOT summarize or paraphrase
- Do NOT add any explanation, prefix, or JSON formatting
- If the audio is unclear, transcribe what you can hear and mark unclear parts with [?]
- If you cannot hear anything or the audio is empty, return exactly: [inaudible]`;

  const effectiveTimeout = Math.max(config.ai.timeoutMs, 60000);

  // ── Strategy 1: speech-to-text providers, in order ─────────────────────
  // Independent of the chat primary on purpose: a chat gateway usually has no
  // speech model, and `input_audio` against one returns 200 with no transcript,
  // which is indistinguishable from silence. Failing loudly here is what keeps
  // a broken STT setup from grading a voice note as blank.
  const dedicatedStt = !!(config.aiTranscribe && config.aiTranscribe.enabled && config.aiTranscribe.apiKey);
  // The paid OpenAI account IS a speech provider (Whisper), so it gets its
  // own attempt whenever Strategy 1 was not already it. Without this, a
  // dedicated key that fails — wrong key, wrong base URL, expired credit —
  // left only chat `input_audio` behind it, which a gateway answers with
  // silence: every voice note was flagged for manual review while the paid
  // key the admin already pays for sat unused. Skipping when Strategy 1 was
  // literally this account (same key, same base URL — how config.js wires
  // OPENAI_API_KEY into aiTranscribe) keeps one account from being billed
  // twice for the same file.
  const paidOpenaiStt = !!(config.openai && config.openai.apiKey);
  const paidAlreadyTried = dedicatedStt
    && config.aiTranscribe.apiKey === config.openai.apiKey
    && config.aiTranscribe.baseUrl === config.openai.baseUrl;
  if (dedicatedStt) {
    try {
      console.log(`[ai] Transcribing audio via ${config.aiTranscribe.model} at ${config.aiTranscribe.baseUrl}...`);
      const text = await whisperTranscribe(config.aiTranscribe, audioBuffer, {
        ext, mimeType, prompt: questionText, timeoutMs: effectiveTimeout,
      });
      console.log(`[ai] Audio transcribed via ${config.aiTranscribe.model}: "${text.slice(0, 150)}..."`);
      return text;
    } catch (err) {
      console.warn(`[ai] Transcribe API failed: ${err.message}`);
    }
  }
  if (paidOpenaiStt && !paidAlreadyTried) {
    // whisper-1, not AI_TRANSCRIBE_MODEL: that setting names the DEDICATED
    // provider's model (often a Groq/local spelling OpenAI does not have),
    // and the paid account's own endpoint only takes OpenAI's.
    try {
      console.log(`[ai] Transcribing audio via the paid OpenAI account (whisper-1) at ${config.openai.baseUrl}...`);
      const text = await whisperTranscribe(
        { baseUrl: config.openai.baseUrl, apiKey: config.openai.apiKey, model: 'whisper-1' },
        audioBuffer,
        { ext, mimeType, prompt: questionText, timeoutMs: effectiveTimeout }
      );
      console.log(`[ai] Audio transcribed via openai (whisper-1): "${text.slice(0, 150)}..."`);
      return text;
    } catch (err) {
      console.warn(`[ai] Paid OpenAI transcription failed: ${err.message}`);
    }
  }
  if (!dedicatedStt && !paidOpenaiStt) {
    console.warn(
      '[ai] No speech-to-text provider configured (set OPENAI_API_KEY or AI_TRANSCRIBE_API_KEY). ' +
      'Voice notes cannot be transcribed - they will be flagged for manual review.'
    );
  }

  // ── Strategy 2: Provider chat endpoints with input_audio ──────────────
  const providers = [
    { name: 'primary', baseUrl: config.ai.baseUrl, apiKey: config.ai.apiKey, model: config.ai.model },
  ];
  if (secondaryConfigured()) {
    providers.push({ name: 'secondary', baseUrl: config.claude.baseUrl, apiKey: config.claude.apiKey, model: config.claude.model || config.ai.model });
  }
  if (tertiaryConfigured()) {
    providers.push({ name: 'tertiary', baseUrl: config.xai.baseUrl, apiKey: config.xai.apiKey, model: config.xai.model });
  }

  let lastErr;
  for (const p of providers) {
    try {
      // Detect Gemini and use native API for audio
      if (p.baseUrl.includes('generativelanguage.googleapis.com')) {
        const nativeUrl = `https://generativelanguage.googleapis.com/v1beta/models/${p.model}:generateContent`;
        const body = {
          contents: [{
            parts: [
              { text: prompt },
              { inlineData: { mimeType, data: base64 } },
            ],
          }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 2048 },
        };
        const controller = new AbortController();
        const res = await withHardTimeout(
          fetch(nativeUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': p.apiKey },
            body: JSON.stringify(body),
            signal: controller.signal,
          }),
          effectiveTimeout,
          () => controller.abort(),
        );
        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          throw new AIError(`Gemini audio API failed (${res.status}): ${errText.slice(0, 200)}`);
        }
        const data = await res.json().catch(() => { throw new AIError('Gemini returned a non-JSON response'); });
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        if (!text || text === '[inaudible]') {
          throw new AIError('Audio transcription returned empty or inaudible');
        }
        console.log(`[ai] Audio transcribed via Gemini native: "${text.slice(0, 150)}..."`);
        return text.trim();
      }

      // Non-Gemini providers: try OpenAI-compatible endpoint with base64 audio
      const audioFormat = ext === 'mp3' ? 'mp3' : ext === 'wav' ? 'wav' : 'ogg';
      const messages = [
        { role: 'system', content: 'You are an exam answer transcriber. Transcribe spoken audio answers accurately and return ONLY the transcribed text.' },
        { role: 'user', content: [
          { type: 'text', text: prompt },
          { type: 'input_audio', input_audio: { data: base64, format: audioFormat } },
        ] },
      ];
      const result = await callEndpointRaw({
        baseUrl: p.baseUrl,
        apiKey: p.apiKey,
        model: p.model,
        messages,
        temperature: 0.1,
        maxTokens: 2048,
        timeoutMs: effectiveTimeout,
      });
      const text = typeof result === 'string' ? result : '';
      if (!text || text === '[inaudible]') {
        throw new AIError('Audio transcription returned empty or inaudible');
      }
      console.log(`[ai] Audio transcribed via ${p.name}: "${text.slice(0, 150)}..."`);
      return text.trim();
    } catch (err) {
      console.error(`[ai] ${p.name} provider failed for audio transcription: ${err.message}`);
      lastErr = err;
    }
  }
  // The raw error from the input_audio path ("no choices in payload") says
  // nothing useful to whoever has to fix it. When no speech provider is
  // configured, name the actual cause: chat providers on a gateway answer 200
  // with no transcript, so this endpoint is not a viable transcription path.
  if (lastErr && !(config.aiTranscribe && config.aiTranscribe.enabled)) {
    throw new AIError(
      'Audio transcription failed and no speech-to-text provider is configured. ' +
      'Set AI_TRANSCRIBE_API_KEY - a chat gateway (AshnaAI, OpenRouter, Groq chat ' +
      'models) cannot transcribe audio, so the input_audio fallback cannot work either. ' +
      `Underlying error: ${lastErr.message}`
    );
  }
  throw lastErr || new AIError('All providers failed for audio transcription');
}

module.exports = {
  AIError,
  aiConfigured,
  openaiConfigured,
  visionConfigured,
  chatJSON,
  mapLimit,
  batchConcurrencyFor,
  batchLaunchStaggerMs,
  providerCooldownMs,
  resetCircuitBreakers,
  isProviderAvailable,
  recordProviderFailure,
  isReasoningModel,
  EXAMINER_PERSONA,
  examinerPrompt,
  generateQuestions,
  getHistoricalQuestions,
  logGeneratedQuestions,
  deduplicateAgainstHistory,
  extractQuestionsFromText,
  mergeSubQuestions,
  normalizeFollowUps,
  answerObjectiveQuestions,
  resolveObjectiveAnswer,
  verifyObjectiveAnswers,
  detectAiGeneratedAnswer,
  generateTheoryScheme,
  markImageTheory,
  locateFigures,
  markTheory,
  splitIntoBlocks,
  leadingContext,
  leadingSectionHeader,
  trailingContext,
  estimateQuestionCount,
  estimateNumberedQuestions,
  parseQuestionsLocally,
  splitBlockInHalf,
  completenessWarning,
  parseStats,
  splitSolutionSections,
  cleanExamText,
  extractAnswerKeySection,
  extractMarkingSchemeSection,
  attachMarkers,
  parseJSON,
  repairTruncatedJSON,
  readPhotoAnswer,
  transcribeAudio,
  generateDiagram,
  generateFollowUpQuestions,
  shouldHaveDiagram,
  selectDiagramType,
};

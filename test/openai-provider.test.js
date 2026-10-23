'use strict';
// The admin's own PAID OpenAI account (OPENAI_API_KEY) lights up the three
// features a chat gateway cannot serve: Whisper transcription for voice
// notes, a vision-capable model asked FIRST for photo answers, and a chat
// FALLBACK when the primary provider fails. One key, all three — and with no
// key the app behaves exactly as before.
//
// Config is read at load, so each config case is a FRESH load with only its
// own variables set (the way a Render deploy sees them). No network: every
// fetch is stubbed.
require('./helpers/isolate');

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const config = require('../src/config');
const ai = require('../src/services/ai');

// ── config wiring: one key, both features ──────────────────────────────

const CONFIG_PATH = require.resolve('../src/config');
const sharedConfig = require.cache[CONFIG_PATH];

/** Reload src/config with only `env` set, then put the shared module back. */
function loadConfig(env) {
  const savedEnv = { ...process.env };
  try {
    for (const key of Object.keys(process.env)) {
      if (/^(AI_|OPENAI_|CLAUDE_|XAI_)/.test(key)) delete process.env[key];
    }
    Object.assign(process.env, env);
    delete require.cache[CONFIG_PATH];
    return require('../src/config');
  } finally {
    delete require.cache[CONFIG_PATH];
    require.cache[CONFIG_PATH] = sharedConfig;
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  }
}

test('OPENAI_API_KEY alone enables Whisper transcription and photo vision', () => {
  const fresh = loadConfig({ OPENAI_API_KEY: 'sk-live-openai-test' });

  assert.equal(fresh.aiTranscribe.enabled, true, 'the paid key alone is enough for voice notes');
  assert.equal(fresh.aiTranscribe.apiKey, 'sk-live-openai-test');
  assert.equal(fresh.aiTranscribe.baseUrl, 'https://api.openai.com/v1', 'transcription goes to OpenAI itself');
  assert.equal(fresh.aiTranscribe.model, 'whisper-1');

  assert.equal(fresh.openai.apiKey, 'sk-live-openai-test');
  assert.equal(fresh.openai.visionModel, 'gpt-4o-mini', 'photo answers default to a vision-native model');
  assert.equal(fresh.openai.baseUrl, 'https://api.openai.com/v1');
});

test('a dedicated transcribe key wins over the paid OpenAI account', () => {
  const fresh = loadConfig({
    AI_TRANSCRIBE_API_KEY: 'sk-dedicated-stt',
    OPENAI_API_KEY: 'sk-live-openai-test',
  });
  assert.equal(fresh.aiTranscribe.apiKey, 'sk-dedicated-stt', 'an explicit AI_TRANSCRIBE_API_KEY is never overridden');
  assert.equal(fresh.openai.apiKey, 'sk-live-openai-test', 'and the OpenAI account still owns photo answers');
});

test('a gateway chat key never becomes a speech key', () => {
  const fresh = loadConfig({
    AI_BASE_URL: 'https://api.ashna.ai/v1/api',
    AI_API_KEY: 'gateway-chat-key',
  });
  assert.equal(
    fresh.aiTranscribe.enabled, false,
    'a chat gateway has no speech model behind it — audio must not be sent there'
  );
});

test('chat pointed at OpenAI itself still feeds transcription', () => {
  const fresh = loadConfig({ AI_BASE_URL: 'https://api.openai.com/v1', AI_API_KEY: 'sk-chat-openai-test' });
  assert.equal(fresh.aiTranscribe.enabled, true, 'when chat IS OpenAI, its key is a real speech key');
  assert.equal(fresh.aiTranscribe.apiKey, 'sk-chat-openai-test');
});

// ── the runtime paths that consume that config ─────────────────────────

const WAV = path.join(os.tmpdir(), `openai-stt-${process.pid}.wav`);
// A 16-bit mono 8kHz WAV header with no samples: transcribeAudio reads the
// bytes into a multipart body and never decodes the audio.
fs.writeFileSync(WAV, Buffer.from('RIFF$' + '0'.repeat(36), 'binary'));
after(() => { try { fs.unlinkSync(WAV); } catch { /* best effort */ } });

test('voice notes reach Whisper through the paid OpenAI account', async () => {
  // The very block a fresh OPENAI_API_KEY load produces, handed to the runtime
  // config — this is the chain: one env key → aiTranscribe → /audio/transcriptions.
  const openaiTranscribe = loadConfig({ OPENAI_API_KEY: 'sk-live-openai-test' }).aiTranscribe;
  const savedTranscribe = config.aiTranscribe;
  const savedBase = config.ai.baseUrl;
  const savedFetch = global.fetch;
  const calls = [];
  try {
    config.aiTranscribe = openaiTranscribe;
    config.ai.baseUrl = '';
    global.fetch = async (url, init) => {
      calls.push({ url: String(url), headers: (init && init.headers) || {} });
      return { ok: true, status: 200, text: async () => 'the mitochondrion', json: async () => ({}) };
    };

    const text = await ai.transcribeAudio(WAV, 'What is the powerhouse of the cell?');

    assert.equal(text, 'the mitochondrion');
    assert.equal(calls.length, 1, 'the speech endpoint answered on the first try');
    assert.equal(calls[0].url, 'https://api.openai.com/v1/audio/transcriptions');
    assert.equal(calls[0].headers.Authorization, 'Bearer sk-live-openai-test');
  } finally {
    global.fetch = savedFetch;
    config.aiTranscribe = savedTranscribe;
    config.ai.baseUrl = savedBase;
  }
});

const PHOTO = 'openai-photo-read.png';
fs.writeFileSync(path.join(config.uploadsDir, PHOTO), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));

/** Put the shared config into the shape each photo case needs, then restore. */
function withProviders(overrides, fn) {
  const saved = { openai: config.openai, ai: { ...config.ai } };
  config.openai = overrides.openai || { baseUrl: 'https://api.openai.com/v1', apiKey: '', visionModel: 'gpt-4o-mini' };
  config.ai.baseUrl = overrides.chatBase || '';
  config.ai.apiKey = overrides.chatKey || '';
  config.ai.model = overrides.chatModel || 'gpt-5-mini';
  return fn().finally(() => {
    config.openai = saved.openai;
    config.ai.baseUrl = saved.ai.baseUrl;
    config.ai.apiKey = saved.ai.apiKey;
    config.ai.model = saved.ai.model;
  });
}

const visionReply = (content) => ({
  ok: true, status: 200,
  json: async () => ({ choices: [{ message: { content } }] }),
});

test('photo answers are read by the paid OpenAI account first', async () => {
  const savedFetch = global.fetch;
  const calls = [];
  try {
    global.fetch = async (url, init) => {
      calls.push({ url: String(url), body: init && init.body });
      return visionReply('the answer written on the paper');
    };
    await withProviders({
      openai: { baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-live-openai-test', visionModel: 'gpt-4o-mini' },
      chatBase: 'https://api.ashna.ai/v1/api', chatKey: 'gateway-chat-key', chatModel: 'gpt-5-mini',
    }, async () => {
      const text = await ai.readPhotoAnswer(PHOTO, 'What is 2 + 2?');
      assert.equal(text, 'the answer written on the paper');
      assert.equal(calls.length, 1, 'the paid account answered, so no other provider is billed');
      assert.equal(calls[0].url, 'https://api.openai.com/v1/chat/completions');
      assert.equal(JSON.parse(calls[0].body).model, 'gpt-4o-mini');
    });
  } finally {
    global.fetch = savedFetch;
  }
});

test('a failed OpenAI photo read falls through to the other providers', async () => {
  const savedFetch = global.fetch;
  const calls = [];
  try {
    global.fetch = async (url) => {
      const u = String(url);
      calls.push(u);
      if (u.includes('api.openai.com')) return { ok: false, status: 401, text: async () => 'invalid api key' };
      return visionReply('read by the fallback');
    };
    await withProviders({
      openai: { baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-live-openai-test', visionModel: 'gpt-4o-mini' },
      chatBase: 'https://api.ashna.ai/v1/api', chatKey: 'gateway-chat-key', chatModel: 'gpt-5-mini',
    }, async () => {
      const text = await ai.readPhotoAnswer(PHOTO, 'What is 2 + 2?');
      assert.equal(text, 'read by the fallback');
      assert.equal(calls.length, 2, 'OpenAI first, then the chat provider');
      assert.match(calls[0], /api\.openai\.com/);
      assert.equal(calls[1], 'https://api.ashna.ai/v1/api/chat/completions');
    });
  } finally {
    global.fetch = savedFetch;
  }
});

test('with no OpenAI key the photo path is exactly as it was', async () => {
  const savedFetch = global.fetch;
  const calls = [];
  try {
    global.fetch = async (url) => { calls.push(String(url)); return visionReply('gateway read'); };
    await withProviders({
      openai: { baseUrl: 'https://api.openai.com/v1', apiKey: '', visionModel: 'gpt-4o-mini' },
      chatBase: 'https://api.ashna.ai/v1/api', chatKey: 'gateway-chat-key', chatModel: 'gpt-5-mini',
    }, async () => {
      const text = await ai.readPhotoAnswer(PHOTO, 'What is 2 + 2?');
      assert.equal(text, 'gateway read');
      assert.equal(calls.length, 1, 'no phantom OpenAI call is made without the key');
      assert.equal(calls[0], 'https://api.ashna.ai/v1/api/chat/completions');
    });
  } finally {
    global.fetch = savedFetch;
  }
});

test('figure vision asks the paid account first, on its vision model', async () => {
  // locateFigures is the caller. With a gateway primary AND the paid key set,
  // the paid account leads — a gateway model that cannot read an image answers
  // with "no figures" and loses the page's diagram for good, while the account
  // the admin pays for sits unused. Real chatJSON; only fetch is stubbed.
  const savedFetch = global.fetch;
  const savedVision = config.ai.vision;
  const saved = { openai: config.openai, ai: { ...config.ai } };
  const calls = [];
  try {
    ai.resetCircuitBreakers();
    config.openai = { baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-live-openai-test', model: 'gpt-4o-mini', visionModel: 'gpt-4o-mini' };
    config.ai.baseUrl = 'https://api.ashna.ai/v1/api';
    config.ai.apiKey = 'gateway-chat-key';
    config.ai.model = 'gpt-5-mini';
    config.ai.vision = true;
    global.fetch = async (url, init) => {
      calls.push({ url: String(url), body: init && init.body });
      return visionReply('{"figures":[{"x":0.2,"y":0.2,"w":0.3,"h":0.3}]}');
    };

    const boxes = await ai.locateFigures({
      imageBase64: 'AAA',
      pageWidth: 600,
      pageHeight: 800,
      hint: 'study the diagram above',
    });

    assert.equal(boxes.length, 1, 'the box came back and passed validation');
    assert.equal(calls.length, 1, 'the paid account answered first, so the gateway is never billed for the page image');
    assert.match(calls[0].url, /api\.openai\.com/, 'the call went to OpenAI itself');
    const body = JSON.parse(calls[0].body);
    assert.equal(body.model, 'gpt-4o-mini', 'on the vision model — this is a sight call, not a chat one');
    assert.equal(body.messages[1].content[1].type, 'image_url', 'the page image rode along');
  } finally {
    global.fetch = savedFetch;
    config.ai.vision = savedVision;
    config.openai = saved.openai;
    config.ai.baseUrl = saved.ai.baseUrl;
    config.ai.apiKey = saved.ai.apiKey;
    config.ai.model = saved.ai.model;
    ai.resetCircuitBreakers();
  }
});

test('openaiConfigured mirrors the key, and gates open with it', () => {
  const saved = config.openai;
  try {
    config.openai = { baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-live-openai-test', visionModel: 'gpt-4o-mini' };
    assert.equal(ai.openaiConfigured(), true);
    config.openai = { baseUrl: 'https://api.openai.com/v1', apiKey: '', visionModel: 'gpt-4o-mini' };
    assert.equal(ai.openaiConfigured(), false);
  } finally {
    config.openai = saved;
  }
});

// ── chat fallback: the paid account rescues a failed primary ───────────
//
// The third job of OPENAI_API_KEY. An import used to die of "the AI provider
// did not answer in time" when the chat primary was down — with this paid
// account sitting unused. chatJSON now falls through to it (after CLAUDE_*,
// before XAI_*), only when a provider above it FAILED.

test('OPENAI_API_KEY also sets the chat fallback model', () => {
  const fresh = loadConfig({ OPENAI_API_KEY: 'sk-live-openai-test' });
  assert.equal(fresh.openai.model, 'gpt-4o-mini', 'a fast, JSON-reliable default');
  assert.equal(
    loadConfig({ OPENAI_API_KEY: 'sk-x', OPENAI_MODEL: 'gpt-4o' }).openai.model,
    'gpt-4o',
    'OPENAI_MODEL overrides the fallback model'
  );
});

test('a whole extraction survives a dead primary on the paid OpenAI account', async () => {
  // The production failure this wiring exists for: the chat primary (AshnaAI)
  // is down, and an import that used to die of "the AI provider did not
  // answer in time" now finishes on the account the admin already pays for.
  // Real chatJSON, real block pipeline — only fetch is stubbed.
  const savedFetch = global.fetch;
  const saved = { openai: config.openai, ai: { ...config.ai } };
  const calls = [];
  try {
    ai.resetCircuitBreakers();
    config.openai = { baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-live-openai-test', model: 'gpt-4o-mini', visionModel: 'gpt-4o-mini' };
    config.ai.baseUrl = 'https://api.ashna.ai/v1/api';
    config.ai.apiKey = 'gateway-chat-key';
    config.ai.model = 'gpt-5-mini';
    global.fetch = async (url, init) => {
      const u = String(url);
      calls.push(u);
      if (u.startsWith('https://api.ashna.ai/')) {
        return { ok: false, status: 500, text: async () => 'upstream exploded', json: async () => ({}) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{
            message: {
              content: '[{"type":"objective","number":1,"text":"Calculate 1 + 1.","options":["A. 1","B. 2"],"correct_answer":"A"}]',
            },
          }],
        }),
      };
    };

    const warnings = [];
    const parsed = await ai.extractQuestionsFromText(
      'MATHEMATICS PAPER 1\n\nQuestion 1\nCalculate 1 + 1.\nA. 1\nB. 2',
      null,
      (w) => warnings.push(w)
    );

    assert.equal(parsed.length, 1, 'the question arrived via the fallback, the import is not lost');
    assert.equal(parsed[0].text, 'Calculate 1 + 1.');
    assert.ok(calls.some((u) => u.startsWith('https://api.ashna.ai/')), 'the primary was still asked first');
    assert.ok(calls.some((u) => u.startsWith('https://api.openai.com/v1/chat/completions')), 'and OpenAI answered after it failed');
    assert.deepEqual(warnings, [], 'a rescued import carries no failure warning');
  } finally {
    global.fetch = savedFetch;
    config.openai = saved.openai;
    config.ai.baseUrl = saved.ai.baseUrl;
    config.ai.apiKey = saved.ai.apiKey;
    config.ai.model = saved.ai.model;
    ai.resetCircuitBreakers();
  }
});

test('when the chat primary fails, the paid OpenAI account answers instead', async () => {
  const savedFetch = global.fetch;
  const saved = { openai: config.openai, ai: { ...config.ai } };
  const calls = [];
  try {
    ai.resetCircuitBreakers();
    config.openai = { baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-live-openai-test', model: 'gpt-4o-mini', visionModel: 'gpt-4o-mini' };
    config.ai.baseUrl = 'https://api.ashna.ai/v1/api';
    config.ai.apiKey = 'gateway-chat-key';
    config.ai.model = 'gpt-5-mini';
    global.fetch = async (url, init) => {
      const u = String(url);
      calls.push({ url: u, body: init && init.body, headers: (init && init.headers) || {} });
      if (u.startsWith('https://api.ashna.ai/')) {
        return { ok: false, status: 500, text: async () => 'upstream exploded', json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '[{"type":"theory","text":"rescued"}]' } }] }) };
    };

    const out = await ai.chatJSON([{ role: 'user', content: 'extract' }], { maxRetries: 0 });

    assert.deepEqual(out, [{ type: 'theory', text: 'rescued' }], 'the fallback answer is returned as if the primary had answered');
    assert.equal(calls.length, 2, 'primary first, paid OpenAI second');
    assert.match(calls[0].url, /ashna\.ai/, 'the gateway is still preferred');
    assert.equal(calls[1].url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(calls[1].headers.Authorization, 'Bearer sk-live-openai-test', 'the fallback call carries the paid key');
    assert.equal(JSON.parse(calls[1].body).model, 'gpt-4o-mini');
  } finally {
    global.fetch = savedFetch;
    config.openai = saved.openai;
    config.ai.baseUrl = saved.ai.baseUrl;
    config.ai.apiKey = saved.ai.apiKey;
    config.ai.model = saved.ai.model;
    ai.resetCircuitBreakers();
  }
});

test('with no OpenAI key, chat keeps its old single-provider shape', async () => {
  const savedFetch = global.fetch;
  const saved = { openai: config.openai, ai: { ...config.ai } };
  const calls = [];
  try {
    config.openai = { baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o-mini', visionModel: 'gpt-4o-mini' };
    config.ai.baseUrl = 'https://api.ashna.ai/v1/api';
    config.ai.apiKey = 'gateway-chat-key';
    config.ai.model = 'gpt-5-mini';
    global.fetch = async (url) => {
      calls.push(String(url));
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '[{"type":"theory","text":"primary"}]' } }] }) };
    };

    const out = await ai.chatJSON([{ role: 'user', content: 'extract' }], { maxRetries: 0 });

    assert.deepEqual(out, [{ type: 'theory', text: 'primary' }]);
    assert.equal(calls.length, 1, 'no phantom OpenAI call is made without the key');
    assert.match(calls[0], /ashna\.ai/);
  } finally {
    global.fetch = savedFetch;
    config.openai = saved.openai;
    config.ai.baseUrl = saved.ai.baseUrl;
    config.ai.apiKey = saved.ai.apiKey;
    config.ai.model = saved.ai.model;
  }
});

// ── theory photo grading: a vision job that must not be the chat primary's
//    to gate, and must lead with the account that can see ────────────────

test('theory photo grading runs on the paid key alone — no chat gateway required', async () => {
  // The gate used to be `aiConfigured()` only, so a deployment running on
  // nothing but OPENAI_API_KEY threw "AI is not configured" from the very
  // feature the paid account exists to serve.
  const savedFetch = global.fetch;
  const saved = { openai: config.openai, ai: { ...config.ai } };
  const calls = [];
  try {
    ai.resetCircuitBreakers();
    config.openai = { baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-live-openai-test', model: 'gpt-4o-mini', visionModel: 'gpt-4o-mini' };
    config.ai.baseUrl = '';
    config.ai.apiKey = '';
    global.fetch = async (url, init) => {
      calls.push({ url: String(url), body: init && init.body });
      return visionReply('{"marksAwarded":7,"maxMarks":10,"breakdown":[],"feedback":"good","aiGenerated":false}');
    };

    const grade = await ai.markImageTheory({
      questionText: 'Explain osmosis with a labelled diagram.',
      maxMarks: 10,
      presentationMarks: 0,
      grammarMarks: 0,
      imageBase64: 'AAA',
    });

    assert.equal(grade.marksAwarded, 7, 'the photo of the answer was graded, not refused as unconfigured');
    assert.equal(calls.length, 1, 'the paid account alone carried the job');
    assert.match(calls[0].url, /api\.openai\.com/, 'and the grading call went to OpenAI itself');
  } finally {
    global.fetch = savedFetch;
    config.openai = saved.openai;
    config.ai.baseUrl = saved.ai.baseUrl;
    config.ai.apiKey = saved.ai.apiKey;
    ai.resetCircuitBreakers();
  }
});

test('with a gateway present, photo grading still asks the paid account first', async () => {
  // prefer: 'openai', same as figure vision: a model that never saw the photo
  // can still emit a plausible grade — a silent wrong answer — while the
  // account that can see sits unused.
  const savedFetch = global.fetch;
  const saved = { openai: config.openai, ai: { ...config.ai } };
  const calls = [];
  try {
    ai.resetCircuitBreakers();
    config.openai = { baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-live-openai-test', model: 'gpt-4o-mini', visionModel: 'gpt-4o-mini' };
    config.ai.baseUrl = 'https://api.ashna.ai/v1/api';
    config.ai.apiKey = 'gateway-chat-key';
    config.ai.model = 'gpt-5-mini';
    global.fetch = async (url, init) => {
      calls.push({ url: String(url), body: init && init.body });
      return visionReply('{"marksAwarded":9,"maxMarks":10,"breakdown":[],"feedback":"ok","aiGenerated":false}');
    };

    const grade = await ai.markImageTheory({
      questionText: 'Explain diffusion.',
      maxMarks: 10,
      presentationMarks: 0,
      grammarMarks: 0,
      imageBase64: 'AAA',
    });

    assert.equal(grade.marksAwarded, 9);
    assert.equal(calls.length, 1, 'the paid account answered first, so the gateway is never sent the image');
    assert.match(calls[0].url, /api\.openai\.com/, 'the photo went to OpenAI itself');
    const body = JSON.parse(calls[0].body);
    assert.equal(body.model, 'gpt-4o-mini', 'on the vision model — this is a sight call, not a chat one');
    assert.equal(body.messages[1].content[1].type, 'image_url', 'the photo rode along');
  } finally {
    global.fetch = savedFetch;
    config.openai = saved.openai;
    config.ai.baseUrl = saved.ai.baseUrl;
    config.ai.apiKey = saved.ai.apiKey;
    config.ai.model = saved.ai.model;
    ai.resetCircuitBreakers();
  }
});

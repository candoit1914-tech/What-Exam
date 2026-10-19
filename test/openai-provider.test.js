'use strict';
// The admin's own PAID OpenAI account (OPENAI_API_KEY) lights up the two
// features a chat gateway cannot serve: Whisper transcription for voice
// notes, and a vision-capable model asked FIRST for photo answers. One key,
// both features — and with no key the app behaves exactly as before.
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

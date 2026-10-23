'use strict';

// Speech-to-text is a separate concern from chat, and on AshnaAI it is a
// capability the gateway does not have at all: the catalog is 90 chat models,
// /audio/transcriptions 404s, and every model that accepts an `input_audio`
// part answers 200 with no transcript. So chat and transcription cannot share
// one base URL.
//
// These tests pin the routing rule: a dedicated transcribe provider is used
// for audio regardless of what the chat primary happens to be, and when no
// transcribe provider is configured the Whisper endpoint is not called at all
// (it used to be gated on the chat base URL containing "api.openai.com", which
// meant switching the chat provider silently killed audio).
require('./helpers/isolate');

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../src/config');
const ai = require('../src/services/ai');

const WAV = path.join(os.tmpdir(), `stt-probe-${process.pid}.wav`);
// A 16-bit mono 8kHz WAV header with no samples is enough: transcribeAudio
// reads the bytes to build a multipart body and never decodes the audio.
fs.writeFileSync(WAV, Buffer.from('RIFF$' + '0'.repeat(36), 'binary'));

function stubFetch(recorder) {
  const orig = global.fetch;
  global.fetch = async (url, init) => {
    recorder.push({
      url: String(url),
      headers: (init && init.headers) || {},
      body: init && init.body,
    });
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ text: 'photosynthesis' }),
      text: async () => 'photosynthesis',
    };
  };
  return () => { global.fetch = orig; };
}

function withTranscribeProvider(fn) {
  const saved = config.aiTranscribe;
  const savedBase = config.ai.baseUrl;
  return fn().finally(() => {
    config.aiTranscribe = saved;
    config.ai.baseUrl = savedBase;
  });
}

test.after(() => {
  try { fs.unlinkSync(WAV); } catch { /* best effort */ }
});

test('audio uses the dedicated transcribe provider while chat stays on a gateway', async () => {
  const calls = [];
  const restore = stubFetch(calls);
  try {
    await withTranscribeProvider(async () => {
      // Chat primary is a gateway with no STT support at all.
      config.ai.baseUrl = 'https://api.ashna.ai/v1/api';
      config.aiTranscribe = {
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-test-transcribe-key',
        model: 'whisper-1',
        enabled: true,
      };

      const text = await ai.transcribeAudio(WAV, 'What is the powerhouse of the cell?');

      assert.equal(text, 'photosynthesis');
      assert.equal(calls.length, 1, 'exactly one request, no fallback path attempted');
      assert.equal(
        calls[0].url,
        'https://api.openai.com/v1/audio/transcriptions',
        'audio must go to the transcribe provider, not the chat gateway'
      );
      assert.equal(
        calls[0].headers.Authorization,
        'Bearer sk-test-transcribe-key',
        "the transcribe provider's own key must be used, not the chat provider's"
      );
    });
  } finally {
    restore();
  }
});

test('the transcribe model name is sent as the multipart model field', async () => {
  const calls = [];
  const restore = stubFetch(calls);
  try {
    await withTranscribeProvider(async () => {
      config.aiTranscribe = {
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-test-transcribe-key',
        model: 'whisper-large-v3',
        enabled: true,
      };
      await ai.transcribeAudio(WAV, 'Q?');
      const body = calls[0].body;
      assert.equal(
        body.get('model'),
        'whisper-large-v3',
        'the configured transcribe model must be what is sent, not a hardcoded whisper-1'
      );
    });
  } finally {
    restore();
  }
});

test('no transcribe provider means the audio endpoint is never called', async () => {
  const calls = [];
  const restore = stubFetch(calls);
  try {
    await withTranscribeProvider(async () => {
      // Disabled provider: the app must not send audio to a chat gateway that
      // cannot transcribe it, because that 200-with-no-transcript response is
      // indistinguishable from silence to the caller.
      config.ai.baseUrl = 'https://api.ashna.ai/v1/api';
      config.aiTranscribe = {
        baseUrl: 'https://api.openai.com/v1',
        apiKey: '',
        model: 'whisper-1',
        enabled: false,
      };

      await assert.rejects(
        () => ai.transcribeAudio(WAV, 'Q?'),
        /transcrib/i,
        'must fail loudly rather than return a fabricated transcript'
      );
      assert.equal(
        calls.filter((c) => c.url.includes('/audio/transcriptions')).length,
        0,
        'must not hit the audio endpoint without a transcribe provider'
      );
    });
  } finally {
    restore();
  }
});

// ── the paid account as a speech provider, not just a chat one ─────────

/**
 * Run `fn` with a two-actor cast: a dedicated speech key that FAILS, and the
 * paid OpenAI account behind it. `route(auth)` decides each answer, so a test
 * can play "wrong key" then "the real one".
 */
function withSpeechCast(fn) {
  const savedOpenai = config.openai;
  config.openai = {
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-paid-platform-test',
    model: 'gpt-4o-mini',
    visionModel: 'gpt-4o-mini',
  };
  return withTranscribeProvider(fn).finally(() => { config.openai = savedOpenai; });
}

test('a failed dedicated speech key still transcribes through the paid OpenAI account', async () => {
  // The production shape: AI_TRANSCRIBE_API_KEY holds something that is not a
  // working OpenAI key (or points at a different host), so Strategy 1 401s.
  // The paid OPENAI_API_KEY sits right there and used to never be asked —
  // only chat `input_audio` followed, which a gateway answers with silence,
  // so every voice note was flagged for review.
  const orig = global.fetch;
  const calls = [];
  try {
    await withSpeechCast(async () => {
      config.aiTranscribe = {
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-wrong-transcribe-key',
        model: 'whisper-1',
        enabled: true,
      };
      global.fetch = async (url, init) => {
        calls.push({ url: String(url), auth: (init.headers || {}).Authorization });
        if (calls.length === 1) {
          return { ok: false, status: 401, text: async () => 'invalid api key', headers: { get: () => null } };
        }
        return { ok: true, status: 200, text: async () => 'the real transcript', json: async () => ({}), headers: { get: () => null } };
      };

      const text = await ai.transcribeAudio(WAV, 'What is the powerhouse of the cell?');

      assert.equal(text, 'the real transcript', 'the paid account answered where the dedicated key failed');
      assert.equal(calls.length, 2, 'exactly two attempts: the failing key, then the paid account');
      assert.ok(calls[0].url.endsWith('/audio/transcriptions') && calls[1].url.endsWith('/audio/transcriptions'),
        'both attempts are real speech endpoints, not chat input_audio');
      assert.equal(calls[0].auth, 'Bearer sk-wrong-transcribe-key');
      assert.equal(calls[1].auth, 'Bearer sk-paid-platform-test', 'the paid account carries its own key');
    });
  } finally {
    global.fetch = orig;
  }
});

test('the paid account is not asked twice when it already IS the transcribe provider', async () => {
  // config.js wires OPENAI_API_KEY into aiTranscribe when no dedicated key is
  // set — same key, same base URL. When that attempt fails, retrying it would
  // bill the same account twice for the same file; the chain must move on to
  // the chat fallback instead.
  const orig = global.fetch;
  const calls = [];
  try {
    await withSpeechCast(async () => {
      config.aiTranscribe = {
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-paid-platform-test',
        model: 'whisper-1',
        enabled: true,
      };
      global.fetch = async (url, init) => {
        calls.push({ url: String(url), auth: (init.headers || {}).Authorization });
        return { ok: false, status: 401, text: async () => 'invalid api key', headers: { get: () => null } };
      };

      await assert.rejects(() => ai.transcribeAudio(WAV, 'Q?'));
      const audioCalls = calls.filter((c) => c.url.includes('/audio/transcriptions'));
      assert.equal(audioCalls.length, 1, 'the same account is never billed twice for one file');
    });
  } finally {
    global.fetch = orig;
  }
});

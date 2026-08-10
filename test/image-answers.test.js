'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const marking = require('../src/services/marking');
const config = require('../src/config');

test('answers table has the answer_image column', () => {
  const cols = db.prepare("PRAGMA table_info('answers')").all().map((c) => c.name);
  assert.ok(cols.includes('answer_image'), `expected answer_image in columns: ${cols.join(', ')}`);
});

const wa = require('../src/services/whatsapp');

test('parseWebhook returns an image event from an image message', () => {
  const body = {
    entry: [{ changes: [{ value: {
      messages: [{
        from: '233201234567', id: 'wamid.image.1', timestamp: '1750000000', type: 'image',
        image: { id: 'MEDIA_ID_1', caption: 'my written answer' },
      }],
    } }] }],
  };
  const ev = wa.parseWebhook(body).find((e) => e.type === 'message');
  assert.ok(ev, 'image message yields a message event');
  assert.equal(ev.mediaType, 'image');
  assert.equal(ev.mediaId, 'MEDIA_ID_1');
  assert.equal(ev.body, 'my written answer');
});

test('parseWebhook image event without caption has an empty body', () => {
  const body = {
    entry: [{ changes: [{ value: {
      messages: [{ from: '233201234567', id: 'wamid.image.2', timestamp: '1750000000', type: 'image',
        image: { id: 'MEDIA_ID_2' } }],
    } }] }],
  };
  const ev = wa.parseWebhook(body)[0];
  assert.equal(ev.mediaType, 'image');
  assert.equal(ev.body, '');
});

test('downloadMedia resolves buffer and mimeType through the Graph media URL', async () => {
  // Stub global.fetch: first call returns the media meta (an expiring URL),
  // second returns the bytes.
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url, opts });
    if (calls.length === 1) {
      return new Response(JSON.stringify({ url: 'https://media.example.com/abc.jpg', mime_type: 'image/jpeg' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(Buffer.from([1, 2, 3, 4]), { status: 200 });
  };
  try {
    const out = await wa.downloadMedia('MEDIA_ID_1');
    assert.deepEqual([...out.buffer], [1, 2, 3, 4]);
    assert.equal(out.mimeType, 'image/jpeg');
    assert.match(calls[0].url, /\/MEDIA_ID_1$/);
    assert.ok(/Bearer /.test(calls[0].opts.headers.Authorization), 'token attached to the media request');
  } finally {
    global.fetch = original;
  }
});

test('markTheoryImageAnswer flags for manual review when vision is off', async () => {
  const wasVision = config.ai.vision;
  config.ai.vision = false;
  try {
    const out = await marking.markTheoryImageAnswer(
      { id: 1, text: 'Draw the water cycle.', marks: 4, passage: '' },
      '(photo answer)', 'nonexistent.png', { model_answer: '', key_points: [], rubric: [], presentation_marks: 0, grammar_marks: 0 }
    );
    assert.equal(out.needsReview, true);
    assert.equal(out.marksAwarded, 0);
  } finally {
    config.ai.vision = wasVision;
  }
});

test('markTheoryImageAnswer flags for manual review when the AI call fails', async () => {
  const wasVision = config.ai.vision;
  const wasRead = require('fs').readFileSync;
  config.ai.vision = true;
  require('fs').readFileSync = () => 'fake-base64';
  const ai = require('../src/services/ai');
  const orig = ai.markImageTheory;
  ai.markImageTheory = async () => { throw new Error('vision endpoint exploded'); };
  try {
    const out = await marking.markTheoryImageAnswer(
      { id: 1, text: 'Draw the water cycle.', marks: 4, passage: '' },
      '(photo answer)', 'f.png', {}
    );
    assert.equal(out.needsReview, true, 'AI failure falls back to manual review');
  } finally {
    config.ai.vision = wasVision;
    require('fs').readFileSync = wasRead;
    ai.markImageTheory = orig;
  }
});

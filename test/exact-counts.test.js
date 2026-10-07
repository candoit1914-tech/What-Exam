'use strict';
require('./helpers/isolate');

// The admin asks for a paper as "N objective and M theory". The
// provider does not have to be well-behaved for that promise to
// hold: one that over-delivers one type and under-delivers the
// other used to produce a paper with the right TOTAL and every
// per-type count wrong — and a provider that comes back short
// used to save a silently shorter paper.
//
// These tests pin the guarantee: exactly the asked-for number of
// each type, or a loud error and nothing saved.

const test = require('node:test');
const assert = require('node:assert/strict');
const { before, after } = require('node:test');

const config = require('../src/config');
const ai = require('../src/services/ai');

function contentResponse(text) {
  const payload = { choices: [{ message: { content: text } }] };
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => payload,
    text: async () => JSON.stringify(payload),
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

/**
 * A bank of single-token compound words, big enough that every
 * question gets six words no other question uses. The similarity
 * dedup is a Jaccard over tokens, so reused words are what makes
 * a provider's otherwise-fine answers look like duplicates.
 */
const ROOTS = (
  'maize cassava yam cocoa plantain rice millet sorghum groundnut cowpea ' +
  'soybean sesame sunflower oilpalm rubber citrus mango papaya pineapple ' +
  'guava cashew shea baobab dawadawa neem acacia teak mahogany cedar ' +
  'ebony kente adinkra fugu smock krobo beads drum xylophone fontomfrom ' +
  'atumpan kete seperewa goje koloko prempensua danso bokom adowa azonto ' +
  'kpanlogo agbadza sigli bakisimba muwogola nankasa runyege entogoro'
).split(/\s+/);
const MODIFIERS = (
  'meal flour dough porridge stew soup broth snack drink juice oil cake ' +
  'bread paste chips flakes grits mash puree sauce syrup vinegar honey ' +
  'butter cream curd whey malt yeast grain husk fibre starch sap resin ' +
  'timber fibre weave dye tan smoke cure ferment roast boil steam dry'
).split(/\s+/);
const BANK = [];
for (const root of ROOTS) {
  for (const mod of MODIFIERS) {
    BANK.push(root + mod[0].toUpperCase() + mod.slice(1));
  }
}

/** Six bank words, a different set for every question index. */
const wordsFor = (i) => BANK.slice((i - 1) * 6, (i - 1) * 6 + 6);

/**
 * A provider that reads the "EXACTLY n objective … EXACTLY m
 * theory" ask out of the prompt and answers it. `skew` makes it
 * over-deliver one type and under-deliver the other — the
 * classic lopsided answer. `budget` makes it run dry: it can
 * only ever produce that many questions, however often it is
 * asked, which is what a provider that cannot deliver looks like.
 */
function fakeProvider({ skew = 0, budget = Infinity } = {}) {
  let counter = 0;
  let emitted = 0;
  return async (url, init) => {
    const body = JSON.parse(String(init?.body || '{}'));
    const system = String(body.messages?.[0]?.content || '');
    if (system.includes('svg') || system.includes('SVG')) {
      // Diagram generation: return a tiny valid SVG.
      return contentResponse(
        '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600">' +
        '<rect width="800" height="600" fill="#FFFFFF"/></svg>'
      );
    }
    const user = String(body.messages?.[1]?.content || '');
    // The prompt is phrased three ways ("EXACTLY n objective … and
    // EXACTLY m theory", or a single type alone); read both counts
    // out of whichever form the batch was asked in.
    const askObj = user.match(/EXACTLY (\d+) objective/);
    const askTheo = user.match(/EXACTLY (\d+) theory/);
    let obj = askObj ? Number(askObj[1]) : 0;
    let theo = askTheo ? Number(askTheo[1]) : 0;
    // The lopsided pass: a mixed batch comes back with a few
    // extra objective and the same fewer theory. A single-type
    // ask (a retry or top-up round) is answered honestly.
    if (skew && obj > 0 && theo > 0) {
      obj = Math.max(0, obj + skew);
      theo = Math.max(0, theo - skew);
    }
    // Out of ideas: answer with whatever is left of the budget.
    const take = Math.max(0, Math.min(budget - emitted, obj + theo));
    obj = Math.min(obj, take);
    theo = Math.min(theo, take - obj);
    emitted += obj + theo;
    const questions = [];
    for (let i = 0; i < obj; i++) {
      counter += 1;
      const [a, b, c, d, e, f] = wordsFor(counter);
      questions.push({
        type: 'objective',
        text: `On a ${a} farm, which ${b} is most likely to ${c} the ${d} after a ${e} season of ${f}?`,
        options: [`option ${counter}a`, `option ${counter}b`, `option ${counter}c`, `option ${counter}d`],
        correct_index: 0,
        marks: 1,
      });
    }
    for (let i = 0; i < theo; i++) {
      counter += 1;
      const [a, b, c, d, e, f] = wordsFor(counter);
      questions.push({
        type: 'theory',
        text: `Explain how a ${a} farmer can ${b} and ${c} the ${d} during a ${e} ${f} season.`,
        marks: 5,
        model_answer: `answer ${counter}`,
        key_points: [`point ${counter}`],
        rubric: [],
      });
    }
    return contentResponse(JSON.stringify({ questions }));
  };
}

const count = (questions, type) =>
  questions.filter((q) => q.type === type).length;

test('a lopsided provider still yields exactly the asked-for split', async () => {
  usePrimaryOnly();
  const realFetch = global.fetch;
  global.fetch = fakeProvider({ skew: 3 });
  try {
    const generated = await ai.generateQuestions({
      subject: 'Agriculture',
      topics: ['Crop harvest'],
      objectiveCount: 40,
      theoryCount: 5,
      types: ['objective', 'theory'],
      difficulty: 'medium',
    });
    assert.equal(count(generated, 'objective'), 40, 'exactly 40 objective');
    assert.equal(count(generated, 'theory'), 5, 'exactly 5 theory');
    assert.equal(generated.length, 45, 'and nothing else');
  } finally {
    global.fetch = realFetch;
  }
});

test('a theory-only request produces no objective questions at all', async () => {
  usePrimaryOnly();
  const realFetch = global.fetch;
  global.fetch = fakeProvider();
  try {
    const generated = await ai.generateQuestions({
      subject: 'Literature',
      topics: ['Prose'],
      objectiveCount: 0,
      theoryCount: 5,
      types: ['theory'],
      difficulty: 'medium',
    });
    assert.equal(count(generated, 'theory'), 5, 'exactly 5 theory');
    assert.equal(count(generated, 'objective'), 0, 'no stray objective');
  } finally {
    global.fetch = realFetch;
  }
});

test('a provider that cannot deliver the count fails loudly instead of saving a short paper', async () => {
  usePrimaryOnly();
  const realFetch = global.fetch;
  // Only seven questions exist, ever — the paper asks for ten.
  global.fetch = fakeProvider({ budget: 7 });
  try {
    await assert.rejects(
      () => ai.generateQuestions({
        subject: 'Agriculture',
        topics: ['Crop harvest'],
        objectiveCount: 10,
        theoryCount: 0,
        types: ['objective'],
        difficulty: 'medium',
      }),
      /returned \d+ of 10 objective/
    );
  } finally {
    global.fetch = realFetch;
  }
});

// ── The generate route ───────────────────────────────────────
//
// The route is where the count becomes real: whatever the
// provider returned, the paper that reaches the database has
// exactly the asked-for number of each type, or nothing at all.

const http = require('node:http');
const express = require('express');
const db = require('../src/db');
const auth = require('../src/auth');
const api = require('../src/routes/api');

let server;
let base;
let token;

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(
      `${base}${path}`,
      {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
          resolve({ status: res.statusCode, body: json });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function newExam(title) {
  return db
    .prepare("INSERT INTO exams (title, subject, duration_minutes, status) VALUES (?,'Math',30,'published')")
    .run(title).lastInsertRowid;
}

const objective = (i) => ({
  type: 'objective',
  text: `Route objective ${i} about the harvest`,
  options: ['A', 'B', 'C', 'D'],
  correct_index: 0,
  marks: 1,
});
const theory = (i) => ({ type: 'theory', text: `Route theory ${i} about the harvest`, marks: 5 });

before(async () => {
  token = auth.adminToken();
  const app = express();
  app.use(express.json());
  app.use('/api', api);
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => { server?.close(); });

test('the route saves exactly the split the admin asked for', async () => {
  const eid = newExam('__exact_route__');
  const real = ai.generateQuestions;
  // Over-delivers both types: the paper must keep only the
  // asked-for quota, and the overflow belongs to the pool.
  ai.generateQuestions = async () => [
    ...Array.from({ length: 43 }, (_, i) => objective(i)),
    ...Array.from({ length: 7 }, (_, i) => theory(i)),
  ];
  try {
    const res = await request('POST', `/api/exams/${eid}/generate`, {
      count: 45,
      types: ['objective', 'theory'],
      objectiveCount: 40,
      theoryCount: 5,
      pool: true,
      poolMultiplier: 2,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const rows = db.prepare('SELECT type FROM questions WHERE exam_id = ?').all(eid);
    assert.equal(rows.filter((r) => r.type === 'objective').length, 40, 'exactly 40 objective');
    assert.equal(rows.filter((r) => r.type === 'theory').length, 5, 'exactly 5 theory');
    const pooled = db.prepare('SELECT type FROM question_pool WHERE exam_id = ?').all(eid);
    assert.equal(pooled.length, 5, 'the overflow went to the pool, not the paper');
    assert.equal(pooled.filter((r) => r.type === 'objective').length, 3);
    assert.equal(pooled.filter((r) => r.type === 'theory').length, 2);
  } finally {
    ai.generateQuestions = real;
  }
});

test('a theory-only request never grows a stray objective', async () => {
  const eid = newExam('__theory_only_route__');
  const real = ai.generateQuestions;
  // The provider ignores the type selection and adds an objective.
  ai.generateQuestions = async () => [objective(0), ...Array.from({ length: 5 }, (_, i) => theory(i))];
  try {
    const res = await request('POST', `/api/exams/${eid}/generate`, {
      count: 5,
      types: ['theory'],
      objectiveCount: 0,
      theoryCount: 5,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const rows = db.prepare('SELECT type FROM questions WHERE exam_id = ?').all(eid);
    assert.equal(rows.length, 5, 'five questions');
    assert.equal(rows.filter((r) => r.type === 'theory').length, 5, 'all theory');
    assert.equal(rows.filter((r) => r.type === 'objective').length, 0, 'no stray objective');
  } finally {
    ai.generateQuestions = real;
  }
});

test('a short paper is refused and nothing is saved', async () => {
  const eid = newExam('__short_route__');
  const real = ai.generateQuestions;
  ai.generateQuestions = async () => Array.from({ length: 37 }, (_, i) => objective(i));
  try {
    const res = await request('POST', `/api/exams/${eid}/generate`, {
      count: 40,
      types: ['objective'],
      objectiveCount: 40,
      theoryCount: 0,
    });
    assert.equal(res.status, 502, JSON.stringify(res.body));
    assert.match(res.body.error, /37 of 40 objective/);
    assert.equal(
      db.prepare('SELECT COUNT(*) c FROM questions WHERE exam_id = ?').get(eid).c,
      0,
      'a short paper must not be saved'
    );
  } finally {
    ai.generateQuestions = real;
  }
});

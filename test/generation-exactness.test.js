'use strict';
require('./helpers/isolate');

// Complements test/exact-counts.test.js, which pins the
// exact-split guarantee itself. What is pinned here is the
// MECHANISM that restores the split: the top-up round asks
// for the missing type alone (never a fresh batch, never
// more than the quota), and two generate-route paths the
// other file does not cover — the legacy count-only shape
// and a request with no count at all.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const db = require('../src/db');
const config = require('../src/config');
const auth = require('../src/auth');
const ai = require('../src/services/ai');
const api = require('../src/routes/api');

// ── scenario pool ─────────────────────────────────────
// Every stem is built from deliberately plain vocabulary:
// shouldHaveDiagram() fires on a single keyword substring
// ("chart", "table", "measure", "market", "cell", …), and
// a triggered diagram would send these tests down a path they
// do not exercise. Distinct word sets also keep every question
// above the 0.65 history-dedup similarity threshold.
const SCENARIOS = [
  'Ama kept bees behind her kiosk in Accra and collected nine jars of honey',
  'Kofi ferried passengers across the Volta lake each dawn',
  'Abena roasted plantain beside the harbour every evening',
  'Kwame herded cattle through the savanna near Tamale',
  'Efua wove kente cloth on a loom in her courtyard',
  'Yaw caught tilapia with a woven basket by the lagoon',
  'Akosua milled cocoa beans at her grinding shed',
  'Osei pounded fufu for his guests during the harvest',
  'Mama sold bread at the Makola stall before sunrise',
  'Aisha threaded beads into necklaces for classmates',
  'Adjoa painted murals on her studio wall each week',
  'Baffour carved wooden stools for his uncle',
  'Cynthia dried fish over a slow flame',
  'David tended goats beside the orchard',
  'Esi braided hair for wedding guests',
  'Fritz mended fishing canoes each morning',
  'Gloria harvested cassava behind her hut',
  'Hassan wove baskets from palm fronds',
  'Ivy bottled shea butter for her shop',
  'Joseph stacked firewood for the cold nights',
  'Kobina ground pepper with a heavy mortar',
  'Lydia raised pigeons on her rooftop',
  'Mensah stitched uniforms for the choir',
  'Nana brewed palm wine each season',
];

let seq = 0;
function objective() {
  return {
    type: 'objective',
    text: `${SCENARIOS[(seq++) % SCENARIOS.length]}?`,
    options: ['Alpha option', 'Beta option', 'Gamma option', 'Delta option'],
    correct_index: 0,
    marks: 1,
  };
}
function theory() {
  return {
    type: 'theory',
    text: `${SCENARIOS[(seq++) % SCENARIOS.length]}?`,
    marks: 5,
    model_answer: 'A complete model answer.',
    key_points: ['first key point', 'second key point'],
    rubric: [{ point: 'states the core idea', marks: 2, explanation: 'the heart of the answer' }],
    presentation_marks: 1,
    grammar_marks: 1,
  };
}

function jsonOk(payload) {
  // The chat-completions envelope callEndpoint reads the
  // assistant message from.
  const content = JSON.stringify(payload);
  const body = { choices: [{ message: { content } }] };
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
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

// Every chat completion the run makes, so a test can assert
// on what the paper was actually asked for.
const asks = [];
let chatHandler = () => [];
const realFetch = global.fetch;
global.fetch = async (_url, init = {}) => {
  const body = JSON.parse(String(init.body || '{}'));
  const messages = body.messages || [];
  const system = String((messages[0] && messages[0].content) || '');
  const user = String((messages[1] && messages[1].content) || '');
  asks.push({ system, user });
  return jsonOk({ questions: chatHandler({ system, user }) });
};

test('a lopsided batch is topped up by asking for the shortfall alone', async () => {
  usePrimaryOnly();
  asks.length = 0;
  chatHandler = ({ system }) => {
    if (system.includes('top-up round')) {
      // The top-up asks for the shortfall alone — theory only here.
      return [theory(), theory()];
    }
    // The batch phase over-delivers objective and sends no theory.
    return [objective(), objective(), objective(), objective()];
  };

  const paper = await ai.generateQuestions({
    subject: 'Creative Arts',
    topics: 'Crafts and trades',
    count: 4,
    objectiveCount: 2,
    theoryCount: 2,
    types: ['objective', 'theory'],
    difficulty: 'medium',
  });

  assert.equal(paper.filter((q) => q.type === 'objective').length, 2);
  assert.equal(paper.filter((q) => q.type === 'theory').length, 2, 'the missing theory was topped up');
  assert.equal(paper.length, 4);

  // The batch prompts keep the original 2/2 split…
  assert.ok(
    asks.some((a) => /EXACTLY 2 objective questions and EXACTLY 2 theory questions/.test(a.user)),
    'the batch phase asks for the full split'
  );
  // …and the top-up asks for the missing type alone, never a fresh batch.
  assert.ok(
    asks.some((a) => /EXACTLY 2 theory/.test(a.user) && /DO NOT generate any objective/.test(a.user)),
    'the top-up asks for the theory shortfall alone'
  );
  // No prompt ever asks for more of a type than the quota allows.
  for (const a of asks) {
    const m = a.user.match(/EXACTLY (\d+) objective/);
    if (m) assert.ok(Number(m[1]) <= 2, `a prompt asked for too many objective questions: ${a.user}`);
    const t = a.user.match(/EXACTLY (\d+) theory/);
    if (t) assert.ok(Number(t[1]) <= 2, `a prompt asked for too many theory questions: ${a.user}`);
  }
});

// ── the HTTP route ────────────────────────────────────

let server;
let base;
let token;

function request(method, path_, body) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(
      `${base}${path_}`,
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
    .prepare("INSERT INTO exams (title, subject, duration_minutes, status) VALUES (?,'General',30,'published')")
    .run(title).lastInsertRowid;
}

before(async () => {
  token = auth.adminToken();
  const app = express();
  app.use(express.json());
  app.use('/api', api);
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  global.fetch = realFetch;
});

test('a legacy count-only request still splits across both types', async () => {
  const eid = newExam('__legacy_split__');
  const real = ai.generateQuestions;
  ai.generateQuestions = async () => [
    objective(), objective(),
    theory(), theory(),
  ];
  try {
    // No objectiveCount/theoryCount: the older shape must still work.
    const res = await request('POST', `/api/exams/${eid}/generate`, {
      count: 4,
      types: ['objective', 'theory'],
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const objs = db.prepare("SELECT COUNT(*) c FROM questions WHERE exam_id = ? AND type = 'objective'").get(eid).c;
    const theos = db.prepare("SELECT COUNT(*) c FROM questions WHERE exam_id = ? AND type = 'theory'").get(eid).c;
    assert.equal(objs, 2);
    assert.equal(theos, 2);
  } finally {
    ai.generateQuestions = real;
  }
});

test('a generate request with no question count is refused', async () => {
  const eid = newExam('__no_count__');
  const res = await request('POST', `/api/exams/${eid}/generate`, { types: ['theory'] });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /at least one/i);
});

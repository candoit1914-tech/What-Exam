'use strict';
// The WhatsApp selection stage, walked the way a student actually walks it.
// env must be set before ../src/db is required, or db.js opens the real
// database. Same harness pattern as test/question-selection.test.js:1-19.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'la-exam-wasel-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.UPLOADS_DIR = path.join(tmp, 'uploads');
process.env.DOTENV_CONFIG_PATH = path.join(tmp, '.env');
process.env.SEED_ON_BOOT = 'false';
// The repo root's .env carries REAL AI credentials, and src/config.js loads it
// at require time — dotenv.config() ignores DOTENV_CONFIG_PATH above. Without
// this, a theory answer that reaches finalize would generate marking schemes
// against a live provider: real money spent, and a suite whose duration
// depends on the network. Neutralize dotenv and drop the credentials before
// any src module loads, exactly like test/helpers/isolate.js.
require('dotenv').config = () => ({ parsed: {} });
for (const name of Object.keys(process.env)) {
  if (/^(AI_|CLAUDE_|XAI_|PUTER_|WHATSAPP_|PAYSTACK_)/.test(name)) delete process.env[name];
}
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
// aiConfigured() is true whenever a baseUrl exists — and the shipped default
// always does — so the default has to go too. Then finalize marks theory with
// the heuristic fallback instead of calling out to a provider.
require('../src/config').ai.baseUrl = '';
// Belt and braces: any fetch that slips past the stubs fails loudly instead of
// quietly reaching a real service.
global.fetch = async () => { throw new Error('Unexpected network request in isolated test'); };

after(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const selection = require('../src/services/selection');
const examSvc = require('../src/services/exam');
const wa = require('../src/services/whatsapp');
const ai = require('../src/services/ai');

/** Records every outbound message, whatever helper sends it. */
function captureWa() {
  const sent = [];
  const orig = {
    sendText: wa.sendText,
    sendInteractiveList: wa.sendInteractiveList,
    sendInteractiveButtons: wa.sendInteractiveButtons,
    sendImage: wa.sendImage,
  };
  wa.sendText = async (phone, text) => { sent.push({ kind: 'text', text }); return {}; };
  wa.sendInteractiveList = async (phone, title, body, buttonText, rows, footer) => {
    sent.push({ kind: 'list', title, body, buttonText, rows, footer });
    return {};
  };
  wa.sendInteractiveButtons = async (phone, text, buttons) => {
    sent.push({ kind: 'buttons', text, buttons });
    return {};
  };
  wa.sendImage = async () => ({});
  return { sent, restore: () => Object.assign(wa, orig) };
}

const texts = (sent) => sent.map((m) => m.text || m.body || '').join('\n');
const lists = (sent) => sent.filter((m) => m.kind === 'list');
const pickers = (sent) => sent.filter((m) => m.kind === 'list' && m.buttonText === 'Choose questions');
const cards = (sent) => sent.filter((m) => m.kind === 'text' && /Selected: \d+\/\d+/.test(m.text));
const sessionRow = (sid) => db.prepare('SELECT * FROM sessions WHERE id=?').get(sid);
const tentative = (sid) => JSON.parse(sessionRow(sid).selection_tentative || '[]');
/** The full text of one drawn question, as the chat will print it. */
const drawnText = (sid, qOrder) => db.prepare(
  `SELECT qp.text t FROM session_questions sq JOIN question_pool qp ON qp.id = sq.question_id
    WHERE sq.session_id = ? AND sq.q_order = ?`
).get(sid, qOrder).t;
/** The question bubbles only — card and picker lines carry titles too. */
const questionBubbles = (sent) => sent
  .map((m) => m.text || '')
  .filter((t) => /\*QUESTION \d+\*/.test(t));

/**
 * A theory paper that opens straight into a "choose 3 of 5" section, with the
 * invite already delivered — the state every real student is in when they reach
 * a selector, and the one the repeated-picker bug lived in.
 *
 * `compulsory` marks that many leading questions as forced, and `answerCount`
 * is what the section owes in total — the paper's own number, forced questions
 * included — so a "2 of 3 with one compulsory" paper is
 * `{ pool: 3, compulsory: 1, answerCount: 2 }` and the student picks one.
 */
let phoneSeq = 0;
function openAtSelector({ quota = 3, pool = 5, compulsory = 0, answerCount = null } = {}) {
  const eid = db.prepare(
    "INSERT INTO exams(title,duration_minutes,status) VALUES ('Paper',30,'live')"
  ).run().lastInsertRowid;
  for (let i = 1; i <= pool; i++) {
    db.prepare(
      `INSERT INTO questions(exam_id,q_order,type,text,marks,is_compulsory,section_key)
       VALUES (?,?,'theory',?,5,?,'b')`
    ).run(eid, i, `Question ${i} body`, i <= compulsory ? 1 : 0);
  }
  db.prepare(
    `INSERT INTO exam_sections(exam_id,section_key,title,instructions,position,answer_count)
     VALUES (?,?,?, ?, 0, ?)`
  ).run(eid, 'b', 'SECTION II', 'Answer any THREE questions', answerCount ?? quota);

  const phone = `233555${String(++phoneSeq).padStart(6, '0')}`;
  const studentId = db.prepare('INSERT INTO students(phone) VALUES (?)').run(phone).lastInsertRowid;
  db.prepare('INSERT INTO exam_recipients(exam_id,student_id) VALUES (?,?)').run(eid, studentId);
  const sid = examSvc.createSession(eid, studentId).id;
  // The invite the admin already sent. Without it the paper would not have been
  // opened by a reply yet, and the branch this whole suite guards would never run.
  db.prepare(
    `INSERT INTO message_outbox(session_id, question_id, q_order, kind, recipient, state)
     VALUES (?, 0, NULL, 'intro', ?, 'sent')`
  ).run(sid, phone);
  const poolOrders = selection.sessionPlan(sid).find((s) => s.section_key === 'b').optional
    .map((q) => q.q_order);
  return { eid, sid, phone, studentId, poolOrders };
}

// Every test that talks to the chat stubs the AI detector: a free-text theory
// answer kicks off plagiarism detection, which reaches the network.
let realDetect;
before(() => { realDetect = ai.detectAiGeneratedAnswer; ai.detectAiGeneratedAnswer = async () => ({ ai_generated: false }); });
after(() => { ai.detectAiGeneratedAnswer = realDetect; });

test('the section picker is sent exactly once, however many questions are tapped', async () => {
  const { sid, phone, poolOrders } = openAtSelector();
  const cap = captureWa();
  try {
    // The first reply after the invite opens the paper — and, here, the selector.
    await examSvc.handleInbound(phone, 'START');
    assert.equal(pickers(cap.sent).length, 1, 'the section message opens the stage once');
    assert.ok(
      !cap.sent.some((m) => (m.body || m.text || '').includes('Answer any THREE questions')),
      "the paper's own instruction line is never printed — the app's quota sentence says it"
    );
    assert.ok(
      cap.sent.some((m) => /You must choose exactly 3 of the \d+ questions below\./.test(m.body || m.text || '')),
      'and the instruction the student follows is the app\u2019s own'
    );

    for (const q of poolOrders.slice(0, 3)) {
      await examSvc.handleInbound(phone, '', { replyId: `sel:b:${q}` });
    }
    assert.equal(pickers(cap.sent).length, 1, 'a tap must never regenerate the picker');
    assert.equal(
      cap.sent.filter((m) => (m.body || m.text || '').includes('SECTION II')).length, 1,
      'the SECTION header is on screen once, not once per selection'
    );
    assert.deepEqual(tentative(sid), poolOrders.slice(0, 3), 'every tap was recorded');
  } finally { cap.restore(); }
});

test('a tap answers with the checkbox card and a live count, not a new section message', async () => {
  const { sid, phone, poolOrders } = openAtSelector();
  const cap = captureWa();
  try {
    await examSvc.handleInbound(phone, 'START');
    cap.sent.length = 0;

    await examSvc.handleInbound(phone, '', { replyId: `sel:b:${poolOrders[0]}` });
    const first = cards(cap.sent)[0];
    assert.ok(first, 'a selection is answered with the state card');
    assert.match(first.text, /☑ 1\. Question 1 body/);
    assert.match(first.text, /☐ 2\. Question 2 body/);
    assert.match(first.text, /\*Selected: 1\/3\*/, 'the count is on every card');
    assert.ok(
      !/Choose questions/.test(first.text),
      'the card reports state; it does not re-issue the picker'
    );

    cap.sent.length = 0;
    await examSvc.handleInbound(phone, '', { replyId: `sel:b:${poolOrders[1]}` });
    const second = cards(cap.sent)[0];
    assert.match(second.text, /☑ 1\.[\s\S]*☑ 2\./);
    assert.match(second.text, /\*Selected: 2\/3\*/);
  } finally { cap.restore(); }
});

test('Continue is offered only at the exact count, and an early one is refused', async () => {
  const { sid, phone, poolOrders } = openAtSelector();
  const cap = captureWa();
  try {
    await examSvc.handleInbound(phone, 'START');
    await examSvc.handleInbound(phone, '', { replyId: `sel:b:${poolOrders[0]}` });
    cap.sent.length = 0;

    // One of three: no way through, and no picker to compensate for it.
    await examSvc.handleInbound(phone, 'CONTINUE');
    assert.equal(
      cap.sent.filter((m) => m.kind === 'buttons').length, 0,
      'Continue is not offered before the count is met'
    );
    assert.match(texts(cap.sent), /must choose exactly 3/);
    assert.match(texts(cap.sent), /You have chosen 1/);
    assert.equal(pickers(cap.sent).length, 0, 'a refusal must not reopen the section message');
    assert.equal(sessionRow(sid).selection_state, 'selecting', 'the stage is still open');

    // Two more and the count is exact: now the single Continue action appears.
    cap.sent.length = 0;
    await examSvc.handleInbound(phone, '', { replyId: `sel:b:${poolOrders[1]}` });
    await examSvc.handleInbound(phone, '', { replyId: `sel:b:${poolOrders[2]}` });
    const button = cap.sent.find((m) => m.kind === 'buttons');
    assert.ok(button, 'the complete card carries the Continue action');
    assert.match(button.text, /\*Selected: 3\/3\*/);
    assert.equal(button.buttons[0].reply.id, 'sel:confirm');
    assert.equal(button.buttons[0].reply.title, 'Continue');
  } finally { cap.restore(); }
});

test('a full card can be changed without restarting the section', async () => {
  const { sid, phone, poolOrders } = openAtSelector();
  const cap = captureWa();
  try {
    await examSvc.handleInbound(phone, 'START');
    for (const q of poolOrders.slice(0, 3)) {
      await examSvc.handleInbound(phone, '', { replyId: `sel:b:${q}` });
    }
    assert.deepEqual(tentative(sid), poolOrders.slice(0, 3));

    // At the quota, so only a deselect is possible — the fourth question is refused…
    await examSvc.handleInbound(phone, '', { replyId: `sel:b:${poolOrders[4]}` });
    assert.match(texts(cap.sent), /already 3 chosen/);
    assert.deepEqual(tentative(sid), poolOrders.slice(0, 3), 'the refused tap changed nothing');

    // …and swapping one for another stays inside the same stage.
    await examSvc.handleInbound(phone, '', { replyId: `sel:b:${poolOrders[1]}` });
    await examSvc.handleInbound(phone, '', { replyId: `sel:b:${poolOrders[4]}` });
    assert.deepEqual(tentative(sid), [poolOrders[0], poolOrders[2], poolOrders[4]]);
    assert.equal(sessionRow(sid).selection_state, 'selecting', 'no restart happened');
    assert.equal(pickers(cap.sent).length, 1, 'the one picker that opened the stage is still the only one');
  } finally { cap.restore(); }
});

test('typed numbers add up one at a time instead of replacing each other', async () => {
  const { sid, phone, poolOrders } = openAtSelector();
  const cap = captureWa();
  try {
    await examSvc.handleInbound(phone, 'START');
    await examSvc.handleInbound(phone, '1');
    await examSvc.handleInbound(phone, '3');
    assert.deepEqual(tentative(sid), [poolOrders[0], poolOrders[2]],
      'a single typed number ticks, it does not overwrite the card');
    await examSvc.handleInbound(phone, '2');
    await examSvc.handleInbound(phone, '2');           // untick
    assert.deepEqual(tentative(sid), [poolOrders[0], poolOrders[2]]);
    assert.equal(pickers(cap.sent).length, 1, 'typed replies never reopen the picker either');
  } finally { cap.restore(); }
});

test('Continue delivers only the chosen questions, in order, and never the picker again', async () => {
  const { sid, phone, poolOrders } = openAtSelector({ quota: 3, pool: 5 });
  const cap = captureWa();
  try {
    await examSvc.handleInbound(phone, 'START');
    // Choose 1, 3 and 4 of the five, leaving 2 and 5 behind.
    const picks = [poolOrders[0], poolOrders[2], poolOrders[3]];
    const dropped = [poolOrders[1], poolOrders[4]];
    for (const q of picks) await examSvc.handleInbound(phone, '', { replyId: `sel:b:${q}` });
    await examSvc.handleInbound(phone, 'CONTINUE');

    assert.match(texts(cap.sent), /Locked in/);
    assert.equal(sessionRow(sid).selection_state, '', 'the selection stage is closed');
    assert.equal(pickers(cap.sent).length, 1, 'the picker never comes back after Continue');

    // The first chosen question goes out with the commit, as a real question.
    const bubblesSoFar = questionBubbles(cap.sent);
    assert.ok(
      bubblesSoFar.some((t) => t.includes(drawnText(sid, picks[0]))),
      'the first chosen question is delivered in full'
    );
    for (const q of dropped) {
      assert.ok(
        !bubblesSoFar.some((t) => t.includes(drawnText(sid, q))),
        `question ${q} was not chosen, so it is never delivered`
      );
    }
    cap.sent.length = 0;

    // Each answer moves the chat on to the next pick, in the paper's own order.
    for (const expected of picks.slice(1)) {
      const mark = cap.sent.length;
      await examSvc.handleInbound(phone, `answer to ${expected}`);
      const asked = questionBubbles(cap.sent.slice(mark))[0];
      assert.ok(asked, `answering question ${expected} produced the next one`);
      assert.ok(asked.includes(drawnText(sid, expected)), `and it is question ${expected}, in full`);
    }

    assert.equal(pickers(cap.sent).length, 0, 'answering re-opens nothing');
    assert.equal(cards(cap.sent).length, 0, 'and no selection card returns either');
    assert.equal(
      cap.sent.filter((m) => (m.body || m.text || '').includes('Choose questions')).length, 0
    );
  } finally { cap.restore(); }
});

// The shape a real paper takes when it forces one question and still offers a
// choice: "answer any TWO of these THREE". The compulsory question is answered
// without being offered, the student picks ONE of the other two — the quota is
// the section's own total, so a paper that says 2 of 3 must never deliver three.
test('a "2 of 3" paper with a compulsory question asks for exactly one choice', async () => {
  const { sid, phone, poolOrders } = openAtSelector({ pool: 3, compulsory: 1, answerCount: 2 });
  const cap = captureWa();
  try {
    await examSvc.handleInbound(phone, 'START');
    assert.equal(pickers(cap.sent).length, 0, 'the forced question is delivered without being asked about');
    assert.ok(
      questionBubbles(cap.sent).some((t) => t.includes(drawnText(sid, 1))),
      'and it arrives in full'
    );

    await examSvc.handleInbound(phone, 'my answer to the compulsory one');
    const picker = pickers(cap.sent)[0];
    assert.ok(picker, 'the choice opens at the first question the student may refuse');
    assert.match(picker.body, /exactly 1 of the 2 questions below/, 'one choice is owed out of the two on offer');
    assert.match(picker.body, /[Cc]ompulsory/, 'and the forced question is named, never offered');
    assert.equal(picker.rows.length, 2, 'only the questions actually on offer are listed');
    assert.ok(
      picker.rows.every((r) => !r.title.includes('Question 1')),
      'the compulsory question is never a row a student could untick'
    );

    // Take the second question and leave the first optional behind.
    await examSvc.handleInbound(phone, '', { replyId: `sel:b:${poolOrders[1]}` });
    await examSvc.handleInbound(phone, 'CONTINUE');
    assert.match(texts(cap.sent), /Locked in/);
    assert.equal(sessionRow(sid).paper_total, 10, 'two questions at five marks each are owed');
    assert.equal(sessionRow(sid).selection_state, '', 'and the choice is closed for good');

    const delivered = questionBubbles(cap.sent);
    assert.ok(
      delivered.some((t) => t.includes(drawnText(sid, poolOrders[1]))),
      'the chosen question is delivered in full'
    );
    assert.ok(
      !delivered.some((t) => t.includes(drawnText(sid, poolOrders[0]))),
      'the question the student refused is never sent'
    );
  } finally { cap.restore(); }
});

test('a "4 of 5" paper with a compulsory question asks for three choices and bills four', async () => {
  const { sid, phone, poolOrders } = openAtSelector({ pool: 5, compulsory: 1, answerCount: 4 });
  const cap = captureWa();
  try {
    await examSvc.handleInbound(phone, 'START');
    await examSvc.handleInbound(phone, 'answer to the compulsory one');

    const picker = pickers(cap.sent)[0];
    assert.ok(picker, 'the choice opens after the forced question');
    assert.match(picker.body, /exactly 3 of the 4 questions below/);

    const picks = poolOrders.slice(0, 3);
    const dropped = poolOrders[3];
    for (const q of picks) await examSvc.handleInbound(phone, '', { replyId: `sel:b:${q}` });
    await examSvc.handleInbound(phone, 'CONTINUE');

    assert.match(texts(cap.sent), /Locked in/);
    assert.equal(sessionRow(sid).paper_total, 20, 'the forced one plus three choices: four questions priced');
    assert.equal(sessionRow(sid).selection_state, '', 'the choice is closed for good');
    assert.equal(pickers(cap.sent).length, 1, 'the picker came once and never returns');

    // The commit carries the first chosen question; each answer after it moves
    // the chat on to the next one, in the paper's own order.
    assert.ok(
      questionBubbles(cap.sent).some((t) => t.includes(drawnText(sid, picks[0]))),
      'the first chosen question goes out with the commit'
    );
    for (const expected of picks.slice(1)) {
      const mark = cap.sent.length;
      await examSvc.handleInbound(phone, `answer to ${expected}`);
      const asked = questionBubbles(cap.sent.slice(mark))[0];
      assert.ok(asked, `answering produced question ${expected}`);
      assert.ok(asked.includes(drawnText(sid, expected)), `and it is question ${expected}, in full`);
    }
    assert.ok(
      !questionBubbles(cap.sent).some((t) => t.includes(drawnText(sid, dropped))),
      'the question nobody chose is never sent'
    );
  } finally { cap.restore(); }
});

// The commit is also where the student finally sees their own paper: the exact
// numbers they will now be asked — compulsory ones named as such — and what the
// whole sheet is worth, so "scored out of 100" is a number seen BEFORE the
// questions start rather than one that appears in the result.
test('Continue prints the answer sheet: the numbers chosen and what the paper is worth', async () => {
  const { sid, phone, poolOrders } = openAtSelector({ pool: 3, compulsory: 1, answerCount: 2 });
  const cap = captureWa();
  try {
    await examSvc.handleInbound(phone, 'START');
    await examSvc.handleInbound(phone, 'answer to the compulsory one');
    await examSvc.handleInbound(phone, '', { replyId: `sel:b:${poolOrders[1]}` });
    cap.sent.length = 0;
    await examSvc.handleInbound(phone, 'CONTINUE');

    const sheet = cap.sent.find((m) => /here is your paper/.test(m.text || ''));
    assert.ok(sheet, 'the commit hands the student their own sheet');
    assert.match(sheet.text, /\*PAPER II — THEORY\*/, 'the paper is grouped the way the printed paper is');
    assert.match(
      sheet.text, /Q1 \(compulsory\), Q2/,
      'the compulsory question is named as such, the chosen one carries its number'
    );
    assert.match(
      sheet.text, /Total: 2 questions, 10 marks\. Your score is out of 10\./,
      'what the result is scored out of was on screen before the first question'
    );
    assert.equal(
      cap.sent.filter((m) => /here is your paper/.test(m.text || '')).length, 1,
      'the sheet is printed once, at the commit'
    );
    const sheetAt = cap.sent.indexOf(sheet);
    const askAt = cap.sent.findIndex((m) => /\*QUESTION \d+\*/.test(m.text || ''));
    assert.ok(askAt > sheetAt, 'and it arrives before the questions it describes');
  } finally { cap.restore(); }
});

// A resume, a nudge or a replay can still name a question the student refused
// at the selector: current_q_order is only a position, not a promise. The walk
// must continue at the first SELECTED question still owed — the one the student
// chose — and the refused one never reaches the chat.
test('a resume that names the refused question continues at the chosen one instead', async () => {
  const { sid, phone, poolOrders } = openAtSelector({ pool: 3, compulsory: 1, answerCount: 2 });
  const cap = captureWa();
  try {
    await examSvc.handleInbound(phone, 'START');
    await examSvc.handleInbound(phone, 'answer to the compulsory one');
    const refused = poolOrders[0]; // left behind at the selector
    const chosen = poolOrders[1];
    await examSvc.handleInbound(phone, '', { replyId: `sel:b:${chosen}` });
    await examSvc.handleInbound(phone, 'CONTINUE');
    cap.sent.length = 0;

    const session = sessionRow(sid);
    const student = db.prepare('SELECT * FROM students WHERE id = ?').get(session.student_id);
    await examSvc.sendQuestionTo(session, student, refused);

    assert.ok(
      !questionBubbles(cap.sent).some((t) => t.includes(drawnText(sid, refused))),
      'the refused question is never delivered, however the chat comes back to it'
    );
    assert.ok(
      questionBubbles(cap.sent).some((t) => t.includes(drawnText(sid, chosen))),
      'and the chosen one takes its place'
    );
  } finally { cap.restore(); }
});

// A crash can leave a replay queued against a question the student has since
// refused. recoverQueuedSends must retire that debt instead of paying it —
// otherwise the refused question returns to the chat after the choice closed.
test('a queued replay of a refused question is retired on recovery, not delivered', async () => {
  const { sid, phone, poolOrders } = openAtSelector({ pool: 3, compulsory: 1, answerCount: 2 });
  const cap = captureWa();
  try {
    await examSvc.handleInbound(phone, 'START');
    await examSvc.handleInbound(phone, 'answer to the compulsory one');
    const refused = poolOrders[0];
    await examSvc.handleInbound(phone, '', { replyId: `sel:b:${poolOrders[1]}` });
    await examSvc.handleInbound(phone, 'CONTINUE');

    // The replay was written before the choice was made and never confirmed.
    const qid = db.prepare(
      'SELECT question_id FROM session_questions WHERE session_id = ? AND q_order = ?'
    ).get(sid, refused).question_id;
    const queued = db.prepare(
      `INSERT INTO message_outbox(session_id, question_id, q_order, kind, recipient, state)
       VALUES (?, ?, ?, 'question', ?, 'queued')`
    ).run(sid, qid, refused, phone);
    cap.sent.length = 0;

    await examSvc.recoverQueuedSends();

    assert.equal(
      db.prepare('SELECT state FROM message_outbox WHERE id = ?').get(queued.lastInsertRowid).state,
      'sent', 'the debt against a refused question is retired, not retried'
    );
    assert.ok(
      !questionBubbles(cap.sent).some((t) => t.includes(drawnText(sid, refused))),
      'and the refused question never reaches the chat'
    );
  } finally { cap.restore(); }
});

// The same refusal retires everything still queued for the question in the
// same breath: a queued figure would otherwise put its diagram alone above
// whatever the student is answering by then, minutes after the choice closed.
test('the commit retires queued sends still owed to a refused question', async () => {
  const { sid, phone, poolOrders } = openAtSelector({ pool: 3, compulsory: 1, answerCount: 2 });
  const cap = captureWa();
  try {
    await examSvc.handleInbound(phone, 'START');
    await examSvc.handleInbound(phone, 'answer to the compulsory one');
    const refused = poolOrders[0];
    const qid = db.prepare(
      'SELECT question_id FROM session_questions WHERE session_id = ? AND q_order = ?'
    ).get(sid, refused).question_id;
    const queuedQuestion = db.prepare(
      `INSERT INTO message_outbox(session_id, question_id, q_order, kind, recipient, state)
       VALUES (?, ?, ?, 'question', ?, 'queued')`
    ).run(sid, qid, refused, phone);
    const queuedFigure = db.prepare(
      `INSERT INTO message_outbox(session_id, question_id, q_order, kind, recipient, state)
       VALUES (?, ?, ?, 'figure', ?, 'queued')`
    ).run(sid, qid, refused, phone);

    await examSvc.handleInbound(phone, '', { replyId: `sel:b:${poolOrders[1]}` });
    await examSvc.handleInbound(phone, 'CONTINUE');

    const state = (id) => db.prepare('SELECT state FROM message_outbox WHERE id = ?').get(id).state;
    assert.equal(state(queuedQuestion.lastInsertRowid), 'sent', 'the refused question’s replay dies with the refusal');
    assert.equal(state(queuedFigure.lastInsertRowid), 'sent', 'and so does its diagram');
    assert.ok(
      !questionBubbles(cap.sent).some((t) => t.includes(drawnText(sid, refused))),
      'nothing owed to the refused question is delivered'
    );
  } finally { cap.restore(); }
});

// The reported exam, walked exactly as it was reported: six theory questions,
// the student taps the numbers for three of them (positions 1, 2 and 4), and
// everything that follows — the sheet, every question bubble, the score
// denominator — must be the objectives plus those three and nothing else,
// priced at the paper's full 100 marks.
test('choosing questions 1, 2 and 4 delivers only those, and the paper totals 100', async () => {
  const eid = db.prepare(
    "INSERT INTO exams(title,duration_minutes,status) VALUES ('Mixed Paper',30,'live')"
  ).run().lastInsertRowid;
  const options = JSON.stringify([{ key: 'A', text: 'Yes' }, { key: 'B', text: 'No' }]);
  // Section A: four objectives at 10 marks — answered in full, no choice.
  for (let i = 1; i <= 4; i++) {
    db.prepare(
      `INSERT INTO questions(exam_id,q_order,type,text,marks,options,correct_answer,section_key)
       VALUES (?,?,'objective',?,10,?,'A','a')`
    ).run(eid, i, `Objective question ${i}?`, options);
  }
  // Section B: six theory questions at 20 marks, answer any three — 4×10 + 3×20
  // = 100, which is the price the student must end up graded against. Real
  // sentence-shaped texts: a short "Theory 2 body" line reads as a section
  // heading (isSectionHeader) and would travel as its own header bubble.
  for (let i = 1; i <= 6; i++) {
    db.prepare(
      `INSERT INTO questions(exam_id,q_order,type,text,marks,is_compulsory,section_key)
       VALUES (?,?,'theory',?,20,0,'b')`
    ).run(eid, i + 4, `Theory question ${i}: explain it in detail with a labelled diagram.`);
  }
  db.prepare(
    `INSERT INTO exam_sections(exam_id,section_key,title,instructions,position,answer_count)
     VALUES (?, 'a', 'SECTION A', '', 0, 0)`
  ).run(eid);
  db.prepare(
    `INSERT INTO exam_sections(exam_id,section_key,title,instructions,position,answer_count)
     VALUES (?, 'b', 'SECTION B', 'Answer any THREE questions', 1, 3)`
  ).run(eid);

  // The admin's side: the rules must price the paper at its full 100 marks
  // before a single student sits it.
  const pricing = selection.pricingSummary(eid);
  assert.equal(pricing.exact, true, 'every theory question on offer carries the same marks, so any pick costs the same');
  assert.equal(pricing.priced, 100, 'the rules price the paper at its full 100 marks');
  assert.equal(pricing.poolTotal, 160, 'the pool holds every question, but no student is graded against it');
  assert.equal(selection.answerableCount(eid), 7, 'four objectives plus three chosen theory questions');

  const phone = `233555${String(++phoneSeq).padStart(6, '0')}`;
  const studentId = db.prepare('INSERT INTO students(phone) VALUES (?)').run(phone).lastInsertRowid;
  db.prepare('INSERT INTO exam_recipients(exam_id,student_id) VALUES (?,?)').run(eid, studentId);
  const sid = examSvc.createSession(eid, studentId).id;
  db.prepare(
    `INSERT INTO message_outbox(session_id, question_id, q_order, kind, recipient, state)
     VALUES (?, 0, NULL, 'intro', ?, 'sent')`
  ).run(sid, phone);
  const poolOrders = selection.sessionPlan(sid).find((s) => s.section_key === 'b').optional
    .map((q) => q.q_order);
  // Positions 1, 2 and 4 of the six on offer: q_orders 5, 6 and 8 — leaving
  // 7, 9 and 10 behind.
  const picks = [poolOrders[0], poolOrders[1], poolOrders[3]];
  const refused = [poolOrders[2], poolOrders[4], poolOrders[5]];
  assert.equal(poolOrders.length, 6, 'all six theory questions are on offer');

  const cap = captureWa();
  try {
    // What the chat promises before the paper opens: seven questions, 100
    // marks — never the ten questions the pool happens to hold.
    const examRow = db.prepare('SELECT * FROM exams WHERE id = ?').get(eid);
    const intro = examSvc.formatExamIntro(examRow, 10);
    assert.match(intro, /Number of questions: \*7\* \(the ones you will answer\)/,
      'the intro promises the questions the student will answer, not the pool');
    assert.match(intro, /Your paper is worth \*100 marks\*/,
      'and says what the paper is worth before the student commits to anything');

    await examSvc.handleInbound(phone, 'START');
    // Objectives first, every one of them.
    for (let i = 1; i <= 4; i++) await examSvc.handleInbound(phone, 'A');
    const picker = pickers(cap.sent)[0];
    assert.ok(picker, 'the theory choice opens once the objectives are done');
    assert.match(picker.body, /exactly 3 of the 6 questions below/);

    for (const q of picks) await examSvc.handleInbound(phone, '', { replyId: `sel:b:${q}` });
    await examSvc.handleInbound(phone, 'CONTINUE');

    // The commit re-prices the paper: the full draw was 160, the choice is 100.
    assert.equal(sessionRow(sid).paper_total, 100, 'the paper is re-priced to what was actually chosen');
    const sheet = cap.sent.find((m) => /here is your paper/.test(m.text || ''));
    assert.ok(sheet, 'the commit prints the student their own sheet');
    assert.match(sheet.text, /Total: 7 questions, 100 marks\. Your score is out of 100\./,
      'the sheet says the score is out of the 100 the rules priced');

    // Nothing after the commit may name a refused question — the picker and
    // the cards named them all before it, which is the choice itself.
    const lockAt = cap.sent.indexOf(sheet);
    const afterCommit = cap.sent.slice(lockAt + 1).map((m) => m.text || '').join('\n');
    for (const q of refused) {
      assert.ok(
        !afterCommit.includes(drawnText(sid, q)),
        `question ${q} was not chosen, so it never reaches the chat again`
      );
    }

    // Each answer moves on to the next CHOSEN question, in paper order.
    for (const expected of picks.slice(1)) {
      const mark = cap.sent.length;
      await examSvc.handleInbound(phone, `answer to ${expected}`);
      const asked = questionBubbles(cap.sent.slice(mark))[0];
      assert.ok(asked, `answering produced question ${expected}`);
      assert.ok(asked.includes(drawnText(sid, expected)), `and it is question ${expected}, in full — got: ${JSON.stringify(cap.sent.slice(mark))}`);
    }

    // The last chosen answer completes the paper.
    const finalMark = cap.sent.length;
    await examSvc.handleInbound(phone, 'final answer');

    // Whole-chat check: every objective and every chosen question was
    // delivered — the paper the student walked is exactly the seven.
    const allText = cap.sent.map((m) => m.text || '').join('\n');
    for (let q = 1; q <= 10; q++) {
      const shouldDeliver = q <= 4 || picks.includes(q);
      assert.equal(
        allText.includes(drawnText(sid, q)), shouldDeliver,
        `question ${q} ${shouldDeliver ? 'must be' : 'must never be'} in the chat`
      );
    }

    // And exactly those seven were ANSWERED — the refused three hold no rows.
    const answeredOrders = db.prepare('SELECT q_order FROM answers WHERE session_id = ?')
      .all(sid).map((r) => r.q_order).sort((a, b) => a - b);
    assert.deepEqual(answeredOrders, [1, 2, 3, 4, 5, 6, 8],
      'only the objectives and the chosen questions hold answers');

    // The grade is out of 100, because the objectives plus the choices ARE 100.
    const resultText = cap.sent.slice(finalMark).map((m) => m.text || '').join('\n');
    assert.match(resultText, /Score: \*\d+ \/ 100\*/,
      'the result message grades out of the 100 marks the paper was priced at');
    assert.match(resultText, /Percentage: \*\d+(\.\d+)?%\*/);
  } finally { cap.restore(); }
});

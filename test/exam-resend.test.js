'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'exam-resend-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.UPLOADS_DIR = path.join(tmp, 'uploads');
process.env.DOTENV_CONFIG_PATH = path.join(tmp, '.env');
process.env.SEED_ON_BOOT = 'false';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const exam = require('../src/services/exam');
const wa = require('../src/services/whatsapp');
const config = require('../src/config');
config.exam.sendCertificates = false;
after(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

let seq = 0;
function fixture(studentCount = 2) {
  const eid = db.prepare("INSERT INTO exams(title,duration_minutes,status) VALUES ('Resend',30,'live')").run().lastInsertRowid;
  db.prepare("INSERT INTO questions(exam_id,q_order,type,text,options,correct_answer) VALUES (?,1,'objective','Q1',?,'A')")
    .run(eid, JSON.stringify([{ key: 'A', text: 'Yes' }, { key: 'B', text: 'No' }]));
  const ids = [];
  const phones = [];
  for (let i = 0; i < studentCount; i++) {
    const phone = '233resend' + (seq++) + eid;
    const sid = db.prepare('INSERT INTO students(phone) VALUES (?)').run(phone).lastInsertRowid;
    db.prepare('INSERT INTO exam_recipients(exam_id,student_id) VALUES (?,?)').run(eid, sid);
    ids.push(sid);
    phones.push(phone);
  }
  return { eid, ids, phones };
}

// Captures every outbound text so a test can assert on what the student was
// actually sent, not just on the counters the report carries.
function captureSends() {
  const sent = [];
  const original = wa.sendText;
  wa.sendText = async (phone, text) => { sent.push(String(text)); return { messages: [{ id: 'mock' }] }; };
  wa.sendImage = async () => {};
  return { sent, restore: () => { wa.sendText = original; } };
}

test('auto-target resend reaches only recipients who never started', async () => {
  const { eid, ids, phones } = fixture(2);
  const cap = captureSends();
  try {
    await exam.sendExamToRecipients(eid);
    await exam.handleInbound(phones[0], 'START');
    const report = await exam.resendExamToRecipients(eid, null);
    assert.equal(report.sent, 1, 'only the never-started student is re-invited');
    assert.ok(db.prepare('SELECT started_at FROM sessions WHERE exam_id=? AND student_id=?').get(eid, ids[0]).started_at,
      'the student who already began keeps their start time');
  } finally { cap.restore(); }
});

test('an explicit studentIds list overrides auto-targeting', async () => {
  const { eid, ids } = fixture(2);
  const cap = captureSends();
  try {
    await exam.sendExamToRecipients(eid);
    const report = await exam.resendExamToRecipients(eid, [ids[0]]);
    assert.equal(report.sent, 1);
    assert.equal(report.sent + report.skipped, 1, 'only the requested student is touched');
  } finally { cap.restore(); }
});

test('resending to a student mid-exam nudges instead of restarting', async () => {
  const { eid, ids, phones } = fixture(1);
  const cap = captureSends();
  try {
    await exam.sendExamToRecipients(eid);
    await exam.handleInbound(phones[0], 'START');
    const before = db.prepare('SELECT id, current_q_order FROM sessions WHERE exam_id=? AND student_id=?').get(eid, ids[0]);
    cap.sent.length = 0;
    const report = await exam.resendExamToRecipients(eid, [ids[0]]);
    assert.equal(report.resumed, 1, 'a live attempt is nudged');
    const after = db.prepare('SELECT id, current_q_order FROM sessions WHERE exam_id=? AND student_id=?').get(eid, ids[0]);
    assert.equal(after.id, before.id, 'no new attempt is created');
    assert.equal(after.current_q_order, before.current_q_order, 'position is unchanged');
    assert.ok(cap.sent.join('\n').includes('QUESTION 1'), 'the current question is re-delivered');
  } finally { cap.restore(); }
});

test('resending to a student who finished is skipped', async () => {
  const { eid, ids } = fixture(1);
  const cap = captureSends();
  try {
    await exam.sendExamToRecipients(eid);
    const s = db.prepare('SELECT id FROM sessions WHERE exam_id=? AND student_id=?').get(eid, ids[0]);
    db.prepare("UPDATE sessions SET status='completed' WHERE id=?").run(s.id);
    const report = await exam.resendExamToRecipients(eid, [ids[0]]);
    assert.equal(report.skipped, 1);
    assert.equal(report.sent, 0);
  } finally { cap.restore(); }
});

test('a resend to an unstarted student re-invites rather than starting the clock', async () => {
  const { eid, ids, phones } = fixture(1);
  const cap = captureSends();
  try {
    await exam.sendExamToRecipients(eid);
    cap.sent.length = 0;
    const report = await exam.resendExamToRecipients(eid, null);
    assert.equal(report.sent, 1);
    assert.equal(db.prepare('SELECT started_at FROM sessions WHERE exam_id=? AND student_id=?').get(eid, ids[0]).started_at, null,
      'resending must not start the clock');
    assert.ok(cap.sent.join('\n').includes('INSTRUCTIONS'), 'the invite is re-delivered');
    assert.ok(!cap.sent.join('\n').includes('QUESTION 1'), 'still no question until the student replies');
  } finally { cap.restore(); }
});

test('the resend report keeps the shape the dashboard already renders', async () => {
  const { eid } = fixture(1);
  const cap = captureSends();
  try {
    const report = await exam.resendExamToRecipients(eid, null);
    for (const key of ['sent', 'failed', 'skipped', 'resumed', 'errors']) {
      assert.ok(key in report, `report must include ${key}`);
    }
  } finally { cap.restore(); }
});

test('an ended exam cannot be resent', async () => {
  const { eid, ids } = fixture(1);
  const cap = captureSends();
  try {
    db.prepare("UPDATE exams SET status='ended' WHERE id=?").run(eid);
    const report = await exam.resendExamToRecipients(eid, [ids[0]]);
    assert.equal(report.sent, 0);
    assert.equal(report.skipped, 1);
  } finally { cap.restore(); }
});

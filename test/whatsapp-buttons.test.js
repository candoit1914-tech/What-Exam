'use strict';
require('./helpers/isolate');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const wa = require('../src/services/whatsapp');
const exam = require('../src/services/exam');
const webhookRoute = require('../src/routes/webhook');

const webhook = (messages) => ({
  entry: [{ changes: [{ value: { messages } }] }],
});

test('a WhatsApp template Start quick reply is parsed as an exam-entry tap', () => {
  const [event] = wa.parseWebhook(webhook([{
    from: '233201234567',
    id: 'wamid.template-start',
    timestamp: '1760000000',
    type: 'button',
    button: { payload: 'START_EXAM', text: 'Start' },
  }]));

  assert.equal(event.type, 'message');
  assert.equal(event.interactiveType, 'button');
  assert.equal(event.body, 'Start');
  assert.equal(event.replyId, 'START_EXAM');
  assert.equal(exam.isEntryRequest(event.body, event), true);
});

test('interactive button and list replies keep their IDs and labels', () => {
  const events = wa.parseWebhook(webhook([
    {
      from: '233201234567', id: 'wamid.button', type: 'interactive',
      interactive: { type: 'button_reply', button_reply: { id: 'START', title: 'Start' } },
    },
    {
      from: '233201234567', id: 'wamid.list', type: 'interactive',
      interactive: { type: 'list_reply', list_reply: { id: 'A', title: 'A. Accra' } },
    },
  ]));

  assert.equal(events[0].replyId, 'START');
  assert.equal(events[0].body, 'Start');
  assert.equal(events[1].replyId, 'A');
  assert.equal(events[1].body, 'A. Accra');
});

test('webhook accepts a reply ID even if Meta omits its display text', () => {
  const [event] = wa.parseWebhook(webhook([{
    from: '233201234567',
    id: 'wamid.interactive-start',
    type: 'interactive',
    interactive: { type: 'button_reply', button_reply: { id: 'START_EXAM' } },
  }]));
  assert.equal(event.body, '');
  assert.equal(event.replyId, 'START_EXAM');
  assert.equal(webhookRoute.shouldProcessInbound(event), true);
  assert.equal(exam.isEntryRequest(event.body, event), true);
});

test('tapping Start starts the exam and delivers question 1 immediately', async () => {
  const examId = db.prepare(
    "INSERT INTO exams (title, subject, duration_minutes, status) VALUES ('Button Start', 'Math', 30, 'live')"
  ).run().lastInsertRowid;
  const studentId = db.prepare('INSERT INTO students(phone) VALUES (?)').run('233200000001').lastInsertRowid;
  db.prepare('INSERT INTO exam_recipients(exam_id,student_id) VALUES (?,?)').run(examId, studentId);
  db.prepare(
    "INSERT INTO questions (exam_id,q_order,type,text,options,correct_answer) VALUES (?,1,'objective','QUESTION 1: Choose one',?, 'A')"
  ).run(examId, JSON.stringify([{ key: 'A', text: 'Yes' }, { key: 'B', text: 'No' }]));

  const sent = [];
  const originalSendText = wa.sendText;
  wa.sendText = async (_phone, text) => { sent.push(String(text)); return { messages: [{ id: 'mock' }] }; };
  try {
    await exam.sendExamToRecipients(examId);
    sent.length = 0;
    const [event] = wa.parseWebhook(webhook([{
      from: '233200000001',
      id: 'wamid.start',
      type: 'button',
      button: { payload: 'START_EXAM', text: 'Start' },
    }]));

    const result = await exam.handleInbound(event.phone, event.body, event);
    assert.equal(result.started, true);
    assert.ok(sent.some((text) => /QUESTION 1/.test(text)), 'question 1 should be sent by the Start tap');
    assert.ok(db.prepare('SELECT started_at FROM sessions WHERE exam_id=?').get(examId).started_at);
  } finally {
    wa.sendText = originalSendText;
  }
});

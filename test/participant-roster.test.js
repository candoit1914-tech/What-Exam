'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'exam-roster-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.UPLOADS_DIR = path.join(tmp, 'uploads');
process.env.SEED_ON_BOOT = 'false';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const results = require('../src/services/results');
after(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

function newExam(title) {
  return db
    .prepare("INSERT INTO exams(title,duration_minutes,status,pass_percentage) VALUES (?,30,'live',50)")
    .run(title).lastInsertRowid;
}

let phoneSeq = 0;
function addStudent(eid, name, sent = true) {
  const sid = db
    .prepare('INSERT INTO students(phone,name) VALUES (?,?)')
    .run('233r' + ++phoneSeq + String(name).replace(/\W/g, '').slice(0, 6), name).lastInsertRowid;
  db.prepare('INSERT INTO exam_recipients(exam_id,student_id,sent_at) VALUES (?,?,?)')
    .run(eid, sid, sent ? '2026-01-01 09:00:00' : null);
  return sid;
}

// current_q_order is always 1 — the next question to serve, not a count of
// what has been answered. Left at 1 on purpose: the roster must not echo it.
function addSession(eid, sid, { status = 'in_progress', pct = 0, score = 0, attempt = 1, ended = null, answers = 0 } = {}) {
  const sess = db
    .prepare(
      `INSERT INTO sessions(exam_id,student_id,status,final_score,final_percentage,passed,attempt_no,ended_at,current_q_order)
       VALUES (?,?,?,?,?,?,?,?,1)`
    )
    .run(eid, sid, status, score, pct, pct >= 50 ? 1 : 0, attempt, ended).lastInsertRowid;
  for (let i = 1; i <= answers; i++) {
    db.prepare('INSERT INTO answers(session_id,question_id,q_order,answer_text) VALUES (?,?,?,?)')
      .run(sess, 900000 + i, i, 'A');
  }
  return sess;
}

// One exam, three recipients with finished sessions carrying distinct scores.
function seedFinished() {
  const eid = newExam('Bio');
  return {
    eid,
    low: addSession(eid, addStudent(eid, 'Low Learner'), { status: 'completed', pct: 30, score: 3, ended: '2026-01-01 10:00:00' }),
    high: addSession(eid, addStudent(eid, 'High Learner'), { status: 'completed', pct: 90, score: 9, ended: '2026-01-01 10:05:00' }),
    mid: addSession(eid, addStudent(eid, 'Mid Learner'), { status: 'expired', pct: 60, score: 6, ended: '2026-01-01 10:10:00' }),
  };
}

test('finished students are ranked by percentage, highest first', () => {
  const { eid } = seedFinished();
  const roster = results.buildParticipantRoster(eid);
  const names = roster.finished.map((r) => r.name);
  assert.deepEqual(names, ['High Learner', 'Mid Learner', 'Low Learner']);
  assert.deepEqual(roster.finished.map((r) => r.rank), [1, 2, 3]);
});

test('only a student\'s best finished attempt is ranked', () => {
  const eid = db.prepare("INSERT INTO exams(title,duration_minutes,status) VALUES ('Retry',30,'live')").run().lastInsertRowid;
  const sid = db.prepare("INSERT INTO students(phone,name) VALUES ('233retry','Retrier')").run().lastInsertRowid;
  db.prepare('INSERT INTO exam_recipients(exam_id,student_id) VALUES (?,?)').run(eid, sid);
  for (const [pct, attempt] of [[20, 1], [80, 2]]) {
    db.prepare(
      `INSERT INTO sessions(exam_id,student_id,status,final_score,final_percentage,passed,attempt_no)
       VALUES (?,?,'completed',?,?,1,?)`
    ).run(eid, sid, pct / 10, pct, attempt);
  }
  const roster = results.buildParticipantRoster(eid);
  assert.equal(roster.finished.length, 1, 'one row per student, not one per attempt');
  assert.equal(roster.finished[0].final_percentage, 80);
  assert.equal(roster.finished[0].attempt_no, 2);
});

test('a percentage tie is broken by the higher final score', () => {
  const eid = newExam('Score Tie');
  // Inserted first, and the earlier ended_at belongs to the LOWER score, so
  // only a real final_score tie-break can put Higher Score on top.
  addSession(eid, addStudent(eid, 'Lower Score'), { status: 'completed', pct: 50, score: 5, ended: '2026-01-01 09:00:00' });
  addSession(eid, addStudent(eid, 'Higher Score'), { status: 'completed', pct: 50, score: 8, ended: '2026-01-01 10:00:00' });
  const roster = results.buildParticipantRoster(eid);
  assert.deepEqual(roster.finished.map((r) => r.name), ['Higher Score', 'Lower Score']);
  assert.deepEqual(roster.finished.map((r) => r.rank), [1, 2]);
});

test('a percentage and score tie is broken by the earlier ended_at', () => {
  const eid = newExam('Ended Tie');
  // Inserted first, so without an ended_at tie-break the natural order is wrong.
  addSession(eid, addStudent(eid, 'Ended Later'), { status: 'completed', pct: 50, score: 5, ended: '2026-01-01 11:00:00' });
  addSession(eid, addStudent(eid, 'Ended Earlier'), { status: 'completed', pct: 50, score: 5, ended: '2026-01-01 10:00:00' });
  const roster = results.buildParticipantRoster(eid);
  assert.deepEqual(roster.finished.map((r) => r.name), ['Ended Earlier', 'Ended Later']);
  assert.deepEqual(roster.finished.map((r) => r.rank), [1, 2]);
});

test('a live retry does not let a student outrank one who finished earlier', () => {
  const eid = newExam('Live Retry');
  // The retry has ended_at NULL, which sorts first in SQL and used to promote
  // this student above the one who actually finished first.
  const late = addStudent(eid, 'Late Finsher');
  addSession(eid, late, { status: 'completed', pct: 0, score: 0, ended: '2026-01-01 11:00:00' });
  addSession(eid, late, { status: 'in_progress', attempt: 2 });
  addSession(eid, addStudent(eid, 'Early Finsher'), { status: 'completed', pct: 0, score: 0, ended: '2026-01-01 10:00:00' });

  const roster = results.buildParticipantRoster(eid);
  assert.deepEqual(roster.finished.map((r) => r.name), ['Early Finsher', 'Late Finsher']);
  assert.deepEqual(roster.finished.map((r) => r.rank), [1, 2]);
});

test('the best attempt is chosen by score when two attempts tie on percentage', () => {
  const eid = newExam('Attempt Score Tie');
  const sid = addStudent(eid, 'Tied Retrier');
  addSession(eid, sid, { status: 'completed', pct: 50, score: 3, attempt: 1, ended: '2026-01-01 09:00:00' });
  addSession(eid, sid, { status: 'completed', pct: 50, score: 9, attempt: 2, ended: '2026-01-01 10:00:00' });
  const roster = results.buildParticipantRoster(eid);
  assert.equal(roster.finished.length, 1, 'one row per student, not one per attempt');
  assert.equal(roster.finished[0].final_score, 9);
  assert.equal(roster.finished[0].attempt_no, 2);
});

test('an unfinished student reports no score, never a fabricated zero', () => {
  const eid = newExam('Still Sitting');
  addSession(eid, addStudent(eid, 'Still Sitting'), { status: 'in_progress' });
  const roster = results.buildParticipantRoster(eid);
  assert.equal(roster.inProgress.length, 1);
  const row = roster.inProgress[0];
  assert.equal(row.final_percentage, null, 'a default 0 would print as a real 0% score');
  assert.equal(row.final_score, null);
  assert.equal(row.passed, null);
});

test('a never-started recipient reports no score and no answers', () => {
  const eid = newExam('Undelivered');
  addStudent(eid, 'Never Got It', false);
  const roster = results.buildParticipantRoster(eid);
  assert.equal(roster.notSent.length, 1);
  const row = roster.notSent[0];
  assert.equal(row.final_percentage, null, 'a never-started row must agree with an unfinished one');
  assert.equal(row.final_score, null);
  assert.equal(row.passed, null);
  assert.equal(row.questions_answered, 0);
});

test('a student mid-restart is in progress, not filed as not started', () => {
  const eid = newExam('Restarted');
  const sid = addStudent(eid, 'Restarter');
  // restartSession() retires the old attempt as 'abandoned' WITHOUT setting
  // ended_at, and the retired row keeps its partial answers. Both attempts
  // therefore tie on the window's three sort keys.
  addSession(eid, sid, { status: 'abandoned', attempt: 1, answers: 1 });
  addSession(eid, sid, { status: 'in_progress', attempt: 2, answers: 2 });

  const roster = results.buildParticipantRoster(eid);
  assert.deepEqual(roster.inProgress.map((r) => r.name), ['Restarter'], 'actively sitting attempt 2');
  assert.deepEqual(roster.notStarted, [], 'must not be reported as not started');
  assert.deepEqual(roster.notSent, [], 'the recipient was sent, so not sent is impossible too');
  assert.equal(roster.inProgress[0].questions_answered, 2, 'must count the live attempt, not the retired one');
  assert.equal(roster.inProgress[0].attempt_no, 2);
});

test('questions_answered counts real answers, not the next question order', () => {
  const eid = newExam('Answered');
  addSession(eid, addStudent(eid, 'Answerer'), { status: 'completed', pct: 70, score: 7, ended: '2026-01-01 10:00:00', answers: 3 });
  addSession(eid, addStudent(eid, 'Silent'), { status: 'completed', pct: 0, score: 0, ended: '2026-01-01 10:30:00', answers: 0 });
  const roster = results.buildParticipantRoster(eid);
  const byName = Object.fromEntries(roster.finished.map((r) => [r.name, r]));
  assert.equal(byName['Answerer'].questions_answered, 3);
  assert.equal(byName['Silent'].questions_answered, 0, 'current_q_order is 1 even with nothing answered');
});

test('an abandoned session with no sent_at is reported as not sent', () => {
  const eid = newExam('Never Delivered');
  addSession(eid, addStudent(eid, 'Never Delivered', false), { status: 'abandoned', ended: '2026-01-01 10:00:00' });
  const roster = results.buildParticipantRoster(eid);
  assert.deepEqual(roster.notSent.map((r) => r.name), ['Never Delivered']);
  assert.deepEqual(roster.notStarted, []);
});

test('an abandoned session with a sent_at is reported as not started', () => {
  const eid = newExam('Delivered Then Dropped');
  addSession(eid, addStudent(eid, 'Delivered Then Dropped'), { status: 'abandoned', ended: '2026-01-01 10:00:00' });
  const roster = results.buildParticipantRoster(eid);
  assert.deepEqual(roster.notStarted.map((r) => r.name), ['Delivered Then Dropped']);
  assert.deepEqual(roster.notSent, []);
});


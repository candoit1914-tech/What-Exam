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

test('the four sections are mutually exclusive and cover every recipient', () => {
  const eid = newExam('Mix');
  // addStudent() ALWAYS creates the exam_recipients row and only varies
  // sent_at. That row is what makes someone a participant at all: it is created
  // when the admin adds the student, and sent_at is stamped on delivery. So
  // "never told" is a recipient with a NULL sent_at, NOT a student who was
  // never added — a student with no recipient row is not on the exam and
  // summary.total, which counts recipients, must not include them.
  addSession(eid, addStudent(eid, 'Finished One'), { status: 'completed', pct: 80, score: 8, ended: '2026-01-01 10:00:00' });
  addSession(eid, addStudent(eid, 'Running'), { status: 'in_progress' });
  addStudent(eid, 'Waiting');               // delivered, never opened
  addStudent(eid, 'Never Told', false);     // recipient, delivery never succeeded

  const r = results.buildParticipantRoster(eid);
  const all = [...r.finished, ...r.inProgress, ...r.notStarted, ...r.notSent];
  const ids = all.map((x) => x.student_id);
  assert.equal(ids.length, 4, 'every recipient appears exactly once');
  assert.equal(new Set(ids).size, 4, 'no student appears in two sections');
  assert.equal(r.finished.length, 1);
  assert.equal(r.inProgress.length, 1);
  assert.equal(r.notStarted.length, 1);
  assert.equal(r.notSent.length, 1);
  assert.deepEqual(r.finished.map((x) => x.name), ['Finished One']);
  assert.deepEqual(r.inProgress.map((x) => x.name), ['Running']);
  assert.deepEqual(r.notStarted.map((x) => x.name), ['Waiting']);
  assert.deepEqual(r.notSent.map((x) => x.name), ['Never Told']);
  assert.equal(r.summary.total, 4, 'summary.total counts recipients, nothing else');
  assert.equal(r.summary.finished, r.finished.length);
  assert.equal(r.summary.inProgress, r.inProgress.length);
  assert.equal(r.summary.notStarted, r.notStarted.length);
  assert.equal(r.summary.notSent, r.notSent.length);
});

test('a student with no final percentage sorts last instead of erroring', () => {
  const eid = db
    .prepare("INSERT INTO exams(title,duration_minutes,status) VALUES ('Nulls',30,'live')")
    .run().lastInsertRowid;
  // 'Ungraded' carries a real final_score on purpose. The score tie-break in
  // the sort coalesces a NULL score to -1, so a row with BOTH fields NULL lands
  // last no matter what the percentage line decides — the test would then pin
  // nothing about NULL percentage ordering. A high score plus a missing
  // percentage is the only shape where the percentage line alone decides.
  const mk = (name, score, pct) => {
    const sid = db.prepare('INSERT INTO students(phone,name) VALUES (?,?)').run('233' + Math.random().toString(36).slice(2, 8), name).lastInsertRowid;
    db.prepare('INSERT INTO exam_recipients(exam_id,student_id) VALUES (?,?)').run(eid, sid);
    db.prepare(
      `INSERT INTO sessions(exam_id,student_id,status,final_score,final_percentage)
       VALUES (?,?,'completed',?,?)`
    ).run(eid, sid, score, pct);
  };
  mk('Graded', 7.5, 75);
  mk('Zero', 0, 0);        // a genuine 0% result, not a missing one
  mk('Ungraded', 9, null); // outscores Zero and still has no percentage

  const r = results.buildParticipantRoster(eid);
  assert.equal(r.finished.length, 3);
  const names = r.finished.map((x) => x.name);
  assert.equal(r.finished[r.finished.length - 1].name, 'Ungraded', 'NULL percentage must sort last');
  assert.ok(
    names.indexOf('Zero') < names.indexOf('Ungraded'),
    'a missing percentage must sort after a real 0%, not tie with it'
  );
  assert.equal(
    r.finished.find((x) => x.name === 'Ungraded').final_percentage,
    null,
    'sorting last must not turn a missing percentage into a 0'
  );
});

test('a not-started recipient still reports the allotted time', () => {
  const eid = db
    .prepare("INSERT INTO exams(title,duration_minutes,status) VALUES ('Timer',45,'live')")
    .run().lastInsertRowid;
  // A delivered invite the student never opened: there is no session row, so
  // every session column is NULL for this row.
  addStudent(eid, 'Waiter');
  // The other way a student lands in notStarted — a delivered invite whose
  // session was abandoned. current_q_order is 7 with zero answers recorded, so
  // a 0 in questions_answered can only have come from a real COUNT(*) over the
  // answers table; an implementation echoing current_q_order reports 7 here.
  const dropped = addStudent(eid, 'Dropper');
  db.prepare(
    "INSERT INTO sessions(exam_id,student_id,status,current_q_order,ended_at) VALUES (?,?,'abandoned',7,'2026-01-01 10:00:00')"
  ).run(eid, dropped);

  const r = results.buildParticipantRoster(eid);
  const byName = Object.fromEntries(r.notStarted.map((x) => [x.name, x]));
  assert.deepEqual(Object.keys(byName).sort(), ['Dropper', 'Waiter'], 'both delivered students are not started');
  assert.equal(byName['Waiter'].questions_answered, 0, 'no session row at all');
  assert.equal(byName['Dropper'].questions_answered, 0, 'current_q_order is 7, so this must be a real answer count');
  assert.equal(r.exam.duration_minutes, 45);
  for (const name of ['Dropper', 'Waiter']) {
    assert.equal(byName[name].final_percentage, null, `${name} must not be shown a fabricated 0%`);
  }
});

// ── Print page ─────────────────────────────────────────────────────────
// The print view is a standalone document: no app CSS, no JavaScript, no
// buttons. The browser's own print dialog provides the paper output and
// "Save as PDF" in one click, which is why no PDF library is needed.
test('print HTML is self-contained, printable and shows every section', () => {
  const html = results.rosterPrintHTML({
    exam: { id: 7, title: 'Print Me', duration_minutes: 30, pass_percentage: 50, status: 'live' },
    finished: [{ rank: 1, name: 'Alpha', phone: '233', final_score: 8, final_percentage: 80, passed: 1, attempt_no: 1, ended_at: '2026-01-01 10:00:00' }],
    inProgress: [{ name: 'Beta', phone: '234', questions_answered: 3, started_at: '2026-01-01 10:00:00' }],
    notStarted: [{ name: 'Gamma', phone: '235', questions_answered: 0 }],
    notSent: [{ name: 'Delta', phone: '236' }],
    summary: { finished: 1, inProgress: 1, notStarted: 1, notSent: 1, total: 4 },
  });

  assert.match(html, /<style>/, 'must be self-contained with inline CSS');
  assert.match(html, /@page/, 'needs a page size and margins');
  assert.match(html, /@media print/, 'needs print rules');
  assert.match(html, /<thead>/, 'headers must repeat across pages');
  assert.match(html, /display: table-header-group/, 'repeating headers need the header-group display');
  assert.match(html, /break-inside: avoid/, 'rows must not split across a page boundary');
  assert.match(html, /Print Me/, 'exam title must be visible');
  for (const name of ['Alpha', 'Beta', 'Gamma', 'Delta']) {
    assert.ok(html.includes(name), `${name} must appear in the printed roster`);
  }
  assert.ok(!/<script/i.test(html), 'print page must not need JavaScript');
  assert.ok(!/class="btn/.test(html), 'no app chrome on the print page');
});

test('print HTML escapes a hostile exam title and student name', () => {
  const html = results.rosterPrintHTML({
    exam: { id: 1, title: '<script>alert(1)</script>', duration_minutes: 30, pass_percentage: 50 },
    finished: [{ rank: 1, name: '<img src=x onerror=alert(1)>', phone: '1', final_score: 1, final_percentage: 100, passed: 1, attempt_no: 1, ended_at: '' }],
    inProgress: [], notStarted: [], notSent: [],
    summary: { finished: 1, inProgress: 0, notStarted: 0, notSent: 0, total: 1 },
  });
  assert.ok(!/<script>alert/.test(html), 'a title must never become a live script tag');
  assert.ok(!/<img src=x/.test(html), 'a name must never become a live img tag');
  assert.ok(html.includes('&lt;script&gt;'), 'the title must appear escaped instead');
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'), 'the name must appear escaped instead');
});

test('an unfinished student prints no score, and an empty section says so', () => {
  const html = results.rosterPrintHTML({
    exam: { id: 3, title: 'Mixed', duration_minutes: 20, pass_percentage: 40 },
    finished: [],
    inProgress: [{ name: 'Runner', phone: '1', questions_answered: 2, started_at: '' }],
    notStarted: [], notSent: [],
    summary: { finished: 0, inProgress: 1, notStarted: 0, notSent: 0, total: 1 },
  });
  assert.ok(!/>\s*0%/.test(html), 'a student sitting the exam must not print as 0%');
  assert.ok(!/>\s*Fail\s*</.test(html), 'an unfinished student must not be given a Fail verdict');
  assert.match(html, /None/, 'an empty section must say so rather than render an empty table');
});

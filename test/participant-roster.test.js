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

// One exam, one question, N recipients with finished sessions carrying scores.
function seedFinished() {
  const eid = db
    .prepare("INSERT INTO exams(title,duration_minutes,status,pass_percentage) VALUES ('Bio',30,'live',50)")
    .run().lastInsertRowid;
  const mk = (name, pct, score, status, attempt, ended) => {
    const sid = db.prepare('INSERT INTO students(phone,name) VALUES (?,?)').run('233' + Math.random().toString(36).slice(2, 8), name).lastInsertRowid;
    db.prepare('INSERT INTO exam_recipients(exam_id,student_id,sent_at) VALUES (?,?,datetime(\'now\'))').run(eid, sid);
    db.prepare(
      `INSERT INTO sessions(exam_id,student_id,status,final_score,final_percentage,passed,attempt_no,ended_at)
       VALUES (?,?,?,?,?,?,?,?)`
    ).run(eid, sid, status, score, pct, pct >= 50 ? 1 : 0, attempt, ended);
    return sid;
  };
  return {
    eid,
    low: mk('Low Learner', 30, 3, 'completed', 1, '2026-01-01 10:00:00'),
    high: mk('High Learner', 90, 9, 'completed', 1, '2026-01-01 10:05:00'),
    mid: mk('Mid Learner', 60, 6, 'expired', 1, '2026-01-01 10:10:00'),
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

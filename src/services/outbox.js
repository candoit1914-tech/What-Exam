const db = require('../db');

function enqueue({ sessionId, questionId = 0, qOrder = null, kind, recipient }) {
  db.prepare(`INSERT OR IGNORE INTO message_outbox
    (session_id, question_id, q_order, kind, recipient) VALUES (?,?,?,?,?)`)
    .run(sessionId, questionId, qOrder, kind, recipient);
  return db.prepare('SELECT * FROM message_outbox WHERE session_id=? AND question_id=? AND kind=?')
    .get(sessionId, questionId, kind);
}

function markSent(id) {
  db.prepare("UPDATE message_outbox SET state='sent', error='', attempts=attempts+1, sent_at=datetime('now'), updated_at=datetime('now') WHERE id=?").run(id);
}

function markFailed(id, error, maxAttempts) {
  db.prepare(`UPDATE message_outbox SET attempts=attempts+1, error=?,
    state=CASE WHEN attempts+1 >= ? THEN 'failed' ELSE 'queued' END,
    updated_at=datetime('now') WHERE id=?`).run(String(error?.message || error).slice(0, 500), maxAttempts, id);
}

function pending() {
  return db.prepare(`SELECT o.* FROM message_outbox o
    JOIN sessions s ON s.id=o.session_id JOIN exams e ON e.id=s.exam_id
    WHERE o.state='queued' AND s.status='in_progress' AND e.status IN ('live','published')
    ORDER BY o.id`).all();
}

module.exports = { enqueue, markSent, markFailed, pending };

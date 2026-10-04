'use strict';
const db = require('../db');

/**
 * Delete a set of students in one transaction, returning how many rows went.
 *
 * The dependent rows (exam_recipients, sessions, answers) disappear because of
 * the schema's ON DELETE CASCADE, not because of anything written here. This is
 * deliberately the same statement the single-student delete route runs, so bulk
 * and individual removal cannot drift apart in behaviour.
 */
function bulkDeleteStudents(ids) {
  const unique = [...new Set(
    (Array.isArray(ids) ? ids : [])
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0)
  )];
  const remove = db.prepare('DELETE FROM students WHERE id = ?');
  db.exec('BEGIN');
  try {
    let deleted = 0;
    for (const id of unique) deleted += remove.run(id).changes;
    db.exec('COMMIT');
    return deleted;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { bulkDeleteStudents };

const db = require('../db');

// ── Rule resolution ────────────────────────────────────────────────────
//
// A section's behaviour is DERIVED, never stored: its exam_sections row gives
// the quota, its questions give the compulsory/optional split. Two derived
// facts decide everything downstream:
//
//   selective = a quota exists AND it is smaller than the optional pool.
//               A quota that covers the whole pool is a no-op selector, so it
//               is suppressed rather than shown to the student.
//   quota     = MIN(answer_count, optional.length)

/** Template space. Admin UI and PDF reconciliation only. */
function sectionsForExam(examId) {
  return db
    .prepare('SELECT * FROM exam_sections WHERE exam_id = ? ORDER BY position, id')
    .all(examId);
}

function questionsInSection(examId, sectionKey) {
  return db
    .prepare('SELECT * FROM questions WHERE exam_id = ? AND section_key = ? ORDER BY q_order')
    .all(examId, sectionKey);
}

/**
 * Clamp a raw answer_count against a real optional pool.
 *
 * The two suppression cases are different and both matter:
 *   quota 0            — nothing to choose.
 *   quota >= pool      — "answer any 5" with 5 on offer is answer-all. Showing a
 *                        selector there would let a student unanswer questions
 *                        the paper already demanded, which silently changes the
 *                        denominator for no reason.
 */
function clampedQuota(answerCount, optionalLength) {
  const quota = Math.min(Math.max(0, Number(answerCount) || 0), optionalLength);
  return quota > 0 && quota < optionalLength ? quota : 0;
}

/**
 * Template-space plan, keyed on questions.id. Use this for the admin screen and
 * for reconciling a freshly imported PDF against the saved questions. Do NOT use
 * it to drive the selector — a student is only ever shown what they were drawn.
 */
function sectionPlan(examId) {
  const plan = [];
  for (const section of sectionsForExam(examId)) {
    const all = questionsInSection(examId, section.section_key);
    const compulsory = all.filter((q) => q.is_compulsory);
    const optional = all.filter((q) => !q.is_compulsory);
    plan.push({
      section_key: section.section_key,
      title: section.title || '',
      instructions: section.instructions || '',
      position: section.position,
      answer_count: section.answer_count,
      quota: clampedQuota(section.answer_count, optional.length),
      compulsory,
      optional,
    });
  }
  return plan;
}

// ── Session space ──────────────────────────────────────────────────────
//
// Everything from here down is keyed on session_questions.q_order, which is
// the number the student actually sees. session_questions.question_id refers to
// question_pool.id, so template ids cannot be used to select anything.

/**
 * The drawn questions of one section, in the order the student will meet them.
 * session_questions.section_key is copied from the pool row at draw time, so the
 * snapshot stays correct even if the template is edited mid-exam.
 */
function drawnInSection(sessionId, sectionKey) {
  return db
    .prepare(
      `SELECT sq.q_order, sq.question_id, sq.is_selected, sq.section_key,
              qp.marks, qp.is_compulsory, qp.type, qp.text
         FROM session_questions sq
         JOIN question_pool qp ON qp.id = sq.question_id
        WHERE sq.session_id = ? AND sq.section_key = ?
        ORDER BY sq.q_order`
    )
    .all(sessionId, sectionKey);
}

/**
 * Has this section already been chosen for this session?
 *
 * Derived rather than stored, because a single sessions.selection_state cannot
 * represent two independent sections: committing section A would otherwise mark
 * section B as done too. A committed section is exactly one where at least one
 * optional question was dropped — which is guaranteed, because a section is only
 * selective when its quota is strictly smaller than its pool, so committing
 * always leaves at least one optional row at is_selected = 0.
 *
 * session_questions has no compulsory flag of its own, so the pool row joined
 * through question_id is the authority for which rows were optional.
 */
function sectionCommitted(sessionId, sectionKey) {
  return (
    db
      .prepare(
        `SELECT COUNT(*) n
           FROM session_questions sq
           JOIN question_pool qp ON qp.id = sq.question_id
          WHERE sq.session_id = ? AND sq.section_key = ?
            AND qp.is_compulsory = 0 AND sq.is_selected = 0`
      )
      .get(sessionId, sectionKey).n > 0
  );
}

/** Session-space plan. This is what the selector renders and what commits act on. */
function sessionPlan(sessionId) {
  const session = db.prepare('SELECT exam_id FROM sessions WHERE id = ?').get(sessionId);
  if (!session) return [];
  const out = [];
  for (const section of sectionsForExam(session.exam_id)) {
    const all = drawnInSection(sessionId, section.section_key);
    if (!all.length) continue;
    const compulsory = all.filter((q) => q.is_compulsory);
    const optional = all.filter((q) => !q.is_compulsory);
    out.push({
      section_key: section.section_key,
      title: section.title || '',
      instructions: section.instructions || '',
      position: section.position,
      answer_count: section.answer_count,
      quota: clampedQuota(section.answer_count, optional.length),
      compulsory,
      optional,
      committed: sectionCommitted(sessionId, section.section_key),
    });
  }
  return out;
}

function isSelective(sessionId, sectionKey) {
  const found = sessionPlan(sessionId).find((s) => s.section_key === sectionKey);
  return !!found && found.quota > 0 && !found.committed;
}

/**
 * Is the selector due to be shown for the question delivery has just reached?
 *
 * True only at a non-compulsory question of a selective section that has not
 * been committed yet. After the student commits, committed flips and this stops
 * being true, so the selector can never interrupt a second time.
 */
function needsChoice(session, question) {
  if (!question || !question.section_key) return false;
  const sid = session && session.id != null ? session.id : session;
  const sec = sessionPlan(sid).find((s) => s.section_key === question.section_key);
  if (!sec || sec.quota <= 0 || sec.committed) return false;
  return question.is_compulsory === 0;
}

// ── Paper total ────────────────────────────────────────────────────────
//
// The denominator is a stored value, not a sum taken at report time. A student
// who chose 3 of 5 has a paper worth 3 + compulsory; if the admin later edits a
// question's marks that student's percentage must not move under them.

/** Marks of the questions this session will actually be graded on. */
function computePaperTotal(sessionId) {
  const drawn = db
    .prepare(
      `SELECT qp.marks AS marks, sq.is_selected AS is_selected
         FROM session_questions sq
         JOIN question_pool qp ON qp.id = sq.question_id
        WHERE sq.session_id = ?`
    )
    .all(sessionId);
  if (drawn.length) {
    // A pool-drawn exam: only the questions this attempt drew count, and only
    // the selected ones among them.
    return drawn
      .filter((r) => r.is_selected)
      .reduce((sum, r) => sum + Number(r.marks || 0), 0);
  }
  // Template-only exam (no pool draw): fall back to every question of the exam.
  const session = db.prepare('SELECT exam_id FROM sessions WHERE id = ?').get(sessionId);
  if (!session) return 0;
  return db
    .prepare('SELECT COALESCE(SUM(marks),0) t FROM questions WHERE exam_id = ?')
    .get(session.exam_id).t;
}

/**
 * Commit the student's choice for one section and re-price the paper.
 *
 * `chosenQOrders` are session q_orders, matching what the selector displayed.
 * Compulsory questions are never deselected — the paper forced them. The write
 * happens before the first chosen question is sent, so a crash after this point
 * costs the student nothing but a re-send.
 */
function applySelection(sessionId, sectionKey, chosenQOrders) {
  const chosen = new Set((chosenQOrders || []).map(Number));
  const rows = drawnInSection(sessionId, sectionKey);
  const setSel = db.prepare(
    'UPDATE session_questions SET is_selected = ? WHERE session_id = ? AND q_order = ?'
  );
  for (const row of rows) {
    if (row.is_compulsory) continue; // forced by the paper
    setSel.run(chosen.has(row.q_order) ? 1 : 0, sessionId, row.q_order);
  }
  const total = computePaperTotal(sessionId);
  // Clear any provisional state; the choice is now committed.
  db.prepare(
    `UPDATE sessions SET paper_total = ?, selection_state = '', selection_section = '',
                        selection_tentative = ''
      WHERE id = ?`
  ).run(total, sessionId);
  return total;
}

module.exports = {
  sectionsForExam,
  sectionPlan,
  sessionPlan,
  isSelective,
  needsChoice,
  computePaperTotal,
  applySelection,
};
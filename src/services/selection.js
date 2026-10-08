const db = require('../db');
const wa = require('./whatsapp');

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
  // Clear the provisional state; the choice is now committed. selection_section
  // is deliberately KEPT: it is the only pointer handleReply has to the section,
  // so clearing it would make a later CHANGE reply an unroutable no-op.
  db.prepare(
    `UPDATE sessions SET paper_total = ?, selection_state = '', selection_tentative = ''
      WHERE id = ?`
  ).run(total, sessionId);
  return total;
}

// ── Selector ───────────────────────────────────────────────────────────
//
// WhatsApp list messages cap at ten rows and row titles at 24 characters, so
// a bigger pool has to arrive as numbered text. Both paths speak the same
// protocol (taps, "2,4,5", CONFIRM) so nothing downstream branches on which
// one was used.
//
// Every key below is a session q_order. The student is told "QUESTION 7", taps
// row `sel:b:7`, and types "7" — so q_order is the only identifier that means
// the same thing to all three.

const LIST_ROW_CAP = 10;
const ROW_TITLE_CAP = 24;
const CONFIRM_WORDS = new Set(['confirm', 'done', 'ok', 'okay', 'yes', 'submit']);
const CHANGE_WORDS = new Set(['change', 'edit', 'switch', 'back']);

function hasSelections(examId) {
  return sectionPlan(examId).some((s) => s.quota > 0);
}

function beginChoice(sessionId, sectionKey) {
  db.prepare("UPDATE sessions SET selection_state='selecting', selection_section=? WHERE id=?")
    .run(sectionKey, sessionId);
}

function stem(q) {
  return String(q.text || '').replace(/\s+/g, ' ').trim();
}

/**
 * Per-type question numbers, exactly as the student sees them on each
 * question bubble: objectives 1..N, theory 1..M.
 *
 * Computed locally: selection.js must not require exam.js, which loads this
 * module. The rows are walked in sessionQuestionSequence's own order —
 * section position, then q_order — because this map exists only for a
 * section with a quota, and a quota exam is delivered in that order.
 * Numbering off raw q_order instead would describe a different paper from
 * the one the bubbles come from.
 *
 * A number comes back as `null` when it cannot honestly be promised. The
 * section on show has not been committed yet, so every one of its optional
 * questions may be dropped the moment the student replies — and a dropped
 * question takes its number with it, moving everything behind it. From the
 * first still-on-offer question of that section onwards the count is a
 * guess, and callers show the question's text, which the bubble prints
 * verbatim, instead of a number that could be wrong before it is read.
 *
 * Keys are question ids: pool ids, because the selector only exists for a
 * drawn session.
 */
function displayNumberMap(sessionId, sectionKey) {
  const session = db.prepare('SELECT exam_id FROM sessions WHERE id = ?').get(sessionId);
  if (!session) return new Map();
  const position = new Map(sectionsForExam(session.exam_id).map((s) => [s.section_key, s.position]));
  const rows = db
    .prepare(
      `SELECT sq.question_id, sq.q_order, sq.section_key,
              qp.type, qp.is_compulsory
         FROM session_questions sq
         JOIN question_pool qp ON qp.id = sq.question_id
        WHERE sq.session_id = ? AND sq.is_selected <> 0`
    )
    .all(sessionId)
    .sort((a, b) => {
      const pa = position.has(a.section_key) ? position.get(a.section_key) : 9999;
      const pb = position.has(b.section_key) ? position.get(b.section_key) : 9999;
      return pa !== pb ? pa - pb : (a.q_order || 0) - (b.q_order || 0);
    });

  const committed = sectionCommitted(sessionId, sectionKey);
  const counters = { objective: 0, theory: 0 };
  const open = { objective: false, theory: false };
  const numbers = new Map();
  for (const r of rows) {
    const type = r.type === 'theory' ? 'theory' : 'objective';
    // On offer: an optional row of the still-uncommitted section the student
    // is being asked about. It counts today and may be gone tomorrow.
    const onOffer = !committed && r.section_key === sectionKey && Number(r.is_compulsory) === 0;
    if (onOffer) open[type] = true;
    counters[type] += 1;
    numbers.set(r.question_id, open[type] ? null : counters[type]);
  }
  return numbers;
}

function rowTitle(q, n) {
  return (`${n}. ${stem(q)}`).slice(0, ROW_TITLE_CAP);
}

/** The numbered listing used by both the big-pool and the error paths. */
function listing(plan) {
  return plan.optional.map((q, i) => `${i + 1}. ${stem(q).slice(0, 90)}`).join('\n');
}

/**
 * The number the student chose with: the position in the printed listing
 * (1..n), never the session q_order. The reply protocol is "reply with their
 * numbers like 1,3", so echoing a draw position the student has never seen
 * would name questions they did not pick.
 */
function listingNumber(plan, qOrder) {
  const i = plan.optional.findIndex((q) => q.q_order === qOrder);
  return i >= 0 ? i + 1 : qOrder;
}

function selectorBody(plan, numbers) {
  const lines = [];
  if (plan.title) lines.push(`*${plan.title}*`, '');
  if (plan.instructions) lines.push(`${plan.instructions}`, '');
  // The number the bubble will carry — and when that number can still move,
  // the text the bubble will carry instead. drawnInSection returns
  // question_id, never id, so the map is keyed on exactly that.
  const locked = plan.compulsory.map((q) => {
    const n = numbers ? numbers.get(q.question_id) : undefined;
    if (n != null) return `Q${n}`;
    const text = stem(q);
    return `"${text.length > 60 ? `${text.slice(0, 59).trimEnd()}…` : text}"`;
  });
  if (locked.length) {
    lines.push(`🔒 Compulsory — you will answer ${locked.join(', ')}.`);
  }
  lines.push(`You must choose exactly ${plan.quota} of the ${plan.optional.length} questions below.`);
  return lines.join('\n');
}

async function sendSelector(phone, sessionId, sectionKey) {
  const plan = sessionPlan(sessionId).find((s) => s.section_key === sectionKey);
  if (!plan || plan.quota <= 0) return;
  const body = selectorBody(plan, displayNumberMap(sessionId, sectionKey));

  if (plan.optional.length > LIST_ROW_CAP) {
    await wa.sendText(
      phone,
      `${body}\n\n${listing(plan)}\n\nReply with the numbers you choose, e.g. 1,3 — then CONFIRM.`
    );
    return;
  }

  const rows = plan.optional.map((q, i) => ({
    id: `sel:${sectionKey}:${q.q_order}`,
    title: rowTitle(q, i + 1),
  }));
  try {
    await wa.sendInteractiveList(
      phone, plan.title || 'Choose', body, 'Choose questions', rows,
      `Tap to toggle · choose ${plan.quota}`
    );
  } catch (err) {
    // An interactive message can be rejected outright; the numbered-text path
    // always works, so fall back rather than stranding the student.
    console.error('[selection] list message failed, using text:', err.message);
    await wa.sendText(
      phone,
      `${body}\n\n${listing(plan)}\n\nReply with the numbers you choose, e.g. 1,3 — then CONFIRM.`
    );
  }
}

/**
 * The q_orders a student means, from a typed reply or a list row id.
 * Returns { toggles: [q_order] } for a tap, or { set: [q_order] } for typed
 * numbers.
 */
function parseChoice(text, meta, plan) {
  const byRowId = new Map(plan.optional.map((q) => [`sel:${plan.section_key}:${q.q_order}`, q.q_order]));
  const tapped = byRowId.get(meta.replyId || meta.selectedId || '');
  if (tapped != null) return { toggles: [tapped] };

  const pool = plan.optional.map((q) => q.q_order);
  const digits = (String(text || '').match(/\d+/g) || []).map((d) => parseInt(d, 10));
  // A typed number is read first as a position in the printed listing, because
  // that is what the student just read. It is only then read as a q_order, so a
  // student who types the question number they were shown still gets it right.
  const byIndex = digits.filter((n) => n >= 1 && n <= pool.length).map((n) => pool[n - 1]);
  if (byIndex.length) return { set: [...new Set(byIndex)] };
  const byOrder = digits.filter((n) => pool.includes(n));
  if (byOrder.length) return { set: [...new Set(byOrder)] };
  return null;
}

/** q_orders the student has provisionally ticked, without committing anything. */
function currentChoice(sessionId, sectionKey) {
  const plan = sessionPlan(sessionId).find((s) => s.section_key === sectionKey);
  if (!plan) return [];
  const pending = db.prepare('SELECT selection_tentative FROM sessions WHERE id = ?').get(sessionId);
  let ids = [];
  if (pending && pending.selection_tentative) {
    try { ids = JSON.parse(pending.selection_tentative); } catch { ids = []; }
  }
  const pool = new Set(plan.optional.map((q) => q.q_order));
  return ids.filter((id) => pool.has(Number(id)));
}

/** Ticks are provisional; only applySelection commits them. */
function persistChoice(sessionId, sectionKey, chosen) {
  db.prepare('UPDATE sessions SET selection_tentative = ? WHERE id = ?')
    .run(JSON.stringify(chosen), sessionId);
}

/**
 * Handle one reply while a selector is open.
 *
 * Returns { handled, committed }. `committed: true` means exam.js must now
 * deliver the first selected question — the selector never sends it itself.
 */
async function handleReply(session, student, body, meta = {}) {
  const phone = student.phone;
  const sectionKey = session.selection_section;
  const plan = sessionPlan(session.id).find((s) => s.section_key === sectionKey);
  if (!plan || plan.quota <= 0) return { handled: false, committed: false };

  const raw = String(body || '').trim().toLowerCase();
  // Students type the choice and the word in one message ("1,3 CONFIRM"), so the
  // keyword is matched as a word anywhere in the reply rather than as the whole
  // body — an exact match would silently treat that as an unconfirmed tick.
  const says = (words) => raw.split(/[^a-z]+/).some((w) => words.has(w));
  // A CHANGE keyword must be the whole reply: "back" is a normal English word and
  // would otherwise hijack any question containing it.
  const isChangeOnly = CHANGE_WORDS.has(raw) && raw.split(/[^a-z]+/).length === 1;

  // CHANGE reopens a committed choice, but only while nothing has been
  // answered — the first answer is what closes the window.
  if (isChangeOnly) {
    const answered = db
      .prepare('SELECT COUNT(*) c FROM answers WHERE session_id = ?')
      .get(session.id).c;
    if (answered > 0) {
      await wa.sendText(phone, 'Your question choice is locked now that you have answered. You cannot change it.');
      return { handled: true, committed: false };
    }
    // Undo the previous commit so the section reads as unchosen again, and carry
    // the committed picks over as the provisional ones so the student does not
    // lose their work by reopening.
    const committed = db
      .prepare(
        `SELECT q_order FROM session_questions
          WHERE session_id = ? AND section_key = ? AND is_selected = 1
            AND question_id IN (SELECT id FROM question_pool WHERE is_compulsory = 0)
          ORDER BY q_order`
      )
      .all(session.id, sectionKey)
      .map((r) => r.q_order);
    db.prepare(
      'UPDATE session_questions SET is_selected = 1 WHERE session_id = ? AND section_key = ?'
    ).run(session.id, sectionKey);
    db.prepare('UPDATE sessions SET selection_tentative = ? WHERE id = ?')
      .run(JSON.stringify(committed), session.id);
    beginChoice(session.id, sectionKey);
    await sendSelector(phone, session.id, sectionKey);
    return { handled: true, committed: false };
  }

  const chosen = new Set(currentChoice(session.id, sectionKey));

  // A combined "1,3 CONFIRM" both sets the choice and commits it, so apply any
  // numbers in the message before testing the count.
  const digitsInRaw = raw.match(/\d+/g);
  if (meta.replyId !== 'sel:confirm' && says(CONFIRM_WORDS) && digitsInRaw && digitsInRaw.length) {
    const parsed = parseChoice(raw, meta, plan);
    chosen.clear();
    for (const q of (parsed ? parsed.set || parsed.toggles || [] : [])) chosen.add(q);
  }

  if (meta.replyId === 'sel:confirm' || says(CONFIRM_WORDS)) {
    if (chosen.size !== plan.quota) {
      await wa.sendText(
        phone,
        `You must choose exactly ${plan.quota} question${plan.quota === 1 ? '' : 's'}. ` +
        `You have chosen ${chosen.size}. Reply with the numbers, e.g. 1,3, then CONFIRM.`
      );
      await sendSelector(phone, session.id, sectionKey);
      return { handled: true, committed: false };
    }
    applySelection(session.id, sectionKey, [...chosen]);
    await wa.sendText(
      phone,
      `✅ Locked in. Answering ${chosen.size} question${chosen.size === 1 ? '' : 's'} from this section.`
    );
    return { handled: true, committed: true };
  }

  const parsed = parseChoice(body, meta, plan);
  if (!parsed) {
    await wa.sendText(
      phone,
      `I didn't catch that. Tap the questions you want, or reply with their numbers like *1,3*, then send CONFIRM.`
    );
    await sendSelector(phone, session.id, sectionKey);
    return { handled: true, committed: false };
  }

  if (parsed.set) {
    if (parsed.set.length > plan.quota) {
      await wa.sendText(
        phone,
        `You chose ${parsed.set.length} but this section needs exactly ${plan.quota}. ` +
        `Pick ${plan.quota}, e.g. *1,3*, then CONFIRM.`
      );
      return { handled: true, committed: false };
    }
    chosen.clear();
    parsed.set.forEach((q) => chosen.add(q));
  } else {
    for (const q of parsed.toggles) {
      if (chosen.has(q)) chosen.delete(q);
      else if (chosen.size < plan.quota) chosen.add(q);
      else {
        await wa.sendText(phone, `That is already ${plan.quota} chosen — remove one first, or reply CONFIRM.`);
        return { handled: true, committed: false };
      }
    }
  }

  persistChoice(session.id, sectionKey, [...chosen]);
  await wa.sendText(
    phone,
    chosen.size
      ? `✓ Chosen: ${[...chosen].map((q) => listingNumber(plan, q)).join(', ')} — ${chosen.size} of ${plan.quota}. Reply CONFIRM to lock it in.`
      : `Cleared. Choose ${plan.quota} question${plan.quota === 1 ? '' : 's'}.`
  );
  return { handled: true, committed: false };
}

module.exports = {
  sectionsForExam,
  sectionPlan,
  sessionPlan,
  isSelective,
  hasSelections,
  needsChoice,
  computePaperTotal,
  applySelection,
  beginChoice,
  sendSelector,
  handleReply,
};
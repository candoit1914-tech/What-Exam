/* Pure helpers for the Selection Rules card on the exam page.
   Classic script: shares global scope with app.js. No DOM access and no top-level
   side effects, so test/selection-ui.test.js can require() it directly.

   Everything here derives from the payload GET /api/exams/:id returns —
   `sections` (stored rules) and `selection` (the resolved plan from
   src/services/selection.js). Neither vocabulary is copied in here: the server
   already collapses a rule that covers every question to 0, so a second rule list in
   the browser would go stale and could offer a choice the server cannot honour. */
(function (root) {
  // One row per section, merging what is stored with what the server resolved.
  // A section appears if EITHER source knows it: a rule can exist with no
  // questions yet (admin set it up first), and questions can carry a section_key
  // with no rule at all (imported grouping, still answer-all). Dropping either
  // group would hide a section the admin needs to see.
  //
  // `questions` is the third source and the one that makes a rule writable: an
  // import whose "Answer any N" instruction could not be read saves the
  // grouping but no exam_sections row, and a section with no row has no input
  // on this card — so the quota that would finally offer the choice could never
  // be typed in.
  function ruleRows(sections, selection, questions) {
    var byKey = {};
    (selection || []).forEach(function (s) { byKey[s.section_key] = s; });
    var stored = {};
    (sections || []).forEach(function (s) { stored[s.section_key] = s; });
    var keys = [];
    (sections || []).forEach(function (s) { if (keys.indexOf(s.section_key) < 0) keys.push(s.section_key); });
    (selection || []).forEach(function (s) { if (keys.indexOf(s.section_key) < 0) keys.push(s.section_key); });
    (questions || []).forEach(function (q) {
      var k = String((q && q.section_key) || '').trim();
      if (k && keys.indexOf(k) < 0) keys.push(k);
    });

    return keys.map(function (key) {
      var plan = byKey[key] || {};
      var sec = stored[key] || {};
      var optional = plan.optional || [];
      var compulsory = plan.compulsory || [];
      if (!byKey[key]) {
        // No resolved plan for this key yet: the questions are what the server
        // will clamp the rule against when the quota is saved.
        optional = [];
        compulsory = [];
        (questions || []).forEach(function (q) {
          if (String((q && q.section_key) || '').trim() !== key) return;
          if (Number(q.is_compulsory) === 0) optional.push(q);
          else compulsory.push(q);
        });
      }
      return {
        section_key: key,
        title: sec.title || plan.title || key,
        instructions: sec.instructions || plan.instructions || '',
        // The server resolves the real rule; never recompute it here or the
        // card would show a number the students are not actually given.
        // `toAnswer` is the rule the admin typed — the questions the section
        // owes, COMPULSORY INCLUDED — while `quota` is only the part of it the
        // student picks. Reading quota back into the input would show 3 for a
        // rule of 4, and the next save would silently reprice the paper. A plan
        // without `toAnswer` (older server, hand-built fixture) is rebuilt the
        // same way; a section resolved to answer-all still reads 0.
        answer_count: Number(
          plan.toAnswer != null
            ? plan.toAnswer
            : (Number(plan.quota) > 0 ? Number(plan.quota) + (plan.compulsory || []).length : 0)
        ) || 0,
        pool: optional.length,
        compulsory: compulsory.length,
      };
    });
  }

  // "4 questions · 1 compulsory" — the numbers an admin needs to type a
  // sensible rule. The ceiling is the WHOLE section, because answer_count is
  // the number of questions the student answers, compulsory ones included:
  // an input capped at the optional pool would refuse the paper's own
  // "answer any 4 of 5" the moment one of the five is compulsory.
  function rowHint(row) {
    var pool = Number(row.pool) || 0;
    var forced = Number(row.compulsory) || 0;
    var total = pool + forced;
    return total + (total === 1 ? ' question' : ' questions') + ' · ' + forced + ' compulsory';
  }

  // The one-line summary shown in the Edit Exam modal and anywhere a paper's
  // shape is described. Only live rules appear: a section that resolved to 0
  // is answer-all, and listing it as a rule would be a lie. The counts are the
  // paper's own — compulsory included — so the line reads exactly like the
  // instruction printed on the paper.
  function summaryLines(selection) {
    return (selection || [])
      .filter(function (s) { return Number(s.quota) > 0 || Number(s.toAnswer) > 0; })
      .map(function (s) {
        var optional = (s.optional || []).length;
        var forced = (s.compulsory || []).length;
        var toAnswer = Number(s.toAnswer) || Number(s.quota) + forced;
        var label = s.title || s.section_key;
        return label + ': answer ' + toAnswer + ' of ' + (optional + forced) +
          (forced ? ' (' + forced + ' compulsory)' : '');
      });
  }

  // Build the PATCH body from the card's inputs. A blank or unparseable quota is
  // sent as 0, not dropped: omitting the key would leave the stored rule in
  // place, so an admin who cleared the field would see it come back on reload.
  function rulesPayload(rows) {
    return {
      sections: (rows || []).map(function (r) {
        return {
          section_key: String(r.section_key == null ? '' : r.section_key).trim(),
          title: r.title || '',
          instructions: r.instructions || '',
          position: Number(r.position) || 0,
          answer_count: parseInt(r.answer_count, 10) || 0,
        };
      }).filter(function (s) { return !!s.section_key; }),
    };
  }

  // <option> pairs for the per-question Section select: every section the exam
  // knows about, plus the question's current value so editing an old question
  // never silently drops its section when that section has no rule yet.
  function sectionOptions(sections, selection, current) {
    var seen = {};
    var out = [];
    function add(key, label) {
      if (!key || seen[key]) return;
      seen[key] = true;
      out.push([key, label || key]);
    }
    (sections || []).forEach(function (s) { add(s.section_key, s.title); });
    (selection || []).forEach(function (s) { add(s.section_key, s.title); });
    add(String(current || '').trim(), current);
    return out;
  }

  // The section vocabulary is slugged identically on both sides of the wire
  // (src/services/pdfImport.js slugOf), so a value arriving from an import is
  // already the key the select must offer.
  function sectionSlug(section) {
    return String(section == null ? '' : section)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  }

  var api = {
    ruleRows: ruleRows,
    rowHint: rowHint,
    summaryLines: summaryLines,
    rulesPayload: rulesPayload,
    sectionOptions: sectionOptions,
    sectionSlug: sectionSlug,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SelectionUI = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
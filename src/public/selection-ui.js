/* Pure helpers for the Selection Rules card on the exam page.
   Classic script: shares global scope with app.js. No DOM access and no top-level
   side effects, so test/selection-ui.test.js can require() it directly.

   Everything here derives from the payload GET /api/exams/:id returns —
   `sections` (stored rules) and `selection` (the resolved plan from
   src/services/selection.js). Neither vocabulary is copied in here: the server
   already collapses "quota covers the whole pool" to 0, so a second rule list in
   the browser would go stale and could offer a choice the server cannot honour. */
(function (root) {
  // One row per section, merging what is stored with what the server resolved.
  // A section appears if EITHER source knows it: a rule can exist with no
  // questions yet (admin set it up first), and questions can carry a section_key
  // with no rule at all (imported grouping, still answer-all). Dropping either
  // group would hide a section the admin needs to see.
  function ruleRows(sections, selection) {
    var byKey = {};
    (selection || []).forEach(function (s) { byKey[s.section_key] = s; });
    var stored = {};
    (sections || []).forEach(function (s) { stored[s.section_key] = s; });
    var keys = [];
    (sections || []).forEach(function (s) { if (keys.indexOf(s.section_key) < 0) keys.push(s.section_key); });
    (selection || []).forEach(function (s) { if (keys.indexOf(s.section_key) < 0) keys.push(s.section_key); });

    return keys.map(function (key) {
      var plan = byKey[key] || {};
      var sec = stored[key] || {};
      var optional = plan.optional || [];
      var compulsory = plan.compulsory || [];
      return {
        section_key: key,
        title: sec.title || plan.title || key,
        instructions: sec.instructions || plan.instructions || '',
        // The server resolves the real quota; never recompute it here or the
        // card would show a rule the students are not actually given.
        answer_count: Number(plan.quota) || 0,
        pool: optional.length,
        compulsory: compulsory.length,
      };
    });
  }

  // "Answer any 2 of 3 optional · 1 compulsory" — the numbers an admin needs to
  // set a sensible quota, so the input's ceiling is never a surprise.
  function rowHint(row) {
    var pool = Number(row.pool) || 0;
    var forced = Number(row.compulsory) || 0;
    return pool + ' optional' + (pool === 1 ? '' : 's') + ' · ' + forced + ' compulsory';
  }

  // The one-line summary shown in the Edit Exam modal and anywhere a paper's
  // shape is described. Only rules with a live quota appear: a section that
  // resolved to 0 is answer-all, and listing it as a rule would be a lie.
  function summaryLines(selection) {
    return (selection || [])
      .filter(function (s) { return Number(s.quota) > 0; })
      .map(function (s) {
        var pool = (s.optional || []).length;
        var label = s.title || s.section_key;
        return label + ': answer any ' + s.quota + ' of ' + pool;
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
/* Pure helpers for the Participants tab of the admin UI.
   Classic script: shares global scope with app.js. No DOM access and no top-level
   side effects, so test/roster-ui.test.js can require() it directly.

   The section vocabulary is DERIVED from the roster payload the server just
   sent, never copied in here. src/services/results.js owns ROSTER_SECTIONS and
   the group names in `roster.summary`; a second literal list in the browser
   would quietly go stale the next time a section is added, and the admin would
   be offered a choice the server cannot honour. */
(function (root) {
  // `inProgress` is the stored group name; `in_progress` is the URL key the
  // export routes take. One mechanical rule covers every section, including any
  // added later, and is idempotent so a key that is already snake_case passes
  // through unchanged.
  function sectionKey(group) {
    return String(group == null ? '' : group)
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .toLowerCase();
  }

  // 'in_progress' -> 'In progress'. Sentence case, which is what the existing
  // summary chips beside the dropdown already read as.
  function sectionLabel(key) {
    var text = String(key == null ? '' : key).replace(/_/g, ' ');
    return text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
  }

  // The dropdown, built from `roster.summary`. `total` is hoisted to the front
  // because it is the default and the only unfiltered choice; the groups keep
  // the order the server sent them in, so Finished stays first and Not sent last.
  function rosterSectionOptions(summary) {
    if (!summary || typeof summary !== 'object') return [];
    var keys = Object.keys(summary);
    return keys
      .filter(function (k) { return k === 'total'; })
      .concat(keys.filter(function (k) { return k !== 'total'; }))
      .map(function (group) {
        var key = sectionKey(group);
        return [key, sectionLabel(key)];
      });
  }

  // The filename the server chose for a roster file. The docx route always
  // quotes it; the unquoted form is accepted too because a stray quote would end
  // up inside the saved name. An unreadable header falls back rather than saving
  // a file called "undefined".
  function attachmentFilename(contentDisposition, fallback) {
    var header = contentDisposition == null ? '' : String(contentDisposition);
    var m = /filename="?([^";]+)"?/.exec(header);
    return m && m[1] ? m[1] : fallback;
  }

  var api = {
    sectionKey: sectionKey,
    sectionLabel: sectionLabel,
    rosterSectionOptions: rosterSectionOptions,
    attachmentFilename: attachmentFilename,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RosterUI = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

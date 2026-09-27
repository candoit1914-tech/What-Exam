/* Pure recipient-input parsing for the admin UI.
   Classic script: shares global scope with app.js. No DOM access and no top-level
   side effects, so test/recipient-input.test.js can require() it directly. */
(function (root) {
  // Line-ish separators only. Deliberately NOT whitespace: a number an admin spaced
  // out for readability stays inside one line and is rejoined below.
  var LINE_SEP = /[\n\r,;|\t]+/;
  // The trailing run that looks like a phone. Must start with a digit or '+',
  // optionally preceded by '(' so a US-style "(233) 24 200 4542" has its paren
  // consumed by the strip below instead of being orphaned into the name.
  var TRAILING_PHONE = /(\(?[0-9+][0-9\s()\-.]*)$/;

  function splitRecipientLines(raw) {
    return String(raw == null ? '' : raw)
      .split(LINE_SEP)
      .map(function (s) { return s.trim(); })
      .filter(Boolean);
  }

  function parseRecipientLine(line) {
    var text = String(line == null ? '' : line).trim();
    var m = text.match(TRAILING_PHONE);
    if (!m) {
      // No phone-shaped tail. Send the text as the phone and let the server
      // classify it into `invalid`, so the admin sees WHY it was rejected rather
      // than watching it vanish.
      return { phone: text, name: '' };
    }
    return {
      phone: m[1].replace(/[\s()\-.]/g, ''),
      name: text.slice(0, m.index).trim(),
    };
  }

  function parseRecipientInput(raw) {
    return splitRecipientLines(raw)
      .map(parseRecipientLine)
      .filter(function (r) { return r.phone !== ''; });
  }

  var api = {
    splitRecipientLines: splitRecipientLines,
    parseRecipientLine: parseRecipientLine,
    parseRecipientInput: parseRecipientInput,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RecipientInput = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

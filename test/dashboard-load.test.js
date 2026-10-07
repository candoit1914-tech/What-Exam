'use strict';
require('./helpers/isolate');

// src/public/app.js is a classic browser script: it touches
// window/document/localStorage while it loads, so it cannot be
// required here. It is evaluated in a fake DOM instead — and that
// matters, because a script can be syntactically perfect and still
// die while loading.
//
// A stray `async` before a function declaration used to sit on its
// own line and be parsed as a bare identifier expression. `node --check`
// called it valid (it is), the browser happily parsed it, and then it
// threw ReferenceError at run time — freezing the script at that line.
// Function declarations after it still existed (they are hoisted), but
// every `const` below stayed in the temporal dead zone, and the boot
// call at the bottom never ran. The Recipients tab, which reads
// RECIPIENT_STATES, was the first thing the admin noticed: clicking it
// rendered nothing at all.
//
// These tests pin that a load-time failure cannot slip through again.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP = fs.readFileSync(path.join(__dirname, '..', 'src', 'public', 'app.js'), 'utf8');

class FakeElement {
  constructor(id) {
    this.id = id || '';
    this.value = '';
    this.textContent = '';
    this.innerHTML = '';
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.style = {};
    this.dataset = {};
    this.classList = {
      toggle() {}, add() {}, remove() {}, contains() { return false; },
    };
  }
  addEventListener() {}
  removeEventListener() {}
  appendChild() {}
  remove() {}
  focus() {}
  closest() { return null; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
}

/** The payload GET /api/exams/:id serves. */
function examDetail() {
  return {
    exam: {
      id: 1, title: 'Integrated Science', subject: 'Science', description: '',
      duration_minutes: 30, pass_percentage: 50, status: 'draft', generated_by: 'manual',
      total_marks: 0, question_count: 0, sessions_total: 0, sessions_active: 0,
      sessions_finished: 0, created_at: '2026-10-07 08:47:54', published_at: null,
      ended_at: null, pricing: 'free', price_amount: 0,
    },
    questions: [],
    recipients: [
      { id: 1, phone: '233269200946', name: 'Amy Takyiwaa', created_at: '2026-10-07 08:47:54', sent_at: null },
      { id: 2, phone: '233242004542', name: 'Boamah Bryan Ntim', created_at: '2026-10-07 08:47:54', sent_at: null },
    ],
    results: [],
    sections: [],
    selection: [],
    payments: [],
  };
}

function boot(data = examDetail()) {
  const byId = new Map();
  const register = (html) => {
    const re = /id="([^"]+)"/g;
    let m;
    while ((m = re.exec(html))) if (!byId.has(m[1])) byId.set(m[1], new FakeElement(m[1]));
  };

  const view = new FakeElement('view');
  const toast = new FakeElement('toast');
  byId.set('view', view);
  byId.set('toast', toast);

  // A re-render destroys the page's children and rebuilds them, so
  // their markup starts empty again — exactly like a real DOM replace.
  Object.defineProperty(view, 'innerHTML', {
    get() { return view._html || ''; },
    set(v) { view._html = String(v); register(view._html); for (const [k, el] of byId) if (k !== 'view') el.innerHTML = ''; },
  });

  const documentStub = {
    getElementById: (id) => byId.get(id) || null,
    querySelector: (sel) => (typeof sel === 'string' && sel.startsWith('#') ? byId.get(sel.slice(1)) || null : null),
    querySelectorAll: () => [],
    createElement: () => new FakeElement(),
    addEventListener: () => {},
    body: { appendChild: () => {} },
  };

  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    document: documentStub,
    localStorage: { getItem: () => 'test-token', setItem: () => {}, removeItem: () => {} },
    location: { hash: '#/exams/1', href: '' },
    fetch: async () => ({ ok: true, status: 200, json: async () => data }),
    confirm: () => true,
    alert: () => {},
    FormData: class {},
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
  };
  sandbox.window = sandbox;
  sandbox.window.API_BASE = 'http://localhost:3000';
  sandbox.window.addEventListener = () => {};
  sandbox.window.matchMedia = () => ({ matches: false, addEventListener: () => {} });
  sandbox.globalThis = sandbox;

  // Globals the sibling scripts (selection-ui.js, roster-ui.js,
  // recipient-input.js) provide in the browser. Only the calls the
  // rendered tabs actually make are needed here.
  sandbox.SelectionUI = {
    ruleRows: () => [],
    rowHint: () => '',
    rulesPayload: () => ({}),
    sectionOptions: () => [],
    summaryLines: () => [],
  };
  sandbox.RosterUI = {
    rosterSectionOptions: () => [],
    attachmentFilename: () => 'roster.docx',
  };
  sandbox.RecipientInput = {
    parseRecipientInput: () => ({ students: [], merged: [], conflicts: [], invalid: [] }),
  };

  // A syntax check is not enough: the script has to survive execution.
  vm.createContext(sandbox);
  vm.runInContext(APP, sandbox, { filename: 'app.js' });
  return { sandbox, byId };
}

/** Let the double-requestAnimationFrame chain and fetches land. */
const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

test('the dashboard script loads and boots without throwing', async () => {
  const { byId } = boot();
  // Boot runs router() at the bottom of the script, which renders
  // the exam the hash points at — through two requestAnimationFrame
  // hops, so give the timers a moment to land.
  await settle();
  assert.ok(byId.get('view').innerHTML.length > 0, 'the exam page rendered');
  assert.ok(byId.has('tabbody'), 'the tab body exists');
  assert.ok(byId.get('tabbody').innerHTML.length > 0, 'the default tab rendered');
});

test('the Recipients tab lists every student and its state labels', async () => {
  const { sandbox, byId } = boot();
  await settle();
  sandbox.setTab('recipients');
  await settle();
  const html = byId.get('tabbody').innerHTML;
  assert.ok(html.includes('Amy Takyiwaa'), 'the first recipient is listed');
  assert.ok(html.includes('Boamah Bryan Ntim'), 'the second recipient is listed');
  assert.ok(html.includes('ADD A'), 'the add-student form rendered');
  assert.ok(html.includes('Not sent'), 'RECIPIENT_STATES is live (its labels rendered)');
  assert.ok(html.includes('Recipients'), 'the tab header rendered');
});

test('clicking between tabs still works after a re-render', async () => {
  const { sandbox, byId } = boot();
  await settle();
  sandbox.setTab('recipients');
  await settle();
  assert.ok(byId.get('tabbody').innerHTML.includes('Amy Takyiwaa'));
  sandbox.setTab('questions');
  await settle();
  const questions = byId.get('tabbody').innerHTML;
  assert.ok(questions.length > 0, 'the questions tab rendered after the recipients tab');
  sandbox.setTab('recipients');
  await settle();
  assert.ok(byId.get('tabbody').innerHTML.includes('Boamah Bryan Ntim'), 'back to recipients renders again');
});

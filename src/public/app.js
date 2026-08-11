/* What Exam — premium emerald landing dashboard (vanilla JS SPA) */

const API_BASE = (window.API_BASE || 'http://localhost:3000').replace(/\/+$/, '');
const AUTH_KEY = 'wa_exam_token';
const $view = document.getElementById('view');

// ── Session ─────────────────────────────────────────────────────
function getToken() { return localStorage.getItem(AUTH_KEY); }
function setToken(t) { localStorage.setItem(AUTH_KEY, t); }
function clearToken() { localStorage.removeItem(AUTH_KEY); }

// ── Performance: API cache ───────────────────────────────────────
const _cache = new Map();
const CACHE_TTL = 15_000;

async function api(path, opts = {}) {
  const isGet = !opts.method || opts.method === 'GET';
  const key = isGet ? path : null;

  if (key && _cache.has(key)) {
    const { data, ts } = _cache.get(key);
    if (Date.now() - ts < CACHE_TTL) return data;
    _cache.delete(key);
  }

  const hasBody = opts.body != null;
  const isForm = hasBody && typeof FormData !== 'undefined' && opts.body instanceof FormData;
  const headers = Object.assign({}, opts.headers || {});
  if (!isForm) headers['Content-Type'] = 'application/json';
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(API_BASE + path, {
    ...opts,
    headers,
    body: hasBody ? (isForm ? opts.body : JSON.stringify(opts.body)) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith('/auth/login')) {
    clearToken();
    showLanding();
    throw new Error(data.error || 'Session expired — please sign in.');
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);

  if (key) _cache.set(key, { data, ts: Date.now() });
  return data;
}

function invalidateCache(pattern) {
  for (const k of _cache.keys()) {
    if (k.includes(pattern)) _cache.delete(k);
  }
}

// ── Auth ────────────────────────────────────────────────────────
function landingHTML(anon = false) {
  return `
    <div class="landing">
      <section class="hero">
        <div class="hero-grid">
          <div class="hero-copy reveal" style="--d:0ms">
            <div class="eyebrow"><span class="dot"></span>WhatsApp Examination System</div>
            <h1>EXAMS THAT<br><span class="grad">MARK THEMSELVES</span></h1>
            <p>Create AI-marked exams, deliver them over WhatsApp, and let the bot run the whole session — question by question, live timer, instant results.</p>
            <div class="hero-actions">
              ${anon
                ? `<button class="btn btn-primary" onclick="showLoginCard()">Admin Sign In ${I.arrow}</button>`
                : `<button class="btn btn-primary" onclick="location.hash='#/exams'">Create an Exam ${I.arrow}</button>
                   <button class="btn btn-ghost" onclick="location.hash='#/results'">View Results</button>`}
            </div>
            ${anon ? `<p class="anon-note">Exams are created by your school administrator. Students take exams directly on WhatsApp.</p>` : ''}
            ${anon ? '' : `
            <div class="hero-stats">
              <div class="stat-chip reveal" style="--d:100ms"><b data-count="0">0</b><span>Exams</span></div>
              <div class="stat-chip reveal" style="--d:200ms"><b data-count="0">0</b><span>Live</span></div>
              <div class="stat-chip reveal" style="--d:300ms"><b data-count="0">0</b><span>Questions</span></div>
              <div class="stat-chip reveal" style="--d:400ms"><b data-count="0">0</b><span>Students</span></div>
            </div>`}
          </div>
          <div class="hero-visual reveal" style="--d:150ms">
            <div class="wapp">
              <div class="wapp-status">
                <span>09:42</span>
                <span class="st-icons">
                  <svg viewBox="0 0 24 24" fill="currentColor"><path d="M2 20h2.4v-6H2zM7.6 20H10v-10H7.6zM13.2 20h2.4V6h-2.4zM18.8 20h2.4V2h-2.4z"/></svg>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 8.5a14.5 14.5 0 0120 0M5.5 12a9.5 9.5 0 0113 0M9 15.5a4.5 4.5 0 016 0"/><circle cx="12" cy="18.5" r="1.3" fill="currentColor" stroke="none"/></svg>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1" y="7" width="18" height="10" rx="2"/><path d="M22 10v4"/></svg>
                </span>
              </div>
              <div class="wapp-head">
                <button class="wa-icon" aria-label="Back">${I.back}</button>
                <img class="wapp-ava" src="/icon.svg" alt="Exam Bot">
                <div class="wapp-id"><b>Exam Bot</b><span>online</span></div>
                <button class="wa-icon" aria-label="Search">${I.search}</button>
                <button class="wa-icon" aria-label="Menu">${I.menu}</button>
              </div>
              <div class="wapp-chat"></div>
            </div>
          </div>
        </div>
      </section>

      ${anon ? `
      <section class="section reveal">
        <div class="section-head">
          <div class="eyebrow"><span class="dot"></span>Request an exam</div>
          <h2>LET US BUILD<br><span class="grad">YOUR EXAM</span></h2>
          <p>Send your school, class, or industry and your contact details — the admin creates your exam and delivers it to you.</p>
        </div>
        <div class="features-grid">
          <div class="feature-card reveal" style="--d:0ms">
            <a class="f-link" href="https://wa.me/233558126390?text=${encodeURIComponent('Hello Admin, I would like an exam created for my school, class, or industry. My details are:')}" target="_blank" rel="noopener" aria-label="Chat on WhatsApp — 0558126390">
              <div class="f-icon">${I.wa}</div>
            </a>
            <h3>Chat on WhatsApp</h3>
            <p>Message the admin with your school, class, or industry details.</p>
          </div>
          <div class="feature-card reveal" style="--d:100ms">
            <a class="f-link" href="mailto:candoit1914@gmail.com?subject=${encodeURIComponent('Exam Creation Request')}&body=${encodeURIComponent('Hello Admin,\n\nI would like an exam created for my school, class, or industry.\n\nMy details:\nName:\nSchool / Class / Industry:\nContact:\n\nThank you.')}" aria-label="Send an email to candoit1914@gmail.com">
              <div class="f-icon">${I.envelope}</div>
            </a>
            <h3>Send an email</h3>
            <p>Write to the admin and we will set your exam up.</p>
          </div>
          <div class="feature-card reveal" style="--d:200ms">
            <a class="f-link" href="sms:+233558126390?&body=${encodeURIComponent('Hello Admin, I would like an exam created for my school, class, or industry. My details are:')}" aria-label="Send an SMS to 0558126390">
              <div class="f-icon">${I.phone}</div>
            </a>
            <h3>Send an SMS</h3>
            <p>Text your details and the admin will reply.</p>
          </div>
        </div>
      </section>` : ''}

      <section class="section reveal">
        <div class="section-head">
          <div class="eyebrow"><span class="dot"></span>How it works</div>
          <h2>PAPER IN. <span class="grad">GRADED</span> OUT.</h2>
          <p>Results, printable reports, and live delivery activity roll into your dashboard in real time.</p>
        </div>
        <div class="features-grid">
          <div class="feature-card reveal" style="--d:0ms">
            <div class="f-icon">${I.pen}</div>
            <h3>Create it your way</h3>
            <p>Draft by hand, import a PDF, or let AI build the paper — every question ships with an editable marking scheme.</p>
            <span class="f-tag">Hand · PDF · AI</span>
          </div>
          <div class="feature-card reveal" style="--d:100ms">
            <div class="f-icon">${I.wa}</div>
            <h3>Delivered in WhatsApp</h3>
            <p>Exams land in the class chat and flow one question at a time against a live timer. Answers lock the moment they send.</p>
            <span class="f-tag">One question · one answer</span>
          </div>
          <div class="feature-card reveal" style="--d:200ms">
            <div class="f-icon">${I.spark}</div>
            <h3>Marked as it lands</h3>
            <p>AI scores objective and theory answers the moment they arrive — no waiting, no piles of scripts.</p>
            <span class="f-tag">Instant AI marking</span>
          </div>
        </div>
      </section>

      <footer class="footer reveal">
        <div class="footer-brand"><img src="/icon.svg" alt=""> WHAT EXAM</div>
        <div class="footer-links">
          <a href="#/exams">Exams</a>
          <a href="#/results">Results</a>
          <a href="${API_BASE}/privacy" target="_blank">Privacy</a>
        </div>
        <div class="footer-copy">WhatsApp Examination System · AI marking · © ${new Date().getFullYear()} What Exam</div>
      </footer>

      ${anon ? `
      <div class="login-wrap login-wrap--hidden">
        <div class="login-card">
          <div class="login-brand"><img src="/icon.svg" alt="What Exam"><span>WHAT&nbsp;EXAM</span></div>
          <h1>Admin sign in</h1>
          <p class="sub">This dashboard is protected. Enter the admin password to continue.</p>
          <form id="login_form" onsubmit="event.preventDefault(); login();">
            <div class="field"><label>Password</label>
              <input type="password" id="login_pass" autocomplete="current-password" placeholder="••••••••">
            </div>
            <button class="btn btn-primary btn-block" type="submit" id="login_btn">Sign In</button>
          </form>
        </div>
      </div>` : ''}
    </div>`;
}

function showLanding() {
  clearToken();
  document.body.classList.add('anon');
  $view.innerHTML = landingHTML(true);
  requestAnimationFrame(() => {
    observeReveals();
    initHeroScene();
  });
}

function showLoginCard() {
  const wrap = document.querySelector('.login-wrap');
  if (!wrap) return;
  wrap.classList.remove('login-wrap--hidden');
  wrap.classList.add('login-wrap--show');
  wrap.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const input = document.querySelector('#login_pass');
  if (input) setTimeout(() => input.focus(), 400);
}

async function login() {
  const btn = document.querySelector('#login_btn');
  const input = document.querySelector('#login_pass');
  if (!input || !btn) return;
  const password = input.value;
  if (!password) return toast('Enter the admin password.', true);
  btn.disabled = true;
  btn.textContent = 'Signing in…';
  try {
    const { token } = await api('/api/auth/login', { method: 'POST', body: { password } });
    setToken(token);
    document.body.classList.remove('anon');
    _cache.clear();
    toast('Welcome back.');
    router();
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'Sign In';
    toast(e.message, true);
  }
}

function logout() {
  clearToken();
  _cache.clear();
  showLanding();
}

const _reportUrls = new Map();
async function reportUrl(sessionId) {
  if (_reportUrls.has(sessionId)) return _reportUrls.get(sessionId);
  const { url } = await api(`/api/results/${sessionId}/report-url`);
  _reportUrls.set(sessionId, url);
  return url;
}

function debounce(fn, ms = 200) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// ── Utilities ────────────────────────────────────────────────────
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function toast(msg, isError = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast' + (isError ? ' error' : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.className = 'toast hidden'), 3200);
}

function badge(status) {
  return `<span class="badge ${esc(status)}">${esc(status)}</span>`;
}

function setActiveNav() {
  const hash = (location.hash || '#/').replace(/^#/, '');
  const base = '/' + hash.split('/').filter(Boolean)[0];
  document.querySelectorAll('.nav-item').forEach((a) => {
    a.classList.toggle('active', a.dataset.nav === base);
  });
}

// ── Icon set ─────────────────────────────────────────────────────
const I = {
  compass: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M15 9l-2.2 4.8L8 16l2.2-4.8L15 9z"/></svg>',
  gauge: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 14a8 8 0 1116 0"/><path d="M12 14l4-4"/><circle cx="12" cy="14" r="1.6" fill="currentColor" stroke="none"/></svg>',
  envelope: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg>',
  chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 20V10M12 20V4M19 20v-6"/><path d="M2 20h20"/></svg>',
  people: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="8" r="3.5"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><circle cx="17" cy="9" r="2.5"/><path d="M16 13.5c2.6.5 5 2.7 5 5.6"/></svg>',
  empty: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4M4 7l8 4M4 7v10l8 4m0-10v10"/></svg>',
  pen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>',
  doc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/></svg>',
  spark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15z"/></svg>',
  wa: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 11.5a8.5 8.5 0 01-12.6 7.4L3 21l2.1-5.4A8.5 8.5 0 1121 11.5z"/><path d="M9 10h.01M12.5 10h.01M16 10h.01"/></svg>',
  phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.9v3a2 2 0 01-2.2 2 19.8 19.8 0 01-8.6-3.1 19.5 19.5 0 01-6-6A19.8 19.8 0 012.1 4.2 2 2 0 014.1 2h3a2 2 0 012 1.7c.1 1 .4 2 .7 2.9a2 2 0 01-.5 2.1L8.1 10a16 16 0 006 6l1.3-1.3a2 2 0 012.1-.4c.9.3 1.9.5 2.9.7a2 2 0 011.6 1.9z"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>',
  radar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 1118 0"/><path d="M7 12a5 5 0 0110 0"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/></svg>',
  bolt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  layers: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l10 5-10 5L2 7l10-5z"/><path d="M2 12l10 5 10-5"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l8 3v6c0 5-3.5 9-8 11-4.5-2-8-6-8-11V5l8-3z"/><path d="M9 12l2 2 4-4"/></svg>',
  menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 5l-7 7 7 7"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>',
};

// ── Loading skeletons ────────────────────────────────────────────
function skeletonCards(n = 3) {
  return Array.from({ length: n }, () => '<div class="skeleton skeleton-card"></div>').join('');
}
function skeletonRows(n = 5) {
  return Array.from({ length: n }, () => '<div class="skeleton skeleton-row"></div>').join('');
}

// ── Modal ────────────────────────────────────────────────────────
async function openModal(title, bodyHTML) {
  return new Promise((resolve) => {
    const div = document.createElement('div');
    div.className = 'modal-backdrop';
    div.innerHTML = `<div class="modal">
      <h3>${esc(title)}</h3>
      ${bodyHTML}
      <div class="modal-actions">
        <button class="ghost" data-act="cancel">Cancel</button>
      </div>
    </div>`;
    document.body.appendChild(div);
    div.addEventListener('click', (e) => {
      if (e.target === div || e.target.closest('[data-act="cancel"]')) {
        div.remove();
      }
    });
    const onEsc = (e) => { if (e.key === 'Escape') { div.remove(); document.removeEventListener('keydown', onEsc); } };
    document.addEventListener('keydown', onEsc);
    resolve(div);
  });
}

// ── Stat count-up animation ──────────────────────────────────────
function animateCountUp(el, target, duration = 700) {
  if (!el) return;
  if (target === 0) { el.textContent = '0'; return; }
  const start = performance.now();
  function tick(now) {
    const p = Math.min((now - start) / duration, 1);
    const ease = 1 - Math.pow(1 - p, 3);
    el.textContent = Math.round(target * ease);
    if (p < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

// ── Motion: scroll reveal ────────────────────────────────────────
function observeReveals() {
  if (!('IntersectionObserver' in window)) {
    document.querySelectorAll('.reveal').forEach((el) => el.classList.add('in'));
    return;
  }
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        e.target.classList.add('in');
        io.unobserve(e.target);
      }
    }
  }, { threshold: 0.12 });
  document.querySelectorAll('.reveal').forEach((el) => io.observe(el));
}

// ── Motion: animated WhatsApp hero scene ─────────────────────────
function initHeroScene() {
  const chat = document.querySelector('.wapp-chat');
  if (!chat || chat.dataset.scene === 'on') return;
  chat.dataset.scene = 'on';
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    chat.innerHTML = `
      <div class="wapp-date">TODAY</div>
      <div class="wapp-bubble out"><span class="b-label">QUESTION 1 · OBJECTIVE</span>What is the capital of Ghana?<span class="b-time">09:42</span></div>
      <div class="wapp-bubble out"><span class="b-label">ANSWER OPTIONS</span><div class="b-opts"><b>A.</b> Accra<br><b>B.</b> Kumasi<br><b>C.</b> Cape Coast<br><b>D.</b> Tamale</div><div class="b-hint">Time remaining: 09:45</div></div>
      <div class="wapp-bubble in">A<span class="b-time">09:43</span></div>
      <div class="wapp-bubble out"><span class="b-label">AI MARKING</span>✓ Correct — <b>+1 mark</b><span class="b-time">09:43<span class="wapp-ticks">✔✔</span></span></div>`;
    return;
  }

  const script = [
    { type: 'date', wait: 400, html: 'TODAY' },
    { type: 'bubble', cls: 'out', wait: 600, html: '<span class="b-label">QUESTION 1 · OBJECTIVE</span>What is the capital of Ghana?<span class="b-time">09:42</span>' },
    { type: 'bubble', cls: 'out', wait: 700, html: '<span class="b-label">ANSWER OPTIONS</span><div class="b-opts"><b>A.</b> Accra<br><b>B.</b> Kumasi<br><b>C.</b> Cape Coast<br><b>D.</b> Tamale</div><div class="b-hint">Time remaining: 09:45</div><span class="b-time">09:42</span>' },
    { type: 'typing', wait: 950 },
    { type: 'bubble', cls: 'in', wait: 750, html: 'A<span class="b-time">09:43</span>' },
    { type: 'bubble', cls: 'out', wait: 1600, html: '<span class="b-label">AI MARKING</span>✓ Correct — <b>+1 mark</b><span class="b-time">09:43</span>' },
    { type: 'bubble', cls: 'out', wait: 1300, html: '<span class="b-label">QUESTION 2 · THEORY</span>State two causes of soil erosion.<span class="b-time">09:44</span>' },
    { type: 'typing', wait: 1100 },
    { type: 'bubble', cls: 'in', wait: 850, html: 'Rainwater washes away topsoil and wind blows dry soil away.<span class="b-time">09:45</span>' },
    { type: 'typing', wait: 950 },
    { type: 'bubble', cls: 'out', wait: 1500, html: '<span class="b-label">AI THEORY MARKING</span>✓ Marked — <b>4 / 5</b><br><span style="opacity:.8;font-size:11.5px">Correctness · Completeness · Relevance</span><span class="b-time">09:45<span class="wapp-ticks">✔✔</span></span>' },
    { type: 'score', wait: 2600, html: 'Exam complete — <b>9 / 10</b> · Pass' },
    { type: 'clear', wait: 3600 },
  ];

  function bubble(cls, html) {
    const el = document.createElement('div');
    el.className = 'wapp-bubble ' + cls;
    el.innerHTML = html;
    chat.appendChild(el);
    chat.scrollTop = chat.scrollHeight;
  }
  function typing() {
    const t = document.createElement('div');
    t.className = 'wapp-typing';
    t.innerHTML = '<i></i><i></i><i></i>';
    chat.appendChild(t);
    chat.scrollTop = chat.scrollHeight;
  }
  function score(html) {
    const el = document.createElement('div');
    el.className = 'wapp-score';
    el.innerHTML = html;
    chat.appendChild(el);
    chat.scrollTop = chat.scrollHeight;
  }
  function date(html) {
    const el = document.createElement('div');
    el.className = 'wapp-date';
    el.innerHTML = html;
    chat.appendChild(el);
    chat.scrollTop = chat.scrollHeight;
  }

  function run(i) {
    if (!chat.isConnected) return;
    if (i >= script.length) {
      setTimeout(() => { chat.innerHTML = ''; run(0); }, script[script.length - 1].wait);
      return;
    }
    const m = script[i];
    if (m.type === 'bubble') bubble(m.cls, m.html);
    else if (m.type === 'typing') typing();
    else if (m.type === 'score') score(m.html);
    else if (m.type === 'date') date(m.html);
    else if (m.type === 'clear') { chat.innerHTML = ''; }
    setTimeout(() => run(i + 1), m.wait);
  }
  run(0);
}

// ── Page head helper ─────────────────────────────────────────────
function pageHead(icon, title, sub) {
  return `
    <div class="page-head"><div class="ic">${I[icon]}</div><h1>${title}</h1></div>
    ${sub ? `<p class="sub">${sub}</p>` : ''}`;
}

// ── Router ───────────────────────────────────────────────────────
const routes = {
  '': renderDashboard,
  '/': renderDashboard,
  '/exams': renderExams,
  '/exams/:id': renderExam,
  '/results': renderResults,
  '/results/:id': renderResultDetail,
  '/students': renderStudents,
  '/messages': renderMessages,
};

function router() {
  const hash = (location.hash || '#/').replace(/^#/, '');
  const parts = hash.split('/').filter(Boolean);
  const id = parts[1];
  const key = '/' + parts[0] + (id ? '/:id' : '');
  const match = routes[key];

  $view.style.willChange = 'opacity, transform';
  $view.style.transition = 'none';
  $view.style.opacity = '0';
  $view.style.transform = 'translateY(6px)';

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (match) match(id);
      else renderDashboard();
      setActiveNav();
      $view.style.transition = 'opacity 0.35s cubic-bezier(0.16,1,0.3,1), transform 0.35s cubic-bezier(0.16,1,0.3,1)';
      $view.style.opacity = '1';
      $view.style.transform = 'translateY(0)';
      setTimeout(() => { $view.style.willChange = 'auto'; }, 400);
      observeReveals();
      initHeroScene();
      applySearchFilter();
      document.querySelectorAll('[data-count]').forEach((el) => {
        animateCountUp(el, parseInt(el.dataset.count) || 0);
      });
    });
  });
}

window.addEventListener('hashchange', router);

// ── Overview / Landing ───────────────────────────────────────────
async function renderDashboard() {
  $view.innerHTML = landingHTML();
  const s = await api('/api/stats');
  document.querySelectorAll('.stat-chip b[data-count]').forEach((el) => {
    const val = { exams: s.exams, live: s.published, questions: s.questions, students: s.students }[el.parentElement.querySelector('span').textContent.toLowerCase()] ?? 0;
    el.dataset.count = val;
    animateCountUp(el, val);
  });
}

// ── Exams list ───────────────────────────────────────────────────
async function renderExams() {
  $view.innerHTML = `
    ${pageHead('gauge', 'EXA<span class="gr">MS</span>', 'All papers, their live status, and delivery volume')}
    <div class="spread" style="margin-bottom:14px">
      <p class="sub" style="margin:0">Loading exams…</p>
      <button class="btn btn-primary" onclick="createExam()">＋ New Exam</button>
    </div>
    <div class="card table-card"><div class="skeleton skeleton-row" style="margin:10px"></div></div>`;

  const exams = await api('/api/exams');
  $view.innerHTML = `
    ${pageHead('gauge', 'EXA<span class="gr">MS</span>', 'All papers, their live status, and delivery volume')}
    <div class="spread" style="margin-bottom:14px">
      <p class="sub" style="margin:0">${exams.length} exam(s) created</p>
      <button class="btn btn-primary" onclick="createExam()">＋ New Exam</button>
    </div>
    <div class="card table-card reveal">
      <table>
        <thead><tr><th>Title</th><th>Subject</th><th>Status</th><th>Questions</th><th>Marks</th><th>Students</th><th>Created</th><th></th></tr></thead>
        <tbody>
          ${exams.map((e) => `<tr>
            <td><a href="#/exams/${e.id}">${esc(e.title)}</a></td>
            <td>${esc(e.subject) || '—'}</td>
            <td>${badge(e.status)}</td>
            <td>${e.question_count}</td>
            <td>${e.total_marks}</td>
            <td>${e.sessions_total} <span class="muted">(${e.sessions_active} active)</span></td>
            <td class="muted">${e.created_at}</td>
            <td><a href="#/exams/${e.id}"><button class="small ghost">Open</button></a></td>
          </tr>`).join('') || `<tr><td colspan="8"><div class="empty-state">${I.empty}<p>No exams yet. Create one to get started.</p></div></td></tr>`}
        </tbody>
      </table>
    </div>`;
  observeReveals();
}

async function createExam() {
  const bodyHTML = `
    <div class="field"><label>Title</label><input type="text" id="ne_title" placeholder="e.g. End of Term Science Exam"></div>
    <div class="field"><label>Subject</label><input type="text" id="ne_subject" placeholder="e.g. Integrated Science"></div>
    <div class="field"><label>Duration (minutes)</label><input type="number" id="ne_duration" value="30"></div>
    <div class="field"><label>Pass mark (%)</label><input type="number" id="ne_pass" value="50"></div>
    <div class="modal-actions" style="margin-top:18px">
      <button id="ne_save" class="btn btn-primary">Create Exam</button>
    </div>`;
  await openModal('New Exam', bodyHTML);
  const btn = document.querySelector('#ne_save');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const body = {
      title: document.querySelector('#ne_title').value,
      subject: document.querySelector('#ne_subject').value,
      duration_minutes: document.querySelector('#ne_duration').value,
      pass_percentage: document.querySelector('#ne_pass').value,
    };
    try {
      const { id } = await api('/api/exams', { method: 'POST', body });
      invalidateCache('/api/exams');
      document.querySelector('.modal-backdrop').remove();
      location.hash = `#/exams/${id}`;
    } catch (e) { toast(e.message, true); }
  });
}

// ── Exam editor ──────────────────────────────────────────────────
let examState = { tab: 'questions' };

async function renderExam(id) {
  $view.innerHTML = `
    <div class="page-head"><div class="ic">${I.gauge}</div><h1>Loading…</h1></div>
    <div class="card"><div class="skeleton skeleton-card"></div></div>
    <div class="card"><div class="skeleton skeleton-card"></div></div>`;

  const data = await api(`/api/exams/${id}`);
  examState.id = id;
  examState.data = data;

  const { exam, questions, recipients, results } = data;
  $view.innerHTML = `
    <div class="spread">
      <div>
        <h1>${esc(exam.title)}</h1>
        <p class="muted" style="margin-top:4px">${esc(exam.subject)} · ${exam.question_count} questions · ${exam.total_marks} marks · ${exam.duration_minutes} min · pass ${exam.pass_percentage}% · ${badge(exam.status)}</p>
      </div>
      <div class="row">
        ${exam.status === 'draft' ? `<button class="btn btn-primary" onclick="publishExam(${exam.id})">Publish</button>` : ''}
        ${exam.status === 'live' ? `<button class="btn btn-ghost" onclick="endExam(${exam.id})">End Exam</button>` : ''}
        <button class="btn btn-ghost" onclick="editExamMeta(${exam.id})">Edit</button>
        <button class="btn btn-ghost danger" onclick="deleteExam(${exam.id})">Delete</button>
      </div>
    </div>
    <div class="tabbar">
      <button class="tab ${examState.tab === 'questions' ? 'active' : ''}" onclick="setTab('questions')">Questions</button>
      <button class="tab ${examState.tab === 'schemes' ? 'active' : ''}" onclick="setTab('schemes')">Marking Scheme</button>
      <button class="tab ${examState.tab === 'recipients' ? 'active' : ''}" onclick="setTab('recipients')">Recipients (${recipients.length})</button>
      <button class="tab ${examState.tab === 'results' ? 'active' : ''}" onclick="setTab('results')">Results (${results.length})</button>
    </div>
    <div id="tabbody"></div>`;
  renderTab();
}

function setTab(tab) {
  examState.tab = tab;
  renderExam(examState.id);
}

async function renderTab() {
  const bodyEl = document.getElementById('tabbody');
  const { exam, questions, recipients, results } = examState.data;
  const id = examState.id;
  const tab = examState.tab;

  if (tab === 'questions') {
    bodyEl.innerHTML = `
      <div class="row" style="margin:14px 0">
        <button class="btn btn-primary" onclick="addQuestionForm(${id})">＋ Add Question</button>
        <button class="btn btn-ghost" onclick="aiGenerateForm(${id})">${I.spark} AI Generate</button>
        <button class="btn btn-ghost" onclick="pdfUploadForm(${id})">${I.doc} Upload PDF</button>
      </div>
      ${questions.length === 0 ? `<div class="empty-state">${I.empty}<p>No questions yet. Add manually, generate with AI, or upload a PDF.</p></div>` : ''}
      ${questions.map((q, i) => {
        const prev = i > 0 ? questions[i - 1] : null;
        const same = !!q.passage && !!prev && prev.passage === q.passage;
        return qitemHTML(q, id, same);
      }).join('')}`;
  } else if (tab === 'schemes') {
    bodyEl.innerHTML = questions.length === 0
      ? `<div class="empty-state">${I.empty}<p>No questions yet.</p></div>`
      : questions.map((q) => schemeHTML(q, id)).join('');
  } else if (tab === 'recipients') {
    bodyEl.innerHTML = `
      <div class="card">
        <h3 style="margin-bottom:4px">ADD A <span class="gr">STUDENT</span></h3>
        <div class="row" style="margin-top:10px;gap:8px">
          <input id="stu_name" placeholder="Student name (e.g. Amy Takyiwaa)" style="flex:1">
          <input id="stu_phone" placeholder="WhatsApp number (any format, e.g. 0269200946)" style="flex:1">
        </div>
        <div class="row" style="margin-top:12px">
          <button class="btn btn-primary" onclick="addStudent(${id})">＋ Add Student</button>
        </div>
      </div>
      <div class="card" style="margin-top:14px">
        <h3 style="margin-bottom:4px">ADD MANY <span class="gr">RECIPIENTS</span></h3>
        <p class="muted" style="font-size:12.5px">Comma or newline separated, any country format.</p>
        <textarea id="phones_input" placeholder="+233 24 123 4567&#10;0541234567&#10;+1 555 123 4567"></textarea>
        <div class="row" style="margin-top:12px">
          <button class="btn btn-primary" onclick="addRecipients(${id})">Add Recipients</button>
          <button class="btn btn-ghost" onclick="sendExam(${id})">${I.wa} Send Exam to Recipients</button>
        </div>
      </div>
      <div class="card table-card" style="margin-top:14px"><table>
        <thead><tr><th>Name</th><th>Phone</th><th>Sent</th><th></th></tr></thead>
        <tbody>
          ${recipients.length === 0 ? `<tr><td colspan="4"><div class="empty-state">${I.empty}<p>No recipients yet.</p></div></td></tr>` : ''}
          ${recipients.map((r) => `<tr>
            <td>${esc(r.name || '—')}</td>
            <td>${esc(r.phone)}</td>
            <td class="muted">${esc(r.sent_at || '—')}</td>
            <td><button class="small ghost danger" onclick="removeRecipient(${id}, ${r.id})">Remove</button></td>
          </tr>`).join('')}
        </tbody>
      </table></div>`;
  } else if (tab === 'results') {
    const urls = {};
    await Promise.all(
      results
        .filter((s) => ['completed', 'expired', 'ended'].includes(s.status))
        .map(async (s) => { urls[s.id] = await reportUrl(s.id).catch(() => null); })
    );
    bodyEl.innerHTML = `<div class="card table-card"><table>
      <thead><tr><th>Student</th><th>Phone</th><th>Score</th><th>%</th><th>Result</th><th>Status</th><th>Started</th><th></th></tr></thead>
      <tbody>
        ${results.length === 0 ? `<tr><td colspan="8"><div class="empty-state">${I.empty}<p>No sessions yet. Send the exam to recipients to begin.</p></div></td></tr>` : ''}
        ${results.map((s) => {
          const finished = ['completed', 'expired', 'ended'].includes(s.status);
          const pct = finished ? (s.final_percentage != null ? s.final_percentage + '%' : '—') : '—';
          return `<tr>
            <td>${esc(s.student_name || '—')}</td>
            <td>${esc(s.phone)}</td>
            <td>${finished ? `${s.final_score}` : '—'}</td>
            <td>${pct}</td>
            <td>${finished ? (s.passed ? '<span class="pass">PASS</span>' : '<span class="fail">FAIL</span>') : badge(s.status)}</td>
            <td>${badge(s.status)}</td>
            <td class="muted">${s.started_at}</td>
            <td class="row">
              ${finished ? (urls[s.id] ? `<a href="${API_BASE}${urls[s.id]}" target="_blank"><button class="small ghost">Report</button></a>` : '')
                + `<button class="small ghost" onclick="resendResult(${s.id})">Resend</button>` : ''}
              <a href="#/results/${s.id}"><button class="small ghost">Details</button></a>
            </td>
          </tr>`;
        }).join('')}
      </tbody>
    </table></div>`;
  }
}

function qitemHTML(q, id, samePassageAsPrev = false) {
  const opts = q.options || [];
  return `<div class="qitem">
    <div class="qhead">
      <div>
        <div class="muted" style="font-size:12px">Q${q.q_order} · ${q.type} · ${q.marks} mark(s) · ${q.difficulty} · ${badge(q.source)}</div>
        ${q.passage && samePassageAsPrev
          ? `<div class="qpassage-same">↳ same passage as above</div>`
          : q.passage ? `<div class="qpassage">${esc(q.passage)}</div>` : ''}
<div class="qtext">${esc(q.text)}</div>
        ${q.image ? `<div class="qimg-wrap"><img class="qimg" src="${API_BASE}/api/exams/${id}/images/${encodeURIComponent(q.image)}" alt="diagram"></div>` : ''}
        <div class="opts-list">
          ${opts.map((o) => `<div class="${o.key === q.correct_answer ? 'correct' : ''}">${o.key}. ${esc(o.text)}${o.key === q.correct_answer ? ' ✓' : ''}</div>`).join('')}
        </div>
        ${q.learning_objective ? `<div class="muted" style="margin-top:6px">🎯 ${esc(q.learning_objective)}</div>` : ''}
      </div>
      <div class="row">
        <button class="small ghost" onclick="editQuestionForm(${id}, ${q.id})">Edit</button>
        <button class="small ghost danger" onclick="deleteQuestion(${id}, ${q.id})">Del</button>
      </div>
    </div>
  </div>`;
}

function schemeHTML(q, id) {
  const scheme = q.scheme || (q.type === 'objective' ? { correct_answer: q.correct_answer, marks: q.marks } : null);
  let summary = '';
  if (q.type === 'objective') {
    summary = `<p><b>Correct answer:</b> ${esc(scheme?.correct_answer || q.correct_answer || '—')} &nbsp; <b>Marks:</b> ${q.marks}</p>`;
  } else if (scheme) {
    const parts = [];
    if (scheme.model_answer && String(scheme.model_answer).trim()) {
      parts.push(`<p><b>Model answer:</b> ${esc(scheme.model_answer)}</p>`);
    }
    const points = scheme.key_points || [];
    if (points.length) {
      parts.push(`<p><b>Key points:</b></p><ul>${points.map((k) => `<li>${esc(k)}</li>`).join('')}</ul>`);
    }
    const rubric = scheme.rubric || [];
    if (rubric.length) {
      parts.push(`<p><b>Rubric:</b></p>
      <table><thead><tr><th>Point</th><th>Marks</th><th>Explanation</th></tr></thead>
      <tbody>${rubric.map((r) => `<tr><td>${esc(r.point)}</td><td>${r.marks}</td><td>${esc(r.explanation || '')}</td></tr>`).join('')}</tbody></table>`);
    }
    if (Number(scheme.presentation_marks) || Number(scheme.grammar_marks)) {
      parts.push(`<p class="muted">Presentation: ${scheme.presentation_marks || 0} · Grammar: ${scheme.grammar_marks || 0}</p>`);
    }
    summary = parts.join('');
  }
  return `<div class="qitem">
    <div class="qhead">
      <div><div class="muted" style="font-size:12px">Q${q.q_order} · ${q.type}</div>${q.passage ? `<div class="qpassage">${esc(q.passage)}</div>` : ''}<div class="qtext">${esc(q.text)}</div></div>
      <div class="row">
        ${q.type === 'theory' ? `<button class="small ghost" onclick="regenerateScheme(${id}, ${q.id})">${I.spark} AI Regenerate</button>` : ''}
        <button class="small ghost" onclick="editScheme(${id}, ${q.id}, ${q.type === 'theory'})">Edit JSON</button>
      </div>
    </div>
    ${summary
      ? `<div class="scheme">${summary}</div>`
      : q.type === 'theory' ? '' : '<div class="scheme"><span class="muted">No scheme yet.</span></div>'}
  </div>`;
}

// ── Question actions ─────────────────────────────────────────────

function questionFormHTML(q, id) {
  const type = q?.type || 'objective';
  const opts = (q?.options || [{ key: 'A', text: '' }, { key: 'B', text: '' }, { key: 'C', text: '' }, { key: 'D', text: '' }]);
  return `
    <label>Type</label>
    <div class="row" style="margin:6px 0 12px">
      <label style="display:flex;gap:6px;align-items:center"><input type="radio" name="q_type" value="objective" ${type === 'objective' ? 'checked' : ''} onchange="toggleType()"> Objective</label>
      <label style="display:flex;gap:6px;align-items:center"><input type="radio" name="q_type" value="theory" ${type === 'theory' ? 'checked' : ''} onchange="toggleType()"> Theory</label>
    </div>
    <div class="field"><label>Question</label><textarea id="qf_text">${esc(q?.text || '')}</textarea></div>
    ${q?.image && id ? `<div class="field"><label>Diagram</label><img class="qimg" style="max-width:320px" src="${API_BASE}/api/exams/${id}/images/${encodeURIComponent(q.image)}" alt="diagram"></div>` : ''}
    <div class="field"><label>Passage (reading comprehension) — optional</label><textarea id="qf_passage" placeholder="Text the question is based on...">${esc(q?.passage || '')}</textarea></div>
    <div id="qf_opts">
      ${opts.map((o) => `<div class="row" style="margin:4px 0">
        <input type="text" style="width:44px;text-align:center" value="${esc(o.key)}" disabled>
        <input type="text" data-opt="${esc(o.key)}" value="${esc(o.text)}" placeholder="Option ${esc(o.key)}">
      </div>`).join('')}
      <div class="field"><label>Correct answer</label>
        <div class="row">
          ${['A', 'B', 'C', 'D'].map((k) => `<label style="display:flex;gap:4px;align-items:center"><input type="radio" name="qf_correct" value="${k}" ${q?.correct_answer === k ? 'checked' : ''}> ${k}</label>`).join('')}
        </div>
      </div>
    </div>
    <div class="field" id="qf_theory_marks"><label>Marks</label><input type="number" id="qf_marks" value="${q?.marks || (type === 'theory' ? 5 : 1)}" step="0.5"></div>
    <div class="field"><label>Difficulty</label>
      <select id="qf_diff">
        ${['easy', 'medium', 'hard'].map((d) => `<option ${q?.difficulty === d ? 'selected' : ''}>${d}</option>`).join('')}
      </select></div>
    <div class="field"><label>Learning objective</label><input type="text" id="qf_lo" value="${esc(q?.learning_objective || '')}"></div>
    <div class="field"><label>Explanation (shown after answering)</label><textarea id="qf_expl">${esc(q?.explanation || '')}</textarea></div>`;
}

function toggleType() {
  const theory = document.querySelector('input[name="q_type"]:checked').value === 'theory';
  const opts = document.querySelector('#qf_opts');
  if (opts) opts.style.display = theory ? 'none' : 'block';
  const m = document.querySelector('#qf_marks');
  if (m && theory && !m.value) m.value = 5;
  if (m && !theory && m.value === '5') m.value = 1;
}

async function addQuestionForm(id) {
  const body = `<div class="field" style="margin:0"><label>Type</label>
    <div class="row" style="margin:6px 0 12px">
      <label style="display:flex;gap:6px;align-items:center"><input type="radio" name="q_type" value="objective" checked onchange="toggleType()"> Objective</label>
      <label style="display:flex;gap:6px;align-items:center"><input type="radio" name="q_type" value="theory" onchange="toggleType()"> Theory</label>
    </div></div>
    <div class="field"><label>Question</label><textarea id="qf_text" placeholder="What is the capital of Ghana?"></textarea></div>
    <div class="field"><label>Passage (reading comprehension) — optional</label><textarea id="qf_passage" placeholder="Text the question is based on..."></textarea></div>
    <div id="qf_opts">
      ${['A', 'B', 'C', 'D'].map((k) => `<div class="row" style="margin:4px 0">
        <input type="text" style="width:44px;text-align:center" value="${k}" disabled>
        <input type="text" data-opt="${k}" placeholder="Option ${k}">
      </div>`).join('')}
      <div class="field"><label>Correct answer</label>
        <div class="row">
          ${['A', 'B', 'C', 'D'].map((k) => `<label style="display:flex;gap:4px;align-items:center"><input type="radio" name="qf_correct" value="${k}"> ${k}</label>`).join('')}
        </div>
      </div>
    </div>
    <div class="field"><label>Marks</label><input type="number" id="qf_marks" value="1" step="0.5"></div>
    <div class="field"><label>Difficulty</label><select id="qf_diff"><option>easy</option><option selected>medium</option><option>hard</option></select></div>
    <div class="modal-actions" style="margin-top:18px"><button id="qf_save" class="btn btn-primary">Add Question</button></div>`;

  const div = await openModal('Add Question', body);
  if (!div) return;
  document.querySelector('#qf_save').addEventListener('click', async () => {
    const type = document.querySelector('input[name="q_type"]:checked').value;
    const payload = {
      type,
      text: document.querySelector('#qf_text').value,
      passage: document.querySelector('#qf_passage').value,
      marks: parseFloat(document.querySelector('#qf_marks').value) || 1,
      difficulty: document.querySelector('#qf_diff').value,
      learning_objective: '',
      explanation: '',
    };
    if (type === 'objective') {
      payload.options = ['A', 'B', 'C', 'D'].map((k) => document.querySelector(`[data-opt="${k}"]`).value.trim());
      const sel = document.querySelector('input[name="qf_correct"]:checked');
      payload.correct_answer = sel ? sel.value : '';
    }
    try {
      await api(`/api/exams/${id}/questions`, { method: 'POST', body: payload });
      invalidateCache(`/api/exams/${id}`);
      div.remove();
      renderExam(id);
    } catch (e) { toast(e.message, true); }
  });
}

async function editQuestionForm(id, qid) {
  const q = examState.data.questions.find((x) => x.id === qid);
  const div = await openModal('Edit Question', questionFormHTML(q, id));
  if (!div) return;
  const addBtn = document.createElement('button');
  addBtn.textContent = 'Save Question';
  addBtn.id = 'qf_save';
  addBtn.className = 'btn btn-primary';
  div.querySelector('.modal-actions').appendChild(addBtn);
  document.querySelector('#qf_save').addEventListener('click', async () => {
    const type = document.querySelector('input[name="q_type"]:checked').value;
    const payload = {
      type,
      text: document.querySelector('#qf_text').value,
      passage: document.querySelector('#qf_passage').value,
      marks: parseFloat(document.querySelector('#qf_marks').value) || 1,
      difficulty: document.querySelector('#qf_diff').value,
      learning_objective: document.querySelector('#qf_lo').value,
      explanation: document.querySelector('#qf_expl').value,
    };
    if (type === 'objective') {
      payload.options = ['A', 'B', 'C', 'D'].map((k) => document.querySelector(`[data-opt="${k}"]`).value.trim());
      const sel = document.querySelector('input[name="qf_correct"]:checked');
      payload.correct_answer = sel ? sel.value : '';
    }
    try {
      await api(`/api/exams/${id}/questions/${qid}`, { method: 'PUT', body: payload });
      invalidateCache(`/api/exams/${id}`);
      div.remove();
      renderExam(id);
    } catch (e) { toast(e.message, true); }
  });
}

async function deleteQuestion(id, qid) {
  if (!confirm('Delete this question and its marking scheme?')) return;
  await api(`/api/exams/${id}/questions/${qid}`, { method: 'DELETE' });
  invalidateCache(`/api/exams/${id}`);
  renderExam(id);
}

// ── AI generation ────────────────────────────────────────────────

async function aiGenerateForm(id) {
  const div = await openModal('Generate Questions with AI', `
    <div class="field"><label>Subject / topic area</label><input type="text" id="ag_subject" placeholder="e.g. Integrated Science — Soil Erosion"></div>
    <div class="row">
      <div class="field"><label>Objective questions</label><input type="number" id="ag_obj_count" value="40" min="1"></div>
      <div class="field"><label>Theory questions</label><input type="number" id="ag_theory_count" value="5" min="0"></div>
    </div>
    <div class="field"><label>Types</label>
      <div class="row">
        <label style="display:flex;gap:6px"><input type="checkbox" id="ag_obj" checked> Objective</label>
        <label style="display:flex;gap:6px"><input type="checkbox" id="ag_theory" checked> Theory</label>
      </div></div>
    <div class="field"><label>Difficulty</label>
      <select id="ag_diff"><option>easy</option><option selected>medium</option><option>hard</option><option>mixed</option></select></div>
    <div class="field"><label>Extra instructions (optional)</label><textarea id="ag_inst" placeholder="e.g. focus on causes and effects, 12 marks each"></textarea></div>
    <div class="field">
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer"><input type="checkbox" id="ag_pool" checked> Fresh questions per attempt</label>
      <p class="muted" style="margin:4px 0 8px">Generates extra variant questions from the same topic so every student's attempt (and retake) draws a different, unseen set.</p>
      <select id="ag_variants">
        <option value="2">2 variants per question</option>
        <option value="3" selected>3 variants per question</option>
        <option value="4">4 variants per question</option>
        <option value="5">5 variants per question</option>
        <option value="6">6 variants per question</option>
        <option value="7">7 variants per question</option>
      </select>
    </div>
    <div class="modal-actions" style="margin-top:18px"><button id="ag_run" class="btn btn-primary">Generate</button></div>
  `);
  if (!div) return;
  const run = document.querySelector('#ag_run');
  run.addEventListener('click', async () => {
    run.disabled = true;
    run.textContent = 'Generating…';
    try {
      const types = [];
      if (document.querySelector('#ag_obj').checked) types.push('objective');
      if (document.querySelector('#ag_theory').checked) types.push('theory');
      const objCount = Math.max(1, parseInt(document.querySelector('#ag_obj_count').value) || 40);
      const theoryCount = Math.max(0, parseInt(document.querySelector('#ag_theory_count').value) || 0);
      const body = {
        subject: document.querySelector('#ag_subject').value,
        objectiveCount: objCount,
        theoryCount: types.includes('theory') ? theoryCount : 0,
        types,
        difficulty: document.querySelector('#ag_diff').value,
        instructions: document.querySelector('#ag_inst').value,
        pool: document.querySelector('#ag_pool').checked,
        poolMultiplier: parseInt(document.querySelector('#ag_variants').value) || 3,
      };
      const res = await api(`/api/exams/${id}/generate`, { method: 'POST', body });
      invalidateCache(`/api/exams/${id}`);
      div.remove();
      toast(`Generated ${res.count} questions${res.poolCount ? ` + ${res.poolCount} variants for fresh attempts` : ''} with full marking schemes.`);
      renderExam(id);
    } catch (e) {
      run.disabled = false;
      run.textContent = 'Generate';
      toast(e.message, true);
    }
  });
}

// ── PDF upload (background job + polling) ────────────────────────────

async function pdfUploadForm(id) {
  const div = await openModal('Upload Exam PDF', `
    <p class="muted" style="margin-bottom:12px">Text-based PDFs only (scanned images are not supported yet). Answer keys and options are detected automatically; missing answers are generated by AI.</p>
    <div id="pdf_status"></div>
    <div id="pdf_upload">
      <input type="file" id="pdf_file" accept="application/pdf">
      <div class="modal-actions" style="margin-top:18px"><button id="pdf_run" class="btn btn-primary">Extract Questions</button></div>
    </div>
  `);
  if (!div) return;

  // Resume an import that is already running for this exam instead of starting a duplicate.
  try {
    const jobs = await api(`/api/jobs?exam_id=${id}`);
    const active = (jobs || []).find((j) => j.status === 'pending' || j.status === 'running');
    if (active) {
      document.querySelector('#pdf_upload').style.display = 'none';
      return pollPdfJob(id, div, active.id);
    }
  } catch { /* no active job */ }

  document.querySelector('#pdf_run').addEventListener('click', async () => {
    const file = document.querySelector('#pdf_file').files[0];
    if (!file) return toast('Choose a PDF file first.', true);
    const btn = document.querySelector('#pdf_run');
    btn.disabled = true;
    btn.textContent = 'Uploading…';
    const fd = new FormData();
    fd.append('file', file);
    try {
      const headers = {};
      const token = getToken();
      if (token) headers.Authorization = `Bearer ${token}`;
      const res = await fetch(`${API_BASE}/api/exams/${id}/pdf`, { method: 'POST', headers, body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      document.querySelector('#pdf_upload').style.display = 'none';
      return pollPdfJob(id, div, data.jobId);
    } catch (e) {
      btn.disabled = false;
      btn.textContent = 'Extract Questions';
      toast(e.message, true);
    }
  });
}

function pollPdfJob(examId, div, jobId) {
  const status = document.querySelector('#pdf_status');
  const update = (text) => { if (status) status.innerHTML = `<p class="muted" style="margin:8px 0">${text}</p>`; };
  let misses = 0;
  const timer = setInterval(async () => {
    let job;
    try {
      job = await api(`/api/jobs/${jobId}`);
      misses = 0;
    } catch {
      // Don't silently freeze on the last stage: tell the user the server
      // went away and keep retrying (it recovers after a redeploy).
      misses++;
      update(`<span class="spinner"></span> Server unreachable — retrying… (attempt ${misses})`);
      return;
    }
    update(`<span class="spinner"></span> ${esc(job.stage || 'Processing…')} <strong>${job.progress || 0}%</strong>`);
    if (job.status === 'done') {
      clearInterval(timer);
      invalidateCache(`/api/exams/${examId}`);
      div.remove();
      const base = `Extracted ${job.count} questions (schemes generated automatically).`;
      toast(job.warning ? `${base} ${job.warning}` : base);
      renderExam(examId);
    } else if (job.status === 'error') {
      clearInterval(timer);
      div.remove();
      toast(job.error || 'Extraction failed.', true);
    }
  }, 2000);
}

// ── Scheme actions ───────────────────────────────────────────────

async function editScheme(id, qid, isTheory) {
  const q = examState.data.questions.find((x) => x.id === qid);
  const scheme = q.scheme || {};
  const div = await openModal('Edit Marking Scheme (JSON)', `
    <p class="muted" style="margin-bottom:8px">Edit directly as JSON. For theory: model_answer, key_points, rubric (point/marks/explanation), presentation_marks, grammar_marks.</p>
    <textarea id="sch_json" style="font-family:monospace;min-height:260px">${esc(JSON.stringify(scheme, null, 2))}</textarea>
    <div class="modal-actions" style="margin-top:18px"><button id="sch_save" class="btn btn-primary">Save Scheme</button></div>
  `);
  if (!div) return;
  document.querySelector('#sch_save').addEventListener('click', async () => {
    try {
      const parsed = JSON.parse(document.querySelector('#sch_json').value);
      await api(`/api/exams/${id}/scheme/${qid}`, { method: 'PUT', body: { scheme: parsed } });
      invalidateCache(`/api/exams/${id}`);
      div.remove();
      renderExam(id);
    } catch (e) { toast('Invalid JSON: ' + e.message, true); }
  });
}

async function regenerateScheme(id, qid) {
  try {
    toast('Generating scheme with AI…');
    const res = await api(`/api/exams/${id}/scheme/${qid}/generate`, { method: 'POST' });
    invalidateCache(`/api/exams/${id}`);
    toast('Scheme regenerated.');
    renderExam(id);
  } catch (e) { toast(e.message, true); }
}

// ── Recipients ───────────────────────────────────────────────────

async function addStudent(id) {
  const name = document.querySelector('#stu_name').value.trim();
  const phone = document.querySelector('#stu_phone').value.trim();
  if (!phone) return toast('Enter the student\'s WhatsApp number.', true);
  if (!name) return toast('Enter the student\'s name.', true);
  try {
    const res = await api(`/api/exams/${id}/recipients`, { method: 'POST', body: { students: [{ name, phone }] } });
    invalidateCache(`/api/exams/${id}`);
    toast(`Added ${res.added[0]?.name || 'student'}.`);
    renderExam(id);
  } catch (e) { toast(e.message, true); }
}

async function addRecipients(id) {
  const phones = document.querySelector('#phones_input').value.split(/[\n,]+/).map((p) => p.trim()).filter(Boolean);
  if (!phones.length) return toast('Enter at least one phone number.', true);
  try {
    const res = await api(`/api/exams/${id}/recipients`, { method: 'POST', body: { phones } });
    invalidateCache(`/api/exams/${id}`);
    toast(`Added ${res.added.length} recipient(s).`);
    renderExam(id);
  } catch (e) { toast(e.message, true); }
}

async function removeRecipient(id, sid) {
  await api(`/api/exams/${id}/recipients/${sid}`, { method: 'DELETE' });
  invalidateCache(`/api/exams/${id}`);
  renderExam(id);
}

async function sendExam(id) {
  if (!confirm('Send this exam to all recipients now? Sessions start immediately.')) return;
  const btn = event.currentTarget;
  btn.disabled = true;
  btn.textContent = 'Sending…';
  try {
    const res = await api(`/api/exams/${id}/send`, { method: 'POST' });
    invalidateCache(`/api/exams/${id}`);
    const errList = (res.errors || []).map((e) => `${e.phone}: ${e.error}`).join(' | ');
    const parts = [`Sent ${res.sent}`, `resumed ${res.resumed || 0}`, `failed ${res.failed}`];
    toast(errList ? `${parts.join(', ')}. ${errList}` : parts.join(', ') + '.');
    renderExam(id);
  } catch (e) { toast(e.message, true); btn.disabled = false; btn.textContent = 'Send Exam to Recipients'; }
}

// ── Exam actions ─────────────────────────────────────────────────

async function publishExam(id) {
  try {
    await api(`/api/exams/${id}/publish`, { method: 'POST' });
    invalidateCache('/api/exams');
    invalidateCache(`/api/exams/${id}`);
    toast('Exam published. Add recipients and send it.');
    renderExam(id);
  } catch (e) { toast(e.message, true); }
}

async function endExam(id) {
  if (!confirm('End this exam? All active sessions will be stopped and no more questions will be sent to students.')) return;
  await api(`/api/exams/${id}/end`, { method: 'POST' });
  invalidateCache('/api/exams');
  invalidateCache(`/api/exams/${id}`);
  renderExam(id);
}

async function deleteExam(id) {
  if (!confirm('Permanently delete this exam and all its data?')) return;
  await api(`/api/exams/${id}`, { method: 'DELETE' });
  invalidateCache('/api/exams');
  location.hash = '#/exams';
}

async function editExamMeta(id) {
  const { exam } = examState.data;
  const div = await openModal('Edit Exam', `
    <div class="field"><label>Title</label><input type="text" id="em_title" value="${esc(exam.title)}"></div>
    <div class="field"><label>Subject</label><input type="text" id="em_subject" value="${esc(exam.subject)}"></div>
    <div class="field"><label>Description</label><textarea id="em_desc">${esc(exam.description)}</textarea></div>
    <div class="field"><label>Duration (minutes)</label><input type="number" id="em_dur" value="${exam.duration_minutes}"></div>
    <div class="field"><label>Pass mark (%)</label><input type="number" id="em_pass" value="${exam.pass_percentage}"></div>
    <div class="modal-actions" style="margin-top:18px"><button id="em_save" class="btn btn-primary">Save</button></div>
  `);
  if (!div) return;
  document.querySelector('#em_save').addEventListener('click', async () => {
    const body = {
      title: document.querySelector('#em_title').value,
      subject: document.querySelector('#em_subject').value,
      description: document.querySelector('#em_desc').value,
      duration_minutes: document.querySelector('#em_dur').value,
      pass_percentage: document.querySelector('#em_pass').value,
    };
    await api(`/api/exams/${id}`, { method: 'PATCH', body });
    invalidateCache('/api/exams');
    invalidateCache(`/api/exams/${id}`);
    div.remove();
    renderExam(id);
  });
}

// ── Results ──────────────────────────────────────────────────────

async function renderResults() {
  const hash = location.hash;
  if (hash.startsWith('#/results/')) {
    const id = hash.split('/')[2];
    return renderResultDetail(id);
  }

  $view.innerHTML = `
      ${pageHead('chart', 'RESU<span class="gr">LTS</span>', 'Completed, expired and ended sessions')}
    <div class="card table-card"><div class="skeleton skeleton-row" style="margin:10px"></div></div>`;

  const results = await api('/api/results');
  const urls = {};
  await Promise.all(results.map(async (s) => { urls[s.id] = await reportUrl(s.id).catch(() => null); }));
  $view.innerHTML = `
      ${pageHead('chart', 'RESU<span class="gr">LTS</span>', 'Completed, expired and ended sessions')}
    <div class="card table-card reveal">
      <table>
        <thead><tr><th>Student</th><th>Exam</th><th>Score</th><th>%</th><th>Result</th><th>Pass Mark</th><th>Ended</th><th></th></tr></thead>
        <tbody>
          ${results.length === 0 ? `<tr><td colspan="8"><div class="empty-state">${I.empty}<p>No completed sessions yet.</p></div></td></tr>` : ''}
          ${results.map((s) => `<tr>
            <td>${esc(s.student_name || s.phone)}</td>
            <td><a href="#/exams/${s.exam_id}">${esc(s.exam_title)}</a></td>
            <td>${s.final_score}</td>
            <td>${s.final_percentage}%</td>
            <td>${s.passed ? '<span class="pass">PASS</span>' : '<span class="fail">FAIL</span>'}</td>
            <td>${s.pass_percentage}%</td>
            <td class="muted">${s.ended_at || '—'}</td>
            <td class="row">
              ${urls[s.id] ? `<a href="${API_BASE}${urls[s.id]}" target="_blank"><button class="small ghost">Report</button></a>` : ''}
              <button class="small ghost" onclick="resendResult(${s.id})">Resend</button>
              <a href="#/results/${s.id}"><button class="small ghost">Details</button></a>
            </td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
  observeReveals();
}

async function renderResultDetail(id) {
  $view.innerHTML = `
    ${pageHead('chart', 'Loading…')}
    <div class="card"><div class="skeleton skeleton-card"></div></div>`;

  const r = await api(`/api/results/${id}`);
  const url = await reportUrl(id).catch(() => null);
  $view.innerHTML = `
    <div class="spread">
      <div>
        <h1>${esc(r.exam.title)} — ${esc(r.exam.subject)}</h1>
        <p class="muted" style="margin-top:4px">Score ${r.score}/${r.totalMarks} · ${r.percentage}% · <span class="${r.passed ? 'pass' : 'fail'}">${r.passed ? 'PASS' : 'FAIL'}</span> (pass ${r.exam.pass_percentage}%)</p>
      </div>
      <div class="row">
        ${url ? `<a href="${API_BASE}${url}" target="_blank"><button class="btn btn-primary">Open Report</button></a>` : ''}
        <button class="btn btn-ghost" onclick="resendResult(${id})">Resend Result</button>
        <a href="#/results"><button class="btn btn-ghost">Back</button></a>
      </div>
    </div>
    <div class="card table-card" style="margin-top:18px"><table>
      <thead><tr><th>#</th><th>Question</th><th>Student Answer</th><th>Key</th><th>Marks</th><th>Marked By</th><th>Feedback</th><th></th></tr></thead>
      <tbody>
        ${r.answers.map((a) => `<tr>
          <td>${a.q_order}</td>
          <td style="max-width:280px">${esc(a.text)}</td>
          <td>${a.answer_image ? `<img src="${API_BASE}/api/results/${id}/image/${encodeURIComponent(a.answer_image)}" alt="photo answer" style="max-height:90px;border-radius:8px">` : esc(a.answer_text)}</td>
          <td>${a.type === 'objective' ? esc(a.correct_answer) : '—'}</td>
          <td><input type="number" data-aw="${a.id}" value="${a.marks_awarded}" step="0.5" style="width:70px"> / ${a.max_marks}</td>
          <td>${a.marked_by}${a.needs_review ? ' ' + badge('review') : ''}${Number(a.ai_detected) === 1 ? ' ' + badge('ai-copied') : ''}</td>
          <td style="max-width:280px">${esc(a.ai_feedback)}</td>
          <td><button class="small ghost" onclick="saveMarks(${id}, ${a.id})">Save</button></td>
        </tr>`).join('')}
      </tbody>
    </table></div>`;
}

async function saveMarks(sessionId, answerId) {
  const input = document.querySelector(`[data-aw="${answerId}"]`);
  await api(`/api/results/${sessionId}/answers/${answerId}`, {
    method: 'PATCH',
    body: { marks_awarded: parseFloat(input.value), reviewed: true },
  });
  invalidateCache(`/api/results`);
  toast('Marks saved.');
  renderResultDetail(sessionId);
}

async function resendResult(id) {
  try {
    await api(`/api/results/${id}/resend`, { method: 'POST' });
    toast('Result sent via WhatsApp.');
  } catch (e) { toast(e.message, true); }
}

// ── Students ─────────────────────────────────────────────────────

async function renderStudents() {
  $view.innerHTML = `
    ${pageHead('people', 'STUD<span class="gr">ENTS</span>', 'Everyone who has interacted with the exam bot')}
    <div class="card table-card"><div class="skeleton skeleton-row" style="margin:10px"></div></div>`;

  const students = await api('/api/students');
  $view.innerHTML = `
    ${pageHead('people', 'STUD<span class="gr">ENTS</span>', 'Everyone who has interacted with the exam bot')}
    <div class="card table-card reveal">
      <table>
        <thead><tr><th>Name</th><th>Phone</th><th>Exams</th><th>Attempts</th><th>First seen</th><th></th></tr></thead>
        <tbody>
          ${students.length === 0 ? `<tr><td colspan="6"><div class="empty-state">${I.empty}<p>No students yet.</p></div></td></tr>` : ''}
          ${students.map((s) => `<tr>
            <td>${esc(s.name || '—')}</td>
            <td>${esc(s.phone)}</td>
            <td>${s.exams}</td>
            <td>${s.attempts}</td>
            <td class="muted">${s.created_at}</td>
            <td><button class="small ghost" onclick="renameStudent(${s.id})">Rename</button> <button class="small ghost danger" onclick="deleteStudent(${s.id}, this)">Delete</button></td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
  observeReveals();
}

async function renameStudent(id) {
  const name = prompt('Student name:');
  if (name == null) return;
  await api(`/api/students/${id}`, { method: 'PATCH', body: { name } });
  invalidateCache('/api/students');
  renderStudents();
}

async function deleteStudent(id, btn) {
  const name = btn.closest('tr').children[0].textContent.trim();
  if (!confirm(`Delete ${name || 'this student'}? This permanently removes their exam sessions and answers.`)) return;
  await api(`/api/students/${id}`, { method: 'DELETE' });
  invalidateCache('/api/students');
  toast('Student deleted');
  renderStudents();
}

// ── Messages (WhatsApp delivery log) ─────────────────────────────

async function renderMessages() {
  $view.innerHTML = `
    ${pageHead('envelope', 'DELI<span class="gr">VERY</span>', 'WhatsApp delivery status for outbound messages')}
    <div class="card table-card"><div class="skeleton skeleton-row" style="margin:10px"></div></div>`;

  const msgs = await api('/api/messages');
  const events = await api('/api/webhook-events');
  const webhookHealth = events.length
    ? `<div class="webhook-ok" style="background:#052e16;border:1px solid #166534;border-radius:12px;padding:12px 16px;margin:0 0 14px;font-size:13px">
        <strong>Webhook connected ✓</strong> — ${events.length} event(s) received${events[0]?.received_at ? `, last ${esc(events[0].received_at)}` : ''}. Student replies are reaching this server.
      </div>`
    : `<div class="webhook-warn" style="background:#3a1d0a;border:1px solid #92400e;border-radius:12px;padding:12px 16px;margin:0 0 14px;font-size:13px">
        <strong>⚠️ No webhook events received.</strong> Meta has never delivered a message to this server, so student
        replies cannot be processed and exams appear stuck. Verify the webhook URL in the Meta dashboard is
        <code style="background:#0b1220;padding:2px 6px;border-radius:6px">${esc((window.API_BASE || window.location.origin))}/webhook/whatsapp</code>,
        with the verify token from your <code style="background:#0b1220;padding:2px 6px;border-radius:6px">.env</code>, then send a test message to the bot.
      </div>`;
  $view.innerHTML = `
    ${pageHead('envelope', 'DELI<span class="gr">VERY</span>', 'WhatsApp delivery status for outbound messages')}
    ${webhookHealth}
    <div class="spread" style="margin-bottom:14px">
      <p class="sub" style="margin:0">${msgs.length} message(s) logged</p>
      ${msgs.length ? `<button class="btn btn-ghost" onclick="clearMessages()">Clear log</button>` : ''}
    </div>
    <div class="card table-card reveal">
      <table>
        <thead><tr><th>Recipient</th><th>Type</th><th>Status</th><th>Message ID</th><th>Sent</th><th>Updated</th></tr></thead>
        <tbody>
          ${msgs.length === 0 ? `<tr><td colspan="6"><div class="empty-state">${I.empty}<p>No messages sent yet.</p></div></td></tr>` : ''}
          ${msgs.map((m) => `<tr>
            <td>${esc(m.recipient)}</td>
            <td>${esc(m.type || 'text')}</td>
            <td>${badge(m.status || 'sent')}</td>
            <td class="muted" style="max-width:220px;word-break:break-all">${esc(m.message_id || '—')}</td>
            <td class="muted">${esc(m.created_at || '—')}</td>
            <td class="muted">${esc(m.updated_at || '—')}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
  observeReveals();
}

async function clearMessages() {
  if (!confirm('Clear the delivery log?')) return;
  await api('/api/messages', { method: 'DELETE' });
  invalidateCache('/api/messages');
  invalidateCache('/api/webhook-events');
  toast('Delivery log cleared');
  renderMessages();
}

// ── Micro-interactions ───────────────────────────────────────────
document.addEventListener('mouseover', (e) => {
  const card = e.target.closest('.card, .stat-chip, .qitem, .feature-card, .step, .panel, .mini, .browse');
  if (card && !card._glowBound) {
    card._glowBound = true;
    card.addEventListener('mousemove', (ev) => {
      const rect = card.getBoundingClientRect();
      const x = ((ev.clientX - rect.left) / rect.width) * 100;
      const y = ((ev.clientY - rect.top) / rect.height) * 100;
      requestAnimationFrame(() => {
        card.style.setProperty('--glow-x', x + '%');
        card.style.setProperty('--glow-y', y + '%');
      });
    });
  }
});

// ── Search filter (filters the visible table) ──────────────────
function applySearchFilter() {
  const q = (document.querySelector('.search input')?.value || '').trim().toLowerCase();
  document.querySelectorAll('#view table tbody tr').forEach((tr) => {
    tr.style.display = !q || tr.textContent.toLowerCase().includes(q) ? '' : 'none';
  });
}
const searchInput = document.querySelector('.search input');
if (searchInput) {
  const debouncedFilter = debounce(applySearchFilter, 150);
  searchInput.addEventListener('input', debouncedFilter);
}

// ── Boot ─────────────────────────────────────────────────────────
if (getToken()) router();
else showLanding();

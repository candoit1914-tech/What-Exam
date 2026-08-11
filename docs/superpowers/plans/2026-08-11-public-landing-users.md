# Public Landing Page for Users Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let anonymous visitors see a branded landing page (hero + WhatsApp demo + features + footer), while the dashboard and exam creation stay admin-only behind the existing password login.

**Architecture:** Frontend-only change to the vanilla-JS SPA in `src/public`. Anonymous users get `showLanding()` — the existing landing markup from `renderDashboard()` plus a hidden "Admin Sign In" login card. `body.anon` CSS hides admin chrome (nav, search, sign out, New Exam). No backend, API, DB, or test changes; `auth.verifyAdmin` already gates every `/api` route including `POST /api/exams`.

**Tech Stack:** Vanilla JS SPA, no build step, no new dependencies. Node 22.5+ (`node:sqlite`), Express backend untouched.

## Global Constraints

- No backend/API/DB/test/new-dependency changes. `npm test` must stay 114/114.
- Zero API calls from the anonymous landing (stat chips are admin-only).
- Existing motion (`bubbleIn`, `scorePop`, `initHeroScene` script/timings) stays byte-identical.
- Commit per task on `main` (user-granted workflow), messages `feat(ui): …`; after each commit run `npm test`.
- Repo style: no semicolons, template literals, 2-space indent, `// ──` section comments in `app.js`.
- Login card markup and `login()`/`logout()` semantics unchanged except entry points.
- Copy (exact): anon notice `Exams are created by your school administrator. Students take exams directly on WhatsApp.`; button label `Admin Sign In`.

## File Structure

| File | Change |
|---|---|
| `src/public/app.js` | Extract `landingHTML(anon)` helper from `renderDashboard()` (app.js:360-441); new `showLanding()` + `showLoginCard()`; delete `showLogin()`; rewire 401 handler (app.js:41), `logout()` (app.js:101), boot (app.js:1343-1344); `login()` adds/removes `body.anon` |
| `src/public/styles.css` | Append anon-landing CSS block: `body.anon` chrome hiding + embedded `.login-wrap` variants + `.anon-note` |

---

### Task 1: `app.js` — shared landing markup, `showLanding()`, auth rewiring

**Files:**
- Modify: `src/public/app.js:57-75` (replace `showLogin`), `:98-102` (`logout`), `:41` (401), `:360-441` (`renderDashboard` → helper), `:1343-1344` (boot)
- Test: manual browser + `node --check` + grep proofs (no frontend test harness exists; `npm test` covers backend only)

**Interfaces:**
- Produces: `landingHTML(anon = false)` → returns the full `<div class="landing">…</div>` string; `showLanding()` → renders landing + hidden login card and starts hero/reveal animations; `showLoginCard()` → reveals and scrolls to the login card, focuses `#login_pass`; `login()` → on success removes `body.anon` then `router()`.
- Consumes: existing `clearToken()`, `_cache`, `observeReveals()`, `initHeroScene()`, `I.*` icon map, `.login-wrap`/`.login-card` markup from current `showLogin()`.

- [ ] **Step 1: Replace `showLogin()` (app.js:57-75) with `landingHTML()`, `showLanding()`, `showLoginCard()`**

Replace the whole `showLogin()` function with:

```js
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
```

- [ ] **Step 2: Rewire the three entry points + `login()`**

1. In `api()` (app.js:41): `showLogin();` → `showLanding();`
2. In `logout()` (app.js:101): `showLogin();` → `showLanding();`
3. In `login()` success block (app.js:87-90), add the class removal before `router()`:

```js
    const { token } = await api('/api/auth/login', { method: 'POST', body: { password } });
    setToken(token);
    document.body.classList.remove('anon');
    _cache.clear();
    toast('Welcome back.');
    router();
```

4. Boot (app.js:1343-1344):

```js
if (getToken()) router();
else showLanding();
```

- [ ] **Step 3: Convert `renderDashboard()` (app.js:360-441) to use the helper**

Delete the entire inline `$view.innerHTML = \`…\`;` landing string (app.js:361-432) and replace with:

```js
async function renderDashboard() {
  $view.innerHTML = landingHTML();
  const s = await api('/api/stats');
  document.querySelectorAll('.stat-chip b[data-count]').forEach((el) => {
    const val = { exams: s.exams, live: s.published, questions: s.questions, students: s.students }[el.parentElement.querySelector('span').textContent.toLowerCase()] ?? 0;
    el.dataset.count = val;
    animateCountUp(el, val);
  });
}
```

(Keep the existing comment `// ── Overview / Landing ───────────────────────────` above it.)

- [ ] **Step 4: Verify syntax and wiring**

Run:
```bash
node --check C:\Users\pax03\Desktop\La_Exam\src\public\app.js
```
Expected: no output, exit 0.

Grep proofs (PowerShell `Select-String`):
- `showLogin\b` → zero matches (function deleted, all call sites rewired).
- `showLanding\(\)` → 4 matches: 1 definition + calls in `api()` 401, `logout()`, boot.
- `landingHTML(` → 3 matches: 1 definition + 2 calls (`renderDashboard`, `showLanding`).
- `showLoginCard` → 2 matches: definition + hero button `onclick`.
- `login-wrap--hidden` → 2 matches (markup + `showLoginCard` toggle).

- [ ] **Step 5: Commit**

```bash
git -C C:\Users\pax03\Desktop\La_Exam add src/public/app.js
git -C C:\Users\pax03\Desktop\La_Exam commit -m "feat(ui): public landing page for anonymous visitors"
```
Then run `npm test` in `C:\Users\pax03\Desktop\La_Exam` → 114/114.

---

### Task 2: `styles.css` — hide admin chrome + embedded login card styles

**Files:**
- Modify: `src/public/styles.css` (append block at end of file, after the fine-pointer media query at :1396-1467)

**Interfaces:**
- Consumes: `body.anon` class toggled by `showLanding()`/`login()` (Task 1); `login-wrap--hidden`/`login-wrap--show` classes toggled by `showLoginCard()`; `.anon-note` markup rendered by `landingHTML(true)`.

- [ ] **Step 1: Append the CSS block**

Append at the end of `styles.css`:

```css
/* ── Anonymous landing (public users) ──────────────────── */
body.anon .topnav,
body.anon .search,
body.anon .logout-btn,
body.anon .topbar-actions .btn-primary { display: none; }
.landing .login-wrap {
  min-height: 0;
  margin: 30px auto 0;
  padding: 0 16px;
}
.landing .login-wrap--hidden { display: none; }
.landing .login-wrap--show { display: grid; }
.anon-note {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: -18px 0 30px;
  font-size: 13.5px;
  color: var(--text-secondary);
}
.anon-note::before {
  content: '';
  flex: none;
  width: 8px; height: 8px;
  border-radius: 50%;
  background: var(--green);
  box-shadow: 0 0 0 4px rgba(37, 211, 102, 0.15);
}
```

Note: `.login-wrap--show { display: grid; }` must win over `body.anon`-independent base `.login-wrap` (it does — same specificity, later in file; the base block has no `display` override so grid layout still comes from the original `.login-wrap` rule at styles.css:1365-1371).

- [ ] **Step 2: Verify**

Run:
```bash
Select-String -Path C:\Users\pax03\Desktop\La_Exam\src\public\styles.css -Pattern "body.anon|login-wrap--hidden|anon-note"
```
Expected: 4 selector lines present (1 × `body.anon` group, 2 × `login-wrap--` variants, 1 × `.anon-note`).

- [ ] **Step 3: Commit**

```bash
git -C C:\Users\pax03\Desktop\La_Exam add src/public/styles.css
git -C C:\Users\pax03\Desktop\La_Exam commit -m "feat(ui): hide admin chrome for anonymous visitors"
```
Then run `npm test` in `C:\Users\pax03\Desktop\La_Exam` → 114/114.

---

### Task 3: Visual verification (no code unless fixes needed)

- [ ] **Step 1: Start the servers**

If not already running:
```bash
npm run start:all   # backend :3000 + frontend :8080, in C:\Users\pax03\Desktop\La_Exam
```

- [ ] **Step 2: Anonymous checklist** — open `http://localhost:3000` (and `http://localhost:8080`) in a browser:
  - Landing hero renders: eyebrow, headline, sub-copy, animated iOS WhatsApp chat demo, "How it works" cards, footer.
  - Topbar shows only the brand — no nav items, no search, no Sign out, no "New Exam".
  - Stat chips absent; anon notice visible under the single "Admin Sign In" button.
  - Click "Admin Sign In" → page scrolls, login card appears, password input focused.
  - Wrong password → red toast, stays on landing.
  - Hash `#/exams` → view swaps back to the landing (401 path).

- [ ] **Step 3: Admin checklist** — sign in with the admin password:
  - Full dashboard returns: nav, search, Sign out, "New Exam", stat chips counted up.
  - Logout → landing page (not a bare login card).
  - DevTools: while anonymous, no network requests to `/api/*` except none at all.

- [ ] **Step 4: Session-expiry checklist** — while logged in, delete the token (DevTools → Application → Local Storage → `wa_exam_token`) and reload: landing shown, not the login card.

- [ ] **Step 5: `npm test`** → 114/114. No commit unless a fix lands (then `fix(ui): …`).

## Rollback

Each task is a single commit; `git revert` either in order. No migrations, no data impact. Anonymous users lose nothing (zero API surface); admin flow unchanged.

## Self-Review Notes

- Spec coverage: entry points (boot/logout/401/login) ✓ Task 1; shared markup + anon notice + sign-in button ✓ Task 1; stat chips omitted + zero API calls ✓ Task 1 (helper renders chips only when `anon=false`); `body.anon` chrome hiding ✓ Task 2; error handling ✓ Task 1 (401 → landing) + Task 3 step 4; testing ✓ Tasks 1-3.
- Placeholders: none — all code blocks are complete; line numbers verified against current `app.js`/`styles.css`.
- Type/name consistency: `landingHTML`, `showLanding`, `showLoginCard`, `login-wrap--hidden`, `login-wrap--show`, `anon-note`, `body.anon` used identically across tasks and the spec.

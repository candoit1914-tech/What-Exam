# Spec — Public landing page for users (admin-only exam creation)

- Date: 2026-08-11
- Status: Approved by user (design summary), 2026-08-11
- Scope: Let anyone visiting the frontend see a branded landing page; the dashboard and exam creation remain admin-only (login). Frontend-only change — no backend, API, DB, or test changes.

## Context

Today, a visitor who opens the site (frontend SPA at `/`, served by `src/frontend.js`, or the backend at :3000) is greeted by a bare admin login card and nothing else. The user wants:

1. Users (students, teachers, visitors without the admin password) to be able to **see the frontend page** — the marketing/landing content.
2. **Exam creation stays admin-only** — already the case: every `/api` route (incl. `POST /api/exams`, `src/routes/api.js:125`) is behind `auth.verifyAdmin` (`src/routes/api.js:27-34`); only the published WhatsApp flow (`src/routes/webhook.js`) is public, and it cannot create exams. **No backend change is required or desired.**

The dashboard landing view (`renderDashboard()`, `src/public/app.js:360-441`) already contains the marketing content we need: hero + animated WhatsApp chat demo (`initHeroScene()`, `app.js:231-305`), "How it works" feature cards, and a footer. The plan is to surface that markup to anonymous users, minus admin-only bits.

## Architecture

Single-file SPA change. Anonymous users get `showLanding()`; admins get the current `router()` flow. No new endpoints, no new files served, no new dependencies.

## Behavior (approved)

### Entry points

- **Boot** (`src/public/app.js:1343-1344`): `if (getToken()) router(); else showLanding();`
- **`logout()`** (`app.js:98-102`): ends on `showLanding()` instead of `showLogin()`.
- **401 handler** in `api()` (`app.js:39-43`): calls `showLanding()` instead of `showLogin()` (covers expired sessions mid-use).
- **`login()`** (`app.js:77-96`): unchanged — on success `router()`; on failure toast error and stay on the landing.

### `showLanding()` (new, `app.js` around the auth section)

Renders into `#view`:

1. A **hero section** reusing the landing markup from `renderDashboard()`: eyebrow, headline ("EXAMS THAT MARK THEMSELVES"), sub-copy, the iOS-style WhatsApp chat demo (`initHeroScene()` runs it), "How it works" feature cards, and the footer.
2. Hero actions **replaced** for anonymous visitors: "Create an Exam" / "View Results" become a single **"Admin Sign In"** button that reveals the login card below (and focuses the password field).
3. **Stat chips omitted** — they populate from `/api/stats` (admin-only); calling it anonymously would 401. No API call is made on the landing at all.
4. A short anon-only notice line under the hero actions: *"Exams are created by your school administrator. Students take exams directly on WhatsApp."*
5. The login card (existing markup, `app.js:57-75`) rendered after the hero content with class `login-card--hidden` (CSS: `display: none`), revealed by swapping to `login-card--show` when "Admin Sign In" is clicked; the password input is focused on reveal.

Implementation shape: `showLanding()` builds the same static HTML used by `renderDashboard()`. To avoid duplicating ~70 lines of hero/features/footer markup, `renderDashboard()` and `showLanding()` share the markup via a small helper (e.g. `landingHTML({ anonymous })`) that returns hero/features/footer; `renderDashboard()` adds the stat chips and the admin actions, then fetches `/api/stats` as today; `showLanding()` adds the anonymous notice, the Sign In button, and the hidden login card. `initHeroScene()` and `observeReveals()` run in both paths.

### Topbar (`src/public/index.html:18-62`)

For anonymous visitors the topbar must not expose admin affordances. `showLanding()` adds a class to `<body>` (e.g. `body.anon`); `router()`/`login()` removes it. CSS hides `.topnav`, `.search`, `.logout-btn`, and the topbar "New Exam" button when `body.anon` is present (e.g. `body.anon .topnav, body.anon .search, body.anon .logout-btn, body.anon .topbar-actions .btn-primary { display: none; }`). The brand link stays — `#/` routes to the landing when logged out.

Hash links that would hit admin routes while anonymous (e.g. `#/exams`) fall through `router()` → admin renderer → `api()` 401 → `showLanding()`, so they are safe even if reached; with the nav hidden they should not be clickable in normal use.

### Data flow

- Anonymous: zero API calls; no token stored; nothing new exposed.
- Admin: identical to today (boot → `router()` → dashboard views, stats, etc.).
- Session expiry: 401 → `showLanding()`.

## Error handling

- Login failure: toast with server error, stay on landing, form re-enabled.
- 401 mid-session: token cleared, landing shown.
- `initHeroScene()` failures are already guarded (`dataset.scene` + `chat.isConnected` checks); unchanged.

## Testing

1. `node --check src/public/app.js`.
2. Manual browser pass (served locally):
   - Anonymous: landing hero + chat animation + features + footer; nav/Sign out/New Exam hidden; stat chips absent; notice visible; "Admin Sign In" reveals login card.
   - Admin: login → full dashboard (nav + New Exam + stats) exactly as today; logout → landing (not bare login card).
   - Expiry: force a 401 (e.g. clear server session) → landing shown.
3. `npm test` → 114/114 (no backend change; suite does not cover SPA markup).

## Non-goals

- No new admin/user roles or accounts — "users" are anonymous visitors; only the single admin password login exists.
- No public read-only API/data views (exam lists, results) for anonymous visitors.
- No backend or API changes of any kind.
- No changes to the WhatsApp student flow.

## Rollback

Single revert of the frontend commit (`git revert <sha>`) restores the login-gate behavior. No migration, no data impact.
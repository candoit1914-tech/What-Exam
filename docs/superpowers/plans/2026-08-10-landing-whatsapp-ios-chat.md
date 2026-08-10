# Plan: iOS WhatsApp-style landing chat demo restyle

Date: 2026-08-10
Spec: `docs/superpowers/specs/2026-08-10-landing-whatsapp-ios-chat-design.md`

## Goal

Restyle the existing scripted WhatsApp chat demo on the landing hero (`.wapp-*`
markup inside `initHeroScene()`) to look like an iOS WhatsApp chat view —
light translucent header with the app icon avatar, green `#DCF8C6` outgoing /
white `#FFFFFF` incoming bubbles with 16px radius + 4px tail corner and
bottom tails, blue `#34B7F1` read ticks on the bot's **final** outgoing
bubble, `HH:MM` timestamps, doodle wallpaper ≤6% opacity, "TODAY" date pill,
caption chips, Apple system font stack. Demo only — no backend, API, DB, or
test changes.

## Architecture & Files

| File | Lines | Change |
|---|---|---|
| `src/public/app.js` | 240, 241, 250, 254, 256 (script + reduced-motion static block), 384 (hero header) | Markup only: avatar `WE` → `<img src="/icon.svg">`; move `✔✔` ticks off the two student "in" bubbles onto the two final "out" bubbles (script + static) |
| `src/public/styles.css` | 560–784 (`.wapp` … `.wapp-typing`) + `.wapp::after` at 570–581 | Replace whole block with iOS restyle; nothing else in the file touched |

Demo script sequence/timings (app.js:245–259), `bubble()/typing()/score()/date()`
helpers, `dataset.scene` guard, and both animations (`bubbleIn`, `scorePop`)
stay byte-identical.

Note: the wapp-ticks markup exists in **two** places — the reduced-motion
static block (app.js:236–241) and the animated script (250, 254). Both must
change, or reduced-motion users see ticks in the wrong bubbles.

## Global Constraints

- No backend/API/DB/test/new-dependency changes. `npm test` must stay 114/114.
- No new motion: `bubbleIn` (0.45s var(--ease-out)) and `scorePop` (0.6s) unchanged.
- `/icon.svg` already exists in `src/public` and is served from the same origin.
- Font stack: `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`.
- Commit per task on `main` (user-granted workflow), messages `feat(ui): …`, after each commit run `npm test`.

## Task 1 — app.js markup tweaks (ticks + avatar)

Edit `src/public/app.js` only. No CSS yet (ticks stay blue-ish; CSS lands in Task 2).

Steps:
1. Line 384: `<div class="wapp-ava">WE</div>` → `<img class="wapp-ava" src="/icon.svg" alt="Exam Bot">`.
2. Remove the ticks span from the student "in" bubbles:
   - line 240 (static block inside `prefers-reduced-motion`): `A<span class="b-time">09:43<span class="wapp-ticks">✔✔</span></span>` → `A<span class="b-time">09:43</span>`
   - line 250 (script): `'A<span class="b-time">09:43<span class="wapp-ticks">✔✔</span></span>'` → `'A<span class="b-time">09:43</span>'`
   - line 254 (script): `'Rainwater washes away topsoil and wind blows dry soil away.<span class="b-time">09:45<span class="wapp-ticks">✔✔</span></span>'` → `'Rainwater washes away topsoil and wind blows dry soil away.<span class="b-time">09:45</span>'`
3. Add the ticks span to the **final** outgoing bubble's `.b-time`:
   - line 241 (static): `…<span class="b-time">09:43</span>` → `<span class="b-time">09:43<span class="wapp-ticks">✔✔</span></span>` in the `AI MARKING` bubble
   - line 256 (script): `…AI THEORY MARKING…<span class="b-time">09:45</span>` → `<span class="b-time">09:45<span class="wapp-ticks">✔✔</span></span>`

Verification:
- `node --check src/public/app.js` clean.
- Grep proof: `wapp-ticks` appears exactly twice in `src/public/app.js` (static line 241, script line 256), both inside `.b-time` of an `cls: 'out'` / `class="wapp-bubble out"` bubble; zero occurrences in "in" bubbles; `<img class="wapp-ava"` exactly once.
- `npm test` → 114 pass.
- Commit `feat(ui): move read ticks to bot's final bubble, use app icon avatar`.

## Task 2 — styles.css iOS restyle

Replace the block at styles.css:560–784 with the following (keep the
`@keyframes` rules `bubbleIn` and `scorePop` unchanged — they live inside the
replaced range only as references; define no new keyframes):

```css
.wapp {
  width: min(360px, 100%);
  margin: 0 auto;
  border-radius: 28px;
  background: #EFEAE2;
  border: 1px solid rgba(0, 0, 0, 0.1);
  box-shadow: 0 30px 70px rgba(0, 0, 0, 0.45);
  overflow: hidden;
  position: relative;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}
.wapp::after {
  content: '';
  position: absolute;
  top: 0; left: 50%;
  transform: translateX(-50%);
  width: 130px; height: 24px;
  background: rgba(237, 237, 237, 0.95);
  border-radius: 0 0 14px 14px;
  border: 1px solid rgba(0, 0, 0, 0.1);
  border-top: none;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.08);
  z-index: 3;
}
.wapp-head {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 14px 8px 8px;
  background: rgba(237, 237, 237, 0.94);
  -webkit-backdrop-filter: blur(12px);
  backdrop-filter: blur(12px);
  border-bottom: 0.5px solid rgba(0, 0, 0, 0.08);
}
.wapp-ava {
  flex: none;
  width: 38px; height: 38px;
  border-radius: 50%;
  object-fit: cover;
  background: linear-gradient(145deg, #25D366, #128C7E);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.35);
}
.wapp-id { flex: 1; min-width: 0; padding-left: 4px; }
.wapp-id b { display: block; font-size: 16.5px; font-weight: 600; color: #111B21; }
.wapp-id span { font-size: 12px; color: #00A884; }
.wapp-head .wa-icon {
  width: 36px; height: 36px;
  border: none;
  background: transparent;
  color: #008069;
  display: grid;
  place-items: center;
  cursor: pointer;
  border-radius: 50%;
}
.wapp-head .wa-icon svg { width: 21px; height: 21px; }
.wapp-chat {
  position: relative;
  min-height: 380px;
  max-height: 420px;
  padding: 10px 8px;
  display: flex;
  flex-direction: column;
  gap: 5px;
  overflow: hidden;
  background-color: #EFEAE2;
}
.wapp-chat::before {
  content: '';
  position: absolute;
  inset: 0;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120' viewBox='0 0 120 120'%3E%3Cg fill='none' stroke='%23667C7A' stroke-opacity='0.06'%3E%3Cpath d='M10 20c0 6 4 10 10 10M90 90c6 0 10-4 10-10' stroke-width='2'/%3E%3Ccircle cx='60' cy='30' r='4'/%3E%3Ccircle cx='30' cy='80' r='3'/%3E%3Ccircle cx='92' cy='18' r='3'/%3E%3Cpath d='M18 60c4 4 8 4 12 0M70 60c4 4 8 4 12 0M40 45c0 4 3 7 7 7M88 62c0 4-3 7-7 7' stroke-width='2'/%3E%3Cpath d='M26 40l4 4M52 92l4 4M84 44l4-4M14 100l4-4' stroke-width='2'/%3E%3Cpath d='M104 40c0 3-2 5-5 5s-5-2-5-5' stroke-width='2'/%3E%3C/g%3E%3C/svg%3E");
  background-size: 120px 120px;
  opacity: 1;
  pointer-events: none;
}
.wapp-chat > * { position: relative; }
.wapp-bubble {
  position: relative;
  max-width: 75%;
  padding: 7px 10px 8px;
  border-radius: 16px;
  font-size: 14.5px;
  line-height: 1.45;
  color: #111B21;
  box-shadow: 0 1px 0.5px rgba(17, 27, 33, 0.13);
  transform: translateY(14px) scale(0.94);
  opacity: 0;
  animation: bubbleIn 0.45s var(--ease-out) forwards;
}
@keyframes bubbleIn {
  to { transform: translateY(0) scale(1); opacity: 1; }
}
.wapp-bubble.in {
  align-self: flex-start;
  background: #FFFFFF;
  border-top-left-radius: 4px;
}
.wapp-bubble.in::before {
  content: '';
  position: absolute;
  bottom: 0; left: -6px;
  width: 13px; height: 13px;
  background: #FFFFFF;
  border-top-right-radius: 100%;
}
.wapp-bubble.out {
  align-self: flex-end;
  background: #DCF8C6;
  border-top-right-radius: 4px;
}
.wapp-bubble.out::before {
  content: '';
  position: absolute;
  bottom: 0; right: -6px;
  width: 13px; height: 13px;
  background: #DCF8C6;
  border-top-left-radius: 100%;
}
.wapp-bubble .b-label {
  display: block;
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: #008069;
  margin-bottom: 3px;
}
.wapp-bubble.in .b-label { color: #667781; }
.wapp-bubble .b-opts {
  margin-top: 6px;
  padding: 7px 10px;
  border-left: 2px solid rgba(0, 128, 105, 0.4);
  background: rgba(11, 20, 26, 0.04);
  border-radius: 8px;
  font-size: 13px;
  line-height: 1.65;
}
.wapp-bubble .b-opts b { color: #008069; font-weight: 800; }
.wapp-bubble .b-hint {
  margin-top: 6px;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: #0B7A5E;
  opacity: 0.85;
}
.wapp-bubble .b-time {
  float: right;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  margin: 8px -4px -4px 10px;
  font-size: 11px;
  font-weight: 400;
  color: rgba(17, 27, 33, 0.5);
}
.wapp-bubble.in .b-time { color: rgba(17, 27, 33, 0.5); }
.wapp-ticks {
  display: inline-flex;
  align-items: center;
  gap: 1px;
  font-size: 13px;
  font-weight: 400;
  color: #34B7F1;
}
.wapp-date {
  align-self: center;
  padding: 5px 12px;
  margin: 2px 0 4px;
  border-radius: 7.5px;
  background: rgba(255, 255, 255, 0.95);
  border: 1px solid rgba(17, 27, 33, 0.07);
  box-shadow: 0 1px 1px rgba(0, 0, 0, 0.05);
  font-size: 11.5px;
  font-weight: 500;
  color: rgba(17, 27, 33, 0.6);
}
.wapp-score {
  align-self: center;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 8px 16px;
  margin-top: 2px;
  border-radius: 999px;
  background: #DCF8C6;
  border: 1px solid rgba(7, 94, 84, 0.2);
  font-size: 12.5px;
  font-weight: 700;
  color: #005C4B;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
  transform: scale(0.92);
  opacity: 0;
  animation: scorePop 0.6s var(--ease-out) forwards;
}
@keyframes scorePop {
  to { transform: scale(1); opacity: 1; }
}
.wapp-score b { font-family: var(--display); font-size: 15px; }
.wapp-typing {
  position: relative;
  align-self: flex-start;
  display: inline-flex;
  gap: 4px;
  padding: 11px 14px;
  background: #FFFFFF;
  border-radius: 16px;
  border-top-left-radius: 4px;
}
.wapp-typing::before {
  content: '';
  position: absolute;
  bottom: 0; left: -6px;
  width: 13px; height: 13px;
  background: #FFFFFF;
  border-top-right-radius: 100%;
}
.wapp-typing i {
  width: 7px; height: 7px;
  border-radius: 50%;
  background: #7B8A93;
  animation: typingDot 1.2s ease-in-out infinite;
}
.wapp-typing i:nth-child(2) { animation-delay: 0.15s; }
.wapp-typing i:nth-child(3) { animation-delay: 0.3s; }
```

Steps:
1. Replace exactly the ranges styles.css:570–581 (`.wapp::after`), 582–635 (head/avatar/id/icons/chat/wallpaper), 636–738 (bubbles/labels/ticks/date), 759–784 (typing) with the block above; keep no leftover old rules (e.g. old `.wapp-bubble.in::before` top tails, `.wapp-ava` grid + `var(--display)` text styles are gone).
2. The `@keyframes bubbleIn` / `scorePop` definitions must remain in the file exactly once (they already are; the new block re-states them at the same place — do not duplicate elsewhere).

Verification:
- `node --check` not applicable (CSS); instead: `Select-String -Path src/public/styles.css -Pattern 'wapp'` → only the intended selectors remain, no `base64` or `.wapp` rules outside 560–784 that were left stale.
- Hard-code spot-checks in diff review: `#DCF8C6` outgoing, `#FFFFFF` incoming, `stroke-opacity='0.06'`, `#34B7F1` ticks, `#00A884` online, two `top-right-radius: 100%` / `top-left-radius: 100%` tails, `font-size: 11px` timestamps, `16px` + `4px` radii, no `top: 0`-style old tails.
- `npm test` → 114 pass (unchanged).
- Commit `feat(ui): iOS WhatsApp-style landing chat restyle`.

## Task 3 — Visual verification (no code unless fixes needed)

1. Server already running (PID 2316 on :3000; if dead: `Start-Process node src/server.js -RedirectStandardOutput "$env:TEMP\opencode\laexam-boot.out.log" -RedirectStandardError "$env:TEMP\opencode\laexam-boot.err.log"`).
2. Open `http://localhost:3000` → landing hero shows the demo chat.
3. Checklist (from spec Section 1): timestamped links: header light translucent w/ `/icon.svg` avatar + "Exam Bot" + green online; green out / white in bubbles, 75% max-width, 16px radius, 4px corner, bottom tails; blue read ticks only on final bot bubble; 11px HH:MM stamps; doodle wallpaper subtle; "TODAY" pill at top; caption chips teal/gray; Apple font stack.
4. Toggle OS reduced-motion (or DevTools emulation) → static block renders same layout with ticks on final bot bubble.
5. `npm test` → 114/114.
6. No commit for this task unless a fix lands (then append to Task 2's commit via a new `fix(ui): …` commit).

## Rollback

Each task is a single commit; revert per task (`git revert <sha>`). The two
tasks never touch the same line simultaneously after commit ordering (app.js
vs styles.css), so reverts are conflict-free.
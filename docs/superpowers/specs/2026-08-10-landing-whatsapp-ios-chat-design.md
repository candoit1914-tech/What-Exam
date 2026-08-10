# Spec — iOS WhatsApp-style chat for the landing demo

- Date: 2026-08-10
- Status: Approved by user (both sections), 2026-08-10
- Scope: Restyle the existing scripted `.wapp-*` chat demo on the login/landing screen to look like a genuine iOS WhatsApp conversation. Demo only — no real conversation view, no backend changes.

## Context

The dashboard landing/login screen (served at `/`) contains a scripted WhatsApp-style chat demo used as a marketing hero. It is built from:

- `src/public/app.js:232-290` — the demo script: `TYPE OUT A QUESTION`-style choreography with `bubble(cls, html)` (+ color/ticks), typing indicator, options render, and the WhatsApp header.
- `src/public/styles.css:560-769` — `.wapp`, `.wapp-head`, `.wapp-chat`, `.wapp-bubble.in/.out`, `.b-label`, `.b-opts`, `.b-time`, `.wapp-ticks`, `.wapp-date`, `.wapp-score`, `.wapp-typing`, tails via `::before`.

The current look is generic; the goal is a convincing iOS WhatsApp appearance with minimal churn.

## Visual spec (approved)

- **Bubbles**
  - Outgoing (Exam Bot): background `#DCF8C6`, right-aligned, corner radius 16px with the tail corner at 4px; tail bottom-right.
  - Incoming (student): background `#FFFFFF`, left-aligned, same radii; tail bottom-left.
  - Max width 75% of the chat area. Text color `#111B21`, font-size 15px.
  - Padding ~7px 10px, bubble margin ~3px with tighter stacking (margin 1px between consecutive bubbles of the same side).
- **Ticks**: `#34B7F1` double-tick (read) on the FINAL Exam Bot bubble (currently the demo shows `wapp-ticks` on the student's last incoming bubble — the markup moves them to the bot's final outgoing "AI THEORY MARKING" bubble, matching real WhatsApp semantics; incoming bubbles carry no ticks).
- **Timestamps**: 11px `rgba(17,27,33,.5)`, bottom-right inside bubble, `HH:MM` format as today.
- **Header** (`.wapp-head`): iOS-style translucent light bar (rgba white with blur), avatar circle using `/icon.svg`, bold dark name "What Exam", green `#00A884` "online" subtitle; decorative back-chevron + video/phone glyphs (SVG, muted gray-green).
- **Wallpaper**: the chat area gets a faint repeating doodle pattern via a low-opacity (≤6% black) inline SVG data-URI background; text remains fully legible.
- **Date chip**: centered "TODAY" pill (bg `#FFF` at ~85% opacity, 12px caption text `rgba(17,27,33,.6)`, subtle shadow) inserted before the first message.
- **Typography**: `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif` throughout the chat widget.
- **Labels** (`.b-label`, "QUESTION 1 · OBJECTIVE", "AI MARKING", etc.): small caption chips — teal `#008069` tint for out, gray for in — rendered above/inside the bubble top edge, 10.5px uppercase tracking-wide.
- **Reduced motion**: no new motion is introduced; existing scripted timings are preserved.

## Structure & behavior (approved)

- Files: `src/public/styles.css` (bulk of the change) and minimal `src/public/app.js` tweaks:
  - date-chip element ("TODAY") inserted at chat start before the first message;
  - header avatar swaps from the text initials "WE" (`.wapp-ava`, app.js:384) to the app icon `/icon.svg` (brand consistency; header identity "Exam Bot" + "online" already correct);
  - move `wapp-ticks` from the student's last incoming bubble to the bot's final outgoing bubble (blue read ticks).
- The scripted sequence, timings, typing indicator, and options rendering in `app.js:232-290` are otherwise NOT changed.
- No backend, API, database, or test-suite changes. Existing `npm test` must stay green (it does not cover landing markup).
- Branding: the widget identity stays "Exam Bot" with the app icon.

## Verification

1. `npm test` — full suite green (unchanged behavior).
2. Serve locally (`npm run dev`), capture a screenshot of the landing demo (Playwright if available in the environment; otherwise a manual browser check), and confirm: iOS bubble colors/alignment/tails, read ticks, timestamp placement, header chrome, date chip, wallpaper legibility, no console errors.
3. Optional screenshot artifact saved under `.superpowers/sdd/<plan>/` review package for the task review.

## Non-goals

- No real conversation view fed by `webhook-events`/`outbound_messages`.
- No changes to message storage or WhatsApp API.
- No new dependencies.
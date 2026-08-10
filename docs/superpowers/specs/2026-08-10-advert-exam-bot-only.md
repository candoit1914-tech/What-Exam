# Spec: Exam-Bot-only advert rework (26s, iOS chat style)

Date: 2026-08-10

## Goal

Rework the existing Remotion advert in `advert/` (26s, 780 frames @ 30fps,
1920x1080) so its visuals feature **only the Exam Bot** — the WhatsApp chat
persona with the app icon — in the same iOS chat style as the landing demo
restyle (spec `2026-08-10-landing-whatsapp-ios-chat-design.md`). Replace the
"WHAT EXAM" wordmark, dashboard mockup, and results-table scenes with chat
scenes. Re-record the voiceover (same voice `en-US-GuyNeural`, `-5%`, `-2Hz`)
with the new lines. Re-render `out/advert.mp4`.

Deliverables:
1. Edited `advert/src/WhatExamAdvert.tsx` (+ `advert/src/Root.tsx` if needed for identity).
2. `advert/public/icon.svg` (copy of `src/public/icon.svg`, the app icon).
3. Regenerated VO files in `advert/public/audio/` (via `advert/scripts/generate-voiceover.py`) + updated `vo-manifest.json`.
4. Freshly rendered `advert/out/advert.mp4`.

## Visual language (mandatory, reused from the landing restyle spec)

- Chat canvas: `#EFEAE2` with the doodle wallpaper (SVG data-URI, stroke `#667C7A` at 6% opacity).
- Bubbles: outgoing `#DCF8C6` right-aligned; incoming `#FFFFFF` left-aligned; radius 16px with 4px tail-corner (top-left 4px for in, top-right 4px for out); tails at the **bottom** edge; text `#111B21`, ~15px.
- Read ticks: `#34B7F1` double tick on the bot's (outgoing) final message.
- Timestamps: 11px `rgba(17, 27, 33, 0.5)`, `HH:MM`, bottom-right of bubble.
- Header: translucent light bar `rgba(237, 237, 237, 0.94)` (+blur), back-chevron + video/phone/plus glyphs in `#008069`, avatar = `icon.svg`, name "Exam Bot" `#111B21` 16.5px/600, "online" `#00A884` 12px.
- Date pill: white, 11.5px, `rgba(17, 27, 33, 0.6)` text.
- Caption chips inside bubbles: uppercase 10.5px, letter-spacing 0.07em — teal `#008069` (out), gray `#667781` (in).
- Score pill: `#DCF8C6` bg, `#005C4B` text, 999px radius.
- Typography: `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`.
- Brand lockups (intro/outro): the app `icon.svg` + wordmark "Exam Bot" in `#111B21`, on `#EFEAE2`/light background. The word "What Exam" is never used (monitor: no "WHAT EXAM" caption/TEXT node remains).

## Voiceover (exact new lines, replaces VO_LINES in generate-voiceover.py)

| id | text | start_frame |
|---|---|---|
| 01-intro | `Exam Bot.` | 30 |
| 02-tagline | `Exams that mark themselves. Your bot delivers them — AI does the rest.` | 140 |
| 03-chat | `Students take exams right inside WhatsApp. One question at a time, with a live timer keeping things fair.` | 285 |
| 04-answers | `Answers arrive as text or photos. Theory, diagrams — whatever the question needs.` | 495 |
| 05-aimarking | `Every answer is graded by AI — instantly. Scored across correctness, completeness, and relevance. No waiting. No manual marking.` | 675 |
| 06-results | `Results the moment the exam ends.` | 785 |
| 07-outro | `Exam Bot. Start examining — for free.` | 845 |

Sequence timing (unchanged from current composition, 26s @ 30fps = 780 frames):

| # | Frames | Duration | Scene content (new) | VO id |
|---|---|---|---|---|
| 1 | 0–60 | 2s | Intro: icon reveal + "Exam Bot" lockup (replaces WHAT EXAM logo) | 01 |
| 2 | 60–180 | 4s | Tagline over iOS chat: greeting bubbles in/out | 02 |
| 3 | 180–360 | 6s | Chat: question bubble w/ caption chip, options, student answer, blue ticks (replaces dashboard mockup) | 03 |
| 4 | 360–510 | 5s | Chat: photo-answer bubble (image bubble with app-icon badge), continued | 04 |
| 5 | 510–690 | 6s | AI marking: ✓ Correct — +1 mark + analysis chips (replaces theory-marking mock) | 05 |
| 6 | 690–750 | 2s | Results: score pill "Exam complete — 9 / 10 · Pass" in chat (replaces results table) | 06 |
| 7 | 750–780 | 1s | Outro: icon + "Exam Bot" lockup + "Start examining — for free." + `whatexam.com` | 07 |

- BGM `bgm.wav` at 0.15 and whoosh at [60, 180, 360, 510, 690, 750], ding at 385, chime at 710: **unchanged**.
- Scene transitions may reuse the existing easing, but every scene's *content* is chat UI or the icon lockup.
- VO filenames follow the manifest ids: `vo-02-tagline.mp3` stays, `vo-03-dashboard.mp3` → `vo-03-chat.mp3`, `vo-04-whatsapp.mp3` → `vo-04-answers.mp3`; the TSX `<Audio>` srcs must be updated to match, `Sequence from/durationInFrames` stay as currently hardcoded.

## Implementation notes

- Chat scenes are static (non-animated) frame compositions matching the landing demo's UI — no chat animation required inside the advert; the existing per-scene motion/slide-ins stay.
- `advert/src/Root.tsx` keeps the `WhatExamAdvert` composition id + fps (render script unchanged; only visuals/audio content change). `npm run build` (npx remotion render) must produce the MP4 locally.
- VO regeneration requires `pip install edge-tts` if missing, and takes ~10 seconds per line.

## Out of scope

- No changes to 16:9 aspect, duration, bgm/SFX positions, or the Remotion version.
- No new dependencies; no changes outside `advert/` (except the copied `icon.svg`).
- Question-generation speed work: **dropped for now** (user decision).
- The landing iOS restyle stays governed by its own spec/plan (runs after/independently).
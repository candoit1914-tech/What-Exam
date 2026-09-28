# Participant Roster: Download and Print

Date: 2026-09-28
Status: approved

## Problem

An exam administrator can see a per-recipient roster in the admin SPA
(`src/public/app.js:711`) showing `Finished` / `In progress` / `Not started` /
`Not sent`. There is no way to download it or print it, and no ranked view by
score, so results cannot be circulated as a document or a spreadsheet.

Separately, administrators need to see at a glance that a student who never
started still holds their full allotted time. The timer only begins on the
student's first answer (`handleInbound` resets `started_at` while a session has
no answers), so a non-starter genuinely keeps the entire window. That behaviour
is correct today but invisible.

## Decisions

These were settled with the user before implementation.

1. **Four separate sections, not one list.** Finished students are ranked by
   percentage. In-progress, not-started and not-sent students appear in their
   own unranked tables. Nobody is shown a 0% they never earned, because a
   student mid-exam is not the same as a student who failed everything.

2. **Best attempt only.** The schema allows `max_attempts` sessions per exam
   (0 = unlimited), so one student can hold several sessions. Only each
   student's highest-scoring finished attempt appears in the ranked list, so a
   student never occupies two positions in the ranking.

3. **Print via the browser, not a PDF library.** A standalone HTML page with
   inline `@media print` CSS, printed with Ctrl+P ("Save as PDF" from the print
   dialog). Chosen over a client-side PDF library (new dependency, fragile table
   pagination) and over server-side headless Chrome (heavyweight, slow, memory
   pressure on a small Render instance). The service stays dependency-free.

## Architecture

One pure function powers the screen, the print page and the CSV, so the three
renderings can never disagree.

```js
// src/services/results.js
buildParticipantRoster(examId) => {
  exam, finished[], inProgress[], notStarted[], notSent[], summary
}
```

`finished` arrives pre-sorted and carrying an explicit `rank`. The UI, the
print page and the CSV all iterate that same array rather than re-deriving
order.

### Data source

No schema change. Uses the existing `sessions.final_score`,
`sessions.final_percentage`, `sessions.passed` columns and the existing
`exam_recipients` table. Ranking happens in SQL rather than JavaScript:

```sql
ROW_NUMBER() OVER (
  PARTITION BY student_id
  ORDER BY final_percentage DESC, final_score DESC, ended_at ASC
)
```

Filtering `rank = 1` yields one row per student. Ties break by higher
`final_score`, then by earlier `ended_at`. A `NULL` percentage coalesces to
`-1` so an ungraded attempt sorts last instead of raising an error. The database
is `DatabaseSync` from `node:sqlite`, so window functions are available.

### Sections

| Section | Session statuses | Ranked |
|---|---|---|
| Finished | `completed`, `ended`, `expired` | Yes, 1..N |
| In progress | `in_progress` | No |
| Not started | recipient with a session but no answers | No |
| Not sent | recipient never delivered the exam | No |

The four buckets are mutually exclusive and collectively cover every recipient.

The Not started section shows the allotted duration and the time remaining,
which makes the timer behaviour visible to an administrator.

## Routes

All three sit in `src/routes/api.js`, whose `router.use` guard at line 81
already requires `auth.verifyAdmin` for everything after it. They inherit that
guard, so no new auth surface is introduced.

```
GET /api/exams/:id/participants         JSON, powers the screen
GET /api/exams/:id/participants.csv     text/csv, Content-Disposition attachment
GET /api/exams/:id/participants/print   standalone HTML with inline @media print
```

## Print page

Self-contained HTML: no app chrome, no JavaScript required. Carries:

- `@page { margin: 14mm }`
- a repeating `<thead>` so column headings survive page breaks
- `page-break-inside: avoid` on rows
- a print-only header with exam title, generation date and section totals

## User interface

A new card in the exam detail tab, above the existing roster table:

- four section counts as a summary strip
- a **Print / Save PDF** button opening `/participants/print`
- a **Download CSV** button triggering `/participants.csv`
- the ranked table: position, name, phone, score, percentage, pass/fail, attempt
  number, finish time

## CSV

One flat sheet, sections in the same order as the screen. Two escaping rules:

- values beginning `=`, `+`, `-` or `@` get a leading apostrophe, so a student
  name cannot execute as a formula in Excel
- a UTF-8 BOM is written, so accented names open correctly in Excel

## Error handling

- 404 when the exam does not exist
- an exam with no participants renders a clear "no participants yet" page
  rather than empty tables
- a `NULL` percentage displays as an em dash and sorts last

## Testing

TDD, failing test first in `test/participant-roster.test.js`. The functions are
pure, so no mocking is required.

- best attempt per student, with ties broken by score then finish time
- a `NULL` percentage sorts last
- the four buckets are mutually exclusive and cover every recipient
- CSV escapes formula-leading values
- CSV row order matches the ranked array

## Files

- `src/services/results.js` — `buildParticipantRoster`, `rosterToCsv`
- `src/routes/api.js` — three routes
- `src/public/app.js` — participants card with the two buttons
- `test/participant-roster.test.js` — new

## Out of scope

- No new database columns or migrations
- No new npm dependencies
- PDF files are produced by the browser's print dialog, not generated server-side

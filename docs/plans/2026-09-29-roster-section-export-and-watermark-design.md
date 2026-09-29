# Roster Section Export, Word Download, and Watermark Branding

Date: 2026-09-29
Status: approved
Revised: 2026-09-29 — the CSV download is removed (see Decisions 5 and 7).

Extends [2026-09-28-participant-roster-export-design.md](2026-09-28-participant-roster-export-design.md),
which built the roster and its print page. That design stays in force except
where this revision removes the CSV download; this one adds section-scoped
export, a Word download, and watermark branding.

## Problem

The roster currently exports all four sections or nothing. An administrator who
only needs the not-sent list — to chase delivery failures, the most common
follow-up action on a live exam — must print or export every table and throw the
rest away.

The export is also unbranded. The print page carries no logo and no colour, so a
register that leaves the building is indistinguishable from one produced by
anything else.

## Decisions

Settled with the user before implementation.

1. **A section dropdown, defaulting to Total.** Five options — Total, Finished,
   In progress, Not started, Not sent — matching the five counts already shown
   in the summary chips. Total reproduces today's behaviour, so nothing changes
   for anyone who never touches the dropdown.

2. **Word (`.docx`) as the download format.** A `.csv` cannot carry a watermark
   or a border, so the branded download had to change format. Word was chosen
   over PDF (not editable by the recipient) and over Excel (the watermark and
   outline story is weaker and needs a new dependency).

3. **Hand-rolled OOXML, no new dependency.** A `.docx` is a ZIP of XML parts.
   Node 24 ships `zlib.deflateRawSync` and `zlib.crc32`, both verified present,
   so the container costs about forty lines. This beats the `docx` npm package
   (≈1 MB for what is ≈300 lines of XML, and no first-class washed-out picture
   watermark — the VML would be hand-written regardless) and beats saving
   print-HTML as `.doc` (Word flags the file, ignores the page border, and prints
   with the wrong page setup).

4. **One app-wide watermark logo, uploaded from the device, used for the
   watermark only.** It does not touch the app's own header or brand, which keep
   `src/public/icon.svg`. A per-exam logo was considered and rejected as
   disproportionate: it needs a column on `exams`, a picker in the exam form, and
   per-exam resolution in every renderer.

5. **The CSV download is removed.** The Download CSV button, its route, its
   serialiser and its tests are deleted. The Print / Save PDF path already gives
   the recipient a shareable file, and the CSV was carrying its own bug: simple
   groups exported eight columns instead of four. Removing it removes that
   column-shape change entirely. This reverses the original decision, which kept
   the CSV.

6. **Not Sent aligns to four columns everywhere.** The screen shows two
   (name, phone) while the print page shows four (plus questions answered and
   started). A shared section definition forces one answer, so the screen gains
   the two columns it was missing. The roster is an official record, and a
   not-sent recipient has genuinely answered nothing and started at nothing —
   those two fields should be visibly empty, not structurally absent.

7. **PDF comes from the browser's print dialog, not a server-side generator.**
   The Print / Save PDF button opens the standalone print page and the
   administrator picks "Save as PDF" as the destination. This keeps the
   zero-dependency promise: a server-side PDF needs a real renderer (pdfkit
   re-implements pagination and font handling poorly; headless Chromium is a
   large, fragile addition), and the browser already paginates, embeds fonts and
   applies the print stylesheet correctly.

## Architecture

`buildParticipantRoster(examId)` is unchanged and remains the single source of
truth. Everything below is presentation layered on the roster it returns.

```js
// src/services/results.js

// One definition of the five exportable sections. The keys are the URL
// vocabulary; the labels are what the dropdown and the filenames use.
const ROSTER_SECTIONS = {
  total:        { label: 'Total',       groups: ['finished', 'inProgress', 'notStarted', 'notSent'] },
  finished:     { label: 'Finished',    groups: ['finished'] },
  in_progress:  { label: 'In progress', groups: ['inProgress'] },
  not_started:  { label: 'Not started', groups: ['notStarted'] },
  not_sent:     { label: 'Not sent',    groups: ['notSent'] },
};

// Unknown, missing or malformed input resolves to 'total' rather than
// throwing: these URLs are also built by bookmark and by a bare button
// click, and a section typo must not turn a register into a 404.
function normalizeSection(value) {
  const key = String(value == null ? '' : value).trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(ROSTER_SECTIONS, key) ? key : 'total';
}
```

The `hasOwnProperty` guard is deliberate. A plain truthy lookup on
`ROSTER_SECTIONS[key]` would resolve `total`, `constructor` and `toString` —
inherited properties — to something truthy and then fail confusingly later.

### Column definitions

One table per group, declared once, consumed by all three renderings:

| group | columns |
|---|---|
| `finished` | #, Name, Phone, Score, %, Result, Attempt, Finished |
| `inProgress` | Name, Phone, Questions answered, Started |
| `notStarted` | Name, Phone, Questions answered, Started |
| `notSent` | Name, Phone, Questions answered, Started |

`finished` keeps its rank and verdict columns; the other three share one shape.

### Serialiser signatures

Both gain a `section` parameter and emit only the groups that section
names, reusing the headings they already have:

```js
rosterPrintHTML(roster, section)      // existing, filtered
rosterDocx(roster, section)           // new
```

A filtered export stamps its section into the document ("Section: Not sent")
and into the filename (`participants-12-Not-sent.docx`), so a file found later
in a downloads folder explains itself. `total` keeps the unadorned filename.

### Data flow

```
<select> onchange ──▶ printRoster(id) / downloadRosterDocx(id)
                            │
                            ▼  ?section=<key>
              GET /api/exams/:id/participants.docx?section=…
              GET /api/exams/:id/participants/print?section=…
                            │
                            ▼
                 normalizeSection(req.query.section)
                            │
                            ▼
                    rosterDocx / rosterPrintHTML
```

The dropdown filters the export only. The on-screen roster keeps showing all
four tables, because that is where an administrator orients themselves.

## The Word document

Nine parts, assembled by a small ZIP writer:

```
[Content_Types].xml
_rels/.rels
docProps/core.xml
word/document.xml
word/_rels/document.xml.rels
word/styles.xml
word/header1.xml
word/_rels/header1.xml.rels
word/media/watermark.png
```

### Green page outline

A real Word page border in `sectPr`, so Word lists it under Page Borders and the
recipient can restyle it:

```xml
<w:pgBorders w:offsetFrom="page">
  <w:top w:val="single" w:sz="18" w:space="24" w:color="25D366"/>
  <w:left w:val="single" w:sz="18" w:space="24" w:color="25D366"/>
  <w:bottom w:val="single" w:sz="18" w:space="24" w:color="25D366"/>
  <w:right w:val="single" w:sz="18" w:space="24" w:color="25D366"/>
</w:pgBorders>
```

`25D366` is `--green` from `src/public/styles.css:11` — the native WhatsApp
green the app already uses, not a new colour.

### Watermark

The VML shape Word itself writes for a picture watermark, in `header1.xml`:

```xml
<v:shape type="#_x0000_t75"
  style="position:absolute;margin-left:0;margin-top:0;width:360pt;height:360pt;
         z-index:-251657216;
         mso-position-horizontal:center;mso-position-horizontal-relative:margin;
         mso-position-vertical:center;mso-position-vertical-relative:margin"
  o:allowincell="f">
  <v:imagedata r:id="rId1" o:title="watermark"
               gain="19661f" blacklevel="22938f"/>
</v:shape>
```

`gain`/`blacklevel` are Word's native washout — that is the "fade", applied by
Word itself rather than faked in the pixels. The blur is separate, because Word's
watermark feature exposes no blur control: it is baked into the PNG (§
Watermark pipeline below).

**Every page, not just page one.** The section references the header as
`type="default"` and does *not* set `w:titlePg`. Setting `titlePg` would move
the header to a first-page reference and the watermark would appear once. This
is a one-attribute difference between a watermark and a bug.

### Body

Mirrors the print page so the two documents are recognisably the same artefact:
title, sub-line, the five count chips as a single-row table, then per selected
group a heading and a table. The header row is shaded `25D366` with white bold
text. `w:tblHeader` repeats column headers across pages and `w:cantSplit` stops
a row splitting — the same two guarantees `PRINT_CSS` already asks for via
`thead { display: table-header-group }` and `break-inside: avoid`. A4 portrait,
margins matched to the print page.

## Watermark pipeline

One helper produces the finished watermark, used by both the print page and the
`.docx`, so the two cannot drift apart.

```js
// src/services/watermark.js
async function watermarkPng() // → Buffer, cached
```

Processing, whether the source is an uploaded logo or the default:

1. decode with sharp — PNG, JPEG and SVG all decode
2. resize to 760px wide, aspect preserved
3. `.blur(2.5)`
4. flatten onto white, then `.linear(1, 96)` to lift the ink toward white
5. re-encode PNG

Step 4 exists because `gain`/`blacklevel` are honoured by Word and LibreOffice
but not by every consumer. Baking part of the fade into the pixels means a
renderer that ignores the washout still shows a pale, illegible-either-way mark
rather than a solid logo behind the text.

### Storage and fallback

The processed file lives at `<uploadsDir>/watermark.png`. One fixed filename, so
**the file's existence is the setting** — no column, no migration, no seed.
`uploadsDir` is already on Render's persistent disk (`render.yaml` mounts it and
sets `UPLOADS_DIR`), so the logo survives deploys.

When the file is absent, the helper runs `src/public/icon.svg` through the
identical pipeline. That default is vector, so it rasterises crisply at watermark
scale. `oktek-logo.png` is deliberately not the default: it is 2.3 MB and is the
certificate's partner mark, not the app's.

Results are cached in a module-level promise, the pattern
`src/services/certificate.js:10` already uses.

### Routes

All three behind the existing admin guard, using `multer` memory storage:

| route | behaviour |
|---|---|
| `POST /api/watermark-logo` | Accepts PNG/JPEG/SVG up to 5 MB, writes the processed PNG. 400 on a non-image or an undecodable file. |
| `GET /api/watermark-logo` | `{ custom: boolean, url: string \| null }` — `custom` drives the preview UI. |
| `DELETE /api/watermark-logo` | Unlinks the file; reverts to `icon.svg`. |

The 5 MB cap matches the existing `imageUpload` limit at `src/routes/api.js:58`.

### Safety

sharp decodes and re-encodes, so a file whose bytes are not actually a PNG
cannot survive the round trip. The stored filename is server-chosen, never the
client's. SVG input is rasterised and never served, so no user-supplied markup
reaches a browser or Word. The print page embeds the result as a `data:` URI, so
the document stays self-contained.

## Print page changes

- `@page` margin 14mm/12mm → 16mm/14mm, to leave room for the frame.
- Watermark: `position: fixed; top: 50%; left: 50%; translate(-50%, -50%);
  width: 66%; z-index: 0; pointer-events: none`, with content at `z-index: 1`.
- Green frame: `position: fixed; inset: 6mm; border: 2.5pt solid #25D366;
  pointer-events: none`.
- `print-color-adjust: exact` on `body`, so the green actually prints — the same
  trick `reportHTML` already uses at `src/services/results.js:236`.

## UI

On the Participants tab, in the existing header row:

- the five-option section `<select>`, reading `Total` by default
- **Print / Save PDF** — unchanged, now section-scoped
- **Download Word** — new, section-scoped
- **Watermark logo** — file input, thumbnail preview, "Use default"

The section value is read at click time by both actions, so one selection
applies to whichever the administrator then presses.

## Testing

Added to `test/participant-roster.test.js`.

**Section filter** — `normalizeSection` accepts each of the five keys and
resolves unknown, missing, `null`, and inherited-property keys such as
`constructor` to `total`. Each serialiser emits only its selected group; `total`
emits all four; no group's rows leak into another's output.

**Column alignment** — Not Sent renders the same four columns in the screen,
print and Word output.

**The `.docx`** — ZIP magic and end-of-central-directory present; all nine parts
present; every `r:id` referenced in `document.xml` and `header1.xml` resolves in
the matching `.rels`; `document.xml` parses as XML; `pgBorders` present on all
four sides in `25D366`; the VML shape present with centred positioning and both
`gain` and `blacklevel`; the header referenced as `type="default"` with no
`w:titlePg`.

**XML escaping** — a participant named `<&">` is escaped, and the document still
parses. Word rejects a whole file over one unescaped character, so this is a
correctness property and not a cosmetic one.

**Watermark** — produces a non-empty PNG; uploading a custom logo changes the
bytes; deleting reverts to `icon.svg`; a non-image upload is rejected with 400.

**Regressions** — the existing roster section-coverage and print-page tests must
still pass, and the removed CSV route must 404 rather than linger half-deleted.

The ZIP reader in the tests parses the central directory independently with
`zlib.inflateRawSync` rather than reusing the writer's own bookkeeping, so it
verifies the artefact instead of trusting the code that produced it.

## Risks

**VML is a legacy format.** Word and LibreOffice both render it. Google Docs'
importer may drop the watermark while keeping the border and text. This is
inherent to the Word-native approach, not something the implementation can work
around.

**`position: fixed` is the only working print page border.** `@page { border }`
is the spec'd route and Chrome ignores it entirely. A fixed frame repeats on
every page in Chrome, Edge and Firefox, but a print pipeline that discards fixed
elements would yield the watermark with no border. A browser limitation, recorded
so it is not mistaken for an implementation bug later.

**Vercel.** `vercel.json` sets no `UPLOADS_DIR`, so `uploadsDir` resolves to the
ephemeral `./data/uploads` and an uploaded watermark would be lost on redeploy.
`src/server.js:274` already detects the ephemeral-storage case and warns at boot
about `DB_PATH`/`UPLOADS_DIR`; the logo is subject to the same constraint as the
existing student photos and voice notes. The database has the same exposure. No
new failure mode, but worth stating.

# Design: Manual Question Image Upload + PDF Extraction Verification

## Context

The WhatsApp examination system already handles:
- PDF marking scheme extraction (answer keys + model solutions)
- Images before questions on WhatsApp delivery
- Objective/Theory section arrangement with headers

The missing feature is: **admins cannot add diagrams/images to manually created questions**. The `questions.image` column exists in the DB schema, but the API routes for manual question creation and editing don't accept image file uploads.

## Requirements

1. Admin can upload an image (PNG/JPG) when creating or editing a manual question
2. Batch-created questions can also have images via per-question file upload
3. Images are saved to `uploadsDir` and stored in `questions.image` as filenames
4. WhatsApp delivery sends the image as a separate bubble before the question text
5. The PDF extraction pipeline continues to work as-is (no changes needed)

## Design

### API Changes

#### 1. New endpoint: `POST /exams/:id/questions/:qid/image`
- Accepts `multipart/form-data` with a `file` field (PNG/JPG)
- Saves the file to `uploadsDir` with naming pattern: `{timestamp}-{examId}-q{qOrder}-manual.png`
- Updates `questions.image` column
- Returns `{ ok: true, image: filename }`

#### 2. Modify: `POST /exams/:id/questions` (single question creation)
- Change from JSON body to `multipart/form-data`
- Accept optional `file` field alongside form fields (`text`, `type`, `marks`, etc.)
- If file is provided, save it and set `questions.image`

#### 3. Modify: `PUT /exams/:id/questions/:qid` (question update)
- Change from JSON body to `multipart/form-data`
- Accept optional `file` field
- If file is provided, save it and update `questions.image`
- Accept optional `remove_image=1` to clear the image

#### 4. Batch questions: two-step process
- Step 1: `POST /exams/:id/questions/batch` (unchanged, creates questions without images)
- Step 2: `POST /exams/:id/questions/:qid/image` per question that needs an image
- This avoids complex multipart-with-multiple-files handling

### Frontend Changes

- Add image upload field to the manual question creation form
- Add image upload field to the question edit form
- Show image preview when an image exists
- Allow removing an image from a question

### Files to Modify

| File | Change |
|------|--------|
| `src/routes/api.js` | Add `/questions/:qid/image` endpoint, modify `POST /questions` and `PUT /questions/:qid` to accept multipart |
| `src/frontend.js` or public HTML | Add image upload UI to question forms |
| `src/services/pdfImport.js` | No changes needed (already handles images) |
| `src/services/exam.js` | No changes needed (already sends images before questions) |

### Image Naming Convention

```
{timestamp}-{examId}-q{qOrder}-manual.png
```

This follows the existing pattern from `pdfImport.js:imageFileNameFor()`:
```
{timestamp}-{examId}-q{qOrder}-{markerIndex}.png
```

The `-manual` suffix distinguishes admin-uploaded images from PDF-extracted ones.

### Error Handling

- Invalid file type → 400 with message "Only PNG and JPG images are accepted"
- File too large → 400 with message (multer limit: 5MB for single images)
- Question not found → 404
- Exam is live/ended → 400 "Questions can no longer be edited"

### WhatsApp Delivery

No changes needed. The existing `exam.js:sendQuestionTo()` already:
1. Checks `question.image` (line 592)
2. Sends the image as a separate bubble first (line 593)
3. Then sends the question text and options

## Verification

1. Create a manual question with an image → verify image appears before question on WhatsApp
2. Edit a manual question to add an image → verify image appears on next delivery
3. Remove an image from a question → verify no image is sent
4. Upload PDF with marking scheme → verify marking scheme is extracted
5. Upload PDF without marking scheme → verify AI generates one
6. Verify objective questions appear before theory on WhatsApp

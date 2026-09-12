# Manual Question Image Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow admins to upload images (PNG/JPG) when creating or editing manual exam questions, so diagrams appear before question text on WhatsApp.

**Architecture:** Add a dedicated image upload endpoint per question, and modify the single-question create/update routes to accept multipart form data with an optional file. Batch creation uses a two-step process (create questions, then upload images separately). No changes needed to PDF extraction or WhatsApp delivery — they already handle images correctly.

**Tech Stack:** Node.js, Express, multer (multipart), @napi-rs/canvas (image processing), SQLite (existing DB)

## Global Constraints

- Node >= 22.5 (from package.json engines)
- Existing multer config: `memoryStorage()` with 20MB limit (api.js:16)
- New image upload limit: 5MB per image
- Image formats: PNG, JPG/JPEG only
- Image naming: `{timestamp}-{examId}-q{qOrder}-manual.png`
- uploadsDir from config.js (already used by pdfImport)
- No changes to existing PDF extraction or WhatsApp delivery logic

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/routes/api.js` | Modify | Add image upload endpoint, modify create/update routes for multipart |
| `src/public/index.html` | Modify | Add image upload UI to question forms |

---

### Task 1: Add image upload endpoint for questions

**Files:**
- Modify: `src/routes/api.js` (add new route after line 438)
- Test: manual test via curl

**Interfaces:**
- Consumes: `config.uploadsDir`, `multer`, `db`
- Produces: `POST /exams/:id/questions/:qid/image` → `{ ok: true, image: filename }`

- [ ] **Step 1: Add multer config for image uploads**

In `src/routes/api.js`, after the existing `upload` variable (line 16), add a second multer instance for image-only uploads:

```javascript
const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'image/png' || file.mimetype === 'image/jpeg') {
      cb(null, true);
    } else {
      cb(new Error('Only PNG and JPG images are accepted'));
    }
  },
});
```

- [ ] **Step 2: Add the image upload endpoint**

After the `DELETE /exams/:id/questions/:qid` route (line 438), add:

```javascript
router.post('/exams/:id/questions/:qid/image', imageUpload.single('file'), asyncWrap(async (req, res) => {
  const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(req.params.id);
  if (!exam) return res.status(404).json({ error: 'Exam not found' });
  if (exam.status === 'live' || exam.status === 'ended') {
    return res.status(400).json({ error: 'Exam is already live/ended. Questions can no longer be edited.' });
  }
  const q = db.prepare('SELECT * FROM questions WHERE id = ? AND exam_id = ?').get(req.params.qid, req.params.id);
  if (!q) return res.status(404).json({ error: 'Question not found' });
  if (!req.file) return res.status(400).json({ error: 'No image file uploaded' });

  const ext = req.file.mimetype === 'image/png' ? 'png' : 'jpg';
  const filename = `${Date.now()}-${exam.id}-q${q.q_order}-manual.${ext}`;
  const filePath = require('path').join(config.uploadsDir, filename);
  require('fs').writeFileSync(filePath, req.file.buffer);

  db.prepare('UPDATE questions SET image = ? WHERE id = ?').run(filename, q.id);
  res.json({ ok: true, image: filename });
}));
```

- [ ] **Step 3: Add image removal endpoint**

After the image upload endpoint, add:

```javascript
router.delete('/exams/:id/questions/:qid/image', (req, res) => {
  const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(req.params.id);
  if (!exam) return res.status(404).json({ error: 'Exam not found' });
  if (exam.status === 'live' || exam.status === 'ended') {
    return res.status(400).json({ error: 'Exam is already live/ended. Questions can no longer be edited.' });
  }
  const q = db.prepare('SELECT * FROM questions WHERE id = ? AND exam_id = ?').get(req.params.qid, req.params.id);
  if (!q) return res.status(404).json({ error: 'Question not found' });

  // Delete the file if it exists
  if (q.image) {
    const filePath = require('path').join(config.uploadsDir, q.image);
    try { require('fs').unlinkSync(filePath); } catch {}
  }
  db.prepare('UPDATE questions SET image = ? WHERE id = ?').run('', q.id);
  res.json({ ok: true });
});
```

- [ ] **Step 4: Test the endpoints**

Start the server and test with curl:

```bash
# Upload an image to question 1 of exam 1
curl -X POST http://localhost:3000/api/exams/1/questions/1/image \
  -H "Authorization: Bearer <token>" \
  -F "file=@diagram.png"

# Remove the image
curl -X DELETE http://localhost:3000/api/exams/1/questions/1/image \
  -H "Authorization: Bearer <token>"
```

Expected: `{ ok: true, image: "..." }` on upload, `{ ok: true }` on delete.

- [ ] **Step 5: Commit**

```bash
git add src/routes/api.js
git commit -m "feat: add image upload/remove endpoints for manual questions"
```

---

### Task 2: Modify single question creation to accept image

**Files:**
- Modify: `src/routes/api.js:272-299` (POST /exams/:id/questions)
- Test: manual test via curl

**Interfaces:**
- Consumes: `imageUpload.single('file')`, `config.uploadsDir`
- Produces: Question with `image` field set when file is provided

- [ ] **Step 1: Change the single question creation route to accept multipart**

Replace the `POST /exams/:id/questions` route (lines 272-299) with:

```javascript
router.post('/exams/:id/questions', imageUpload.single('file'), asyncWrap(async (req, res) => {
  const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(req.params.id);
  if (!exam) return res.status(404).json({ error: 'Exam not found' });
  if (exam.status === 'live' || exam.status === 'ended') {
    return res.status(400).json({ error: 'Exam is already live/ended. Questions can no longer be edited.' });
  }
  const q = req.body;
  const nextOrder = (db.prepare('SELECT MAX(q_order) m FROM questions WHERE exam_id = ?').get(exam.id).m || 0) + 1;
  const marks = parseFloat(q.marks) || 1;

  // Handle image upload if provided
  let imageFile = '';
  if (req.file) {
    const ext = req.file.mimetype === 'image/png' ? 'png' : 'jpg';
    imageFile = `${Date.now()}-${exam.id}-q${nextOrder}-manual.${ext}`;
    const filePath = require('path').join(config.uploadsDir, imageFile);
    require('fs').writeFileSync(filePath, req.file.buffer);
  }

  const info = db
    .prepare(
      `INSERT INTO questions (exam_id, q_order, type, text, passage, options, correct_answer, marks, difficulty, learning_objective, explanation, source, image)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      exam.id, nextOrder, q.type || 'objective', q.text || '', q.passage || '',
      q.type === 'objective' && Array.isArray(JSON.parse(q.options || '[]'))
        ? q.options
        : q.type === 'objective' && typeof q.options === 'string'
          ? q.options
          : q.type === 'objective' && Array.isArray(q.options)
            ? JSON.stringify(q.options.map((o, i) => ({ key: String.fromCharCode(65 + i), text: o })))
            : null,
      q.correct_answer || null,
      marks, q.difficulty || 'medium', q.learning_objective || '', q.explanation || '',
      'manual', imageFile
    );
  const question = db.prepare('SELECT * FROM questions WHERE id = ?').get(info.lastInsertRowid);
  await marking.buildMarkingScheme(question);
  marking.recomputeExamTotal(exam.id);
  res.json(qWithScheme(question));
}));
```

- [ ] **Step 2: Test creation with image**

```bash
curl -X POST http://localhost:3000/api/exams/1/questions \
  -H "Authorization: Bearer <token>" \
  -F "text=What does this diagram show?" \
  -F "type=theory" \
  -F "marks=5" \
  -F "file=@diagram.png"
```

Expected: Question returned with `image` field containing the filename.

- [ ] **Step 3: Test creation without image (regression)**

```bash
curl -X POST http://localhost:3000/api/exams/1/questions \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"text":"What is 2+2?","type":"objective","options":["2","3","4","5"],"correct_answer":"C","marks":1}'
```

Expected: Question created without image, same as before.

- [ ] **Step 4: Commit**

```bash
git add src/routes/api.js
git commit -m "feat: single question creation accepts optional image upload"
```

---

### Task 3: Modify question update to accept image

**Files:**
- Modify: `src/routes/api.js:388-419` (PUT /exams/:id/questions/:qid)
- Test: manual test via curl

**Interfaces:**
- Consumes: `imageUpload.single('file')`, `config.uploadsDir`
- Produces: Updated question with `image` field

- [ ] **Step 1: Change the question update route to accept multipart**

Replace the `PUT /exams/:id/questions/:qid` route (lines 388-419) with:

```javascript
router.put('/exams/:id/questions/:qid', imageUpload.single('file'), asyncWrap(async (req, res) => {
  const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(req.params.id);
  if (!exam) return res.status(404).json({ error: 'Exam not found' });
  if (exam.status === 'live' || exam.status === 'ended') {
    return res.status(400).json({ error: 'Exam is already live/ended. Questions can no longer be edited.' });
  }
  const q = db.prepare('SELECT * FROM questions WHERE id = ? AND exam_id = ?').get(req.params.qid, req.params.id);
  if (!q) return res.status(404).json({ error: 'Question not found' });
  const b = req.body;
  const fields = [];
  const vals = [];
  if (b.text !== undefined) { fields.push('text=?'); vals.push(String(b.text)); }
  if (b.passage !== undefined) { fields.push('passage=?'); vals.push(String(b.passage)); }
  if (b.type !== undefined) { fields.push('type=?'); vals.push(String(b.type)); }
  if (b.correct_answer !== undefined) { fields.push('correct_answer=?'); vals.push(b.correct_answer || null); }
  if (b.marks !== undefined) { fields.push('marks=?'); vals.push(parseFloat(b.marks)); }
  if (b.difficulty !== undefined) { fields.push('difficulty=?'); vals.push(String(b.difficulty)); }
  if (b.learning_objective !== undefined) { fields.push('learning_objective=?'); vals.push(String(b.learning_objective)); }
  if (b.explanation !== undefined) { fields.push('explanation=?'); vals.push(String(b.explanation)); }
  if (b.options !== undefined) {
    const arr = Array.isArray(b.options) ? b.options : [];
    fields.push('options=?');
    vals.push(JSON.stringify(arr.map((o, i) => ({ key: String.fromCharCode(65 + i), text: o }))));
  }

  // Handle image upload
  if (req.file) {
    // Delete old image if exists
    if (q.image) {
      const oldPath = require('path').join(config.uploadsDir, q.image);
      try { require('fs').unlinkSync(oldPath); } catch {}
    }
    const ext = req.file.mimetype === 'image/png' ? 'png' : 'jpg';
    const filename = `${Date.now()}-${exam.id}-q${q.q_order}-manual.${ext}`;
    const filePath = require('path').join(config.uploadsDir, filename);
    require('fs').writeFileSync(filePath, req.file.buffer);
    fields.push('image=?');
    vals.push(filename);
  } else if (b.remove_image === '1' || b.remove_image === 1) {
    // Remove image without uploading new one
    if (q.image) {
      const oldPath = require('path').join(config.uploadsDir, q.image);
      try { require('fs').unlinkSync(oldPath); } catch {}
    }
    fields.push('image=?');
    vals.push('');
  }

  if (fields.length) {
    vals.push(q.id);
    db.prepare(`UPDATE questions SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
  }
  marking.recomputeExamTotal(q.exam_id);
  const updated = db.prepare('SELECT * FROM questions WHERE id = ?').get(q.id);
  res.json(qWithScheme(updated));
}));
```

- [ ] **Step 2: Test update with image**

```bash
curl -X PUT http://localhost:3000/api/exams/1/questions/1 \
  -H "Authorization: Bearer <token>" \
  -F "text=Updated question text" \
  -F "file=@new-diagram.png"
```

Expected: Question updated with new image.

- [ ] **Step 3: Test image removal**

```bash
curl -X PUT http://localhost:3000/api/exams/1/questions/1 \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"remove_image": 1}'
```

Expected: Image field cleared.

- [ ] **Step 4: Commit**

```bash
git add src/routes/api.js
git commit -m "feat: question update accepts optional image upload and removal"
```

---

### Task 4: Add image upload UI to admin dashboard

**Files:**
- Modify: `src/public/index.html` (question creation/edit forms)
- Test: manual browser test

**Interfaces:**
- Consumes: `POST /exams/:id/questions/:qid/image` endpoint
- Produces: Image upload field in question forms

- [ ] **Step 1: Find the question creation form in the frontend**

Search `src/public/index.html` for the question creation form (look for "Add Question" or similar). Identify the form elements.

- [ ] **Step 2: Add file input to question creation form**

Add a file input field to the form:

```html
<div class="form-group">
  <label for="question-image">Diagram/Image (optional)</label>
  <input type="file" id="question-image" name="file" accept="image/png,image/jpeg">
  <small>Upload a diagram or image for this question (PNG or JPG, max 5MB)</small>
</div>
```

- [ ] **Step 3: Modify form submission to use FormData**

Update the JavaScript that handles the form submission to use `FormData` instead of JSON when a file is selected:

```javascript
// When submitting a question with an image
const formData = new FormData();
formData.append('text', questionText);
formData.append('type', questionType);
formData.append('marks', questionMarks);
// ... other fields
if (fileInput.files.length > 0) {
  formData.append('file', fileInput.files[0]);
}
// Send as multipart
fetch(`/api/exams/${examId}/questions`, {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${token}` },
  body: formData,
});
```

- [ ] **Step 4: Add image preview and remove button**

When editing a question that has an existing image, show a preview:

```html
<div class="image-preview" id="image-preview" style="display:none;">
  <img src="" alt="Question diagram" style="max-width:200px;">
  <button type="button" onclick="removeImage()">Remove Image</button>
</div>
```

- [ ] **Step 5: Add remove image function**

```javascript
async function removeImage(examId, questionId) {
  await fetch(`/api/exams/${examId}/questions/${questionId}/image`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${token}` },
  });
  // Refresh the question display
}
```

- [ ] **Step 6: Test in browser**

1. Create a new question with an image → verify image appears in the question list
2. Edit a question to add an image → verify image is added
3. Remove an image from a question → verify image is removed
4. Create a question without an image → verify it works as before

- [ ] **Step 7: Commit**

```bash
git add src/public/index.html
git commit -m "feat: add image upload UI to manual question forms"
```

---

### Task 5: Verify end-to-end flow

**Files:**
- No new files, verification only
- Test: full manual test

- [ ] **Step 1: Create a manual question with image**

Via the admin dashboard, create a theory question with a diagram image.

- [ ] **Step 2: Send exam to a student via WhatsApp**

Publish the exam and send it to a test student.

- [ ] **Step 3: Verify image appears before question on WhatsApp**

Check that the student receives:
1. OBJECTIVE section header (if applicable)
2. Theory section header
3. Image bubble (if theory question has image)
4. Question text bubble
5. Options (for objective questions)

- [ ] **Step 4: Verify PDF upload with marking scheme**

Upload a PDF that contains a marking scheme section. Verify:
1. Questions are extracted
2. Marking scheme from PDF is preserved
3. Questions without marking schemes get AI-generated ones

- [ ] **Step 5: Verify PDF upload without marking scheme**

Upload a PDF without a marking scheme section. Verify:
1. Questions are extracted
2. All marking schemes are AI-generated

- [ ] **Step 6: Verify objective questions appear before theory**

On WhatsApp, verify that all OBJECTIVE questions are sent before THEORY questions.

- [ ] **Step 7: Final commit**

```bash
git add -A
git commit -m "feat: manual question image upload complete"
```

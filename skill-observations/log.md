# Skill Observation Log

Observations captured during task-oriented work.

**Status key:** OPEN = not yet actioned | ACTIONED (YYYY-MM-DD) = skill
updated/created | DECLINED (YYYY-MM-DD) = user decided not to pursue —
resolved statuses always carry their resolution date

---

## 2026-09-12

### Observation 1: Task 2 implementation of image upload for single question creation

**Status:** OPEN
**Date:** 2026-09-12
**Session context:** Implementing Task 2: modify POST /exams/:id/questions route to accept optional image file upload.
**Skill:** task-observer
**Type:** open-source
**Phase/Area:** task execution

**Issue:** The user requested modification of an existing route to accept image uploads. The implementation required adding multer middleware, handling file buffer, generating filename, updating SQL INSERT statement, and adding imageFile parameter. The task was completed successfully with commit 541482a.

**Suggested improvement:** Consider adding error handling for file write failures (e.g., disk full, permission denied) and transactional safety (rollback database insert if file write fails). Also, the batch endpoint may need similar image upload support.

**Principle:** When adding file upload capabilities, ensure atomicity between file storage and database records to prevent orphaned files. Consider adding cleanup mechanisms for failed uploads.
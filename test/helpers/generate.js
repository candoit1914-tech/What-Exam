'use strict';

/**
 * POST /api/exams/:id/generate returns 202 + a background jobId — the
 * questions exist only once the job reports 'done' (generation runs as a
 * server-side job so Render's ~100s proxy timeout can never kill it).
 *
 * `generateAndAwait` performs the POST and polls GET /api/jobs/:id to the
 * terminal state, returning `{ res, job }` where `job` is the final job row.
 *
 * A synchronously-rejected request (400/404 validation, 409 already running)
 * returns `{ res, job: null }` so callers can assert that shape instead.
 */
async function waitForJob(request, jobId, { timeoutMs = 20000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const jr = await request('GET', `/api/jobs/${jobId}`);
    if (jr.status === 200 && jr.body && (jr.body.status === 'done' || jr.body.status === 'error')) {
      return jr.body;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `job ${jobId} did not finish within ${timeoutMs}ms (last: ${JSON.stringify(jr.body || jr)})`
      );
    }
    await new Promise((r) => setTimeout(r, 30));
  }
}

async function generateAndAwait(request, examId, body, { timeoutMs = 20000 } = {}) {
  const res = await request('POST', `/api/exams/${examId}/generate`, body);
  if (res.status !== 202) return { res, job: null };
  const jobId = res.body && res.body.jobId;
  if (!jobId) {
    throw new Error(`generate returned ${res.status} without a jobId: ${JSON.stringify(res.body)}`);
  }
  const job = await waitForJob(request, jobId, { timeoutMs });
  return { res, job };
}

module.exports = { generateAndAwait, waitForJob };

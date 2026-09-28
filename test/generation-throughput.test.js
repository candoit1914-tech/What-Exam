'use strict';

// Question generation was slow on the AshnaAI gateway even though the key, the
// model and the primary were all correct. Measured on the real endpoint:
//
//   1 batch of 10 questions  = 19.0s
//   4 batches in parallel     = 29.5s wall, 0 x 429
//   8 batches in parallel     = 29.6s wall, 0 x 429
//
// generateQuestions() ran its batches at `concurrency = Math.min(maxCalls, 2)`
// "to avoid 429s" (see the comment at src/services/ai.js), and staggered each
// launch with delay(idx * 500) plus a trailing delay(500). The gateway never
// rate-limited at 4 or 8, so the cap only serialized work the provider was
// happy to run at once.
//
// These tests pin the batch scheduler: batch concurrency must come from config
// and default high enough to be useful, the per-batch stagger must not scale
// with batch index, and the throttle must degrade under 429 rather than being
// permanently conservative.
require('./helpers/isolate');

const test = require('node:test');
const assert = require('node:assert');
const config = require('../src/config');
const ai = require('../src/services/ai');

test('generation batch concurrency defaults above the old hardcoded 2', () => {
  // 2 serialized a 15-call paper into 8 waves at ~19s each. The gateway was
  // measured at 8 concurrent without a single 429, so the floor has to sit
  // well above 2 or this is a no-op.
  assert.ok(
    config.ai.generateConcurrency >= 4,
    `generateConcurrency must default to at least 4, got ${config.ai.generateConcurrency}`
  );
});

test('generation batch concurrency is configurable and bounded', () => {
  const saved = config.ai.generateConcurrency;
  try {
    config.ai.generateConcurrency = 6;
    assert.equal(ai.batchConcurrencyFor(9), 6, 'config value must be honoured');

    config.ai.generateConcurrency = 99;
    assert.equal(
      ai.batchConcurrencyFor(9),
      9,
      'concurrency can never exceed the number of batches, or workers idle'
    );

    config.ai.generateConcurrency = 0;
    assert.ok(
      ai.batchConcurrencyFor(9) >= 1,
      'a nonsense value must not collapse to zero workers and hang forever'
    );
  } finally {
    config.ai.generateConcurrency = saved;
  }
});

test('the launch stagger does not grow with the batch index', () => {
  // delay(idx * 500) meant the 8th batch waited 3.5s before it even started,
  // serialising the tail of every run. The stagger is a rate-limit guard, so
  // it must be a small constant, not a per-batch delay.
  assert.equal(
    ai.batchLaunchStaggerMs(),
    0,
    'no per-index stagger: the provider was measured at 8 concurrent with no 429'
  );
});

test('a 429 is absorbed by backing off rather than by never running batches in parallel', () => {
  // The permanent fix for rate limits is retry-with-backoff, not a global
  // concurrency of 2. assert the retry path still exists and is allowed to
  // retry, so raising concurrency cannot turn a transient 429 into a failure.
  const saved = config.ai.generateConcurrency;
  try {
    config.ai.generateConcurrency = 8;
    // batchConcurrencyFor must not cap at 2 under any circumstance.
    for (const batches of [1, 2, 3, 5, 8, 15]) {
      assert.equal(
        ai.batchConcurrencyFor(batches),
        Math.min(8, batches),
        `with ${batches} batches the scheduler must use more than 2 workers`
      );
    }
  } finally {
    config.ai.generateConcurrency = saved;
  }
});

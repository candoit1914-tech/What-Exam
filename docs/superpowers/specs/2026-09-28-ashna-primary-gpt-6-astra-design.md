# AshnaAI as primary AI provider, gpt-6-astra

Date: 2026-09-28
Status: implemented (config + tests), pending live verification

## Goal

Replace the OpenAI primary with AshnaAI and run `gpt-6-astra` as the model,
keeping NVIDIA Nemotron as the single fallback.

## Background

The app is already provider-agnostic. `src/services/ai.js` posts to
`${AI_BASE_URL}/chat/completions` with `Authorization: Bearer`, and
`src/config.js` reads the primary from `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL`
plus a secondary (`CLAUDE_*`) and tertiary (`XAI_*`) slot that are tried in order
on failure, never raced.

AshnaAI is a multi-model gateway exposing the OpenAI chat-completions contract
at `https://api.ashna.ai/v1/api`, with a 63-model catalog. Swapping the primary
is therefore a configuration change, not a rewrite. The deployed app runs on
Render at `https://what-exam.onrender.com`.

## Why the defaults had to change, not just the env

Setting `AI_MODEL=gpt-6-astra` alone would have shipped a broken deploy. Three
defaults in the repo encoded assumptions that only held for the previous model:

1. **Reasoning effort defaulted to `none`.** `gpt-6-astra` rejects `none` with a
   400. A deploy that set the model but not the effort would have failed every
   one of the ~80 AI calls a paper costs, with a 400 and no fallback. The
   default is now `low`, the cheapest effort astra accepts, and is exposed as
   `defaultReasoningEffort` so a test can assert the pair.
2. **`AI_BLOCK_TIMEOUT_MS` defaulted to 240s**, measured against a 28s-89s range
   on a small fast model. A flagship reasoning model behind a gateway is slower
   than the host that range was measured on, and a block that overruns is
   *skipped with a visible warning* — a tight budget silently deletes questions.
   Raised to 360s.
3. **`AI_BLOCK_CONCURRENCY` defaulted to 4.** It was lowered from 6 to 4 after a
   real upload drove the account into 429s and dropped questions. A shared
   gateway fronts many accounts, so the provider's tolerance for simultaneous
   demand is not ours alone to raise. Lowered to 3, and the test that pins the
   cap was updated to match — that test deliberately couples to the constant.

`src/config.js` also carried a `gpt-5.4-mini` default and an OpenAI base URL
that no longer described the intended primary. Both now describe AshnaAI, so a
deploy missing `AI_MODEL` still lands on a working provider.

## Changes

- `src/config.js` — default base URL to `https://api.ashna.ai/v1/api`; default
  model to `gpt-6-astra`; add `defaultReasoningEffort: 'low'` and use it as the
  fallback when `AI_REASONING_EFFORT` is unset; `blockTimeoutMs` default
  240000 → 360000. Comments rewritten to state the cost and the per-model
  verification each setting depends on.
- `src/services/ai.js` — `BLOCK_CONCURRENCY` default 4 → 3.
- `test/ai-throughput.test.js` — the "default model" test now asserts the model
  and effort pair is internally consistent, and asserts the effort is not
  `none`. Only hardcoded literals are asserted: `config.js` loads `.env`, so
  `model` / `baseUrl` / `reasoningEffort` reflect the developer's local env.
- `test/regression.test.js` — concurrency cap assertion 4 → 3.
- `.env.example` — AI block rewritten for AshnaAI and astra, with the
  `reasoning_effort: none` rejection, the per-model vision caveat, and the
  reasoning behind the timeout and concurrency values.

218/218 tests pass.

## Required environment (Render dashboard + local `.env`)

```
AI_BASE_URL=https://api.ashna.ai/v1/api
AI_API_KEY=<ashna key>
AI_MODEL=gpt-6-astra
AI_REASONING_EFFORT=low
```

`AI_VISION` must stay `false` until vision is verified — see below.

## Open risks

**Vision is unverified and fails silently.** `AI_VISION` is `true` locally. A
gateway routes attachments by what the underlying provider supports and, when a
model cannot take images, substitutes a text note rather than failing. The call
then *succeeds*, and the app grades a handwritten answer it never saw, with no
error anywhere in the log. This is a correctness risk, not a cosmetic one.
`ai.js` already excludes Nemotron from the photo-read path; whether astra
belongs in that exclusion is unconfirmed. Verify by grading one real photo
answer and checking the log reports the image was read, or set
`AI_VISION=false` so those answers route to manual review.

**`AI_API_KEY=<your key>` may still be a literal placeholder** in the Render
dashboard. `statusOf()` in `configCheck.js` matches `your_`, `example`,
`changeme` and `replace_`; the angle-bracket form `<your key>` matches none of
them, so it scores as `set` and the boot log will not warn. Confirm the value
is a real key.

**The boot log cannot confirm the provider.** `[ai] Config: primary=…` and
`[ai] Calling …` fire inside `chatJSON`, on the first real request, not at
startup. No boot-time log line can name the provider: `AI_BASE_URL` and
`AI_MODEL` are not in the config-check list, and `/api/config-check` reports
only `set` / `missing` / `placeholder` and never a value. Verification requires
triggering one AI call and reading those two lines.

**Cost.** astra is the most expensive tier in the catalog and one paper costs
~80 calls. It was chosen for quality on hard papers; if the bill matters more,
`gpt-5-mini`, `glm-5.3-flash` or `gemini-2.5-flash` are cheaper catalog ids and
need no code change.

**Gateway key routing.** AshnaAI keys default to "Cost effective" routing,
which may serve a cheaper model than the one requested. Set the key to "Off" on
the AshnaAI account page if the named model must be honoured exactly.

**Unpushed commit.** Local `main` is at `323481c`; Render is running `ada89c9`.

## Verification plan

1. `GET https://api.ashna.ai/v1/api/models` with the key — confirm `gpt-6-astra`
   is entitled to this key. `403` / `404` means it is not.
2. One chat completion using the exact body `buildChatBody` produces:
   `{ model, messages, max_tokens, reasoning_effort: 'low' }`. Watch for a 400
   on `max_tokens` — a funded reasoning model may require
   `max_completion_tokens` instead, which `buildChatBody` would then need.
3. One JSON extraction shaped like a PDF block, to confirm structured output
   survives the gateway.
4. One vision probe: an image containing a random token, asking the model to
   read it back. Pass = set `AI_VISION=true`; silent non-answer = set
   `AI_VISION=false`.
5. `npm run config:check` and `npm test`.

None of these can run until an AshnaAI key is present in the local `.env`; the
key currently exists only in the Render dashboard, which is not readable from
here.

## Rollback

Restore the four `AI_*` values to the previous provider in the Render
dashboard. No code change is required to move back: `AI_BASE_URL` and
`AI_MODEL` are the whole switch. The repo defaults now describe AshnaAI, so
revert `src/config.js` as well if AshnaAI is abandoned permanently.

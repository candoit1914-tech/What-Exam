# AshnaAI as primary AI provider

Date: 2026-09-28
Status: implemented and verified against the live gateway

Model: settled on `gpt-5-mini` after measuring `gpt-6-astra` (see "Model choice").

## Goal

Replace the OpenAI primary with AshnaAI and run `gpt-5-mini` as the model,
keeping NVIDIA Nemotron as the single fallback.

## Background

The app is already provider-agnostic. `src/services/ai.js` posts to
`${AI_BASE_URL}/chat/completions` with `Authorization: Bearer`, and
`src/config.js` reads the primary from `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL`
plus a secondary (`CLAUDE_*`) and tertiary (`XAI_*`) slot that are tried in order
on failure, never raced.

AshnaAI is a multi-model gateway exposing the OpenAI chat-completions contract
at `https://api.ashna.ai/v1/api`, with a 90-model catalog. Swapping the primary
is therefore a configuration change, not a rewrite. The deployed app runs on
Render at `https://what-exam.onrender.com`.

## Model choice

The provider change was first made against `gpt-6-astra`, the quality ceiling
for hard papers, and everything in it was verified live. It was then swapped to
`gpt-5-mini` on cost grounds: one paper costs ~80 AI calls, so per-call price
is a multiplier, and a flagship exhausts a small credit balance in a few papers.

Both models were measured on the same PDF-extraction block (8 questions,
`max_tokens=16384`), same gateway, same key:

| Model | effort | wall clock | total tokens | reasoning tokens | questions |
|---|---|---|---|---|---|
| `gpt-5-mini` | `low` | 24s | 3275 | 1280 | 8/8 |
| `gpt-5-mini` | `none` | 20s | 3213 | 1088 | 8/8 |
| `gpt-6-astra` | `low` | 19s | 4923 | 3168 | 8/8 |

`gpt-5-mini` uses ~34% fewer total tokens for the same extraction, at comparable
latency. It is the same reasoning family, so `reasoning_effort` still applies
and the cost levers below carry over unchanged. `gpt-5-mini` also read a
generated test image correctly, so the vision path is unaffected.

The tradeoff is question quality on hard papers. If extraction or marking
quality is visibly worse in use, `AI_MODEL=gpt-5.4` or `gpt-6-astra` restores
it with no code change. The flags below are what a downgrade would need, not
what the default requires.

## Why the defaults had to change, not just the env

Setting `AI_BASE_URL` / `AI_MODEL` alone would have shipped a broken deploy.
Three defaults in the repo encoded assumptions that only held for the previous
model:

1. **Reasoning effort defaulted to `none`.** The default is now `low`, exposed
   as `defaultReasoningEffort` so a test can assert the model/effort pair is
   internally consistent.

   The original justification was that `gpt-6-astra` rejects `none` with a 400.
   **That premise was wrong and is retracted.** Measured through the gateway,
   `none` is accepted and answers correctly on both astra and `gpt-5-mini` — the
   rejection was a direct-OpenAI behaviour the gateway does not reproduce.

   `low` ships anyway, on a measured basis: on a PDF block, `none` saved only
   62 of 3275 tokens (~2%) on `gpt-5-mini`. That is too small to trade
   extraction quality for on the app's main job, and reasoning tokens are ~39% of
   the call at `low` — so `AI_REASONING_EFFORT` is the real cost lever, not
   `none`. Had it stayed `none`, nothing would have broken.
2. **`AI_BLOCK_TIMEOUT_MS` defaulted to 240s**, measured against a 28s-89s range
   on a small fast model. Any reasoning model behind a gateway is slower than
   the host that range was measured on, and a block that overruns is *skipped
   with a visible warning* — a tight budget silently deletes questions. Raised
   to 360s. Measured block extraction on the shipped default is 20-24s, so this
   is headroom rather than a live requirement.
3. **`AI_BLOCK_CONCURRENCY` defaulted to 4.** It was lowered from 6 to 4 after a
   real upload drove the account into 429s and dropped questions. A shared
   gateway fronts many accounts, so the provider's tolerance for simultaneous
   demand is not ours alone to raise. Lowered to 3, and the test that pins the
   cap was updated to match — that test deliberately couples to the constant.

`src/config.js` also carried a `gpt-5.6-terra` default — with an OpenAI base URL
and `reasoning_effort: 'none'` — none of which describes the intended primary.
All three now describe AshnaAI, so a deploy missing `AI_MODEL` still lands on a
working provider. `gpt-5.6-terra` is also absent from the gateway catalog, so
leaving it would have failed every call.

## Changes

- `src/config.js` — default base URL to `https://api.ashna.ai/v1/api`; default
  model to `gpt-5-mini`; add `defaultReasoningEffort: 'low'` and use it as the
  fallback when `AI_REASONING_EFFORT` is unset; `blockTimeoutMs` default
  240000 → 360000. Comments rewritten to carry the measured token counts, the
  cost reason for the model default, and the per-model verification each vision
  setting depends on.
- `src/services/ai.js` — `BLOCK_CONCURRENCY` default 4 → 3.
- `test/ai-throughput.test.js` — the "default model" test asserts the shipped
  model and effort, and that the effort is a value the gateway accepts. Only
  hardcoded literals are asserted: `config.js` loads `.env`, so
  `model` / `baseUrl` / `reasoningEffort` reflect the developer's local env.
- `test/regression.test.js` — concurrency cap assertion 4 → 3.
- `.env.example` — AI block rewritten for AshnaAI, with the cost reason for
  `gpt-5-mini`, the measured `none` vs `low` numbers, the list of models vision
  was verified against, and the reasoning behind the timeout and concurrency
  values.

218/218 tests pass.

## Required environment (Render dashboard + local `.env`)

```
AI_BASE_URL=https://api.ashna.ai/v1/api
AI_API_KEY=<ashna key>
AI_MODEL=gpt-5-mini
AI_REASONING_EFFORT=low
AI_VISION=true
```

`AI_VISION=true` is verified for this provider — see Verification. `AI_MODEL`
overrides the repo default, so it must be set in Render; a stale value there
silently wins over the default. The id previously in `src/config.js`
(`gpt-5.6-terra`) and any `*-mini` id are not in the gateway catalog, so a
stale one of those fails every call and falls through to the NVIDIA fallback
instead of erroring.

## Verification (all probes run live against the gateway)

| # | Probe | Result |
|---|---|---|
| 1 | `GET /models` entitlement | **PASS** — 90 ids returned, `gpt-5-mini` and `gpt-6-astra` both present |
| 2 | Exact `buildChatBody` shape | **PASS** — `{model, messages, max_tokens, reasoning_effort}` accepted, no `max_completion_tokens` needed |
| 3 | PDF-block JSON extraction, 16k `max_tokens` | **PASS** — 8/8 questions, valid JSON, on all three model/effort combinations in the Model choice table |
| 4 | Vision (random token in a generated PNG) | **PASS** — token read by `gpt-5-mini`, `gpt-6-astra`, `gpt-4o-mini`, `glm-5.3-flash` |
| 5 | Reasoning effort `none` vs `low` | `none` **accepted** on both; only ~2% cheaper than `low` |
| 6 | App's own `chatJSON` + fallback chain | **PASS** — `Using primary (gpt-5-mini), fallbacks: secondary`, parsed `{"ok":true,"n":7}` |
| 7 | App's own `readPhotoAnswer` | **PASS** — `[ai] Photo read via primary: "ZEBRAFISH-4417"` |
| 8 | App's own `generateQuestions` | **PASS** — 3 questions returned through the primary |
| 9 | `npm test` | **PASS** — 218/218 |
| 10 | `npm run config:check` | `AI_API_KEY: set`; 3 unrelated CRITICALs (admin password, WhatsApp secret/template) |

Probes 1-7 were run twice, once against `gpt-6-astra` and again against the
shipped `gpt-5-mini`, so the shipped default is verified on its own rather than
inherited from the model it replaced.

Probe 4 required a control. A first attempt returned `NO_IMAGE` and looked like
a silent downgrade, but the image generator had silently failed and produced a
blank PNG — the model was right to find no text. It was re-run with a verified
non-blank image (433 sampled dark pixels) and against four models as controls,
all reading the token. The gateway passes images through, so `AI_VISION=true` is
correct for `gpt-5-mini` and the `ai.js` Nemotron exclusion stays as it is.

Probe 6 logged one `Network error ... fetch failed` before a successful retry at
17.4s. The retry absorbed it, so this is noted rather than fixed: if it recurs
in production logs it is a gateway connectivity signal worth watching, not a
request-shape problem.

Probe 8 logged two failures — `failed to fetch history` and `failed to log
history` — because it was invoked outside the server, so `db.transaction` was
not set up. Both are probe-harness artifacts, not provider or model faults: the
same call succeeds in the running app, where the db module is initialised. Worth
recording because the log lines look alarming and would be a real bug in
production.

## Open risks

**`AI_API_KEY` must be a real key in the Render dashboard.** `statusOf()` in
`configCheck.js` matches `your_`, `example`, `changeme` and `replace_`; the
angle-bracket form `<your key>` matches none of them, so it scores as `set` and
the boot log will not warn. The value used for these probes is a working key;
confirm the same value is what Render holds.

**The boot log still cannot confirm the provider.** `[ai] Config: primary=…` and
`[ai] Calling …` fire inside `chatJSON`, on the first real request, not at
startup. No boot-time line can name the provider: `AI_BASE_URL` and `AI_MODEL`
are not in the config-check list, and `/api/config-check` reports only `set` /
`missing` / `placeholder` and never a value. After deploying, trigger one AI
call and confirm `[ai] Calling gpt-5-mini @ https://api.ashna.ai/v1/api`.

**Cost is the reason for the model, so it stays a live concern.** At ~80 calls
per paper, `gpt-5-mini` at 3275 tokens/block is a deliberate ~34% saving on
`gpt-6-astra`. The lever if the bill still matters: `AI_REASONING_EFFORT=none`
saves only ~2%, so the effective levers are `glm-5.3-flash` or
`gemini-2.5-flash` as `AI_MODEL` (no code change, but question quality drops),
or reducing the number of AI calls the paper flow makes.

**Gateway key routing.** AshnaAI keys default to "Cost effective" routing,
which may serve a cheaper model than the one requested. Set the key to "Off" on
the AshnaAI account page if the named model must be honoured exactly.

**Unpushed commit.** Local `main` is one commit ahead of `323481c`; Render is
still running `ada89c9`, which predates all of this work. Push and redeploy
before drawing any conclusion from production behaviour.

## Post-deploy check

Trigger one AI call (a WhatsApp answer, or a PDF import) and confirm the log
reads `[ai] Calling gpt-5-mini @ https://api.ashna.ai/v1/api`. If it instead
names another model or `api.openai.com`, the Render env did not take. A
`falling back to secondary` line right after the call is the signature of a
model id the gateway does not serve: the app still works, on NVIDIA, but
silently off the primary you are paying for.

## Rollback

Restore the four `AI_*` values to the previous provider in the Render
dashboard. No code change is required to move back: `AI_BASE_URL` and
`AI_MODEL` are the whole switch. The repo defaults now describe AshnaAI, so
revert `src/config.js` as well if AshnaAI is abandoned permanently.

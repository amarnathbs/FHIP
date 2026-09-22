# R2 — Real OpenAI Provider Activation (Module 11.3)

**Programme:** Module 11 AI Remediation, 2026-09-22 · **Branch:** `feature/module11-ai-remediation-2026-09-22`
**Verdict:** **FULL PASS (DEV)** — real provider proven live in DEV with minimal spend; production activation deliberately NOT performed (R7).

Evidence classes: **CODE** (read on this branch), **TEST** (vitest executed this session), **DEV** (live DEV project `vqycarelcoijzwlpkpcz`, service-role, read-back from the DB). No production access.

## 1. Provider / model decision (brief §10)

No Module-11-specific decision existed. The Product Owner's standing decision for the sibling AIE subsystem — OpenAI `gpt-4o-mini` as the approved low-cost tier — is adopted as the **configurable default** (`MODULE11_AI_MODEL`, `lib/ai/config.ts`). No service hard-codes a model: the only literal is the config default, and the registry must independently approve it.

Model availability and pricing were verified from OpenAI's official pricing page on 2026-09-22 (fetched live, not copied from AIE config): gpt-4o-mini listed as available; standard $0.15/1M input, $0.075/1M cached input, $0.60/1M output; Batch API 50% (input $0.075/1M, output $0.30/1M).

## 2. What was built (CODE)

| Brief | Implementation |
|---|---|
| §11 env config | `lib/ai/config.ts` — `MODULE11_AI_PROVIDER` (`openai` or mock), `MODULE11_AI_MODEL` (default gpt-4o-mini), `MODULE11_AI_TIMEOUT_MS` (30s, max 120s), `MODULE11_AI_MAX_TRANSIENT_RETRIES` (1, max 3), `OPENAI_API_KEY` (Module 11's own credential, distinct from `AIE_OPENAI_API_KEY`). Server-only marker; never `NEXT_PUBLIC_`; secret-free `describeModule11AiConfig()`. Documented in `.env.example`; forwarded in `amplify.yml` (`-e MODULE11_ -e OPENAI_API_KEY` appended to the single existing grep line, header comment recording the defect class). |
| §12 adapter | `lib/ai/providers/openaiProvider.ts` — real `generateStructured()` via platform `fetch` to `/v1/chat/completions`, strict `response_format: json_schema` (schemas in `openaiJsonSchemas.ts`, generated from the same constants zod validates), `store: false`, AbortController timeout, bounded transient retries with cumulative usage accounting, approved-model guard (refuses any model ≠ configured), max_tokens cap, ProviderError mapping (AUTH/RATE_LIMIT/PROVIDER_UNAVAILABLE/INVALID_REQUEST/TIMEOUT). `estimateCost()` corrected: the 11.0 stub's table was labelled per-1K but held per-1M figures (1000x over-estimate). |
| §13 gateway only | Nothing calls the adapter except `AIModelGateway` (unchanged path). Provider instances come only from `lib/ai/providers/providerFactory.ts` (`resolvePackProvider`, `resolveHealthProvider`), which refuses a registry row whose provider ≠ configured provider. Generate route no longer hard-wires mock (PH-02 closed). |
| §14 health | `app/api/internal/ai/provider/health/route.ts` resolves the configured provider via the factory + gateway; for openai it runs a **zero-token** `GET /v1/models/{model}` probe. Response = health + secret-free config summary (PH-13 closed). |
| §15 registry | Migration `0175` seeds `openai/gpt-4o-mini` (LOW_COST, tasks `[monthly_insight_pack]`, 32k in / 3.2k out, structured output, batch-capable, priced, `effective_from` 2026-09-22, no fallback) **inactive + unapproved**. Mock row retained for tests. `resolveConfiguredModelForTask()` (`modelRegistry.ts`) requires config AND registry to agree. |
| §16 pricing | Registry per-1K `0.000150 / 0.000600`, versioned by `effective_from`, admin-editable via the existing `/api/admin/ai/models/[id]` route. |
| §17 prompt | PR-AI-013 **v2** (R1) is the one certified prompt; activated in DEV only (v1 stays DRAFT; other 12 templates untouched). |

Additional defect found by the first real run and fixed (CODE+TEST): `summarisePackGrounding()` never checked that mandatory blocks were *present* — a provider omitting all four could reach READY on optional blocks alone. Now `mandatory_block_missing` fails the pack (spec §51). The closed metric vocabulary and mandatory list are rendered into every prompt from the validator's own constants (`buildOutputContractSection()`), because the model's first attempt cited FCO field names instead of certified codes.

## 3. DEV smoke test (brief §18) — DEV, real spend

Setup: `scripts/module11/apply_0175_dev_by_content.mjs` (no DDL path to DEV exists — re-probed; 0175 is DML-only, applied by content, `on conflict` semantics preserved), then `scripts/module11/dev_activate_real_provider.mjs --activate` (model active+approved, PR-AI-013 v2 ACTIVE, `ai_platform_controls.max_output_tokens` 800→3200 — the disclosed 11.3 finding, corrected; all three written through the audited tables, `ai_config_audit` rows confirmed).

`scripts/module11/real_provider_dev_smoke.ts`: real service + real DEV DB client + real `ai_admit_request()` + real adapter; synthetic non-identifying FCO; subject = standing synthetic Premium fixture `fhip.e2e.tc049@test.fhip.invalid`. Credential supplied as `OPENAI_API_KEY` from the shell (value of the account's existing DEV key; never printed, logged or committed).

| Run | Result | Tokens (in+out) | Cost USD | Quota | ai_run |
|---|---|---|---|---|---|
| 1 (before output-contract fix) | PARTIAL — 4 blocks returned, 2 UNGROUNDED (`unsupported_metric_code`: model cited `score_band`, `monthly_surplus_or_deficit`), 0 mandatory blocks | 10,570 + 822 | 0.002079 | 10 → 10 | `1129ad12-…`, `execution_status=success`, model_version `gpt-4o-mini-2024-07-18`, latency 9,124 ms |
| 2 (after fix) | **READY — grounding PASS, 6/6 blocks GROUNDED** (4 mandatory + score + cash flow), `critical_safety_failure=false`, 5 `ai_insights` answers written, pack `prompt_version=2`, `pack_schema_version=insight-pack-1.1.0` | 10,907 + 1,201 | 0.002357 | 10 → 10 | `97720508-…`, success, latency 13,289 ms |

Health probe (zero-token): healthy, model available to the credential, both runs. Total programme spend to this point: **$0.004436** (2 completions). Packs/blocks/insights cleaned up (zero residue confirmed); `ai_runs`/ledger rows retained as the spend audit trail.

All eight §18 proof points hold: real request occurred (recorded HTTP body: model gpt-4o-mini, `json_schema` strict, `store:false`, `max_tokens 3000`), structured JSON returned, schema passed, grounding passed (run 2), safety passed, `ai_run` recorded, tokens recorded, cost recorded.

## 4. Fail-closed tests (brief §19) — TEST

`tests/unit/aiR2RealProviderFailClosed.test.ts` — **15/15**. Real service + gateway + adapter + real `ai_admit_request()` in PGlite with migration 0175; only `fetch` is a double. Cases: missing key (AUTH, no fetch); invalid model (no_approved_model); adapter model guard; provider disabled (`provider_disabled`); model inactive / unapproved; live-provider kill switch (`live_provider_disabled`); timeout; malformed body; schema-invalid JSON; model refusal; grounding failure (cost still recorded); cost hard stop (COST_BLOCKED, no fetch); rate limit (`rate_limited` — the seeded 12/hour limiter genuinely fired at the 13th admission on the first run of the file); HTTP 401/503/429. No fabricated fallback anywhere. `tests/unit/aiCostEstimationAndOpenAiAdapter.test.ts` rewritten for the real adapter (7/7).

## 5. Quota separation (§20) and zero-cost regression (§21) — TEST

- §20: 10/10 before and 10/10 after a real-provider pack (positive control in the file above; also 10→10 in both live DEV runs).
- §21: `tests/unit/aiR2ZeroCostRegressionOpenAiConfigured.test.ts` — **3/3**: with `MODULE11_AI_PROVIDER=openai` + credential configured, a network tripwire on global `fetch` plus a spy on the real adapter: 150 standard-question resolutions (25 codes × 3 households × 2 passes) and 10 × every contextual-Explain target → **0 OpenAI calls, 0 adapter calls, 0 admission RPCs, 0 quota**. Positive control proves the tripwire fires when the adapter is invoked.

Full Module 11 estate after R2 (`tests/unit/ai[A-Z]*.test.ts`, 38 files): **1063/1064 passing**. The one failure, `aiResidualClosureFailClosed.test.ts › A4 NEGATIVE CONTROL`, was re-run on an untouched worktree (`d1ce449`) and **fails there identically** — pre-existing, unrelated to this programme (context-builder negative control expects canonical writes that no longer occur). Recorded, not fixed (Standard §14 / brief §57).

## 6. Residual / disclosed

- `approved_by` on the DEV model row is null (service-role script, not an admin session). Production activation (R7 step 4) must go through the admin route so `approved_by` is a real admin.
- DEV now has the real provider path ACTIVE at the registry/prompt level. Whether a real call happens is still gated by `MODULE11_AI_PROVIDER=openai` + `OPENAI_API_KEY` in the *runtime* environment — neither is set in DEV's Amplify/.env.local by this programme; the smoke test injected them per-process. `dev_activate_real_provider.mjs --deactivate` reverses the registry/prompt state.
- Batch (async) provider path: R3.

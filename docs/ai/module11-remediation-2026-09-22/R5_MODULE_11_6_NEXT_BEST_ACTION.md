# R5 — Module 11.6 Rules-First Next Best Action™

**Programme:** Module 11 AI Remediation, 2026-09-22 · **Brief:** §§40–49
**Verdict:** **FULL PASS (DEV, code + PGlite)** for the engine/service/API/SQ-AI-003/025 repoint/test estate; **CONDITIONAL** only for the audit table's live-DEV presence (migration 0178 is DDL; no path from this environment) — the feature degrades gracefully without it (audit write is non-fatal, answers still deterministic).

## Architecture (brief §40) — CODE

`CERTIFIED FINANCIAL STATE` (the FinancialContextObject, every field a certified Module 1–10 output) → `lib/ai/nba/rules.ts` (15 deterministic rules) → eligible candidates → `applySuppression()` → `rankCandidates()` (versioned policy) → `slice(0, 3)` → `explain()` (template from certified evidence). `lib/ai/nba/engine.ts` is a pure function; `service.ts` adds only entitlement, the two kill switches, context build, tenant scope and a non-fatal audit row. **AI does not select or rank anywhere**: the module has no import path to a provider (static boundary test) and 50 evaluations under a spied real adapter + network tripwire produce 0 calls.

## Threshold provenance (brief §41) — every trigger traced

| Action | Certified source consumed | Invented threshold? |
|---|---|---|
| MISSING_CRITICAL_INFORMATION | `data_quality.unavailable_modules` / `domain_certification.{cash_flow,balance_sheet}.status` ∈ {UNAVAILABLE, INVALID} | none |
| STALE_INFORMATION | `domain_certification[*].status = STALE`, `data_quality.stale_fields` | none |
| MISSING_RETIREMENT_DATA | `domain_certification.retirement = UNAVAILABLE` | none |
| MISSING_INSURANCE_DATA | `insurance.data_status = 'missing'` (certified missing ≠ none) | none |
| NEGATIVE_CASH_FLOW | sign of `cash_flow.monthly_surplus_or_deficit` | sign only |
| LIQUIDITY_WEAKNESS | Resilience risk register codes `critical_liquidity` / `low_emergency_fund` with the engine's own severity | none |
| DEBT_PRESSURE | register codes `high_credit_utilization`, `refinancing_exposure`, `variable_rate_exposure` | none |
| INSURANCE_PROTECTION_GAP | register codes `no_life_insurance`, `no_income_protection` | none |
| ASSET_CONCENTRATION | register code `property_concentration` | none |
| INCOME_CONCENTRATION | register code `income_concentration` | none |
| OFF_TRACK_GOALS | `goals[].track_status ∈ {at_risk, off_track}` (the set SQ-AI-021 already uses) | none |
| SCORE_WEAKNESS | `health_score.score_band ∈ {needs_attention, critical}` (migration 0006 band vocabulary) | none |
| SCORE_DETERIORATION | sign of `health_score.score_movement` with a prior valid score | sign only |
| CROSS_BORDER_EXPOSURE | `household.cross_border_indicator` (G6 contract 10) | none |
| RESILIENCE_WEAKNESS | `resilience.resilience_status ∈ {vulnerable, fragile}` (migration 0008 band vocabulary) | none |

A source-scan test asserts the only numeric comparisons in `rules.ts` are sign tests against `0`.

**Not implemented (brief §42 "do not force unsupported rules") — PO decisions needed:** *investment concentration* (`investments.institution_concentration` is a raw ratio with no certified band), *retirement progress* (no certified adequacy status in the FCO), *forecast review* (no certified staleness status on `forecasts[]`). Adding any of them requires an upstream module to certify a status first.

## Ranking (§43), maximum three (§44), suppression (§45)

`nba-ranking-1.0.0`: severity weight (critical 4 › high 3 › medium 2 › low 1) → explicit tier order (DATA_QUALITY, PROTECTION, LIQUIDITY, CASH_FLOW, DEBT, CONCENTRATION, PROGRESS, REVIEW) → alphabetical `action_code` (stable tie-break). 0/1/2 actions are returned as 0/1/2; ≥6 candidates yield exactly 3. Suppression: specific→generic (`LIQUIDITY/DEBT/PROTECTION/CONCENTRATION` suppress `RESILIENCE_WEAKNESS`; `SCORE_WEAKNESS` suppresses `SCORE_DETERIORATION`), data-quality blockers (`MISSING_CRITICAL_INFORMATION` suppresses every cash-flow/liquidity/debt/score/resilience/concentration conclusion; `MISSING_INSURANCE_DATA` suppresses `INSURANCE_PROTECTION_GAP`). Suppression is evaluated against the whole candidate set, so it is order-independent; suppressed items are reported with the suppressor.

## SQ-AI-003 / SQ-AI-025 (§46)

`lib/ai/standardQuestions/service.ts` special-cases both **before** the generic composition path: SQ-AI-003 = rank-1 action, SQ-AI-025 = top ≤3 in engine order; 0 actions → `NOT_APPLICABLE`; origins `DETERMINISTIC`; `provider_called=false`, `custom_quota_consumed=false`. Catalogue entries now declare `preferred_resolution_sources: ['DETERMINISTIC']`, `components: []`, `stored_pack_block_codes: []`. The pack block `priority_review_areas` and the `PRIORITY_REVIEW_AREAS_EXPLANATION` stored answer are no longer read by either question. The R1 ranking source (`priorityRankingSource.ts`) is now bound to this engine, so the Insight Pack narrates the same ranking (test asserts byte-identity between the source and the engine).

## Provider (§47) and quota (§48) independence

Service returns `provider_called: false`, `custom_quota_consumed: false` structurally; `live_provider_enabled=false` has no effect (tested); `ai_globally_enabled=false` or `next_best_action_enabled=false` (0178, ships true) → `FEATURE_DISABLED`; no admission RPC is reachable from `lib/ai/nba/**`.

## Persistence / audit / kill switch / UI / API

- Migration `0178`: `ai_platform_controls.next_best_action_enabled` (default true, audited by the 0115 trigger; exposed on the kill-switch route as `AI_NEXT_BEST_ACTION_ENABLED` and on the Admin AI Operations screen); `ai_next_best_action_evaluations` (select-own RLS, service-role writes, `CHECK action_count BETWEEN 0 AND 3` and `action_count = cardinality(action_codes)`).
- `GET /api/ai/next-best-actions` — takes no input; scope from `resolveHouseholdContext()` only.
- `components/aiInsights/NextBestActions.tsx` mounted on `/ai-insights` above the question library, with "Why this?" evidence and versions.
- `AI_NEXT_BEST_ACTION` sub-capability declared and implemented (`capabilities.ts`).

## Test estate (§49) — TEST

`tests/unit/aiNbaEngine.test.ts` **35/35**: positive/negative per rule (15×2), closed action-code set + no-threshold source scan, unknown risk code ignored, overlap suppression, data-quality suppression, missing-insurance suppression, ranking/tie-break, 0/1/2 actions, ≥6 → exactly 3, same-input determinism (25 runs), snapshot A/B (hash + actions differ), country rules (AU/IN same codes, localised labels/currency), FX integrity (reporting currency only, no cross-currency sum), 20-household matrix, service entitlement/kill-switch semantics (incl. `live_provider_enabled` no-op), uncertified/failed context → INSUFFICIENT_DATA, static import boundary, provider negative control (0/50), API cross-tenant + client tampering (no inputs read; 401 unauthenticated), SQ-AI-003/025 through the real standard-question service, migration 0178 in PGlite (max-3 CHECK, count/codes CHECK, RLS select-own). Existing R1 provenance suite updated (19/19). Full Module 11 estate: **1131/1132** (the one pre-existing failure, R2 §5).

## Not verified live

No browser session and no DEV DDL path: the `/ai-insights` panel and `/api/ai/next-best-actions` were not exercised against DEV. Engine behaviour is fully deterministic and certified in-process; the live gap is rendering/route wiring only.

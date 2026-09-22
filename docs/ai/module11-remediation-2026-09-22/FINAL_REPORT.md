# Module 11 AI Remediation Programme — Final Report

**Date:** 2026-09-22 · **Branch:** `feature/module11-ai-remediation-2026-09-22` (pushed, **not merged**) · **Base:** `origin/main` @ `e5a379d`, later merged with `17e7f3c` (PR #8)
**Source audit:** `origin/audit/module11-ai-production-completeness-2026-09-22` (`f0c0895` basis) — the four deliverables were read from git, not summarised.
**Scope executed:** R1 → R7 in the locked order; STOPPED at R7's written plan. 11.7–11.10 not touched.

Evidence discipline: **DEV** = live DEV project run; **TEST** = vitest/PGlite executed this session; **CODE** = inspection only. Counts below match the listed items exactly.

## Reconciliation (brief §2)

`origin/main` had moved from the audit basis `f0c0895` to `e5a379d` at dispatch (PR #5 NAV1, PR #6, PR #7 — none touching `lib/ai/**` or Module 11 migrations; verified by diff, not assumed) and to `17e7f3c` (PR #8, AIE-1 closure, migrations 0173/0174, `amplify.yml`, `.env.example`) during the programme; merged in with one additive conflict. Migration numbers 0175–0178 were allocated after scanning every remote and local branch (highest in use: 0174); `check:migrations:against-main` clean.

## Per-workstream verdicts (brief §60)

| Workstream | Verdict | One-line basis | Report |
|---|---|---|---|
| R1 Ranking provenance | **FULL PASS** — *RANKING PROVENANCE DEFECT — REMEDIATED AND CERTIFIED* | Provider was the de-facto ranking authority (FCO `recommendations` always `[]`, no ordering instruction, no provenance check); now an immutable ranked list is sent as data, the validator rejects reorder/invent/drop/relabel (the §8 C,A,B negative test), the stored answer is composed in canonical order only. 19/19 TEST. | `R1_RANKING_PROVENANCE_CERTIFICATION.md` |
| R2 Real OpenAI provider | **FULL PASS (DEV)** | Real adapter (strict json_schema, store:false, timeout, retries, approved-model guard), Module 11 config/env/Amplify forwarding, factory, zero-token health probe, registry row + verified pricing, prompt v2 activated in DEV only. Two live DEV calls: READY, grounding PASS 6/6, $0.002357, quota 10→10, ai_run recorded. 15 fail-closed + 3 zero-cost-regression TEST. Found+fixed: omitted mandatory blocks could reach READY. | `R2_REAL_PROVIDER_ACTIVATION.md` |
| R3 Batch + scheduler | **CONDITIONAL PASS** | ADR-M11-002; migration 0176 (ledger, lease functions, provider bookkeeping, `scheduler_enabled` OFF); resumable submit/reconcile with context-hash re-verification; real OpenAI Batch adapter proven mechanically live (round trip completed) but the **OpenAI project lacks the batch model entitlement (403/item)** → governed sync fan-out fallback shipped as default; cron route; runbook, no schedule registered. 15 PGlite + 6 + 2 TEST. Live-DEV scheduler run **blocked on 0176 (DDL)**. | `R3_BATCH_SCHEDULER_CERTIFICATION.md`, `ADR-M11-002-…md` |
| R4 Admin AI Operations UI | **CONDITIONAL PASS** | Two named capabilities (0177), aggregate read over the existing data layer with §8 states and §9 privacy, guarded controls via existing audited routes, admin scheduler trigger, nav/page/`/api/admin/me`. 10 TEST incl. PGlite database-bypass proof; nav 267/267. Live render **blocked on 0177 (DDL) + a grant**. | `R4_ADMIN_AI_OPERATIONS_UI.md` |
| R5 Module 11.6 NBA | **FULL PASS (DEV code/PGlite)** | 15 rules from certified statuses/signs only (source-scan enforced), suppression, versioned ranking, max 3, zero-cost explanations, 0178 (switch + audit), API with no inputs, SQ-AI-003/025 repointed, R1 source bound to the engine, consumer panel. 35 TEST. Three brief-listed rules recorded as unsupported (no certified upstream status). Audit table live **blocked on 0178 (DDL)**. | `R5_MODULE_11_6_NEXT_BEST_ACTION.md` |
| R6 Integrated DEV cert | **CONDITIONAL PASS** | §50–56 all PASS by TEST/DEV incl. the one-counter integrated positive/negative control; Modules 1–10 untouched (80 changed files, all Module 11 paths); full suite 8,250/8,281 with 0 failures attributable to this branch (each of the 26 attributed; 1 doc drift fixed). CONDITIONAL only for the three DDL migrations not live on DEV. | `R6_INTEGRATED_DEV_CERTIFICATION.md` |
| R7 Production activation plan | **FULL PASS (written; not executed)** | 12-step ordered plan with actor, guard and verification per step; pre-conditions incl. PO decisions; rollback. Nothing executed in production. | `R7_PRODUCTION_ACTIVATION_PLAN.md` |

## Spend

Two real chat completions (R2): $0.002079 + $0.002357 = **$0.004436**; two zero-token health probes; one Batch API submission whose single item was rejected 403 by the provider (no completion tokens billed). All on the existing DEV OpenAI key, injected per-process as `OPENAI_API_KEY`; never printed, logged or committed.

## Class A placeholder register closure (audit PH-01..PH-13)

| ID | Audit item | Status now |
|---|---|---|
| PH-01 | adapter throws `PROVIDER_UNAVAILABLE` | **Closed** (R2) |
| PH-02 | generate route resolves mock only | **Closed** (R2 factory) |
| PH-03 | batch types + mock only; no scheduler | **Closed in code; live-DEV blocked on 0176** (R3) |
| PH-04 | Module 11.6 absent | **Closed** (R5) |
| PH-05 | no Admin AI Operations UI | **Closed in code; live-DEV blocked on 0177** (R4) |
| PH-12 | ranking provenance open question | **Closed — was a real defect, remediated** (R1) |
| PH-10 | Module 11 env vars undocumented/unforwarded | **Closed** (R2: `.env.example`, `amplify.yml`, `ENVIRONMENT_VARIABLES.md`) |
| PH-13 | health endpoint hard-codes mock | **Closed** (R2) |
| PH-06/07/08 | future-phase placeholders | untouched, correct as-is |
| PH-09 | dead `ai_recommendations`/`ai_feedback` tables | untouched (out of scope; PO decision) |
| PH-11 | memory-index overstatement | out of scope (documentation-only, Modules 1–10) |

Class A items remaining in 11.1–11.6 by the audit's own definition: **0 in code**. Items that are complete in code but not yet *live-verified in DEV* because their migrations are DDL: **3** (0176 scheduler, 0177 admin capabilities, 0178 NBA audit/switch) — these are operator steps, not missing implementation.

## Defects found by this programme (beyond the audit's list)

1. R1: provider could rank `priority_review_areas` (audit's PH-12 confirmed as a defect).
2. R2: `summarisePackGrounding()` did not require mandatory blocks to be present — a provider omitting all four could reach READY (surfaced by the first live run).
3. R2: the 11.0 adapter's "per-1K" price table carried per-1M figures (1000× over-estimate on the provider fallback path).
4. R2: the gateway hard-coded a 30 s pack timeout, ignoring configuration.
5. R3: a retried pack was not re-parented to the new batch, so a resumed reconcile dropped its result as "unmatched" (surfaced by the PGlite certification).
6. R3: the OpenAI project is not entitled to the batch model (account finding).
7. R6: `ENVIRONMENT_VARIABLES.md` had drifted from `amplify.yml` on `main` (test already failing there).
8. Pre-existing, recorded not fixed: `aiResidualClosureFailClosed › A4`; 11.0/11.1 PGlite cert seed-count assertions; `adminAnalyticsPhaseAMeRoute` (17); `countryGateAccessMatrix`; `resourcesR1_1` timeout; `fdh1Isolation` (from PR #8); the 19 existing `/api/admin/ai/*` routes gated on bare `requireAdmin()` (Admin Standard §1.2 conflict for PO scheduling).

## Decisions needed from the Product Owner

1. Confirm `gpt-4o-mini` as Module 11's model (currently the AIE-inherited configurable default).
2. Enable the batch model on the OpenAI project (then `MODULE11_AI_BATCH_MODE=provider_batch`), or accept standard-rate sync fan-out.
3. Accept the three unsupported NBA rules (investment concentration, retirement progress, forecast review) as deferred until upstream certification exists.
4. Who receives `can_view_ai_operations` / `can_manage_ai_operations`.
5. Apply 0175–0178 to DEV (operator) so the three blocked live gates can be closed, then production per R7.

## FINAL STATUS (brief §61)

```
MODULE 11.1:
CONDITIONAL PASS — DEV-certified (real cost metadata, quota/rate/kill switches re-proven live and in PGlite); Admin UI built; live rendering blocked on migration 0177 reaching DEV.

MODULE 11.2:
FULL PASS — resolution order and DB invariants re-proven (suites + PGlite cert 13/13); unchanged by this programme.

MODULE 11.3:
CONDITIONAL PASS — real provider FULL PASS in DEV (2 live packs, grounding PASS, cost/tokens/audit recorded, quota 10→10); async batch + monthly scheduler built and PGlite-certified; live scheduler blocked on 0176; provider-native batch pricing blocked on OpenAI project entitlement (fallback shipped).

MODULE 11.4:
FULL PASS — 25/25 questions, provider 0, quota 0 under OpenAI configuration; SQ-AI-003/025 now deterministic (11.6); SQ-AI-013 remains deferred.

MODULE 11.5:
FULL PASS — every contextual target, provider 0, quota 0 under OpenAI configuration; snapshot binding suites unchanged and passing.

MODULE 11.6:
CONDITIONAL PASS — engine/service/API/UI/SQ repoint FULL PASS (35/35, 20-household matrix, provider/quota negative controls); audit table + kill-switch column blocked on 0178 reaching DEV.

REAL OPENAI PROVIDER:
VERIFIED

INSIGHT PACK AUTOMATION:
NOT VERIFIED (built and PGlite-certified; not run live in DEV — migration 0176 is DDL with no path from this environment)

ADMIN AI OPERATIONS UI:
NOT VERIFIED (built, type-checked, unit/PGlite-tested; not rendered live — migration 0177 + a capability grant required)

DETERMINISTIC NBA:
VERIFIED

REQUIRED 11.1–11.6 CLASS A GAPS REMAINING:
0 (in code); 3 live-DEV verification gates owed to DDL migrations 0176/0177/0178

READY FOR PRODUCTION ACTIVATION:
NO — pre-conditions P1–P3 of the R7 plan (PO acceptance and decisions; DEV application of 0176–0178 with the three owed live proofs) must be met first; the plan itself is complete.

READY FOR MODULE 11.7:
NO — 11.7 is out of scope by the brief; additionally 11.7 needs the production activation above and a separate PO authorisation.
```

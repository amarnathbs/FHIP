# AIE-1 — Final Implementation, Operational Closure and DEV Certification

**Branch**: `feature/aie-1-final-closure` (based on `integration/aie-1-release-candidate` at its own tip, commit `80e707b`)
**Full commit SHA (this closure work)**: `7331c19755864cf17de5e6ac6648cb638d1c4e85`
**Date**: 2026-09-13
**Not pushed. Not merged to `main`. No production authority exercised or claimed.**

---

## 1. Baseline reconciliation

| Reported (dispatch baseline) | Observed (this session, direct inspection) | Evidence | Discrepancy | Required action |
|---|---|---|---|---|
| AIE-1.1–1.6 implemented, tested, merged into `integration/aie-1-release-candidate` | Confirmed. All phase code present; 39 pre-existing AIE test files passing before this session's changes. | Read every phase file; ran `npx vitest run aie` at session start. | None. | None. |
| AIE-1.2 acceptance-dispatch bug fixed | Confirmed — `accept.ts` dispatches on `getAdapterIdForRun`, not a hardcoded Insurance path. | Read `lib/aie/review/accept.ts`. | None. | None. |
| AIE-1.3 commit-path/idempotency completed | Confirmed — `findCommittedFdhBankWriteForRun` idempotency guard present, `commitFdhBankStatementImport` wired into `accept.ts`. | Read `accept.ts` + `atomicImport.ts`. | None. | None. |
| Migration 0146 fixes trigger-column defect | Confirmed present and, per the existing `AIE_1_0146_INSURANCE_CLOSURE_REPORT.md`, live-DEV proven effective. | Read migration + report. | None. | None. |
| Migrations 0140–0146 applied to **both** DEV and production | **DEV confirmed** (every `aie_*` table exists and is queryable in DEV). **Production also confirmed** — every `aie_*` table exists and is queryable in the production Supabase project too (read-only existence probe, this session). | `scripts/aiecl_closure_migration_state_check.mjs`, run against both projects this session. | The existing `AIE_1_0146_INSURANCE_CLOSURE_REPORT.md` (same day) states "**0146 has not yet been applied to production**." This session's table-existence probe cannot distinguish "0146 applied" from "0140–0145 applied, 0146 not yet, but no new production reads happen to touch the difference" — 0146 is a pure trigger-function replacement with no new queryable object (the same reason the DEV-side check script needed a live *behavioural* reproduction, not a schema check). **This session did NOT attempt a live-behavioural production reproduction** (would require a real write against production, outside this mission's authorised DEV-verification scope). | **Treat "0146 on production" as UNCONFIRMED.** Recommend an explicit PO/operator confirmation (or a read-only `pg_proc` source inspection, if a channel for that exists) before relying on it. This session's own new work does not depend on the answer either way. |
| Post-0146 Insurance HTTP journey already closed | Confirmed, and **re-verified after this session's own changes** (see §5 below) — the journey is unaffected by this closure mission's edits. | `AIE_1_0146_INSURANCE_CLOSURE_REPORT.md` + this session's `AIE_1_CLOSURE_INSURANCE_REGRESSION_REPORT.md`. | None. | None. |
| AIE-1.6 issued CONDITIONAL PASS, 2 findings fixed afterward | Confirmed. | Read `AIE_1_6_CERTIFICATION_REPORT.md` + `AIE_1_MERGE_PLAN.md`. | None. | None. |
| **NEW, discovered this session**: no HTTP intake route exists anywhere for Investment Intelligence (AIE-1.2) | Confirmed by exhaustive `find app/api/aie` — only `intake`, `fdh-bank/intake`, `insurance/intake`, `review/*` exist. II's `write.ts`/`schema.ts`/`reconciliationRule.ts` are fully implemented but have **zero caller** anywhere in `app/`. | Direct filesystem search. | The consolidated report described this as "no live II canonical-write proof" — a narrower framing than the reality: there is no route to reach II at all, live or otherwise. | **IMPLEMENTATION REQUIRED** (not attempted this session — see §9). |
| **NEW, discovered this session**: no cohort/kill-switch allowlist mechanism existed | Confirmed (matches the production-cert plan's own disclosure). | Repo-wide search. | None — matches prior disclosure. | Built this session (§8). |
| **NEW, discovered this session**: no automated accessibility tooling existed | Confirmed (matches prior disclosure). | Repo-wide search for axe-core/jest-axe/cypress-axe. | None — matches prior disclosure. | Built and run this session (§10). |
| **NEW, discovered this session**: no retention/purge job existed for AIE | Confirmed (matches prior disclosure). | Repo-wide search for callers of `deleteFromQuarantine`. | None — matches prior disclosure. | Built this session (§6). |
| **NEW, discovered this session**: PC5 does not exist anywhere in this repo | Confirmed (matches prior disclosure — a roadmap name only). | Repo-wide search. | None — matches prior disclosure. | AIE-side interface built and real-DEV verified this session; end-to-end remains structurally blocked (§7). |

---

## 2. What this session actually built (summary; full detail in per-topic docs)

| # | Area | Status | Evidence doc |
|---|---|---|---|
| 1 | Real OpenAI GPT-4o mini provider (`lib/aie/provider/openaiAieProvider.ts`) | Implementation COMPLETE, contract-tested. Real-provider verification BLOCKED (no `AIE_OPENAI_API_KEY` in this environment). | This report §3 |
| 2 | Provider factory (mock/real switch, fail-loud) | COMPLETE, tested, wired into all 3 real intake routes. | This report §3 |
| 3 | Strict JSON Schema builder for OpenAI Structured Outputs | COMPLETE, tested against the 3 registered schemas (generic/insurance/II). | This report §3 |
| 4 | Adapter-specific schema wiring (`orchestrator.ts` `schemaOverride`) | COMPLETE — closed a real, disclosed dormant gap (every AI call previously used the generic schema regardless of adapter). Wired for Insurance. | This report §3 |
| 5 | Document lifecycle: immediate deletion + scheduled purge (migration 0149, `lib/aie/services/purge.ts`, `app/api/aie/cron/purge-sweep/route.ts`) | Implementation COMPLETE, unit-tested. Real Storage-layer deletion PROVEN live-DEV. DB-side status bookkeeping BLOCKED pending migration 0149 application (no DDL channel). | `AIE_1_CLOSURE_INSURANCE_REGRESSION_REPORT.md` |
| 6 | Atomic AI cost/quota admission (migration 0150, `lib/aie/cost/costAdmission.ts`) | Implementation COMPLETE, unit-tested, wired into the gateway. DB-side atomicity verification BLOCKED pending migration 0150 application. | This report §4 |
| 7 | GuardDuty scan-result decision logic (`lib/aie/malware/scanResultHandler.ts`) | Implementation COMPLETE, unit-tested against AWS's real documented event schema. NOT wired into the live pipeline (storage has not migrated to S3 — see §5). Real-GuardDuty verification BLOCKED (no AWS credentials). | `AIE_1_CLOSURE_AWS_INFRASTRUCTURE.md` |
| 8 | AWS infrastructure (S3 bucket, GuardDuty plan, EventBridge/SQS/DLQ, 5 least-privilege IAM roles, cost alarms) | DOCUMENTED as an exact, copy-paste-ready runbook. NOT PROVISIONED (no AWS credentials). | `AIE_1_CLOSURE_AWS_INFRASTRUCTURE.md` |
| 9 | PC5 exception-consumption interface | Interface + contract COMPLETE, real-DEV VERIFIED (16/16 checks). End-to-end PC5 closure BLOCKED — PC5 itself does not exist. | `AIE_1_CLOSURE_PC5_INTERFACE_REPORT.md` |
| 10 | Allowlisted pilot cohort gate | COMPLETE, tested, wired into all 3 real intake routes. | This report §8 |
| 11 | Automated accessibility scanning | Tooling ADDED (new dependency), real-DEV RUN against 2 of the review UI's states, zero violations found. Manual screen-reader pass remains an explicit, disclosed gap. | `AIE_1_CLOSURE_ACCESSIBILITY_REPORT.md` |
| 12 | Deferred document-class register | COMPLETE (documentation). | `AIE_1_CLOSURE_DEFERRED_CLASS_REGISTER.md` |
| 13 | Operational runbooks (9 named scenarios + 1) | COMPLETE (documentation). | `AIE_1_CLOSURE_OPERATIONAL_RUNBOOKS.md` |
| 14 | Insurance journey regression re-verification | COMPLETE, real-DEV, 14/14 checks, zero regression from this session's changes. | `AIE_1_CLOSURE_INSURANCE_REGRESSION_REPORT.md` |
| 15 | Investment Intelligence HTTP intake route | **NOT BUILT** — explicit, reasoned decision (see §9). | This report §9 |
| 16 | S3 storage-topology migration | **NOT BUILT** — explicit, reasoned decision (see §5). | `AIE_1_CLOSURE_AWS_INFRASTRUCTURE.md` §7 |

---

## 3. OpenAI GPT-4o mini — model verification, integration, and the real BLOCKED status

**Model verified against current official OpenAI documentation (2026-09-13, via live web search/fetch this session)**: Structured Outputs with `strict: true` json_schema is supported on `gpt-4o-mini-2024-07-18` and later. This is the exact, pinned snapshot `lib/aie/config.ts#getAieAiModel()` defaults to — never the floating alias `gpt-4o-mini` in an actual API call (the alias name is retained only as a pricing-lookup key for callers that don't yet know the pinned snapshot).

**Pricing, dated and auditable** (`lib/aie/config.ts`): $0.15 / 1M input tokens, $0.60 / 1M output tokens, `AIE_PRICING_CONFIRMED_DATE = '2026-09-13'` — confirmed against OpenAI's public pricing page this session, not a historical estimate.

**Integration built**: `lib/aie/provider/openaiAieProvider.ts` implements the existing `AieAiProvider` interface via the Chat Completions API (raw `fetch`, no new SDK dependency, matching this repo's own convention). Sends `store: false` explicitly (never described as Zero Data Retention — the mission's own distinction is preserved verbatim in the code comments). Masking happens entirely upstream (the gateway's own PAY-04 defensive re-check) — this adapter never receives, and structurally cannot receive, the original document, a password, or the identity/mask-token map.

**Real-provider verification: BLOCKED.** `AIE_OPENAI_API_KEY` does not exist in this environment (confirmed both at mission start and via provider-factory unit tests that prove the factory refuses to silently substitute mock when `openai` is explicitly selected without a key). **No real OpenAI API call was ever made by this session.** 12 contract tests (mocked `fetch`) prove the adapter's own request-shaping, retry, and error-mapping logic is correct — this is exactly what the mission's own dispatch instructions asked for in this situation, and it does not stand in for real-provider verification.

**Cost**: $0.00 actual (never called). No estimate-vs-observed reconciliation is possible or claimed for a call that never happened.

---

## 4. Cost/quota admission — real atomic logic, blocked DB verification

Migration 0150 (`aie_ai_cost_ledger` + `aie_reserve_ai_cost`/`aie_settle_ai_cost` SECURITY DEFINER functions) implements a genuinely atomic reservation (`UPDATE ... WHERE (reserved+settled+amount) <= allowance RETURNING`) — no read-then-write race window. Wired into `lib/aie/provider/gateway.ts` as an optional DI hook (unit-tested, 6 gateway-level scenarios + 8 wrapper-level scenarios, all passing). **DEV/production verification of the SQL function's real atomicity under concurrent load is BLOCKED** — this session has no DDL execution channel (confirmed: `exec_sql`/`execute_sql`/`run_sql`/`admin_exec` RPC probes all return `PGRST202`).

---

## 5. Malware/GuardDuty and AWS infrastructure — real logic, blocked provisioning, disclosed sequencing gap

`lib/aie/malware/scanResultHandler.ts#decideScanResult()` is verified, via 15 unit tests, against AWS's own currently-documented "GuardDuty Malware Protection Object Scan Result" event schema (fetched live this session) — every mission-required security property holds: clean-admit, threats-found block, scan-failure/skip block, forged/mismatched-event rejection on every identity field (account/region/bucket/key), stale-version rejection (an old clean scan cannot release replacement bytes), duplicate-delivery idempotency, deadline expiry, fail-closed on an unrecognised enum value.

**This logic is NOT wired into the live pipeline.** GuardDuty Malware Protection for S3 requires the object to live in S3; AIE's quarantine is, and remains, Supabase Storage — this session did not migrate storage topology, because doing so would require writing untested SigV4/presigned-URL code with zero ability to verify it against real S3 (the same credential blocker as GuardDuty itself). `AIE_1_CLOSURE_AWS_INFRASTRUCTURE.md` documents the exact target design (Option B object-identity/no-versioning decision, 5 least-privilege IAM roles, EventBridge→SQS→DLQ, cost alarms) as a ready-to-run runbook.

**Real GuardDuty/AWS verification: BLOCKED.** No AWS credentials exist in this environment (confirmed at mission start via `.env.local` grep). No S3 bucket, GuardDuty plan, or any other AWS resource was provisioned. No scan was performed. No fabricated result is reported anywhere in this closure.

---

## 6. Temporary document lifecycle

Immediate deletion (the primary path) is wired into all three real intake routes for adapters confirmed not to need the original bytes again (Insurance, and the generic no-adapter diagnostic route), and into `accept.ts`'s own success branches for the two adapters that genuinely do need them at accept time (Investment Intelligence, FDH-bank — confirmed by reading `write.ts`/`atomicImport.ts` directly, not assumed). The scheduled sweep (`app/api/aie/cron/purge-sweep/route.ts`, migration 0149's `pg_cron` schedule, every 15 minutes) is the backstop, plus a 24-hour hard-age backstop independent of any individual route's own behaviour.

**Real-DEV proof (this session)**: the actual Supabase Storage delete call for Insurance's quarantine object was independently verified to succeed against real DEV Storage. The row-level status bookkeeping for that same deletion is honestly disclosed as blocked on migration 0149 (not yet applied — no DDL channel), observed live, not merely theorised (`AIE_1_CLOSURE_INSURANCE_REGRESSION_REPORT.md`).

**Zero-residue results**: every live-DEV script this session ran (PC5 interface, accessibility, Insurance regression) independently re-verified full cleanup — zero residue in every case, including the two synthetic users and every row they touched.

---

## 7. PC5

Interface (`lib/aie/pc5/pc5ExceptionInterface.ts`) complete, no new exception database, no divergent lifecycle — thin wrappers over AIE's own existing `listOpenUnresolvedItemsForUser`/`decideOnItem`. **Real-DEV verified, 16/16 checks**, including genuine 6-way concurrent idempotent collapse independently confirmed via direct DB query. **End-to-end PC5 closure is BLOCKED** — PC5 does not exist anywhere in this codebase to complete the loop with; this is stated plainly, not glossed over.

---

## 8. Cohort, kill-switches, cost controls

- Global upload kill switch (`AIE_DOCUMENT_INTAKE_ENABLED`): pre-existing, confirmed intact.
- AI fallback kill switch (`AIE_AI_FALLBACK_ENABLED`, plus per-adapter ANDed flags): pre-existing, confirmed intact, now also gates a genuine cost-admission reservation (§4).
- **Allowlisted pilot cohort** (`AIE_PILOT_COHORT_ENFORCED` + user-id/email allowlists): built this session, fails closed (enforced-but-empty denies everyone), wired into all 3 real intake routes, never into the accept or purge-sweep routes (mission's own "disabling new uploads should not prevent cleanup" rule). 8 unit tests.
- Global cost allowance: real, atomic (§4).
- **Per-user quotas**: NOT built. The current cost ledger is global-only. Documented as deliberately deferred rather than rushed — see §9.
- DEV/production separation: structural (separate Supabase projects, separate env var files) — unchanged by this session, confirmed intact.

---

## 9. What was deliberately NOT attempted, and why

1. **Investment Intelligence HTTP intake route.** II's parser/schema/write-gate/reconciliation-rule are all implemented and unit-tested, but reaching them requires building a new route that also constructs `InvestmentReconciliationContext` — real DB-backed account/instrument matching, existing-fingerprint/snapshot lookups, and reconciliation config, none of which exists anywhere as reusable, DB-wired code today (confirmed: `matchAccountsReadOnly`/`matchInstrumentsReadOnly`/`InvestmentReconciliationContext` are used only in AIE's own unit tests, never in any production code path). Building this under time pressure, without deep familiarity with the live II schema, risked introducing a genuine financial-reconciliation defect — exactly the class of error this mission's own section 7.7 ("never invent balancing entries") warns hardest against. Documented here as the single most important remaining implementation item for AIE-1.2's real closure, with the exact shape needed: a new `app/api/aie/investment-intelligence/intake/route.ts` plus a new `lib/aie/adapters/investment-intelligence/reconciliationContext.ts` that queries `ii_accounts`/`ii_instruments`/`ii_transactions`/`ii_holdings`, ideally reusing `documentProcessing.ts#processSourceDocument`'s own existing resolution logic rather than reimplementing it.
2. **S3 storage-topology migration** (§5) — untested SigV4/presigned-URL code with zero ability to verify against real AWS.
3. **Per-user cost quotas** — the current ledger is global; a per-user dimension is a real, additive, non-trivial schema change (a second ledger keyed by user, with its own admission-priority question when both the global and a user's own allowance are checked together) that this session judged lower priority than the items actually completed, given the pilot's own $10 *global* allowance framing in the mission text itself.
4. **Full 9-screen accessibility sweep and manual screen-reader pass** — 2 of the review UI's several states were axe-scanned with zero violations; the remaining states, and Investment Intelligence/FDH-bank's own review journeys, are named as explicit remaining work, not silently skipped (`AIE_1_CLOSURE_ACCESSIBILITY_REPORT.md`).

---

## 10. Final regression

- **AIE-scoped**: 42/42 test files, **462/462 tests** pass.
- **Full repository suite**: 6707/6734 tests pass (23 skipped), 12 failed test files/tests — every one confirmed **pre-existing and unrelated** to any file this closure mission touched:
  - `tests/unit/migrationVersionsCrossBranch.test.ts` — a pre-existing collision between this branch's own `0129` file and `origin/main`'s different `0129` file, confirmed byte-identical to the state already on `integration/aie-1-release-candidate` before this session began (not introduced by this closure work).
  - `tests/unit/aiResidualClosureFailClosed.test.ts`, `tests/unit/countryGateAccessMatrix.test.ts` — pre-existing, unrelated modules.
  - 9 `resourcesXxx*` test files — pre-existing, unrelated to AIE.
  - (A `paymentsCheckoutRoute.test.ts` timeout observed once was confirmed flaky — passes cleanly in isolation; a resource-contention artefact of the full 6700+ test run, not a real failure, matching this mission's own warning about concurrent heavy suites.)
- `tsc --noEmit`: clean throughout every checkpoint.
- `eslint`: clean throughout every checkpoint (zero errors, zero warnings on every file this session touched).
- PGlite full migration-chain rebuild (`tests/unit/aiInsightPack20HouseholdE2E.test.ts`): passes with both new migrations (0149, 0150) in the chain.

---

## 11. Phase-specific verdicts (mission section 15)

Distinguishing implementation-complete, DEV-certified, and production-ready explicitly, per the mission's own instruction. **No verdict here grants production authority.**

| Phase | Verdict | Basis |
|---|---|---|
| AIE-1.1 Shared Gateway | **CONDITIONAL PASS** | Real-provider adapter and cost admission are implementation-complete and contract-tested, not live-provider-verified (credential-blocked). Document-lifecycle purge is implementation-complete, unit-tested, and its storage-layer effect is live-DEV proven; its DB bookkeeping is migration-blocked. |
| AIE-1.2 Investment Intelligence | **CONDITIONAL PASS, narrower than before** — the adapter's own parser/schema/write-gate logic is unit-tested and unchanged from the prior merge, but this session's own discovery (§1) found the gap is more severe than previously disclosed: literally no HTTP route exists to reach it. Not regressed by this session; not advanced either. |
| AIE-1.3 FDH Bank Adapter | **CONDITIONAL PASS**, unchanged in scope from the prior merge — this session's regression focus was Insurance (the one adapter with a real prior live-DEV certification to protect); FDH-bank's own real corpus run remains the same open item it was before this session. |
| AIE-1.4 Insurance + other classes | **FULL PASS for the explicitly tested scope** (Insurance's real HTTP journey, re-verified live-DEV, zero regression from this session's changes) — **explicitly not a FULL PASS for the original nine-class AIE-1.4 scope**, of which one class is implemented, eight are deferred for named reasons, one is prohibited by design (`AIE_1_CLOSURE_DEFERRED_CLASS_REGISTER.md`). |
| AIE-1.5 Review & Acceptance | **CONDITIONAL PASS** — Insurance's own review/accept path is real-DEV proven end to end (including this session's new immediate-deletion behaviour). PC5 integration is interface-complete and DEV-verified but end-to-end BLOCKED. Bulk actions and post-acceptance undo remain explicitly un-built, per the mission's own instruction to retain safe current behaviour rather than invent an unapproved amendment model. |
| AIE-1.6 Certification | **This report supersedes the prior CONDITIONAL PASS with a current, evidence-backed CONDITIONAL PASS** — real new evidence (462 AIE tests, 4 independent live-DEV verification passes with zero residue, zero regression) closes real gaps (real provider adapter, real cost admission, real purge job, real cohort gate, real accessibility tooling, real PC5 interface), while several real, named gaps remain genuinely open (II route, S3/GuardDuty wiring, per-user quotas, full accessibility sweep, manual screen-reader pass, unconfirmed 0146-on-production status). **No phase reaches an unconditional FULL PASS in this closure pass**, and this report does not claim one. |

---

## 12. What is BLOCKED, and the exact named blocker for each

| Item | Exact blocker |
|---|---|
| Real OpenAI API call / real cost observed | `AIE_OPENAI_API_KEY` not present in this environment. |
| Real AWS GuardDuty scan / real S3 provisioning | No AWS credentials present in this environment. |
| Migration 0149/0150 DEV application (and therefore full document-lifecycle DB bookkeeping + real atomic cost-admission DB verification) | No DDL execution channel from this session (`exec_sql`/`execute_sql`/`run_sql`/`admin_exec` all return `PGRST202`, confirmed by direct probe). |
| Confirming migration 0146 is genuinely applied to **production** (not just DEV) | Same DDL-channel absence; a live-behavioural production reproduction (the only reliable check for a pure trigger-function replacement) is a production write, outside this mission's DEV-only authorisation. |
| End-to-end PC5 integration | PC5 does not exist anywhere in this codebase — a roadmap name only. |
| Investment Intelligence real HTTP journey | No intake route exists; building the missing DB-backed reconciliation context was judged too high-risk to rush (§9). |
| Manual screen-reader accessibility certification | No screen-reader tooling available in this environment. |

---

## 13. Was production touched?

**No.** No migration was applied to production. No feature flag was changed in production. No merge to `main` occurred. No push to any remote branch occurred (all work is local commits on `feature/aie-1-final-closure`). The only infrastructure state this session actually changed anywhere is: local git commits in this worktree, and the real DEV Supabase rows created and then fully deleted (zero residue, independently re-verified) by this session's own live-DEV verification scripts.

---

## 14. Exact next action required, in priority order

1. **PO/operator decision**: confirm whether migration 0146 is genuinely applied to production (§1) — a real, if narrow, unresolved factual question this session could not close from its own access level.
2. **Operator action**: apply migrations 0149 and 0150 to DEV (via the Supabase SQL Editor, the same channel every prior migration in this project's history has used) to unblock full document-lifecycle DB bookkeeping and real atomic cost-admission verification.
3. **Engineering decision**: whether to build the Investment Intelligence HTTP intake route + reconciliation-context wiring next (§9.1) — the single largest remaining implementation gap in the whole AIE-1 programme.
4. **Product Owner decision** (unchanged from the prior production-certification plan, still open): the three named scope decisions (PC5 integration timeline, accessibility investment level, malware-scanner risk acceptance for a real pilot cohort) plus a controlled-rollout mechanism decision, now partially answered by this session's own cohort-allowlist build (§8) but still needing an explicit PO sign-off on the actual allowlist membership for a real pilot.
5. Whenever AWS/OpenAI credentials become available: provision the infrastructure in `AIE_1_CLOSURE_AWS_INFRASTRUCTURE.md`, wire `lib/aie/malware/scanResultHandler.ts` into a real SQS consumer, and run the real-provider/real-GuardDuty verification this report could not perform.

No further action in this closure mission is required or authorised beyond what is listed above.

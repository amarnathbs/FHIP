# AIE-1 — Infrastructure Activation Closure Register

Tracks the "AIE-1 — Connect existing AWS S3/GuardDuty and OpenAI GPT-4o
mini, complete remaining integration, and certify in DEV" mission,
item by item. Statuses: **IMPLEMENTED** (code exists, not DB/live-verified),
**VERIFIED IN DEV** (proven against a real running system), **BLOCKED**
(named dependency, not this session's to resolve alone), **EXPLICITLY
DEFERRED** (a reasoned decision not to do it now), **NOT APPLICABLE WITH
REASON**.

Branch: `feature/aie-1-final-closure`. All work local-only, not pushed, not
merged. No production action taken anywhere in this register.

---

## 0. Discovery — what this session's actual AWS/OpenAI access is, right now

| Fact | Value | How discovered |
|---|---|---|
| AWS identity | `arn:aws:iam::879807128139:user/Amar` | `aws sts get-caller-identity` (succeeds — the credential chain itself works) |
| AWS region configured | `ap-southeast-2` | `aws configure get region` |
| `s3:ListAllMyBuckets` | **Denied** | `AccessDenied` |
| `guardduty:ListDetectors` | **Denied** (`AccessDeniedException`) | Direct call, both `ap-southeast-2` and `us-east-1` |
| Guessed candidate bucket names (`fhip-aie-quarantine-dev`, `fhip-aie-quarantine`, `aie-quarantine-dev`, `fhip-aie-dev`, `aie-document-quarantine-dev`, `fhip-dev-aie-quarantine`) | All return `404 Not Found` via `head-bucket` | None of these exact names exist under this account/region — guessing is not productive |
| `AIE_OPENAI_API_KEY` | **Absent** — `.env.local` and process env both checked | `grep`, `env` |
| Migration `0151` (prior session's own cost-admission row-count fix) | **Not yet applied** | Live RPC probe: still returns 2 rows on a successful reservation |

**This is a genuine finding, not a restated assumption**: the AWS credential chain itself is reachable and authenticates correctly (contradicting a naive "no AWS access" conclusion), but this specific IAM identity has zero permissions for any of the discovery calls this mission needs. The user-reported "created an S3 bucket" and "selected GuardDuty" almost certainly happened through the AWS console under a different (the user's own) identity — this session's identity was never granted visibility into it. **This is the single blocking gap for the entire AWS-touching portion of this mission** — see the consolidated question at the end of this document.

---

## 1. Real OpenAI GPT-4o mini provider

| | |
|---|---|
| Requirement | Real, masked, cost-observed GPT-4o mini call in DEV |
| Observed | `lib/aie/provider/openaiAieProvider.ts` — implementation complete, pins `gpt-4o-mini-2024-07-18`, sends `store:false`, never receives raw bytes/password/identity map (re-verified by direct code read this session) |
| Remaining | Nothing code-side. Needs a real `AIE_OPENAI_API_KEY` in this environment to make one real call |
| Dependency | **BLOCKED** — OpenAI API key, to be delivered via a secure channel (never chat) |
| Verification method | Once key is available: one real call against a synthetic document, inspect the actual outbound payload for PII absence, confirm real token/cost numbers |
| Evidence location | N/A yet |
| Status | **IMPLEMENTED, not VERIFIED IN DEV — BLOCKED on credential delivery** |

## 2. AWS S3 quarantine bucket connection

| | |
|---|---|
| Requirement | Connect the PO's already-created DEV S3 bucket; confirm Block Public Access, encryption, ownership, versioning, CORS |
| Observed | No bucket name/region/config visible to this session (§0). The design decision (Option B: no versioning, conditional-write overwrite prevention) is already documented in `AIE_1_CLOSURE_AWS_INFRASTRUCTURE.md` |
| Remaining | Everything — cannot inspect a bucket this session cannot see |
| Dependency | **BLOCKED** — bucket name + region + DEV confirmation, or read permissions scoped to it |
| Verification method | `aws s3api get-bucket-*` calls once visible; a real signed-upload round trip |
| Evidence location | N/A yet |
| Status | **BLOCKED** |

## 3. GuardDuty Malware Protection for S3

| | |
|---|---|
| Requirement | Confirm the plan exists, is ACTIVE, and is Malware Protection for S3 specifically (not general S3 Protection) |
| Observed | `guardduty:ListDetectors` denied outright — cannot even confirm GuardDuty is enabled on this account from this session |
| Remaining | Everything |
| Dependency | **BLOCKED** — same permissions gap as §2 |
| Verification method | `aws guardduty get-malware-protection-plan` once visible, checking `status: ACTIVE` |
| Evidence location | N/A yet |
| Status | **BLOCKED** |

## 4. Real scan-handler wiring (EventBridge → SQS → consumer)

| | |
|---|---|
| Requirement | Wire `lib/aie/malware/scanResultHandler.ts#decideScanResult()` into a real event pipeline |
| Observed | `decideScanResult()` is implementation-complete and unit-tested (15 tests) against AWS's documented event schema (re-verified by direct code read this session — fail-closed on every named property). No caller exists anywhere outside its own test file |
| Remaining | An EventBridge rule, SQS queue + DLQ, and a consumer route/worker — none of which can be usefully built without knowing the real bucket/region (§2/§3) |
| Dependency | **BLOCKED** — same as §2/§3 |
| Verification method | Real GuardDuty scan-result event delivered end-to-end once wired |
| Evidence location | N/A yet |
| Status | **BLOCKED** |

## 5. Migrations 0149/0150/0151/0152 — applied and verified in DEV

| | |
|---|---|
| Requirement | Apply reviewed closure migrations to DEV; verify actual database behavior, not just SQL review |
| Observed | **0149/0150 applied to DEV this session** (prior turn) and independently re-verified live: Insurance's full immediate-deletion path (storage + DB bookkeeping) now works end-to-end; the 24-hour hard-retention backstop proven live (16/16, real aged document, real negative control). **0151** (fixes 0150's 2-row return bug) written, PGlite-proven, **not yet applied**. **0152** (this session, new: fixes a real duplicate-settlement double-counting defect found by live-testing 0150) written, proven against a real Postgres engine (PGlite, 5/5), **not yet applied** |
| Remaining | Nothing — **PO applied both 0151 and 0152 to DEV this session**, in order |
| Dependency | None — closed |
| Verification method | Live RPC probes against real DEV: successful reservation returns exactly 1 row, repeat reservation under the same key doesn't double-reserve, duplicate settle under the same key is a no-op, a different key reserves independently |
| Evidence location | `scripts/aiecl_insurance_regression_live_dev.ts`, `scripts/aiecl_24h_backstop_live_dev.ts`, `tests/unit/aieCostAdmissionPglitePostgresProof.test.ts` (PGlite, pre-application), `scripts/aiecl_0152_cost_idempotency_live_dev_verify.mjs` (real DEV, post-application, 9/9 PASS) |
| Status | **0149/0150/0151/0152 all VERIFIED IN DEV** |

## 6. Cost admission — atomic, idempotent, duplicate-safe

| | |
|---|---|
| Requirement | Atomic reservation; concurrent reservations cannot exceed allowance; settlement/release safe under duplicate execution |
| Observed | Atomicity of the admission check itself: sound since 0150 (single `UPDATE...WHERE...RETURNING`), re-confirmed this session. **Duplicate-settlement protection: absent in 0150/0151, confirmed live via direct RPC calls (settled_usd doubled on a repeat call) — a real, named defect this mission specifically asked to verify.** Fixed in 0152 with a new idempotency-attempt table, proven against a real Postgres engine |
| Remaining | Nothing |
| Dependency | None — closed |
| Verification method | `tests/unit/aieCostAdmissionPglitePostgresProof.test.ts` (5/5, real Postgres, pre-application) AND `scripts/aiecl_0152_cost_idempotency_live_dev_verify.mjs` (9/9, real DEV, post-application) |
| Evidence location | `supabase/migrations/0152_...sql`, `lib/aie/cost/costAdmission.ts`, `lib/aie/provider/gateway.ts` |
| Status | **VERIFIED IN DEV** |

## 7. II/FDH binary-retention-at-acceptance refactor

| | |
|---|---|
| Requirement | Refactor, where feasible, so acceptance consumes a durable structured payload instead of needing original bytes |
| Observed | Traced directly (`lib/aie/adapters/investment-intelligence/write.ts`, `lib/aie/adapters/fdhBankStatement/atomicImport.ts`): both deliberately delegate the ENTIRE canonical write to each module's own real, already-certified orchestrator (`processSourceDocument`/`processBankPdfDocument`), which does not accept pre-extracted JSON as input — it re-parses from a real stored document every time, by design, matching this whole programme's own "never invent a second canonical-write contract" and "never write canonical data directly from a provider response" rules |
| Remaining | A genuine refactor would require either (a) a new write path that trusts AIE's own extracted JSON as truth, bypassing each module's real parser — reintroducing exactly the AI-trust risk this architecture exists to prevent, or (b) modifying II's/FDH's own certified orchestrators to accept an alternate pre-extracted input mode — cross-module surgery outside this session's familiarity with those modules' live schemas, the same caution the original closure report gave for the II route gap |
| Dependency | A genuine architectural/ownership decision by II's and FDH's own module owners, not something this session should do unilaterally |
| Verification method | N/A — no refactor attempted |
| Evidence location | `docs/aie-programme/AIE_1_BINARY_RETENTION_DEPENDENCY_ANALYSIS.md` |
| Status | **EXPLICITLY DEFERRED, with reasons documented** — not claimed as full lifecycle compliance. The actual retention BOUND (24h hard backstop) is real and VERIFIED IN DEV (§5) regardless of this deferral |

## 8. Purge schedule deployed and verified

| | |
|---|---|
| Requirement | Immediate deletion AND scheduled sweep both operational, authenticated scheduler, not merely present in code |
| Observed | Immediate deletion: **VERIFIED IN DEV** (Insurance journey, full path). 24h hard backstop: **VERIFIED IN DEV** (real aged document, real negative control, real storage deletion). `app/api/aie/cron/purge-sweep/route.ts` re-read in full this session: genuinely authenticated (`x-cron-secret` header checked against `CRON_SECRET`, 401 otherwise — not an open endpoint). Migration `0149` (already applied to DEV) genuinely registers a real `pg_cron` job (`aie1-document-purge-sweep`, every 15 minutes, correct auth header) — **but its `url` is the literal placeholder string `<REPLACE_WITH_REACHABLE_APP_ORIGIN>/api/aie/cron/purge-sweep`**, by the migration's own explicit, honest design: this branch is not merged/deployed (no authority to do so under any mission run so far), so no real reachable DEV origin exists yet for the job to call. The migration's own comment states this plainly: the job "will fire and receive 404s... harmless, and expected" until deployment |
| Remaining | Replace the placeholder URL with the real DEV app origin once this branch is actually deployed somewhere reachable — not possible before then, and merge/deploy is explicitly outside every mission's authority so far |
| Dependency | Merge + deployment authorization (separate from this mission's scope) |
| Verification method | Read the route's auth guard (done); confirm the registered job's actual `command` column has a real URL, once one exists — this session has no raw-SQL/`cron.job`-reading channel to check the live value directly (`exec_sql`-style RPCs return `PGRST202`, same disclosed limitation as everywhere else) |
| Evidence location | `supabase/migrations/0149_aie1_closure_document_lifecycle_purge.sql`'s own scheduler section, `app/api/aie/cron/purge-sweep/route.ts` |
| Status | Deletion mechanics **VERIFIED IN DEV**. Scheduler registration **IMPLEMENTED, correctly authenticated, by design non-functional until deployment** — not a defect, a disclosed and expected pre-deployment state |

## 9. Adapter journeys

| Adapter | Status |
|---|---|
| Insurance | **VERIFIED IN DEV**, full real HTTP journey, re-verified post-0149/0150, zero regression, 4 UI states (unresolved/awaiting_acceptance/completed + 2 failure states) all axe-clean and confirmed to render correctly (2 real UI defects found+fixed this session, see accessibility report) |
| Investment Intelligence | **Re-traced this session, confirmed unchanged**: the generic intake route's `source_module_hint=investment_intelligence` is validated and stored as metadata ONLY (`createIntake({..., sourceModuleHint: moduleHint})`) — never passed to `runExtractionPipeline`, which always uses `noDomainAdapterReconciliationRule` for this route regardless of the hint. **No real dispatch path to II's own adapter logic exists** — confirmed by tracing, not assumed. Building the missing route remains the largest single implementation gap, deliberately not rushed (§9.1 of the original closure report) |
| FDH-bank | Adapter logic implemented, own regression not separately re-run this pass (same shared review-UI component as Insurance, already exercised) |

## 10. PC5

| | |
|---|---|
| Requirement | Recheck whether the real module exists; connect if present, else preserve interface + report blocked |
| Observed | Re-checked this session: still only a roadmap reference and one feature flag (`isAieReviewPc5ProjectionEnabled`) with its own comment "NOT built this pass" — no table, route, service, or module |
| Remaining | Nothing on AIE's side — the interface (`lib/aie/pc5/pc5ExceptionInterface.ts`) is complete and independently re-verified live-DEV twice this programme (16/16 both times) |
| Dependency | The Investment Intelligence programme's own PC5 phase (external to AIE-1) |
| Verification method | N/A until PC5 exists |
| Evidence location | `docs/aie-programme/AIE_1_CLOSURE_PC5_INTERFACE_REPORT.md`, `AIE_1_EXTERNAL_DEPENDENCIES_REGISTER.md` |
| Status | **NOT APPLICABLE WITH REASON** — external dependency, correctly not built ahead of its real consumer |

## 11. Accessibility

| | |
|---|---|
| Requirement | Cover upload/scan/extraction/error/retry/exception-nav/correction/summary/acceptance/completion states |
| Observed | All 7 of the run-detail component's real `AieUserFacingState` values now axe-scanned with zero violations, **and 4 real render-gap defects found and fixed this session** (import_failed, unable_to_process_safely, accepted_importing, completed all previously rendered nothing) |
| Remaining | Manual screen-reader pass (no tooling available in this environment — disclosed, not fabricated). Upload/scan-progress states are a raw diagnostic JSON API, not yet a dedicated progress UI (pre-existing, disclosed scope boundary, unchanged) |
| Dependency | Manual screen-reader tooling for the remaining item — none currently available |
| Verification method | `scripts/aiecl_failed_state_ui_live_dev_check.ts`, `scripts/aiecl_accepted_importing_ui_live_dev_check.ts` |
| Evidence location | `docs/aie-programme/AIE_1_CLOSURE_ACCESSIBILITY_REPORT.md` |
| Status | **VERIFIED IN DEV** for every reachable state of the reviewed component. Manual screen-reader pass **BLOCKED** (tooling) |

## 12. Masking verified before network egress

| | |
|---|---|
| Requirement | Prove synthetic identifiers occur in the input fixture and are absent from the outbound provider payload; required financial relationships remain interpretable |
| Observed | **VERIFIED IN DEV** (17/17): real orchestrator + real Insurance parser + real masking engine, a spy provider capturing the exact request object any real OpenAI provider would receive. All 4 synthetic PII values (email/TFN/PAN/card) present in input, absent from the captured outbound payload; the cover-amount financial figure survives unmasked; explicit `[MASKED:...]` tokens present (not silently dropped); real encrypted rows written to `aie_mask_token_map`; full cascade cleanup |
| Remaining | Nothing on the masking logic itself |
| Dependency | None — closed |
| Verification method | `scripts/aiecl_masking_before_egress_live_dev_check.ts` |
| Evidence location | Same |
| Status | **VERIFIED IN DEV** |

**Real, previously-undiscovered finding along the way, fixed for real**: `AIE_MASK_TOKEN_ENCRYPTION_KEY` was entirely absent from DEV's `.env.local` — meaning **any real document that ever reached the masking/AI-fallback path in the real running app would have crashed with an unhandled exception**, today, before this fix. Not previously caught because every prior Insurance regression fixture had `productName` present, which never enters this code path at all — this is the first time this session's testing actually exercised it. A genuine 64-hex-char key has been generated and added to `.env.local` (confirmed gitignored, never committed). This is a local DEV configuration file this session has direct write access to — no external credential or approval was needed to close this gap, unlike the AWS/OpenAI items above.

---

## Consolidated question — the one blocker for the entire AWS-touching half of this mission

Per this mission's own §4 instruction ("ask one consolidated question for only the unavailable values"):

1. **Bucket name** (exact, as created)
2. **Region** it was created in (assumed `ap-southeast-2` unless told otherwise)
3. **Confirmation this is the DEV bucket**, not a shared/production one
4. **GuardDuty status** if you can see it in the console (plan exists? status ACTIVE?) — since this session cannot query it at all right now

Fastest path to let this session self-verify going forward instead of relaying values by hand: attach the least-privilege IAM policy already drafted in `AIE_1_PROVISIONING_IAM_POLICY_REQUEST.md` to the same `Amar` IAM user — it's scoped to `aie-*` names and needs only a couple of unavoidable `Resource: "*"` statements (GuardDuty/Budgets APIs don't support ARN scoping for those specific actions, a real limitation, not a broad ask).

For the OpenAI key: same as before — deliver via your secure channel, not chat, whenever ready.

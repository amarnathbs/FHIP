# FHIP — Independent Live Recovery Requirements-to-Production Completeness Audit
## Final Independent Audit Report

**Date:** 2026-09-14
**Branch:** `audit/lr-independent-completeness-2026-09-14` (worktree branched from `origin/main`)
**Baseline commit audited:** `ff35f54c5eb78bcdf91a9e32b25108712351986f` (`= origin/main` at audit start)
**Production app:** `https://app.financialhealthplatform.com`
**Production database:** Supabase project `twwpnltizhtjxhamyoxt`
**DEV database:** Supabase project `vqycarelcoijzwlpkpcz`
**Prior verdict under review:** LR-12R — "UNCONDITIONAL FULL PASS — LIVE RECOVERY PROGRAMME PRODUCTION CERTIFIED & CLOSED. FROZEN."

---

## 2026-09-21 RECONCILIATION ADDENDUM — READ THIS FIRST

**This 2026-09-14 report was never merged to `main` and never delivered to the Product Owner.** It was discovered on 2026-09-21 by an independent re-audit as an orphaned branch (`audit/lr-independent-completeness-2026-09-14`, HEAD `54018a9`), diverged from `origin/main` at `ff35f54`. It is retained here as **Tier 4 evidence** (per the governing spec's own hierarchy — a lead, not proof) and its individual claims have been independently re-checked against `origin/main` as it stands on 2026-09-21 (`a193583`), one week and roughly 90 commits later. Full detail and updated verdict: `LR_2026_09_21_RECONCILIATION_ADDENDUM.md`. Headline deltas:

| 09-14 finding | 09-21 status | Evidence |
|---|---|---|
| P0-1 SMSF property loan double-subtracted from Net Worth | **FIXED, then partially re-opened as a known, disclosed gap** — `ea95507` (2026-09-14) fixed the double-subtraction; `368d98f` (2026-09-17) found that fix over-corrected and zeroed out other SMSF liabilities entirely, restored the general case, and **explicitly flagged back to the PO** that the narrow original correlation ("this specific loan is already netted elsewhere") remains architecturally unresolved | `git show ea95507`, `git show 368d98f` (both ancestors of `origin/main`) |
| P0-2 migration `0137` broke SMSF Detailed Holdings (`42501` on any edit) | **FIXED** — migration `0148` restores the missing `set_config` guard bracket alongside `0137`'s `security definer` fix | `supabase/migrations/0148_lr_p0_2_restore_smsf_balance_write_guard_bracket.sql`, ancestor of `origin/main` |
| P1-2 Stripe/Razorpay env vars never reach the production runtime | **STILL OPEN, confirmed live on `origin/main` today** — `amplify.yml`'s `env \| grep -e ...` allowlist (line 74) still has no `STRIPE_` / `RAZORPAY_` entry | `git show origin/main:amplify.yml` |
| P1-3 Investment Intelligence upload path has no gate and no malware scanning | **Still true, and now joined by a second, larger instance of the same underlying gap** — see next row | `app/api/investment-intelligence/source-documents/route.ts`, `lib/aie/adapters/investment-intelligence/dispatch.ts:51-62` |
| *(new, not in the 09-14 report)* Production document upload for the **entire FDH-3 surface** (bank CSV/PDF, payslip, liability/investment/retirement statements) | **Deliberately, explicitly enabled in production on 2026-09-20** by direct Product Owner instruction (commit `c4891185`, corroborated by the orchestrating session, not merely the commit's own prose) — `isFdhDocumentUploadEnabled()`'s hard project-ref allowlist now includes the real production Supabase project. **No malware scanning was added alongside it.** A repo-wide check confirms **no real malware/virus scanner exists anywhere in this codebase**, for either the FDH or the Investment Intelligence pipeline — the AIE pipeline's own code explicitly documents this: *"the S3 + GuardDuty swap remains blocked infrastructure and is named as such... rather than implied to be done"* (`lib/aie/adapters/investment-intelligence/dispatch.ts:59-62`) | `lib/financial-data-hub/constants/featureFlags.ts`, commit `c4891185` |

**Required Section 13.7 wording, updated for 2026-09-21 (supersedes both the 09-14 wording above and the framing this audit was originally briefed with):**

> **PRODUCTION DOCUMENT INGESTION — ENABLED BY EXPLICIT PRODUCT OWNER DECISION, WITH THE MALWARE-SCANNING PREREQUISITE KNOWINGLY INCOMPLETE.**
>
> This is neither "CERTIFIED AND ENABLED" (the malware-scanning prerequisite this spec's own §13.1 requires is not met, for any upload path in the system) nor "DELIBERATELY DISABLED" (production upload is, in fact, live for the FDH-3 surface as of 2026-09-20, and has been live and ungated for the Investment Intelligence surface since before the 09-14 audit). The Product Owner has been made aware of this exact tradeoff and accepted it explicitly and separately from this audit; this audit's job is to document the residual risk precisely, not to re-gate it. A follow-up decision (add real scanning soon, or formally accept the residual risk in writing) remains open and is being tracked outside this audit.

This changes the overall verdict from the 09-14 report's Verdict C in one respect and confirms it in another: two of that report's two P0s are now resolved (one fully, one with a disclosed residual gap), but the single largest production-readiness question in the whole programme — real malware scanning before untrusted financial documents reach a parser — is now live in production for *more* surfaces than it was a week ago, not fewer. See the addendum for the full, current verdict and the remainder of the 44-section re-audit still outstanding.

---

## 0. THE PRODUCT OWNER'S QUESTION (Section 46)

> Did FHIP actually implement ALL of the changes and corrections requested throughout the Live Recovery programme, or were some original requirements lost, narrowed, deferred, omitted, or left operationally incomplete?

# NO.

Requirements were lost, narrowed, and left operationally incomplete, and two defects introduced by the Live Recovery programme's own corrective hotfixes are **live in production right now**. The LR-12R "UNCONDITIONAL FULL PASS" does not survive independent re-testing.

The complete list of missing, partial, regressed or operationally incomplete requirements is below. Every item marked **live-proven** was reproduced today against the real DEV database, the real production database, or the real production application — not inferred from code reading.

### The two production defects that exist right now

**P0-1 — An SMSF property loan is subtracted from Net Worth twice.**
Live-proven against the real DEV database using the real engines (`scripts/audit-lr/oracle2_smsf_networth_double_subtraction.ts`). Ground truth for the tested household: one SMSF property worth $500,000 financed by a $365,000 limited-recourse loan, nothing else. Correct Net Worth = **$135,000**. FHIP reports **−$230,000**, in *both* Summary and Detailed mode — an error of exactly the full loan balance, **$365,000**. Production holds two `property_liability_links` rows of `link_type='smsf_property_loan'`. LR-5/LR-6 certified "no double liability subtraction"; that certification is wrong.

**P0-2 — Migration `0137` broke the SMSF Detailed Holdings workspace, and the change is live in production.**
Live-proven (`scripts/audit-lr/oracle5_smsf_0137_regression.ts`). `0137` rewrote `smsf_recompute_fund()` from migration `0084`'s body instead of the current `0090` body, dropping `0090`'s `set_config('fhip.smsf_balance_write','certified')` bracket around its write to `retirement_accounts.current_balance`. Once a fund is in Detailed mode, **adding, editing or removing any holding fails with Postgres `42501`** and a raw database error message. `0137`'s own header claims "No change to any function's logic/body." The single SMSF fund in production is in **detailed** mode with **3 holdings** — that user cannot maintain their own fund today.

### The rest of the answer, in one list

| # | What was requested | What is actually true today | Severity |
|---|---|---|---|
| P0-1 | SMSF liabilities never double-subtracted (LR-5/LR-6, §7.1) | Subtracted twice; Net Worth wrong by the full loan balance | **P0** |
| P0-2 | SMSF Detailed Holdings workspace usable (LR-5) | Add/edit/remove of any holding fails `42501` after migration `0137` | **P0** |
| P1-1 | Family Trust complete (LR-11B) | Migration `0136` **never applied to production**; the deployed UI offers "Family Trust" and the database rejects it | **P1** |
| P1-2 | AU/India payment operationalisation live (LR-10) | Both provider webhooks return **503 "not configured"** in production; `amplify.yml` never forwards `STRIPE_*`/`RAZORPAY_*`; zero webhook events, zero premium entitlements ever | **P1** |
| P1-3 | Production document ingestion fail-closed (§13.4) | The Investment Intelligence upload route has **no gate at all**; 3 real documents and 952 transactions already exist in production; no malware scanning; weaker validation than FDH; no retention or purge | **P1** |
| P1-4 | One household truth across modules (LR-FI-1/2) | The Financial Twin reports **DSR 30% where the Dashboard reports 10%** for the PO's own oracle, and omits entity value from Net Worth | **P1** |
| P1-5 | Premium report export gated server-side (LR-8) | A free user obtains the same server-rendered PDF by sending `format:"print"` | **P1** |
| P1-6 | Consolidated Forecasting Report PDF export (LR-8) | `proxy.ts`'s render-token waiver does not cover `/forecast/report/print`; the renderer PDFs the **login page** and returns HTTP 200 | **P1** |
| P1-7 | Expenses bank-statement workflow Upload→Analyse→Review→Accept→Apply (LR-3) | The user-facing journey dead-ends at `processing_status='queued'`. No worker exists. The UI says "your transactions are being extracted for review." All 10 CSV and 8 PDF bank adapters are unreachable from any UI. **LR-3's own oracle proved a different journey** — it called the `process` step directly over the API, which the panel never does | **P1** |
| P1-8 | Account closure completes (LR-9) | Live-proven: a bare `NO ACTION` foreign key permanently blocks `auth.admin.deleteUser()`. 15 such columns exist; they are staff columns, so **admin accounts are effectively undeletable** | **P1** |
| P1-9 | Storage purge on deletion (LR-9) | Two of the three purged buckets (`fdh-source-documents`, `report-exports`) **do not exist in production**; Supabase returns `200 []` for a missing bucket, so the purge reports clean success while doing nothing | **P1** |
| P2-1 | Deletion removes the user's financial data (LR-9, Privacy copy) | `ii_analytics_results` has **no foreign key** to `auth.users`; live-proven to survive deletion with a dangling `user_id` while the control row cascades | **P2** |
| P2-2 | Insurance register usable (LR-7) | `cover_type` is never collected by the grid, and unlike every sibling register it has no `master_item_key` fallback: a user who adds "Income Protection" with a 90-day waiting period is invisible to the engine — live-proven | **P2** |
| P2-3 | SMSF contributions never contaminate household forecasting (LR-FI-3) | The guard exists only in the retirement-forecast branch; the Dashboard's own contribution figures and the Net Worth forecast include SMSF-linked contributions — live-proven | **P2** |
| P2-4 | Net Worth reconciles with its own breakdown (LR-11) | With any business entity present the allocation sums short by exactly the entity value — live-proven ($100,000 vs $250,000) | **P2** |
| P2-5 | No double counting between legacy owner tags and the entity workspace (LR-11B) | `owner='company'`/`'family_trust'` is hidden in the UI only; every validator and the database still accept it, and those rows do enter personal DTI/DSR | **P2** |
| P2-6 | Privacy copy matches behaviour (LR-9) | It describes a document-upload and raw-file-retention policy that does not apply in production, and does not apply at all to the one upload path that *is* live | **P2** |
| P2-7..18 | Various (see §5) | Webhook idempotency collisions, unretryable failed events, a bypassable billing-country lock, no entitlement period-end reconciliation, an II-published-investment duplicate-row path, missing cache directives, a replayable render token, admin-queue discoverability, missing DB backstops on `business_entities`, no purge pagination, five unlabelled form controls on `/profile` | **P2** |

### What genuinely passed

Independent re-testing **confirmed** the following as correct:

- The PO's mandatory DSR oracle on the canonical path: income $10,000/mo, personal debt service $1,000/mo, SMSF-linked loan service $2,000/mo → **DSR = 10%**, DTI excludes the SMSF balance, surplus = $9,000. Both the `owner='smsf'` tag and the `property_liability_links` override work, combined with OR. (`oracle1`, 6/7 PASS.)
- The LR-FI-3 exactly-once forecast invariant across all eight required scenarios. (`oracle4`, 8/8.)
- Authenticated two-user cross-tenant isolation on every LR-created table, with a working positive control — reads, updates and deletes all isolated. (`oracle6`.)
- Business-entity liabilities are **structurally** excluded from personal DTI/DSR (separate tables, never loaded), which is the strongest available form.
- The account-deletion tombstone survives correctly: stable request UUID, `user_id` NULL, cascade removes owned rows.
- The LR-9 self-execution guard: an admin cannot execute their own deletion request.
- The LR-1 purge-sweep janitor endpoint is **live and authorised in production** — it returned a correct sweep result for a real authenticated cron call today.
- LR-2's two named regression fixes (the Investments `42P10` partial-index upsert and the blank-optional-field edit-after-reload) are both present and correctly scoped.
- No real payment secret appears anywhere in source, tests, scripts, migrations or docs.
- Pricing region isolation is correct: AU→Stripe only, India→Razorpay only, Global→`NO_PLAN_FOR_REGION` with no fabricated price.

---

## 1. VERDICT (Section 45)

# C. FAIL — ORIGINAL REQUIREMENTS NOT FULLY IMPLEMENTED / MATERIAL PRODUCTION DEFECTS FOUND

Verdict C is required by Section 45's own rule: it applies when there are unresolved P0/P1 defects or substantial unauthorized missing scope. This audit found **two unresolved P0 defects live in production** and **nine unresolved P1s**, several of which are unauthorized missing scope rather than disclosed deferments.

The prior LR-12R "UNCONDITIONAL FULL PASS — FROZEN" verdict is **downgraded**. It is not preserved.

This is not a judgement that the Live Recovery programme achieved little. It achieved a great deal, and much of it is genuinely correct and independently re-proven above. The failure is specific: **the programme's terminal certification did not distinguish "merged" from "deployed", "deployed" from "reachable", or "a script passed" from "a user can do this"**, and two of its own late corrective hotfixes introduced regressions that its certification method could not see.

### Required Section 13.7 wording

> **PRODUCTION DOCUMENT INGESTION — DELIBERATELY DISABLED; ENABLEMENT PREREQUISITES OUTSTANDING**

…with one mandatory qualification that changes its meaning: **the statement is false for the Investment Intelligence pipeline, which is not gated at all and is live in production today.** See §4 and `LR_PRODUCTION_UPLOAD_READINESS.md`.

---

## 2. AUTHORITATIVE STAGE REGISTER (Section 2)

Reconstructed from the migration ledger, git history, the committed phase reports, and the project memory record. Phase numbering was **not** trusted.

| Stage | Scope | Code on `origin/main`? | Migration | Applied DEV | Applied PROD | Independent verdict |
|---|---|---|---|---|---|---|
| LR-0 | Production truth / deployment lineage | n/a (audit) | — | — | — | Re-performed; see §3 |
| LR-FI-1 | SMSF household financial isolation | Yes | — | — | — | **PASS** on the canonical path; **FAIL** on the Financial Twin (P1-4) |
| LR-FI-2 | Loan principal/interest/fees, debt ratios | Yes | — | — | — | **PASS** (symmetric filters live-proven) |
| LR-FI-3 | Exactly-once contribution/forecast integrity | Yes | — | — | — | **PASS** (8/8); SMSF contribution leak is P2-3 |
| LR-1 | Upload security / raw-file deletion | Yes | `0135` | Yes | Yes (janitor live-proven today) | **PASS for FDH**; **FAIL of scope** — the II pipeline has no purge at all |
| LR-2 | Unified manual input UX | Yes | — | — | — | **PASS** (form-first on all 8; both named fixes intact) |
| LR-3 | Expenses bank-statement workflow | Yes | `0131` | Yes | Yes | **FAIL** — no user-reachable journey (P1-7) |
| LR-4 | Income/Liability/Investment/Retirement import recovery | Yes | `0091`/`0096`/`0112` | Yes | Yes | **PARTIAL** — see the Import Support Matrix |
| LR-5 | SMSF entity workspace foundation | Yes | `0084`/`0089`/`0090` | Yes | Yes | **FAIL** — P0-1, P0-2 |
| LR-6 | SMSF P&L / reconciliation / forecast / export | Yes | — | — | — | **PARTIAL** — see §6 |
| LR-7 | Insurance + Goal lifecycle | Yes | — | — | — | **PARTIAL** — P2-2 |
| LR-8 | Reports Hub / navigation consolidation | Yes | — | — | — | **FAIL** — P1-5, P1-6, P1-9 |
| LR-9 | Privacy / Terms / Disclaimer / Accessibility / Account closure | Yes | `0132` | Yes | Yes | **PARTIAL** — P1-8, P1-9, P2-1, P2-6 |
| LR-10 | AU / India / Global payment operationalisation | Yes | `0133` | Yes | Yes | **FAIL in production** — P1-2 |
| LR-11 | Company entity architecture | Yes | `0134` | Yes | Yes | **PARTIAL** — P2-4, P2-5 |
| LR-11B | Family Trust completion | Yes | `0136` | Yes | **NO** | **FAIL in production** — P1-1 |
| LR-12 | Full production journey / release certification | Docs only | — | — | — | Superseded |
| LR-12R | Final closure / production re-certification | Docs only | `0137` | Yes | Yes | **Verdict downgraded**; `0137` introduced P0-2 |

### Documentation-lineage inconsistency (Section 2's explicit instruction)

Migration `supabase/migrations/0136_lr13_family_trust_entity_type.sql` is named **`lr13`** for work the Product Owner explicitly renamed **LR-11B** and explicitly ruled must not be a new numbered phase. The commit that introduced it (`cd7b201`) is titled `feat(lr13): Family Trust entity type`. This is recorded as a **documentation-lineage inconsistency**, not a new product phase — exactly as Section 2 directs.

### A methodological correction worth recording

Section 29 requires `git merge-base --is-ancestor` rather than lexical comparison. Applying it to the 18 named LR commits found three reported **NOT-ON-MAIN**: `cd7b201` (LR-11B Family Trust), `5447fac` and `ab94d1f` (the two LR-9 storage fixes). **All three are false negatives.** Their *content* is present on `origin/main` — migration `0136` exists, the family-trust validator and UI exist, and `accountDeletionStorage.ts` carries both the corrected folder discriminator and the abort invariant. The commits were rebased or squashed on the way in, so the SHAs differ. **Ancestry by SHA is not a sufficient test of "is this on main"; content must be checked.** Any future certification that relies on SHA ancestry alone will produce this same false alarm.

---

## 3. LR-0 RE-CHECK — PRODUCTION TRUTH, THEN vs NOW (Section 8)

Built today from live introspection of both databases, the live production app, and `origin/main`.

| Surface | Code on main | Prod DB | Prod storage | Deployed | Reachable | Works for a real user |
|---|---|---|---|---|---|---|
| Manual registers (8) | Yes | Yes | n/a | Yes | Yes | **Yes** |
| Dashboard / scores / DNA / resilience | Yes | Yes | n/a | Yes | Yes | **Yes** |
| Financial Twin | Yes | Yes | n/a | Yes | Yes | **Wrong numbers** (P1-4) |
| Forecasting | Yes | Yes | n/a | Yes | Yes | Yes, except the PDF export (P1-6) |
| Reports (in-app) | Yes | Yes | n/a | Yes | Yes | Yes |
| Report PDF export | Yes | Yes | **Bucket absent** | Yes | Yes | **No** — and a free user can trigger it (P1-5, P1-9) |
| Expenses bank import | Yes | Yes | **Bucket absent** | Yes | Yes | **No** — gate off, and no worker even in DEV (P1-7) |
| Payslip / liability / investment / retirement import | Yes | Yes | **Bucket absent** | Yes | Yes | **No** — gate off (disclosed) |
| Investment Intelligence import (India CAS) | Yes | Yes | Bucket present | Yes | Yes | **Yes — ungated** (P1-3) |
| SMSF workspace | Yes | Yes | n/a | Yes | Yes | **Broken in Detailed mode** (P0-2); Net Worth wrong (P0-1) |
| Company entity | Yes | Yes | n/a | Yes | Yes | Yes |
| Family Trust | Yes | **Constraint missing** | n/a | Yes | Yes | **No** (P1-1) |
| Goals | Yes | Yes | n/a | Yes | Yes | Yes |
| Payments (Stripe/Razorpay) | Yes | Yes | n/a | Yes | Yes | **No** — 503 not configured (P1-2) |
| Account closure (user request) | Yes | Yes | n/a | Yes | Yes | Yes (0 requests ever made) |
| Account closure (admin execute) | Yes | Yes | n/a | Yes | **URL only** | Untested in production; blockers exist (P1-8, P1-9) |
| Privacy / Terms / Disclaimer / Accessibility | Yes | n/a | n/a | Yes | Footer on `/` only | Yes, with copy defects (P2-6) |
| LR-1 purge janitor | Yes | Yes | n/a | Yes | n/a | **Yes — proven live today** |

### Production usage reality (read-only, service role, today)

| Table | Production rows |
|---|---|
| `user_profiles` | 7 |
| `reports` | 1 |
| `report_exports` | **0** |
| `account_deletion_requests` | **0** |
| `user_entitlements` | 7 (all `free`, all `provider: null`) |
| `payment_webhook_events` | **0** |
| `business_entities` | **0** |
| `smsf_funds` | 1 (**detailed** mode, 3 holdings) |
| `fdh_statement_uploads` | **0** |
| `aie_document_intake` | **0** |
| `ii_source_documents` | **3** |
| `ii_transactions` | **952** |

Read plainly: **the only Live Recovery capability a production user has actually exercised is the ungated Investment Intelligence document pipeline.** Every other LR-built capability has zero production usage, and several of them could not have succeeded if attempted.

### Production storage (definitive, per-bucket)

| Bucket | DEV | PROD |
|---|---|---|
| `investment-source-documents` | present | **present** |
| `fdh-source-documents` | present | **ABSENT** (`NoSuchBucket`) |
| `report-exports` | present | **ABSENT** (`NoSuchBucket`) |
| `aie-document-quarantine` | present | **ABSENT** |

---

## 4. THE PRODUCTION DOCUMENT-INGESTION CONTROLS, SEPARATED (Section 13.5)

| Control | Status |
|---|---|
| Secure transient architecture (FDH) | **PASS** |
| Strict raw-file deletion (FDH) | **PASS** |
| Autonomous janitor | **PASS** — endpoint live-proven in production today; pg_cron invocation remains operator-verified |
| Cross-tenant storage security | **PASS** |
| Malware scanning | **NOT READY — none exists anywhere in the codebase** |
| Production document DB/storage infrastructure | **NOT READY** — `fdh-source-documents` bucket absent; `aie_document_intake` purge columns absent |
| Production load / performance certification | **NOT READY — never attempted** |
| Production upload gate (FDH surfaces) | **PASS — correctly OFF** |
| Production upload gate (Investment Intelligence surface) | **FAIL — no gate exists** |
| User can upload documents in production | **YES, via one ungated path** — and that path has no malware scan, no magic-byte validation, and no retention policy |

The `isFdhDocumentUploadEnabled()` gate itself is well built and genuinely fail-closed (an allowlist on the certified DEV Supabase project ref, with no env override). It is **not** a defect. The defect is that one upload surface never asks it.

Two accepted-risk registers in this repository rate the missing malware scanner as "P2 (bounded — production uploads structurally disabled regardless)". **That bounding premise is false**, and the risk acceptance rests on it.

---

## 5. FULL DEFECT REGISTER

See `LR_MISSING_REQUIREMENTS_REGISTER.md` for the complete P0/P1/P2/P3 register with evidence references, and `LR_PRODUCTION_TRACEABILITY_MATRIX.md` for the per-requirement register Section 4 requires.

---

## 6. WHAT THIS AUDIT COULD NOT VERIFY (Section 5, class 17)

Stated plainly rather than assumed away.

| Item | Why | What would close it |
|---|---|---|
| Amplify deployment identity (which commit is deployed) | No Amplify API access. The production build was proven **fresh today** (a server-rendered page emits `new Date()` and returned 2026-09-14) and behaviourally consistent with current `origin/main` on every path tested | Amplify deployment history, or a build-stamp endpoint |
| `pg_cron` job registration and schedule in production | `cron.*` is not exposed through PostgREST | One SQL query as the database owner |
| Production authenticated user journeys | **Deliberately not performed.** Creating a synthetic production user could not be cleanly reversed: production account deletion has never been exercised, two of its three purge buckets do not exist, and P1-8 shows deletion can block outright. Running it would risk permanent residue in a live database — precisely what Section 39 forbids | PO authorisation for one bounded synthetic production user, ideally *after* P1-8/P1-9 are fixed |
| Live Stripe/Razorpay round trip | Impossible: the deployed app has no provider credentials at runtime (P1-2) | Fix `amplify.yml`, then re-run |
| Three route handlers under local `next dev` | `/api/reports/[id]/exports`, `/api/forecast/report/export` and `/api/financial-data-hub/documents/upload-sessions` returned the Turbopack 404 page locally (a dev-server module-resolution artifact on this slow filesystem; the same routes answer correctly in production). Their defects were therefore established from source plus live proxy-layer behaviour, not from a local end-to-end run | A working local build, or a DEV deployment with a public URL |
| Formal accessibility conformance | No axe/pa11y/Lighthouse/screen-reader tooling exists in the repository. One hand-rolled Playwright tab/overflow smoke covers 5 FDH screens. **No screen-reader evidence exists** | Real assistive-technology testing |
| Production load/performance of the upload pipeline | Never attempted, by anyone | A non-production load certification per §13.3 |

---

## 7. REMEDIATION POSTURE (Sections 35–37)

**No source code, migration, or production configuration was changed by this audit.** The only files added are the audit's own evidence scripts under `scripts/audit-lr/` and these reports.

That is a deliberate decision, not an omission. Section 36 requires a STOP for canonical financial semantics, security posture, and enabling production capability — and **every P0/P1 found here trips one of those**:

- P0-1 has two defensible fixes with opposite semantics (exclude SMSF-linked liabilities from Net Worth's `totalLiabilities`, or make fund valuation gross). Choosing is a PO decision.
- P0-2, P1-1 require applying/repairing migrations in production.
- P1-2 requires a production deployment-configuration change.
- P1-3 requires deciding whether to gate a pipeline real users are already using.
- P1-5 requires deciding what `format:'print'` should mean.
- P1-6, P1-8, P1-9 are one-to-three-line fixes but are security- or deletion-critical, and Section 37 requires deployment verification that this mission is explicitly not authorised to perform.

Exact minimal remediations, with the specific lines to change, are given per finding in `LR_MISSING_REQUIREMENTS_REGISTER.md`.

### Recommended order

1. **P0-2** — restore `0090`'s `set_config` bracket in `smsf_recompute_fund()` as a new migration. Smallest fix, unblocks a live user.
2. **P1-1** — apply migration `0136` to production. One statement.
3. **P0-1** — PO ruling on Net Worth semantics, then fix and re-run `oracle2`.
4. **P1-3** — gate or deliberately accept the Investment Intelligence upload path; either way, correct the two residual-risk registers whose premise is false.
5. **P1-2** — add `STRIPE_`/`RAZORPAY_` to `amplify.yml`'s forwarding list, redeploy, re-run the live probe.
6. **P1-9** — create the two missing production buckets (or remove the code that assumes them).
7. **P1-4, P1-5, P1-6, P1-7, P1-8** — each is independently scoped.

---

## 8. THE STANDARD, RESTATED

> MERGE ≠ DEPLOYMENT ≠ REACHABILITY ≠ FINANCIAL CORRECTNESS ≠ SECURITY READINESS ≠ OPERATIONAL READINESS ≠ PRODUCTION CERTIFICATION.

Every finding above sits in one of those gaps. The Live Recovery programme closed the first two links of that chain well and assumed the rest.

**Companion reports**

1. `LR_FULL_REQUIREMENTS_RECONCILIATION.md`
2. `LR_MISSING_REQUIREMENTS_REGISTER.md`
3. `LR_DEFERRED_SCOPE_RECONCILIATION.md`
4. `LR_PRODUCTION_TRACEABILITY_MATRIX.md`
5. `LR_FINANCIAL_ORACLE_CERTIFICATION.md`
6. `LR_SECURITY_AND_TENANT_ISOLATION_CERTIFICATION.md`
7. `LR_IMPORT_SUPPORT_MATRIX.md`
8. `LR_ENTITY_CAPABILITY_MATRIX.md`
9. `LR_PRODUCTION_UPLOAD_READINESS.md`
10. `LR_FINAL_INDEPENDENT_AUDIT_REPORT.md` (this document)

Plus one supplementary record: `LR_CONSOLIDATED_ACCESSIBILITY_MOBILE_SWEEP_2026_09_14_AUDIT.md` (Section 33 re-check).

**Evidence scripts** (all re-runnable) are under `scripts/audit-lr/`.

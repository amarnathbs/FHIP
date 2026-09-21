# FHIP — Live Recovery Independent Completeness Audit
## 2026-09-21 Reconciliation Addendum (checkpoint, not a terminal closure)

**Branch:** `audit/lr-independent-completeness-2026-09-21` (worktree `D:\FHIP\.claude\worktrees\audit-lr-2026-09-21`, branched from `origin/main`)
**`origin/main` at start of this pass:** `a193583` (`git rev-parse origin/main` == `git rev-parse HEAD` before branching — worktree was current)
**Governing spec:** `C:\Users\user\Downloads\FHIP_Live_Recovery_Independent_Completeness_Audit_Consolidated_Claude_Prompt.md` (§1–§48), read in full before acting
**Relationship to the 2026-09-14 audit:** that audit (`audit/lr-independent-completeness-2026-09-14`, HEAD `54018a9`) executed the same spec seven days earlier, reached Verdict C (FAIL), produced all ten mandated reports, and **was never merged to `main` or, apparently, delivered** — it sat as an orphaned local branch. This addendum treats its ten reports as Tier 4 evidence (leads, not proof) and independently re-checks their claims against `origin/main` as of 2026-09-21, then extends the audit to what has changed in the intervening week.

---

## 0. Section 46 — the Product Owner's question, answered now

> Did FHIP actually implement ALL of the changes and corrections requested throughout the Live Recovery programme, or were some original requirements lost, narrowed, deferred, omitted, or left operationally incomplete?

# NO — with a specific, current list, not a percentage.

The 2026-09-14 audit already answered NO once, with two live P0s and nine P1s. This pass independently re-verified (via `git merge-base --is-ancestor`, `git show`, and direct inspection of current source — not by trusting that report's own prose) that **some of those items are now genuinely fixed**, but the single most consequential control in the entire programme — real malware/virus scanning ahead of any document-ingestion path — is **still completely absent from the codebase**, and the surface it protects has **grown**, not shrunk, in the intervening week, via an explicit, disclosed Product Owner decision rather than an oversight.

### Confirmed FIXED since 2026-09-14 (independently re-verified against current `origin/main`, not merely re-read from the old report)

| Item | Status | Evidence |
|---|---|---|
| P0-1 (09-14): SMSF property loan subtracted from Net Worth twice | **Fixed for the reported scenario**, with a known, PO-disclosed residual architecture gap (see below) | `ea95507` (2026-09-14) → `368d98f` (2026-09-17), both ancestors of `origin/main` |
| P0-2 (09-14): migration `0137` broke SMSF Detailed Holdings (`42501` on any edit) | **Fixed** | `supabase/migrations/0148_lr_p0_2_restore_smsf_balance_write_guard_bracket.sql`, ancestor of `origin/main` |

**The residual gap in P0-1's fix, in the fixing engineer's own words** (commit `368d98f`, verbatim, because Section 48 requires exactly this kind of disclosure to be preserved, not softened): the general double-subtraction is fixed and 96/96 (97 with a new regression test) target tests pass, but *"correctly scoping that exclusion needs either that correlation [which specific loan is already netted inside a specific fund's own valuation] or a gross (not netted) SMSF fund valuation. **Flagged back to the PO as an open item** rather than silently re-broken or silently left broken."* This is a live, open, disclosed architectural decision still awaiting a PO ruling — recorded here as **DEFERRED — EXPLICIT PO AUTHORIZATION EXISTS (for the deferral itself, not yet for a chosen fix)**, not as CANNOT VERIFY or NEVER IMPLEMENTED.

### Confirmed STILL OPEN, unchanged since 2026-09-14 (re-verified live against current `origin/main`, not assumed)

| Item | Status | Evidence |
|---|---|---|
| P1-2 (09-14): Stripe/Razorpay env vars never reach the production Next.js runtime, so both payment providers 503 in production and Premium can never be granted | **Still broken today.** `amplify.yml`'s allowlist line (`env \| grep -e SUPABASE_SERVICE_ROLE_KEY -e CRON_SECRET -e APP_BASE_URL -e RESEND_API_KEY -e CONTACT_FROM_EMAIL -e G4_APP_CAPABILITY_LAYER_ENABLED -e G5B_GENERIC_WRITE_ENABLED -e G2_LANDING_LOCALISATION_ENABLED -e G2_ALLOW_TEST_DETECTION_HEADER -e ROLLOUT_ -e AIE_`) has no `STRIPE_` or `RAZORPAY_` term, seven weeks after G6-G8's own similar amplify.yml env-forwarding defect was found and fixed for a *different* set of variables | `git show origin/main:amplify.yml` (line ~74), read directly in this pass |
| P1-3 (09-14): Investment Intelligence upload path has no production gate at all and no malware scanning | **Still true, unchanged.** `app/api/investment-intelligence/source-documents/route.ts`'s only precondition remains `requireCountryConfirmedUser()` | Direct inspection this pass |

### NEW since 2026-09-14 — not in the prior audit, discovered in this pass

**Production document upload for the entire FDH-3 surface (bank CSV/PDF, payslip, liability statement, investment statement, retirement statement) was deliberately enabled in production on 2026-09-20**, one day before this audit was dispatched — commit `c4891185`, `feat(fdh): lift the production upload hold`. This is confirmed as an explicit, direct Product Owner instruction (corroborated by the orchestrating session's own record of the instruction, not merely the commit message's self-description) — **not an unauthorized regression**, and this audit does not recommend reverting it.

What this audit independently confirmed about the *state* that decision was made into:

- `lib/financial-data-hub/constants/featureFlags.ts`'s `isFdhDocumentUploadEnabled()` hard-gate (a project-ref allowlist an env var cannot override) now lists the real production Supabase project ref alongside DEV. The gate mechanism itself is still well-built and still correctly un-overridable by environment variables — that part is not a defect.
- **No malware or virus scanning was added anywhere in the FDH-3 code path** as part of, before, or after this change. All ten FDH-3 upload/process routes were checked directly; none references `scan`, `malware`, or `guardduty`.
- **No real malware/virus scanner exists anywhere else in the codebase either.** The Investment Intelligence/AIE pipeline — the one surface that might plausibly have supplied one — explicitly documents in its own source that it does not: `lib/aie/adapters/investment-intelligence/dispatch.ts:51-62` states outright that *"this application has no S3 code path and no GuardDuty wiring... the 'scan' is `validateUploadForAdmission`'s real structural and signature checks, which fail CLOSED. That is a genuine admission gate, and it is not a malware scanner. The S3 + GuardDuty swap remains blocked infrastructure and is named as such... rather than implied to be done."* This is the codebase's own honest self-disclosure, independently located and re-confirmed in this pass, not an inference.
- No document anywhere in the repository records the 2026-09-20 decision independently of the one commit message — there is no dated PO-decision memo, no updated risk-acceptance register entry, and no new test exercising the newly-added production allowlist row.

**Required Section 13.7 wording for 2026-09-21** (this supersedes both the 09-14 report's wording and the "production upload is deliberately disabled" framing this audit was originally briefed with, which is now out of date by one day):

> **PRODUCTION DOCUMENT INGESTION — ENABLED BY EXPLICIT PRODUCT OWNER DECISION, WITH THE MALWARE-SCANNING PREREQUISITE KNOWINGLY INCOMPLETE.**

Per the coordinator's own instruction on this point: this is not classified as a defect to be silently fixed or reverted by this audit, and it is not re-gated. It is recorded, precisely, as a live operational risk with an outstanding follow-up decision (add real scanning soon, or formally accept the residual risk in writing) that is being raised with the Product Owner separately from this audit.

---

## 1. Updated authoritative stage register (Section 2)

Carried forward from the 09-14 register (reproduced in `LR_FINAL_INDEPENDENT_AUDIT_REPORT.md` §2) with only the cells that changed this week:

| Stage | 09-14 verdict | 09-21 delta |
|---|---|---|
| LR-5 SMSF workspace | FAIL — P0-1, P0-2 | **P0-2 fixed (0148). P0-1 fixed for the reported case; one architecture question explicitly still open per PO.** |
| LR-10 Payments | FAIL in production — P1-2 | **Unchanged — still FAIL in production.** |
| LR-1 / Production upload gate | PASS for FDH (correctly OFF); FAIL of scope (II ungated) | **FDH gate now intentionally ON in production by PO decision; II still ungated and unchanged. Malware-scanning prerequisite confirmed absent system-wide, not only for FDH.** |
| LR-11 / LR-11B | PARTIAL — P2-4, P2-5; P1-1 (migration `0136` not in prod) | **Not independently re-checked this pass — production DB state requires a live probe not performed here (see §3, Cannot Verify). Code-level presence on `origin/main` unchanged.** |
| All other stages (LR-0, LR-FI-1/2/3, LR-2, LR-3, LR-4, LR-6, LR-7, LR-8, LR-9, LR-12/12R) | see 09-14 register | **Not independently re-run this pass.** Their 09-14 evidence (live-DEV/production probes, oracle scripts under `scripts/audit-lr/`) is Tier 4 and was not re-executed here; treat as "presumed still representative, pending re-confirmation" rather than as newly re-proven. Several relevant subsequent commits exist (e.g. `f0eab90`/`73f1229` "admin cannot execute an account-deletion request for their own account", `9e4d46e`/`f2af007` "resolve legacy Company/Trust owner-tag double-entry risk") that were not individually traced to specific 09-14 findings in this pass. |

---

## 2. What this checkpoint did and did not do

**Done, with real independent evidence (not inference from prior reports):**
- Full read of the 788-line governing spec before acting.
- §1/§29/§30 git and worktree reconciliation, including discovering that this exact audit had already been run once (2026-09-14) and never merged — a fact the dispatching brief did not know.
- `git merge-base --is-ancestor` (never lexical SHA comparison) used throughout.
- Independent confirmation of 2 fixed P0s, 1 still-open P1 (payments), 1 still-open P1 (II gating), and 1 major new fact (FDH production upload deliberately opened, no scanning added) — all via direct commit/diff/source inspection, not by re-reading the 09-14 report's conclusions.
- Correct handling of a mid-task environment hazard: this session's working directory was reassigned mid-task to a **different, unrelated in-progress worktree** (`feature/nav1-selective-history-2026-09-21`, with real uncommitted changes belonging to that workstream). No files in that worktree were modified; a dedicated worktree (`D:\FHIP\.claude\worktrees\audit-lr-2026-09-21`) was created for this branch instead, per the standing instruction not to touch other concurrent workstreams.

**Not done in this pass — genuine outstanding work, not silently marked complete:**
- Live re-execution of the 09-14 audit's own oracle scripts (`scripts/audit-lr/oracle1`–`oracle8`) against current DEV/production — this worktree does not carry `.env.local` (untracked, not copied by `git worktree add`), and copying real production/DEV credentials into this session was judged an unnecessary handling risk for a checkpoint pass rather than attempted casually.
- A live, read-only check of whether the `fdh-source-documents` production bucket now exists (directly relevant to whether the newly-opened FDH-3 gate can even complete a storage write today).
- A live check of whether migration `0136` (Family Trust) has since been applied to production (P1-1, 09-14).
- Re-running the §7 financial-invariant oracles (DTI/DSR, exactly-once forecast, loan economics) fresh — the 09-14 report's own oracle results are carried forward as Tier 4 evidence only.
- §31 security/RLS live cross-tenant re-testing, §33 accessibility/mobile re-check, §34 performance/failure-mode testing, and the full §28 migration-by-migration reconciliation for every migration between `0131` and the current `0164` (twenty-seven migrations landed since the 09-14 baseline, driven mostly by the AIE and Investment-Intelligence PC5/PC6/PC7 programmes, none of which were individually reconciled against LR requirements in this pass).
- Updates to `LR_FULL_REQUIREMENTS_RECONCILIATION.md`, `LR_DEFERRED_SCOPE_RECONCILIATION.md`, `LR_PRODUCTION_TRACEABILITY_MATRIX.md`, `LR_FINANCIAL_ORACLE_CERTIFICATION.md`, `LR_SECURITY_AND_TENANT_ISOLATION_CERTIFICATION.md`, `LR_IMPORT_SUPPORT_MATRIX.md`, and `LR_ENTITY_CAPABILITY_MATRIX.md` beyond copying the 09-14 versions forward unchanged — they still describe the 09-14 baseline and have not yet been re-verified against 09-21 `main`.

---

## 3. Cannot-Verify register (Section 5, class 17) added this pass

| Item | Why | What would close it |
|---|---|---|
| Whether the `fdh-source-documents` production bucket exists today | No credentials loaded into this audit worktree | One read-only Supabase Storage list call with production credentials |
| Whether migration `0136` is applied to production | Same | One read-only schema probe |
| Whether the 2026-09-20 FDH production-upload decision is recorded anywhere durable besides the commit message and this audit | Not found in `docs/` by search | A short PO-decision memo added to `docs/live-recovery/` or an equivalent risk register |
| Whether P0-1's remaining architectural question (fund-level netting correlation) has since received a PO ruling | Not found in git history after `368d98f` | Search recent commits/docs, or ask directly |
| The 27 migrations `0138`–`0164` and their relationship to any LR requirement | Out of scope for this checkpoint's time budget | A dedicated §28 migration reconciliation pass |

---

## 4. Verdict for this checkpoint (Section 45)

Consistent with the 09-14 audit and not softened by it: **Verdict C — FAIL — ORIGINAL REQUIREMENTS NOT FULLY IMPLEMENTED / MATERIAL PRODUCTION DEFECTS FOUND** remains the operative verdict pending the outstanding work in §2 above. One P0 (`0137`'s SMSF regression) is now closed. The payments P1 is unchanged. The malware-scanning gap — the item Section 13 treats as the single most important control in the entire document-ingestion story — is not merely unresolved; the population of production surfaces exposed to it has grown this week by explicit, disclosed PO decision. This is recorded exactly as Section 48 requires: neither dressed up as "by design and therefore fine" nor treated as a reason to reopen or revert a decision that was already made knowingly by the Product Owner.

This is a **checkpoint**, not the terminal closure the spec's ~44 remaining sections still call for. The next continuation should prioritize, in order: (1) a live, credentialed probe of the two DB/storage facts in §3 above, since they determine whether the newly-opened FDH gate is even functional; (2) a PO ruling request on P0-1's remaining netting-correlation question; (3) re-running the 09-14 oracle scripts fresh rather than carrying their results forward as Tier 4; (4) the migration-by-migration reconciliation of `0138`–`0164`; (5) the remaining seven companion reports' full re-verification against 09-21 `main`.

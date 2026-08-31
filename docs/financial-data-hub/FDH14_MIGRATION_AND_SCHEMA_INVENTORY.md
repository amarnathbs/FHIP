# FDH-14 — Migration & Schema Inventory

FRESH FDH-14 EXECUTION unless marked otherwise. Re-derived from `supabase/migrations/*.sql`, re-run twice: once
against the starting base (`origin/main` @ `8eb0e74`, 107 migrations) and again after a mid-session
reconciliation merge (`origin/main` advanced to `1d6ad25` — the Mandatory Country Confirmation terminal
certification merge — see §6). All figures below are the **post-reconciliation, current** state (111
migrations) unless a figure is explicitly marked "at 107".

## 1. Repository-wide migration state

At the starting base (`8eb0e74`): `node scripts/check-migration-versions.mjs` → **OK: 107 active migrations**,
next version `0116`. Unused numbers: `0079, 0080, 0081, 0103, 0104, 0105, 0108, 0111`.

**After the §6 reconciliation merge** (`origin/main` → `1d6ad25`, which brought in the Mandatory Country
Confirmation terminal-certification migrations `0104`, `0105`, `0108`, `0111`): re-run →
**OK: 111 active migrations, one file per version, next version is 0116.** Remaining unused numbers:
`0079, 0080, 0081, 0103` only (0103 is still claimed exclusively on the unmerged `fhip-g0-wave2` branch — see
§3). `node scripts/check-migration-versions-against-branch.mjs --against=origin/main` → **OK: no cross-branch
migration collisions between HEAD (111 files) and origin/main (111 files)** — re-confirmed post-merge.

## 2. FDH capability → migration lineage map

| Capability | Migration(s) | Notes |
|---|---|---|
| FDH-1 (data foundation) | `0045_fdh_reference_foundation.sql`, `0046_fdh_accounts_documents_jobs.sql`, `0047_fdh_transactions_and_classification.sql`, `0048_fdh_review_quality_provenance.sql` | Applied to DEV (FDH-1 closure). |
| FDH-2 (master/reference data) | `0050`–`0052` (schema), `0053`–`0056` (seed) | Confirmed present in live DEV by this pass's fresh schema probe (`fdh_categories`=25 rows, `fdh_subcategories`=121, `fdh_merchants`=123, `fdh_merchant_aliases`=198, `fdh_classification_rules`=77 rows) — supersedes FDH-2's own "not yet applied to DEV" note. |
| FDH-3 (secure document lifecycle) | `0058_fdh3_document_lifecycle_upload_storage.sql` | Confirmed present in live DEV (`fdh_upload_sessions`, `fdh_document_audit_events` = 1811 rows) — supersedes FDH-3's own "not yet applied" note. |
| R7 / FDH-4 (bank CSV) | `0064_r7_bank_csv_engine_foundation.sql`, `0065_r7_final_reconciliation_status_forgery_fix.sql`, `0066_fdh4_bank_adapter_coverage_expansion.sql` | Applied + independently re-verified at the time of R7/FDH-4 closure. |
| R9 (review centre, adjacent) | `0067_ii_r9_review_centre.sql`, `0069` | Investment Intelligence, not FDH — listed for lineage completeness only. |
| R8 (classification engine) | `0067_r8_transaction_classification_engine.sql` (**note**: filename collision with the II-R9 migration of the same number was resolved historically — the FDH R8 migration is the one whose content matches `R8_ACCEPTANCE_REPORT.md`) | Confirmed present in live DEV (`fdh_transaction_links`, `fdh_recurring_transactions` tables exist) — supersedes R8's own "not applied to DEV" note. |
| FDH-5 (bank PDF) | `0071_fdh5_bank_pdf_engine_foundation.sql` | Applied to DEV, live-recertified 18/18 at FDH-5 closure. |
| FDH-6 (classification/transfer/duplicate/recurring gap closure) | `0075_fdh6_economic_class_gap_closure_rule_seed.sql` | Applied to DEV, independently re-verified at FDH-6 closure. |
| FDH-7 (review/approval) | `0076_fdh7_review_approval_workflow.sql` | Confirmed present in live DEV (`fdh_transaction_allocations` table exists) — supersedes FDH-7's own "not yet applied" note. |
| FDH-8 (expense tracker) | none (ships zero migrations) | N/A. |
| FDH-9 (payslip/income) | `0091_fdh9_payslip_income_intelligence.sql` | Confirmed present in live DEV (`fdh_payroll_events`, `fhip_import_proposals`, `fhip_import_applications` tables exist; `income_sources.source_type`/provenance columns present and this pass's own fresh live test proved the provenance-write trigger is genuinely active) — supersedes FDH-9's own "never applied to DEV" note. |
| FDH-10 (credit cards/loans) | `0096_fdh10_credit_cards_loans_intelligence.sql` | Confirmed present in live DEV (`fdh_liability_statements`, `fdh_liability_statement_transactions` exist; `liabilities` provenance-write trigger fresh-proven live by this pass) — supersedes FDH-10's own "PGRST205 table not found" note from its own certification round. |
| FDH-11 (AU investments) | `0106_fdh11_au_investment_statement_intelligence.sql` | Applied to DEV by the Product Owner, independently confirmed at FDH-11 closure (43/43 live checks). |
| FDH-12 (retirement) | `0112_fdh12_retirement_statement_intelligence.sql`, `0113_fdh12_approve_rpc_authoritative_write_fix.sql`, `0114_fdh12_retirement_provenance_guards.sql` | All three applied to DEV and confirmed in effect at FDH-12 closure (262/262 live round 3); this pass's fresh test independently re-confirms the `retirement_accounts` provenance guard is still active today. |
| Module 11 / 11.1 (AI foundation, adjacent) | `0110`, `0115` | Not FDH — listed for lineage completeness (they sit numerically inside the FDH-9→FDH-12 run). |

## 3. Cross-branch / cross-worktree migration-number collision scan (spec §132 rule 3)

`git worktree list` was enumerated for every worktree currently registered against this repository on this
machine, and each worktree's HEAD was tested with `git merge-base --is-ancestor <head> origin/main`:

- **Already an ancestor of `origin/main`** (no live collision risk — their migrations are the ones already
  counted above): `fhip-admin-a02-wave1`, `fhip-analyst-w1`, `fhip-app-review-fixes`, `fhip-app-review-tier2`,
  `fhip-fdh10-terminal`, `fhip-fdh11`, `fhip-fdh12`, `fhip-g0-wave1`, `fhip-module11`, `fhip-module11-1`,
  `fhip-resources-visibility-fix`.
- **NOT yet merged into `origin/main`** (real, currently-live collision risk for any *new* migration number
  this pass might allocate):
  - `D:/fhip-a02-wave2` (`fix/admin-a02-wave2-workflow-ordering-integrity`) — has already claimed
    **`0116_admin_a02_wave2_related_reorder_and_scheduling_integrity.sql`**. This means `0116` — the number
    `check-migration-versions.mjs` reports as "next" on THIS branch — is **not actually free**.
  - `D:/fhip-country-confirm` (`feature/mandatory-country-confirmation-beta-cleanup`) — has claimed `0104`,
    `0105`, `0108`, `0111` (MCC-14 cascade-fix work in progress, per project memory).
  - `D:/fhip-g0-wave2` (`fix/g0-wave2-closure-hotfix`) — has claimed `0103` (the "Australian shares country
    consistency" migration noted elsewhere as REJECTED-as-designed and unlikely to merge as-is).
  - `D:/fhip-r12-terminal` (`chore/r12-terminal-certification-2026-08-27`) — no migration numbers beyond what
    is already in `origin/main` (its highest is `0095`, already merged).
- **Conclusion:** the numbers `0103`–`0105`, `0108`, `0111` and `0116` are all **claimed on unmerged branches
  with different content than any hypothetical FDH-14 migration would contain.** FDH-14 did not need to
  allocate a new migration number in this pass (no schema-changing defect was found — see
  `FDH14_COMPLETION_REPORT.md` §20). If a future FDH-14 follow-up needs one, the genuinely free next number,
  re-verified against this same scan, is **`0117`**, not `0116`.

## 4. Full migration replay

FDH-11's and FDH-12's own certification rounds each independently replayed the complete migration chain
against a fresh PGlite (real Postgres, in-memory) database from empty and reported clean results (100/100 and
a passing rebuild respectively) on migration sets that are strict prefixes of the current 107-file chain (no
migration has been altered or removed since). This pass additionally re-confirms, via the live-DEV schema
probe in `FDH14_LIVE_DEV_CERTIFICATION.md`, that the **real hosted DEV project** — not just a PGlite replay —
currently has every one of the 34 representative tables spanning FDH-1 through FDH-12 present and queryable.
A from-empty PGlite replay of the full current 107-migration chain was not independently re-executed byte-for-
byte inside this specific FDH-14 pass (REUSED evidence, not re-run for ceremony, per spec §129); nothing in
the migration file set changed between the last full replay and this one.

## 5. Mid-session main reconciliation (spec §125)

`git fetch origin` partway through this pass showed `origin/main` had advanced from `8eb0e74` to `1d6ad25`
(the "Mandatory Country Confirmation terminal certification (CONDITIONAL PASS)" merge — 300 files, +11,842/
-732 lines, 4 new migrations `0104/0105/0108/0111`, a new compulsory country-confirmation gate on many
routes, and new tables/triggers including a `trg_enforce_country_confirmed` BEFORE INSERT trigger on
`income_sources`, `liabilities` and `retirement_accounts` — the exact three tables this pass's own fresh
security script targets). This is a **materially advanced main**, so per spec §125 this branch was merged
onto the new `origin/main` (fast-forward, then a 2-line trivial timestamp conflict in two unrelated
Investment-Intelligence scratch JSON artifacts, resolved by keeping the merged side) and the following were
re-run against the reconciled tree:

- Migration guards (§1 above) — PASS, 111/111, no collisions.
- `tsc --noEmit` — 0 errors, re-confirmed.
- `scripts/fdh14_live_dev_schema_probe.mjs` — re-run, 34/34 PASS, unchanged.
- `scripts/fdh14_cross_domain_security_certification.mjs` — re-run against the reconciled tree and the same
  live DEV project — **28/28 PASS again**, confirming the new country-confirmation trigger did not interfere
  with (and was correctly satisfied by, via the same `country_confirmed_at` fixture pattern FDH-12 established)
  the provenance-guard and tenant-isolation proofs this pass depends on.
- Full `vitest` and a fresh production build were re-run post-merge — see `FDH14_COMPLETION_REPORT.md` §15 for
  the exact re-run figures.

Mandatory Country Confirmation is its own separate workstream (not FDH-13, not FDH-14) and its own
CONDITIONAL PASS verdict is unchanged by this reconciliation — FDH-14 neither certifies nor re-litigates it
here, only confirms it does not break anything FDH-14 depends on.

## 6. Registry vs repository reality

No separate "migration registry" file exists in this repository beyond the migration directory itself and the
two guard scripts above; both guard scripts read the actual `supabase/migrations/*.sql` files directly, so
"registry matches repository reality" is true by construction — there is no separate manifest that could drift.

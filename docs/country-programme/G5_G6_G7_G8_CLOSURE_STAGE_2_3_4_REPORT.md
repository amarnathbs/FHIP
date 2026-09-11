# G5/G6/G7/G8 Country Programme Closure — Stage 2, 3 & 4 Report

Covers Stage 2 (branch-lineage isolation), Stage 3 (independent revalidation
of all 17 G6/G7/G8 contracts), and Stage 4 (full certification of migrations
`0138`/`0139`), per the "FHIP Country Programme — Consolidated G5 Production
Closure and G6-G8 Completion" mission. Stage 0 and Stage 1 (G5 production
status) were already established before this pass and are not repeated here
beyond citing them where relevant.

**Scope discipline honoured throughout**: no DEV or production database
write, no feature-flag change, no merge to `main`, `feature/lr-1-upload-
security-lifecycle` untouched. All database verification below is against a
local, throwaway PGlite (real PostgreSQL 18/WASM) instance only.

---

## 0. A correction to one "already established" premise, found while verifying it

Stage 2 step 4 asks to confirm "main hasn't advanced past the fork point at
all" before checking whether any later `origin/main` commit already fixed a
G6/G7/G8 item. Checking this directly (not skipping it because it was
expected to be trivial):

```
git log --oneline 1cafce3..origin/main | wc -l   ->  11
```

**`origin/main` HAS advanced 11 commits past the merge-base `1cafce3`**, to
`9793949`. The "main has not advanced" premise as stated is factually
imprecise. What is still true, and is the substantive point the mission
cared about: **all 11 of those commits are Live-Recovery (LR) programme
commits** (`lr2`, `lr5-lr6`, `lr9` ×3, `lr11b`, `lr12r` ×2, `lr13`,
`live-recovery` docs) — the same LR fixes that also independently landed on
`feature/lr-1-upload-security-lifecycle` itself, applied to both branches
separately (matching this session's own memory note that a `main`-side
editorial fix for LR-13→LR-11B was applied on "both branches"). **None of
the 11 is a G6/G7/G8 item.** So the answer to the actual question Stage 2
step 4 asks — did `main` already independently fix any of the 17 G6/G7/G8
contracts — is confirmed **no**, but by direct verification of the 11
commits' content, not by the stated (and here corrected) premise that main
never moved.

This discrepancy mattered concretely for Stage 2's cherry-pick plan: two
files touched by the G6/G7/G8 commits (`components/grid/FinancialDataGrid.tsx`,
`lib/services/dashboardData.ts`) were ALSO touched by these 11 independent
`main`-side LR commits. Building the new branch off `origin/main` (rather
than off the merge-base `1cafce3`) was therefore the correct choice — it
already carries `main`'s own copy of those LR fixes, so the G6/G7/G8
cherry-picks land on top of the exact same LR-fixed baseline they were
originally written against on the old branch. This is confirmed empirically
in section 1 below (zero cherry-pick conflicts).

---

## 1. Stage 2 — Branch-lineage isolation

### 1.1 Baseline re-confirmation

| Check | Result |
|---|---|
| `origin/feature/lr-1-upload-security-lifecycle` HEAD | `cd86823` — matches dispatch-time baseline exactly |
| `origin/main` HEAD | `9793949` |
| merge-base(`origin/main`, feature branch) | `1cafce3` — matches baseline exactly |
| Commits unique to feature branch (`1cafce3..cd86823`) | **44** |

### 1.2 Classification of all 44 unique commits

Read every commit's actual `git show --stat` diff (not just its message).

| Class | Count | Commits |
|---|---|---|
| LR-programme (fix/feat/docs/test(lr...) or touches `docs/live-recovery/`) | 17 | `cd7b201`, `8447b7e`†, `02ef154`, `5447fac`, `f2af007`, `ab94d1f`, `bb11550`, `19e4db8`, `78c139d`, `9b6a0bd`, `0473b9e`, `29489a6`, `838c542`, `73f1229`, `c8ddc60`, `8184f9d`, `0857ec8` |
| G6 docs (discovery/ownership/data-contract) | 4 | `86c0cf7`, `16c280f`, `b7afa72`, and part of `4c6f9f4` (G6-G8 combined) |
| G7 docs | 3 | `b34137b`, `77708d9`, and part of `61f33bd` (G7+G8 combined) |
| G8 docs | 5 | `c341bc2`, `141d169`, `dc6a6db`, `b4d6c91`, part of `61f33bd` |
| G6-G8 combined docs (final verdict) | 2 | `4c6f9f4`, `cd86823` |
| G6 code+migration+test | 9 | `ee86c71`, `da281d3`, `68d9cc9`, `c49151c`, `50a1151`, `1d5c2bc`, `9aeaea3`, `dd9d4df`, `2f85d9f` |
| G7 code+test | 5 | `e9ee3f3`, `1f43417`, `3429a94`, `2af3edf`, `9d4c4c9` |
| G8 code+test | 1 | `d56f3be` |

† `8447b7e`'s message has no `docs(lr...)` prefix ("docs: full detailed
compilation of LR-2 through LR-12 phase reports") but its diff touches
exactly one file, `docs/live-recovery/LR2_TO_LR12_FULL_DETAILED_REPORT.md` —
classified LR by content, confirming the mission's instruction not to trust
message prefixes alone.

Total: 17 (LR) + 27 (G6/G7/G8, all flavours) = 44. ✓

### 1.3 Mixed-commit check (empirical, not message-trusting)

Read every commit's full file list (`git log --name-only`) and checked every
"combined-topic" commit's diff directly:

- `61f33bd` ("docs(g7,g8): ...") — touches 5 files, all under
  `docs/country-programme/`, spanning G7 and G8 only. **No LR file.**
- `0857ec8` ("docs(lr12r): editorial correction...") — touches exactly one
  file, `docs/live-recovery/LR12R_FINAL_CLOSURE_CERTIFICATION.md`. **Pure
  LR, despite sitting between two G-programme docs commits in history.**
- All 15 G6/G7/G8 code commits spot-checked via full `git show`: each
  touches only `lib/`, `app/api/`, `components/`, `supabase/migrations/`, or
  `tests/unit/` files that are exclusively G6/G7/G8 in subject matter (own
  commit body cites its own contract number).

**No single commit mixes LR-programme and G6/G7/G8 file changes.** The
one-topic-per-commit convention held.

### 1.4 Real file overlap across commit boundaries (not just adjacency)

Per the mission's instruction, checked for files touched by an LR commit
that are ALSO touched by a G6/G7/G8 commit (even in different commits):

| File | Touched by LR commit(s) | Touched by G-commit |
|---|---|---|
| `components/grid/FinancialDataGrid.tsx` | `29489a6` (lr5-lr6), `f2af007` (lr11b) | `d56f3be` (G8 Contract 1) |
| `lib/services/dashboardData.ts` | `c8ddc60` (lr12r) | `2f85d9f` (G6 Contract 3) |

Both are genuine sequential-edit overlaps (same file edited by an earlier
LR commit and a later G-commit), not commit mixing. This is exactly why
building the new branch off `origin/main` (which independently already
carries the same LR edits to these two files — see §0) rather than off the
merge-base was correct: it puts the G-commits' diffs on the identical
baseline they were written against. Verified directly:

```
git diff origin/main origin/feature/lr-1-upload-security-lifecycle -- components/grid/FinancialDataGrid.tsx  # 26 lines (the G8 addition only)
git diff origin/main origin/feature/lr-1-upload-security-lifecycle -- lib/services/dashboardData.ts           # 30 lines (the G6 addition only)
git diff origin/main origin/feature/lr-1-upload-security-lifecycle -- lib/engines/householdContext.ts         # 0 lines (LR-only file, untouched by any G-commit, identical on both branches)
```

### 1.5 `origin/main` independently fixing a G6/G7/G8 item

See §0 — checked for real, confirmed no. The 11 `main`-only commits since
`1cafce3` are entirely LR-programme content.

### 1.6 Migration-collision re-scan (not trusting a stale prior run)

Re-ran both scripts fresh, on the current `origin/feature/lr-1-upload-
security-lifecycle` tree (before any branch surgery):

```
$ node scripts/check-migration-versions.mjs
OK: 132 active migrations, one file per version, next version is 0138.
```

(That run was against the pre-existing worktree state, at `origin/main`'s
132 migrations — confirming no collisions exist independent of anything
this pass does. Re-run again after building the new branch — see §1.9.)

### 1.7 Decision: branch is clean — build isolated closure branch

Per the mission's own decision rule: the branch is genuinely clean (§1.3,
§1.4), so a fresh branch was built off `origin/main` and only the 27
G6/G7/G8-labelled commits (all docs + all code, chronological order) were
cherry-picked — **not squashed**, preserving individual commit traceability.
`feature/lr-1-upload-security-lifecycle` was **not touched, not deleted, not
rewritten** — it remains the historical record every existing report's SHA
citations resolve against. Both branches now coexist.

Cherry-pick order (chronological, docs first then code, matching the
original branch's own history):

```
86c0cf7 16c280f b7afa72 b34137b 77708d9 61f33bd b4d6c91 dc6a6db 141d169
c341bc2 4c6f9f4                                                          (11 docs commits)
ee86c71 da281d3 68d9cc9 c49151c 50a1151 1d5c2bc 9aeaea3 dd9d4df 2f85d9f
e9ee3f3 1f43417 3429a94 2af3edf 9d4c4c9 d56f3be                          (15 code commits)
cd86823                                                                  (1 final verdict-update doc commit)
```

**Result: all 27 cherry-picks applied cleanly, zero conflicts, zero manual
hunk surgery needed.** (This also empirically confirms §1.4's overlap
analysis was correct — a real conflict would have surfaced here if the
baseline mismatch mattered.)

New branch: **`feature/g6-g8-country-programme-closure`**, built from
`origin/main` HEAD (`9793949`).

### 1.8 One genuine defect found and fixed during verification (disclosed)

While running `npx eslint` on every touched file (§1.9), a real, if minor,
defect surfaced in the code newly added by this programme (not a
pre-existing one):

**`tests/unit/g7Contract4ConsolidatedSectionsLimitationText.test.ts`** (new
file, introduced by commit `fb7a52c`/G7 Contract 4) placed an
`eslint-disable-next-line @typescript-eslint/no-explicit-any` comment above
the *opening* line of a multi-line object literal (`goals: {`), while the
`as any` cast it was meant to silence sits on the literal's *closing* line
several lines later. Result: ESLint still flagged the real `any` usage and
reported the disable comment itself as unused — a lint-only defect, zero
behavioural effect.

**Fix**: moved the disable comment to sit directly above the line
containing `} as any,`, matching the established single-line convention
already used by the sibling fixture this test's own header comment cites
(`tests/unit/reportSectionsPremiumStressApplicability.test.ts:55-56`).
Committed as a new, clearly-labelled commit on top of the cherry-picks
(`192ab9f`, "fix(g7-contract4): correct misplaced eslint-disable in new test
fixture") rather than silently rewriting history, so the change is visible
and attributable. Re-ran `npx eslint` on the file after the fix: **0
errors, 0 warnings.**

No other defect was found in any of the 17 contracts' shipped code (see
Stage 3, §2).

### 1.9 Independent verification of the new branch

**`git diff origin/main..HEAD --stat`**: 71 files changed, 3131
insertions(+), 98 deletions(-), 28 commits ahead of `origin/main`.

**File-list isolation check** (`git diff origin/main..HEAD --name-only`):
71 files — 32 `docs/country-programme/*.md`, 2 new
`supabase/migrations/013{8,9}_*.sql`, 24 `lib/`/`app/`/`components/` source
files, 13 `tests/unit/*.test.ts`. **Zero** `docs/live-recovery/*` files,
**zero** LR-numbered migrations (`0136`, `0137`), confirmed by direct
listing.

**Migration-collision scans** (re-run fresh on the new branch, not trusted
from Stage 2 step 6's earlier run):

```
$ node scripts/check-migration-versions.mjs
OK: 134 active migrations, one file per version, next version is 0140.
Note: unused version numbers in the chain: 0079, 0080, 0081, 0103, 0128

$ node scripts/check-migration-versions-against-branch.mjs --against=origin/main
OK: no cross-branch migration collisions between "HEAD" (134 files) and "origin/main" (132 files).
```

**Secret / hardcoded-UUID scan** (`git diff origin/main..HEAD` grepped for
AWS/OpenAI-style key patterns, PEM headers, `password=`, and
canonical-UUID-shaped literals): **zero matches** of any kind.

**No mainline fix reverted**: spot-diffed every file touched by both an LR
`main`-independent commit and a G-commit (`FinancialDataGrid.tsx`,
`dashboardData.ts`) — both diffs are pure, well-commented additions (a
label-lookup swap and two new nullable-column read/writes respectively),
zero lines of the LR-added content removed.

**One naming artifact, not a scope violation**: G6 Contract 9's new test
file is named `tests/unit/lr12rNriResidencyCrossCheck.test.ts` — the
filename retains an `lr12r`-looking prefix (evidently copied from a related
LR test's naming pattern as a template) but its commit (`3c856b3`), content,
and `describe()` block are 100% G6 Contract 9
(`resolveResidencyProfileForTaxReport()` in
`lib/services/investmentIntelligenceReportData.ts`). Confirmed by reading
the full commit and file. Cosmetic only; flagged here for the record, not
fixed (renaming would be an unrequested, unrelated change outside this
pass's scope).

**`npx tsc --noEmit`**: 10 pre-existing errors, all in
`app/api/payments/{razorpay,stripe}/webhook/route.ts`,
`lib/services/payments/{invoices,razorpayClient,stripeClient}.ts`,
`scripts/resources/lib/workbook.ts`, and
`tests/unit/support/pgliteInsightPackHarness.ts` — caused by
`razorpay`/`stripe`/`xlsx`/`@electric-sql/pglite` being declared in
`package.json` but genuinely absent from the shared `node_modules` in this
environment (confirmed: `ls node_modules/<pkg>` fails for all four; not a
symlink or path issue). **None of these 10 errors touch any of the 71
files this branch changed.** This is a pre-existing environment gap, not a
regression introduced by this branch. (`@electric-sql/pglite` was
separately installed with `npm i --no-save` purely to run the Stage 4
replay harness below — `package.json`/`package-lock.json` confirmed
untouched; `stripe`/`razorpay`/`xlsx` were left uninstalled as genuinely out
of scope for this pass.)

**`npx eslint` on all 43 touched TS/TSX files** (application code + tests):
0 errors after the fix in §1.8. One pre-existing warning
(`@next/next/no-img-element` on `components/reports/ReportPreview.tsx:226`)
confirmed to be on a line this branch's own diff never touches. One
pre-existing error cluster (10 `no-explicit-any` errors in
`tests/unit/goalArchivedLinkedFunding.test.ts` lines 62-101) confirmed
line-for-line identical to `origin/main`'s own copy of the file (this
branch's only edit to that file is 6 lines near line 208, unrelated to the
`any` usages) — pre-existing test-fixture debt, not introduced here, out of
this pass's scope to fix.

**Test suites — personally reproduced, not trusted from any commit
message**:

```
$ npx vitest run <all 13 files touched by the 17 contracts>
 Test Files  13 passed (13)
      Tests  163 passed (163)
```

Full-suite run for regression safety: **6360 passed, 18 failed, 18 skipped**
(305 files, 6396 total tests). All 18 failures independently confirmed
unrelated to this branch:
- 15 failures (`paymentsCheckoutRoute`, `paymentWebhookRoutes`,
  `paymentProviderActivation`, all 8 `resources*LiveDev`/`resources*` files,
  all 3 `aiInsightPack*` files) — same pre-existing missing-package gap as
  the `tsc` errors above (`stripe`/`razorpay`/`xlsx`/`pglite` not installed);
  none of these files are in this branch's 71-file diff.
- `tests/unit/countryGateAccessMatrix.test.ts` (MC-15) — asserts "no
  account/user-deletion API route exists anywhere"; this is now false
  because `app/api/admin/account-deletions/[id]/execute/route.ts` exists —
  confirmed present on `origin/main` **independently** of this branch
  (`git ls-tree origin/main -- "app/api/admin/account-deletions/[id]/execute/route.ts"`
  resolves), added there by `main`'s own independent LR-9 commit (§0). Not
  touched by any of this branch's 27 commits. Pre-existing on `origin/main`
  itself.
- `tests/unit/aiResidualClosureFailClosed.test.ts` (A4 negative control) —
  this branch's own G6 Contract 10 commit (`50a1151`) already disclosed,
  in its own commit message, having verified this exact failure occurs
  identically on `origin/main` with the two files it touches unmodified
  (via `git stash`), i.e. a pre-existing, unrelated flake. Independently
  re-confirmed here: the failure is in an `AIModelGateway`/`canonicalWrites`
  code path this branch's `financialContextObject.ts` edit (a single
  `cross_border_relationships` count query) does not touch.

**Zero regressions attributable to any of the 27 G6/G7/G8 commits or the one
lint fix.**

### 1.10 Isolation-proof checklist

| Check | Result |
|---|---|
| No LR-1-only file entered the clean branch | ✓ confirmed (§1.9 file list) |
| No unrelated migration entered | ✓ only `0138`/`0139` added, no `0136`/`0137` |
| No mainline fix reverted | ✓ confirmed by diff inspection (§1.9) |
| No duplicate migration exists | ✓ both scans clean (§1.9) |
| No generated build output committed | ✓ `git diff --stat` shows only source/docs/test/migration files, no `.next/`, no `dist/` |
| No secret / synthetic-UUID committed | ✓ grep scan clean (§1.9) |

### 1.11 Push

`feature/g6-g8-country-programme-closure` pushed to `origin` after all of
the above passed. `feature/lr-1-upload-security-lifecycle` untouched. No
merge to `main` performed or attempted.

---

## 2. Stage 3 — Independent revalidation of all 17 contracts

Every row below was built by reading the actual shipped diff
(`git show <sha>`) directly, not by transcribing the consolidated verdict
document's own table — then cross-checked against it. Test counts are from
the personal `npx vitest run` reproduction in §1.9 (163/163 across the 13
files these contracts add or touch), not from any commit message's claimed
count.

| # | Contract | Owner (file/function) | DB field(s) | API | Client | Calc | Historical-data effect | Rollback safety |
|---|---|---|---|---|---|---|---|---|
| G6-1 | Widen `country_code` enum (assets/liabilities/investments/retirement) | `lib/validation/{asset,investment,liability,retirement}.ts` (Zod schema) | none (Zod-only; DB FK already unrestricted — confirmed no CHECK narrower than the FK exists anywhere in `supabase/migrations/*.sql`) | writes to these 4 registers | grid forms | none | **None** — existing AU/IN values remain valid; widening a Zod enum accepts a superset, rejects nothing previously accepted | Trivial: revert the enum literal; no data was ever written outside the old set |
| G6-2 | New `country_code` on income/expense/insurance | `lib/validation/{income,expense,insurance}.ts`; migration `0138` | `income_sources.country_code`, `expense_items.country_code`, `insurance_policies.country_code` (new, nullable, `char(2)` FK→`countries`) | generic registry route (`lib/services/registry.ts`, passthrough) | grid forms | none | **None** — verified via local PGlite: column is nullable with no default (`is_nullable=YES`, `column_default=null`); no backfill statement exists in the migration | Trivial: `ALTER TABLE ... DROP COLUMN` rehearsed locally, succeeds cleanly (§4) |
| G6-3 | FX-rate lineage on `financial_snapshots` | `lib/services/dashboardData.ts`'s `loadDashboard()`; migration `0139` | `financial_snapshots.fx_rate_aud_inr` (numeric), `fx_rate_date` (date) — both new, nullable, no default | dashboard load path | dashboard UI (reads `SnapshotRow`, new fields passed through untouched) | none (write-time provenance only) | **None** — populated only on new upserts going forward; pre-existing rows keep NULL, confirmed nullable/no-default via local PGlite | Trivial: rehearsed DROP COLUMN succeeds (§4) |
| G6-4 | Shared `isDomesticRecord()` | `lib/services/jurisdiction.ts` | none | n/a | n/a | `resilienceStress.ts`, `reportSectionsPremium.ts` (both call sites) | **None** — pure refactor; both callers preserve exact original `!==` semantics via `!== true` (never reclassifies an unresolved country as domestic) | Trivial: two call sites revert to their own private inline comparison |
| G6-5 | `netWorthByCountryConverted` | `lib/engines/dashboard.ts`'s `computeDashboard()` | none (derived field) | dashboard load path | any `DashboardSummary` consumer | new, additive field alongside untouched `assetsByCountry`/`liabilitiesByCountry`/`retirementByCountry` | **None** — purely additive computed field | Trivial: delete the field and its computation block |
| G6-6 | Goal-funding cross-currency conversion | `lib/services/goalFundingAllocation.ts`'s `computeLiveLinkedFundingValue()` | none | n/a | Goals detail page (via `goalsData.ts`), Forecasting calculator (via `forecastData.ts`) | fixes a real defect: a foreign-currency-linked funding source is now converted before its percentage is applied | **None on data** — behavioural fix only, changes a live calculation, not stored data; two new optional trailing params default such that omission preserves pre-fix numeric behaviour exactly | Straightforward but not zero-effort: reverting changes goal-progress numbers back to the (defective) pre-fix behaviour for any cross-currency-linked goal — a real behavioural revert, not just a schema no-op |
| G6-7 | Wire `CROSS_BORDER` capability | `app/api/user/cross-border-relationships/{route.ts,[id]/route.ts}`; `lib/services/appCapability.ts` (`allowGenericWhenG4Off` option, default `false`) | none | 3 routes (GET/POST/PATCH) | cross-border declaration UI | none | **None** | Trivial for the new option (default `false`, unused by any pre-existing caller); reverting the 2 routes to the old direct gate restores byte-identical prior behaviour |
| G6-8 | Preview route real cross-border count | `app/api/user/primary-country/preview/route.ts` | reads `cross_border_relationships` (no schema change) | 1 route, deliberate breaking field rename (`cross_border_relationships_retained`→`active_cross_border_relationships_count`) | **none** — independently confirmed via repo-wide grep: zero references to either the old or new field name anywhere in `app/`, `components/`, `lib/` outside this one route file | none | **None** | Trivial: revert to the old hardcoded-`true` literal; confirmed no live consumer to break either way |
| G6-9 | NRI-disclaimer cross-check | `lib/services/investmentIntelligenceReportData.ts`'s new `resolveResidencyProfileForTaxReport()` | none | n/a | Investment Intelligence tax report | fixes a real defect: a self-declared "resident" is no longer trusted blindly when `country_of_residence` disagrees | **None on data** — behavioural fix in a report-generation calculation, not a stored value | Straightforward: reverting restores the old blind-trust behaviour (a real behavioural regression, not a schema concern) |
| G6-10 | `secondary_country` readers → `cross_border_relationships` | `lib/services/twinData.ts`, `lib/ai/context/financialContextObject.ts` | reads `cross_border_relationships` (no schema change); `secondary_country` column itself untouched, not dropped | n/a | Financial Twin display, AI context object | fixes a real defect: legacy `Boolean(secondary_country)` signal replaced by a real active-relationship count | **None on data** | Trivial: revert both readers to the old boolean check; `secondary_country` column still exists and populated exactly as before |
| G7-1 | Report header country context | `lib/services/reportsData.ts`'s `generateReport()` | writes `reports.country_scope` (existing `text not null default 'household'` column, no schema change) | report generation | see §3 below (`reports.country_scope` consumer analysis) | none | **None** — go-forward only; existing report rows keep their stored `'household'` value, never rewritten (confirmed: no `UPDATE reports SET country_scope` anywhere in the diff or migration set) | Trivial: revert the resolved-value line back to the literal `'household'` |
| G7-2 | Reporting currency/date locale | `lib/engines/money.ts`'s new `localeForReportingCurrency()` | none | n/a | `ReportHistoryTable.tsx`, `ReportPreview.tsx` (3 sites), `reportsData.ts` | none | **None** — verified: for the specific `toLocaleDateString()` option shapes used (spelled-out/abbreviated month+year, no numeric day/month), `en-AU`/`en-IN` render byte-identical English text | Trivial: revert 5 call sites to hardcoded `'en-AU'` |
| G7-3 | Shared `hasCrossBorderEligibility()` | `lib/engines/reportEligibility.ts` | none | n/a | n/a | `reportEligibility.ts`'s own `cross_border` check, `reportSectionsPremium.ts`'s `buildCrossBorderFull()` (now exported) | **None** — confirmed zero-behavioural-change by construction (both call sites' pre-existing threshold was already `>1`) and by test (`reports.test.ts`, `reportSectionsPremiumStressApplicability.test.ts` both pass unmodified) | Trivial |
| G7-4 | Consolidated-sections `limitationText` | `lib/engines/reportSections.ts` | none | n/a | net_worth/cash_flow/executive_summary report sections | **None** — additive caveat text only, fires only when `countriesInUse.length > 1` | Trivial: remove the conditional caveat block |
| G7-5 | Historical report snapshots FX/country provenance | `lib/services/reportsData.ts`'s `generateReport()` | writes 3 new keys into `report_snapshots.snapshot_metadata_json` (existing JSONB, **no schema change**) | report generation | any future consumer of the JSONB metadata (none exists in-tree today, same as G6 Contract 8's field) | none | **None** — go-forward only, existing `report_snapshots` rows keep whatever metadata they already have | Trivial: remove the 3 keys from the insert object |
| G7-6 | Recommendation applicability | `lib/services/appCapability.ts` (doc-string only) + new test coverage of `lib/engines/recommendations/matcher.ts` | none | n/a | n/a | none — matcher logic itself unchanged, discovery found it already correct | **None** | Trivial: revert the doc-string; matcher.ts untouched either way |
| G8-1 | "not IN becomes Australia" copy fix | `components/grid/FinancialDataGrid.tsx`; new `currencyMismatchCountryLabel()` in `lib/validation/currencyCountry.ts` | none | n/a | currency-mismatch warning banner | none — confirmed currently inert (only reachable for AU/IN today, per the widened G6-1 enum not yet exposed in any UI selector) | **None** | Trivial: revert to the two-way ternary |

### 2.1 Where a claim didn't hold up exactly as stated

**One did not hold up as literally stated, and is corrected in §0**: the
mission's own "main has not advanced past the fork" premise. The
*substance* of what it was checking for (no independent main-side fix to
any of the 17 contracts) does hold.

**Everything else held up**: every "additive only / no backfill / zero
behavioural change" claim made in the original commit messages was checked
against the actual migration SQL or diff directly (not re-asserted from the
commit message) and confirmed true in every one of the 17 cases, including
the two genuinely-behavioural fixes (G6-6 goal-funding conversion, G6-9 NRI
cross-check) which correctly do NOT claim "zero behavioural change" — they
claim "fixes a real defect," which is a different, and in both cases
accurate, category of claim.

**One genuine defect was found and fixed** (§1.8) — a misplaced
`eslint-disable` in a new test file, lint-only, zero behavioural effect,
fixed and disclosed as a new, separate commit.

---

## 3. `reports.country_scope` — semantics finding (mission's explicit flag)

The mission asks whether `'household'` as the unresolved-country fallback
is semantically safe, or whether the column is expected to carry a real
country/scope taxonomy the placeholder doesn't satisfy — and to read every
actual consumer, not just the writer, before answering.

**Method**: repo-wide `grep` for `country_scope` across `lib/`, `app/`,
`components/`, `scripts/` (33 files matched in total; all but the two below
are the AI module's own unrelated `country_scope` columns on entirely
different tables — `ai_prompt_templates.country_scope`,
`ai_standard_questions.country_scope`, `ai_intent_taxonomy.country_scope`,
`ai_contextual_explanations.country_scope` — confirmed by reading each
occurrence's surrounding code).

**The only two genuine `reports.country_scope` occurrences in the entire
codebase**:
1. `lib/services/reportsData.ts:226` — the write site (`generateReport()`).
2. `docs/country-programme/g7-data-contracts.md:11` — the spec's own
   illustrative snippet, whose comment states outright: `// BEFORE:
   country_scope: 'household' (fixed literal, never read again)`.

**There is no read-site anywhere in the application.** `ReportRow` (the
typed interface every caller of `reportsData.ts` receives) does not even
include `country_scope` as a field (`lib/services/reportsData.ts:52-69`) —
confirmed by reading the full interface. Every `.select('*')` call on
`reports` (3 call sites) returns it in the raw row, but nothing downstream
maps it into a typed object, renders it, or queries by it.

**Finding: `'household'` is confirmed semantically safe today, with
confidence, because there is currently zero application-code consumer for
this column to be unsafe against.** This is not "picking an answer to have
one" — it is the direct, verifiable result of exhaustively locating every
read site and finding none, corroborated by the data-contract spec's own
contemporaneous comment already stating the field was "never read again."

**Caveat, disclosed rather than escalated as an open PO item**: the column
has no `CHECK` constraint restricting its value set — `'household'` sits in
the same untyped `text` column a real ISO country code would occupy, with
no schema-level distinction between "unresolved placeholder" and "a real
country." This is a soft design gap (the column doesn't yet have a defined
future taxonomy), but it does not rise to "cannot establish the semantics
safely" — the semantics (write-only provenance field, zero live consumers)
are established with confidence. No Product Owner ruling is required on
this specific point; if a future phase adds the first real consumer of
`reports.country_scope`, that phase's own contract should define the
taxonomy (household vs. per-country vs. cross-border) at that time.

---

## 4. Stage 4 — Migration `0138`/`0139` certification

Both migration files, verbatim, as shipped (**unchanged** — no defect was
found in either file; both already matched their own header comments
exactly under every check below):

**`supabase/migrations/0138_g6_contract2_country_code_columns.sql`**
```sql
-- G6 Contract 2 (docs/country-programme/g6-data-contracts.md) — adds
-- country_code to the three registers that never had one: income_sources,
-- expense_items, insurance_policies. assets/liabilities/investments/
-- retirement_accounts already have this column (G6 Contract 1 only widens
-- its accepted value set at the validation layer; no schema change there).
--
-- Additive, forward-only, no data migration: nullable, no default, no
-- backfill. Every existing row gets NULL (unattributed) — a permanent,
-- valid state for pre-G6 rows, not a transient one to be cleaned up later,
-- per this programme's "preserve existing source values, never rewrite
-- history" data-integrity rule (same convention as G6 Contract 3's
-- fx_rate_aud_inr/fx_rate_date columns on financial_snapshots).
alter table income_sources add column country_code char(2) references countries(country_code);
alter table expense_items add column country_code char(2) references countries(country_code);
alter table insurance_policies add column country_code char(2) references countries(country_code);
```

**`supabase/migrations/0139_g6_contract3_snapshot_fx_lineage.sql`**
```sql
-- G6 Contract 3 (docs/country-programme/g6-data-contracts.md) — FX-rate
-- lineage on financial_snapshots. Additive, forward-only, no data
-- migration: populated at write-time only (loadDashboard()'s upsert),
-- never backfilled for historical rows — a pre-G6 snapshot legitimately
-- has NULL here, meaning "rate unknown, do not attempt retroactive
-- reconciliation," matching this programme's "treat unavailable as
-- unavailable, not zero" rule (same convention as G6 Contract 2's
-- country_code columns).
alter table financial_snapshots add column fx_rate_aud_inr numeric(12,6);
alter table financial_snapshots add column fx_rate_date date;
```

All verification below used the repo's existing PGlite-based clean-rebuild
harness (`scripts/db-rebuild-check/`, real PostgreSQL 18 compiled to
WebAssembly) — reused, not reinvented, per the mission's instruction.
`@electric-sql/pglite` (already a declared, but not-yet-installed,
devDependency) was installed with `npm i --no-save` purely for this local
verification; `package.json`/`package-lock.json` confirmed untouched.
**No DEV or production database was touched at any point.**

| # | Check | Method | Result |
|---|---|---|---|
| 1 | SQL parse/static validation | `scripts/db-rebuild-check/replay.mjs` executes every statement in both files against real PostgreSQL (WASM) | Both files parse and execute with zero errors |
| 2 | Fresh replay from zero (0001→0139) | `node scripts/db-rebuild-check/replay.mjs` | **`REPLAY COMPLETE: 134/134 migrations applied with zero manual intervention`**, `0138` and `0139` both listed `ok`, manifest emitted (`231 tables`, all `rls_enabled=231`) |
| 3 | Upgrade replay from mainline head (0137→0139) | `origin/main`'s highest migration is confirmed exactly `0137` (`git ls-tree origin/main -- supabase/migrations/` — highest file present). The full replay in check 2 applies `0138` and `0139` as the immediate next two files right after `0137`, in the same single ordered run — this **is** the "apply 0138/0139 on top of a database at 0137" scenario; there is no divergent path between the two framings since nothing changes before `0138` | Same clean result as check 2 — `0138`/`0139` land cleanly on top of exactly the schema state `origin/main` is at today |
| 4 | Constraint/index/RLS/trigger inventory | Ad-hoc `information_schema`/`pg_policies` queries against the fully-replayed local DB | All 5 new columns: `is_nullable = YES`, `column_default = NULL` for every one (no fabricated AU/IN default, no fabricated FX rate). 3 FK constraints confirmed present and correctly pointing `income_sources/expense_items/insurance_policies.country_code → countries.country_code`. Full CHECK-constraint listing for all 4 affected tables shows **zero** CHECK constraints touching any of the 5 new columns (all existing CHECKs are pre-existing NOT NULL/range checks on unrelated columns). RLS: all 4 tables show `relrowsecurity=true` with their pre-existing single row-level policy (`auth.uid() = user_id`) still in force — confirmed by reading the original policy definitions (`0003_module2.sql`, `0005_module3_dashboard.sql`): all use `for all using/with check (auth.uid() = user_id)`, no column-level restriction, so the new columns are automatically covered with **no new RLS policy required** |
| 5 | Destructive-statement scan | Direct read of both files (reproduced verbatim above) | Zero `DROP`, zero `DELETE`, zero data-rewriting `UPDATE` in either file — both are pure `ALTER TABLE ... ADD COLUMN` |
| 6 | Secret scan | Direct read + grep | Trivially clean — both files are schema-only, no literals beyond column/type/table names |
| 7 | Duplicate-migration-number scan | Already run fresh in Stage 2 §1.9 on this exact branch | `OK: 134 active migrations, one file per version` / `OK: no cross-branch migration collisions ... origin/main` — cited here, not re-run redundantly |
| 8 | Rollback rehearsal | Wrote and executed, against the fully-replayed local PGlite DB, the exact revert statements: `alter table income_sources drop column country_code;` / `expense_items` / `insurance_policies` / `financial_snapshots drop column fx_rate_aud_inr;` / `fx_rate_date;` | All 5 `DROP COLUMN` statements succeeded with **zero errors**. Post-rollback inventory query confirms **zero** of the 5 columns remain. No dependent view, function, trigger, or constraint blocked any drop — expected, since nothing referencing these columns has been merged or deployed anywhere yet |
| 9 | FX-direction convention confirmation | Read `lib/engines/fx.ts`'s header comment directly; traced `dashboardData.ts`'s `loadDashboard()` write path | `fx.ts`: `fx_rate_aud_inr = INR per 1 AUD` (matches `0016_module10_forecasting_fx_seed.sql`). `dashboardData.ts` writes the exact value returned by `getFxRateAudInr()` into the new `financial_snapshots.fx_rate_aud_inr` column under that same name and semantic — confirmed by reading lines 42-48 (`getFxRateAudInr()`) and 317-326 (the write) directly. G7 Contract 5's `report_snapshots` JSONB write uses the identical `getFxRateAudInr()` call. **One convention, applied consistently everywhere it's used — no ambiguity, confirmed by direct code reading, not re-litigated from scratch** |

### 4.1 End state — stopping exactly where the mission specifies

**Both migration files above are unchanged from what was originally
shipped** — no defect was found in either, so no fix was needed and none
was made. They are certified, locally rehearsed (fresh-from-zero and
upgrade-from-0137, both clean), and their rollback path is proven safe.

**Per the mission's own explicit instruction: stopping here.** Neither
migration has been applied to any DEV or production database, and none will
be as part of this pass. Both files are ready for Product Owner review at:

- `supabase/migrations/0138_g6_contract2_country_code_columns.sql`
- `supabase/migrations/0139_g6_contract3_snapshot_fx_lineage.sql`

(paths as they exist on `feature/g6-g8-country-programme-closure`, byte-
identical to their originals on `feature/lr-1-upload-security-lifecycle`).

---

## 5. Summary of what changed vs. what was found

| Category | Count / detail |
|---|---|
| New branch created | `feature/g6-g8-country-programme-closure`, pushed to `origin`, 28 commits ahead of `origin/main` |
| Commits cherry-picked unmodified | 27 (11 docs + 15 code + 1 final-verdict doc), zero conflicts |
| New commits added on top | 1 (`192ab9f`, lint-only fix, disclosed in §1.8) |
| `feature/lr-1-upload-security-lifecycle` | Untouched — still holds the original 15-commit implementation for SHA-citation traceability in prior reports |
| Genuine defects found in the 17 contracts' shipped code | 1 (misplaced `eslint-disable`, lint-only, fixed) |
| Genuine defects found in migrations `0138`/`0139` | 0 — both certified unchanged |
| Contracts whose "no backfill / additive only / zero behavioural change" claim failed verification | 0 of 17 |
| Open Product Owner items surfaced by this pass | 0 new ones — `reports.country_scope` resolved with confidence (§3), not escalated |
| Pre-existing (not this-pass) issues surfaced incidentally | `tests/unit/countryGateAccessMatrix.test.ts` MC-15 is now stale against `origin/main` itself (an account-deletion route was added independently by the LR-9 programme); `tests/unit/goalArchivedLinkedFunding.test.ts` has 10 pre-existing `no-explicit-any` lint errors unrelated to this branch; `razorpay`/`stripe`/`xlsx` are declared dependencies genuinely missing from the shared environment's `node_modules`. None are in this pass's scope to fix and none are touched by any of the 27 cherry-picked commits. |

---

## End of this pass

This report, the branch-isolation proof, the 17-contract revalidation, and
the migration-0138/0139 certification are complete. **No DEV or production
database was written to. No feature flag was changed. `main` was not
touched.** `feature/g6-g8-country-programme-closure` is pushed and ready
for review alongside this report.

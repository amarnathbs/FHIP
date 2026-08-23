# Chunk 3c — Forecasting + Financial Twin phantom-balance fix

Follow-on to Chunk 3b (`171f554`, `docs/app-review-2026-08/CHUNK3B_MIGRATION_AUDIT.md`).
Chunk 3b fixed `lib/engines/dashboard.ts`'s `totalRetirement` so it no longer
sums Class-F contribution-type `retirement_accounts` rows (`employer_contributions`,
`salary_sacrifice`, `personal_concessional`, `non_concessional`,
`government_co_contribution`, `spouse_contribution`) as phantom account
balances — see `isRetirementContributionRow()` in `lib/engines/dashboard.ts`.
That fix was scoped to `dashboard.ts` only; `lib/services/forecastData.ts`
(Forecasting) and `lib/services/twinData.ts` (Financial Twin) were explicitly
out of scope for Chunk 3b and were flagged as needing the same investigation.
This pass is that investigation, plus the fix.

## Investigation — which of the flagged sites were real

The request named 8 line numbers across 2 files as suspects (unfiltered
`current_balance` sums with no `master_item_key` exclusion). Each was read in
context, not just pattern-matched. Verdict:

| File | Site | Live defect? | Why |
|---|---|---|---|
| `forecastData.ts` ~409-451 | cross-border forecast calculator input (`foreignRetirement`) | **Yes** | Raw `reduce((sum, r) => sum + r.current_balance, 0)`, select never carried `master_item_key` |
| `forecastData.ts` ~471-511 | retirement forecast calculator input (`currentBalance`) | **Yes** | Same shape, plus the existing FX-conversion wrapper (P0 cross-border fix, `64b2bab`) — the exclusion has to compose with that, not replace it |
| `forecastData.ts` ~1213-1217 | cross-border variance "actual" (`getVarianceActual`) | **Yes** | Same raw-sum shape, separate query from the calculator-input one above |
| `twinData.ts` ~200 (`loadDashboardForTwin`) | Financial Twin's own copy of the dashboard summary | **Yes — but not a raw sum** | This call site already delegates to `computeDashboard()` (Chunk 3b-fixed), but its `retirement_accounts` select never requested `master_item_key`, so the existing exclusion silently no-ops for every row. The bug is an incomplete field selection, not missing filter logic. |
| `twinData.ts` ~98 (`loadTwinSourceData`'s `rawRetirement`) | raw retirement rows kept on `TwinSourceData` | **No — investigated and ruled out** | Grepped every consumer of `rawRetirement`/`TwinRetirementRow` (`lib/engines/twin/metricDerivation.ts`). The only fields ever read off it are `target_retirement_age` (retirement-age derivation) — `current_balance` is never re-summed from this array anywhere. Not a live instance of the defect. `master_item_key` was still added to the select/interface for parity and to prevent a future consumer from reintroducing the bug silently, but no filtering logic was needed here. |

Every genuine call to `computeDashboard()` elsewhere in both files (the
`resilience`/`net_worth`/`retirement`/`investment` branches of
`forecastData.ts`, all of which go through `loadDashboard()` in
`dashboardData.ts`) was already safe — `dashboardData.ts`'s own
`retirement_accounts` select has carried `master_item_key` since Chunk 3b.

## The fix

**`forecastData.ts`**: imports `isRetirementContributionRow` directly from
`lib/engines/dashboard.ts` (reused, not re-derived — the two can never drift
apart) via a new exported pure helper:

```ts
export function sumRetirementBalanceExcludingContributions<T extends { current_balance: number | null; master_item_key?: string | null }>(
  rows: T[],
  valueOf: (row: T) => number = (row) => row.current_balance ?? 0
): number {
  return rows.filter((r) => !isRetirementContributionRow(r.master_item_key)).reduce((sum, r) => sum + valueOf(r), 0);
}
```

The optional `valueOf` composes with the retirement-forecast site's existing
FX-conversion closure (`toRetirementReportingCurrency`) — filtering happens
first, conversion happens only on the surviving rows. All 3 sites' selects
now request `master_item_key`.

**Deliberately unchanged**: at both sites, the `employer_contribution`/
`personal_contribution` **flow** fields on the very same Class-F rows still
feed the monthly-contribution figures (`foreignRetirementMonthlyContribution`,
`monthlyContribution`) completely unfiltered — matching `dashboard.ts`'s own
`retirementEmployerMonthlyContribution`/`retirementPersonalMonthlyContribution`
(`lib/engines/dashboard.ts:715-729`), which sum `input.retirement` (the full,
unfiltered set) for contributions but `retirementBalanceRows` (filtered) for
the balance. A contribution row's contribution is real; only its
`current_balance` is the phantom double-count. Regression-tested explicitly
(see below) so a future edit can't accidentally "fix" this into filtering
contributions too.

**`twinData.ts`**: one-line fix — `master_item_key` added to
`loadDashboardForTwin`'s `retirement_accounts` select. No new filtering logic
needed; `computeDashboard()` already had the exclusion, it just never
received the field it keys off. Also added to the separate `rawRetirement`
select/`TwinRetirementRow` interface for parity (see investigation table —
not a live bug there, disclosed as such, not claimed as a fix).

No schema change, no migration — same as Chunk 3b's `dashboard.ts` fix, this
corrects a live-computed figure immediately for every existing row,
regardless of `master_item_key`'s catalogue `is_active` status.

## Regression tests

`tests/unit/forecastData.test.ts` (7 new tests) — unit-tests
`sumRetirementBalanceExcludingContributions` directly (pure function, no
Supabase mocking needed, consistent with this codebase's existing test
convention — `dashboard.test.ts`, `retirementAccounts.ts`, `smsf.ts` are all
tested the same way): excludes a Class-F row, excludes all 6 keys, does not
exclude a custom/no-key row, excludes before applying the FX-conversion
`valueOf` callback, a realistic mixed-currency case, an empty-array edge
case, and — the "deliberately unchanged" claim above — a standalone
reproduction proving a Class-F row's contribution flow still counts even
though its balance is now excluded.

`tests/unit/twinData.test.ts` (2 new tests) — this sandbox has no live
Supabase/DB access (same disclosed limitation as
`tests/unit/chunk3aSchemaRls.test.ts`), so the fix can't be exercised via a
real `loadTwinSourceData()` call against seeded data. Verified directly
against the source instead, same technique as that file: (1) the
`retirement_accounts` select inside `loadDashboardForTwin` must include
`master_item_key`, and (2) it must match `dashboardData.ts`'s own select for
the same table **exactly** (structural equality of the column sets) — so the
Twin's copy can never silently drift from the canonical Dashboard again the
way it just had.

**Negative control, run before finalizing**: reverted the fix
(`git stash`) and re-ran both new test files — both failed against the
pre-fix source (the `twinData.ts` structural-equality test reported the
missing `master_item_key` by name in its diff), then re-ran clean after
`git stash pop` restored the fix. Confirms these tests actually detect the
defect rather than passing vacuously.

## Live-DEV confirmation (read-only, no writes)

`scripts/forecastTwinPhantomBalanceAudit.mjs` (new, same `.env.local`-loading
and service-role pattern as `scripts/chunk3bMigrationAudit.mjs` — every call
is `.select()`, no `.insert()`/`.update()`/`.delete()`), run against the same
DEV project (`vqycarelcoijzwlpkpcz`) Chunk 3b audited:

- 357 active `retirement_accounts` rows, **45 Class-F rows across 39 distinct
  users** — identical population to Chunk 3b's own audit (no drift between
  passes, as expected: this fix touches no data, only read paths).
- All **39/39** affected users have a `forecast_profiles` row (i.e. have used
  Forecasting) — confirms the Forecasting defect was live-reachable, not
  theoretical, for the entire affected population.
- Financial Twin has no opt-in gate — `loadDashboardForTwin` runs
  unconditionally whenever a Financial Twin page/report renders, so all 39
  users were getting a double-counted `totalRetirement` (and everything
  derived from it: `retirement_balance`, `productive_asset_ratio`, the
  retirement-readiness projection, `cross_border_retirement_coverage`, net
  worth via `totalAssetBase`) inside the Twin specifically.
- Full per-user row counts and nominal phantom-balance totals captured in the
  script's stdout during this session; not committed to the repo (matches
  the established precedent from Chunk 3b's audit of not committing one-off
  evidence dumps).

## Regression

`tsc --noEmit`: clean. `vitest`: 24 files / 207 tests (was 22/197 after
Chunk 3b; +2 files, +10 tests). `eslint`: 5 errors / 6 warnings (unchanged,
pre-existing, none in touched files — confirmed by diff). `next build`: exit
0, 145 routes (unchanged from Chunk 3b).

No migration applied or required — this is a pure code fix on read paths,
same as Chunk 3b's `dashboard.ts` change.

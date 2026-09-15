# FHIP App Review — Findings & Required Corrections, 15 Sep 2026

## Response

**Branch:** `fix/app-review-findings-2026-09-15` (branched from `origin/main` @ `23b49da`)
**Status:** not pushed, not merged — for Product Owner review.
**Verification environment:** hosted DEV (`vqycarelcoijzwlpkpcz`). Production was
not touched; a read-only production probe was blocked by this environment's
permission policy, so every live proof below is DEV.

Each item below follows the structure the review itself requests: **Root
cause** → **Change made** → **Verification**. Item 6 additionally carries the
explicit data lineage; items 8–9 carry the rate, formula and derived term per
loan.

Four things need a Product Owner decision. They are collected in
[§ Decisions needed](#decisions-needed) at the end and cross-referenced from
the items they belong to.

---

## Summary table

| | Item | Outcome | Blocker |
|---|---|---|---|
| G1 | No decimals on monetary amounts | **Fixed**, app-wide, centralised | — |
| G2 | Right-align amount columns | **Fixed**, app-wide + repo-wide guard | — |
| 1 | Wrong "Back" navigation (II India) | **Fixed** | — |
| 2 | XIRR must be calculated | **Root cause found + fixed** | — |
| 3 | Migration text in user Notes | **Fixed in code**, migration written | Needs manual DEV+prod apply |
| 4 | Sections show "Missing" although entered | **Root cause found + fixed** | — |
| 5 | "No active goals" although one exists | **Root cause found + fixed** | — |
| 6 | Retirement figures + wrong Final Target | **Root cause found + fixed**, lineage documented | — |
| 7 | Unformatted decimals in narrative | **Fixed at the pattern level** | — |
| 8 | Amortisation verification + wording | **Verified correct**; 2 further defects found and fixed elsewhere | 1 decision |
| 9 | "120-month" hard-coded payoff term | **Fixed**, term now derived | — |

---

## G1 — No decimal places on any monetary amount

### Root cause

Two separate causes, not one.

1. **The shared helper itself kept cents.** `lib/engines/money.ts`'s
   `formatMoney()` — which the great majority of the app already routed money
   through — used `Intl.NumberFormat` with `style: 'currency'` and no
   fraction-digit options, so it inherited each currency's minor unit (2 for
   both AUD and INR). A second helper, `formatMoneyWhole()`, had been added
   earlier for the Consolidated Forecasting Report only, having reached the
   same conclusion for multi-year projections; the rest of the app never
   adopted it.
2. **Screens that could not use the AUD/INR-typed helper had each grown their
   own local `Intl.NumberFormat`.** Eleven of them. Some already passed
   `maximumFractionDigits: 0`, some did not, and one (`companies/page.tsx`)
   fell back to `value.toFixed(2)` on an unrecognised currency code. There was
   no single place where the rule could be stated.

### Change made

The rule is enforced in the one shared helper, so all existing call sites
become compliant with one change rather than ~200 individually-missable ones.

`lib/engines/money.ts`:

- `formatMoney()` now pins **both** `minimumFractionDigits: 0` and
  `maximumFractionDigits: 0`. Pinning only the maximum is not enough —
  `Intl`'s currency style defaults the *minimum* to the currency's minor unit,
  and relying on the implementation clamping one against the other is not
  portable across runtimes/ICU versions.
- `formatMoneyWhole()` is now an alias of `formatMoney()`. Kept rather than
  mechanically deleted so the ~24 call sites that name it explicitly keep
  stating the intent at the point of use. A test asserts the two are identical
  for every input, so they cannot drift apart again.
- **`formatMoneyCode(amount, isoCode)`** added — same whole-unit rule for the
  surfaces holding an arbitrary ISO 4217 code rather than this app's two
  reporting currencies (per-row `currency_code` on investments, liabilities,
  II instruments, invoices). These are the surfaces that had each grown a
  local `Intl` instance. Falls back to a grouped number plus the code rather
  than throwing inside a render on an unknown code.
- **`formatMoneyNarrative(amount, isoCode)`** added for engine-side sentence
  text (see item 7). Engine modules must not import UI code, so it lives
  beside the other money primitives.

Bespoke formatters removed and routed through the shared helper:

| File | Was |
|---|---|
| `app/(app)/companies/page.tsx` | local `Intl` + `toFixed(2)` fallback |
| `components/investment-intelligence/InvestmentIntelligenceClient.tsx` | `toLocaleString({maximumFractionDigits: 2})` |
| `components/investment-intelligence/OverviewClient.tsx` | local `Intl` |
| `components/investment-intelligence/PerformanceClient.tsx` | local `Intl` |
| `components/investment-intelligence/PortfolioXrayClient.tsx` | local `Intl` |
| `components/investment-intelligence/SipIntelligenceClient.tsx` | local `Intl` |
| `components/investment-intelligence/TaxIntelligenceClient.tsx` | local `Intl` |
| `lib/engines/goalInsights.ts` | local `Intl`, cents in user-facing insight copy |
| `lib/engines/investment-intelligence/reviewCentre.ts` | `toFixed(2)` in review-item descriptions |

Engine narratives (the item 7 pattern) fixed in
`goalCalculator.ts`, `debtCalculator.ts`, `netWorthCalculator.ts`,
`resilienceCalculator.ts`, `crossBorderCalculator.ts`.

**One sanctioned exception, named so it is greppable rather than scattered:**
`formatMoneyExact()`. Four call sites, two categories — see
[Decision 1](#decision-1--the-two-g1-carve-outs).

### Verification

- `tests/unit/money.test.ts` — 18 assertions, using the review's own worked
  examples verbatim: `$541.67 → $542`, `541.6666666666666 → $542`,
  `3690.83 → $3,691`, and the matching `3149.16 → $3,149` from the same
  sentence. Plus `₹8,06,724` to confirm INR lakh grouping survives, negative
  amounts, zero, and `formatMoneyWhole ≡ formatMoney`.
- **App-wide grep proof** (the review asked for this rather than a fix of the
  nine screenshot locations):
  - **206 call sites across 66 files** now render money through
    `formatMoney` / `formatMoneyWhole` / `formatMoneyCode` /
    `formatMoneyNarrative`, all of which are whole-unit.
  - **0** remaining bespoke `style: 'currency'` `Intl.NumberFormat` instances
    anywhere in `app/`, `components/` or `lib/` outside `money.ts`
    (was 11).
  - **0** remaining raw-float interpolations (`toFixed(2)` / bare
    `toLocaleString()`) of a monetary value in any forecast-engine narrative
    (was 9 across 5 files).
  - **4** call sites use the sanctioned `formatMoneyExact` exception, all
    listed in Decision 1.

---

## G2 — Right-align all amount columns in tables/reports

### Root cause

There is no shared table component in this codebase. 43 files hand-roll their
own `<table>` markup, so there was no "column component level" at which the
rule could be applied, and every table had been aligned (or not) by hand.

### Change made

Two parts, because a shared constant alone can be forgotten:

1. **`lib/ui/tableAlign.ts`** — the rule stated once.
   `NUM_CELL_CLASS = 'text-right tabular-nums'` and
   `NUM_HEADER_CLASS = 'text-right'`. `tabular-nums` travels with the
   right-alignment deliberately: right-aligning proportional figures still
   leaves the digits ragged, because `1` is narrower than `8`.
2. **`tests/unit/g2AmountColumnAlignment.test.ts`** — the rule enforced
   repo-wide. It scans every `.tsx` file for a table cell that renders a
   monetary value and fails the build if that cell is not right-aligned.
   Local formatter aliases are resolved **per file** so a generic name like
   `fmt` counts as money only where it actually is money — several files use
   `fmt` for plain string formatting, and flagging those would be a false
   positive rather than a G2 violation. Percentage/count/date columns are out
   of scope, matching the review's own wording ("values, targets, gaps,
   variances, currency amounts").

Then the sweep the guard demanded: **26 money cells across 12 files**, plus
their matching `<th>` headers, plus the sibling numeric cells in the same
columns of the Measure/Current/Scenario comparison tables (where scores and
months share a column with amounts, so aligning only the money row would look
broken).

Files: `forecast/ScenarioComparisonPanel`, `forecast/ForecastReportContent`,
`goals/GoalWhatIfSimulator`, `goals/MonthlyAllocationPanel`,
`goals/ScenarioTable`, `grid/FinancialDataGrid`,
`investment-intelligence/PortfolioXrayClient`,
`investment-intelligence/SipIntelligenceClient`, `reports/ReportPreview`,
`resilience/StressTestPanel`, `retirement/RetirementStatementImportPanel`,
`score/WhatIfSimulator`, and the standalone
`app/(app)/forecast/variance/page.tsx` (the Consolidated Variance table named
in item 6).

### Verification

`npx vitest run tests/unit/g2AmountColumnAlignment.test.ts` — passes with zero
offenders. It failed with 26 before the sweep, and will fail again the moment
a new misaligned amount column is added. That is what makes G2 a standard
rather than a one-off pass.

---

## Item 1 — Wrong "Back" navigation on Investment Intelligence (India)

### Root cause

**Not a regression — an incomplete fix from the previous review round.** The
back link did not exist at all until commit `f86962a`
("fix(app-review): Dashboard whole-dollar Vital Signs + II back-to-Dashboard
link", 2026-09-14, merged to `main`), which added it in response to item 4 of
the 2026-09-14 review. It was pointed at `/dashboard` simply by copying the
idiom used by other deep workspace views. `/dashboard` is not where anyone
arrives from: the only in-app entry point into this workspace is the "India
Investments" link on the Investment & Retirement page's Investments tab
(`app/(app)/investments/page.tsx`).

### Change made

`components/investment-intelligence/InvestmentIntelligenceSubNav.tsx` —
`href` changed `/dashboard` → `/investments`, label changed
"← Back to Dashboard" → "← Back to Investments".

No query string or hash is needed to land on the right tab:
`components/investments/InvestmentsSubNav.tsx` selects its tab by pathname
equality (`/investments` = Investments, `/retirement` = Retirement), so
`/investments` **is** the Investments tab.

### Verification

This shared component renders on all seven II workspace pages (Overview,
Statements & data, Performance, Recurring investments, Underlying fund
holdings, Tax & cost, Review) — confirmed by
`tests/unit/iiPc2WorkspaceUiContract.test.ts`, which asserts every one of the
seven imports and renders it. So the corrected link applies to every tab, as
the acceptance criterion requires. `npx tsc --noEmit` clean; the existing II
workspace UI contract suite (83 files, 1,634 tests) passes.

---

## Item 2 — XIRR must be calculated

### Root cause

**Found, and it is neither the solver nor the search bracket.**

The review suggested three candidate causes: all flows the same sign, the
current value missing, or too narrow a bracket. The actual cause is a fourth
one, and it is specific:

`lib/engines/investment-intelligence/analyticsOrchestrator.ts` built the
**portfolio-level** investor cash-flow series from each scheme's
`externalCashFlows`, which **include that scheme's own synthetic terminal
current-value flow, dated at that scheme's own valuation date**. A household's
statements do not all carry the same valuation date — this is why the PC4
round added per-scheme valuation-date disclosure in the first place. So a
purchase in one scheme can legitimately fall *after* another scheme's
valuation date, and when it does, the chronologically **last** flow in the
netted portfolio series is negative.

At that point XIRR is genuinely unsolvable, and the solver is behaving
correctly:

- As `r → +∞`, every flow after `date₀` is discounted away, so `NPV(r)` tends
  to the sign of the **earliest** flow — a purchase, i.e. negative.
- As `r → −1⁺`, the last flow's discount factor dominates everything else, so
  `NPV(r)` tends to the sign of the **latest** flow — also negative here.

Both ends negative ⇒ `NPV(r)` never crosses zero anywhere in the domain, even
though the series contains both signs (so `ALL_SAME_SIGN` does not fire). The
bracket scan finds nothing and reports `NOT_BRACKETED` — "No sign change found
for NPV(r) across the search domain", exactly what the reviewer saw.

**Widening the bracket cannot fix this, and the bracket was never the
problem.** The existing search domain is already `−99.9999%` to `+10,000%` —
far wider than the `−99%..+1000%` the review suggests as a minimum. This is
asserted directly in the tests (a +8,900%-in-a-year series and a
−99.8%-in-a-year series both solve).

The same failure is reached by a second route: a scheme with **no** holding
snapshot at all gets `currentValue = 0`, so no terminal flow is appended, and
the series simply ends on a purchase.

### Change made

The fix is the construction the review itself specifies — "each purchase as an
outflow on its date, current portfolio value as a single inflow on the
valuation date":

1. **`lib/services/investment-intelligence/analyticsRepository.ts`** now
   builds `externalCashFlowsExcludingTerminal` alongside `externalCashFlows` —
   the real flows, with the synthetic terminal valuation kept separate.
2. **`lib/engines/investment-intelligence/analyticsOrchestrator.ts`** builds
   the portfolio investor series from the real flows only, then appends **one**
   terminal inflow: the sum of every scheme's current value, dated at the
   latest valuation date in the group (the date as at which that total is
   true, and the same date the Overview and the Performance header already
   show). Because it is appended after netting, it is the chronologically last
   flow whenever the portfolio still holds value — which is precisely the
   condition XIRR needs. The field is optional and the orchestrator derives it
   by identity for any caller not yet updated, so no existing caller breaks.
3. **`lib/engines/investment-intelligence/xirr.ts`** now returns
   **`NO_TERMINAL_VALUE`** — a reason already declared in
   `XirrUnavailableReason` but never previously emitted — with an explanation
   the user can act on ("The most recent recorded event is money going in,
   with no later valuation to measure it against…"). `NOT_BRACKETED` and its
   NPV message are now reserved for a genuinely pathological series (a root
   essentially at the domain floor, i.e. a total wipeout to a rounding
   residue). This satisfies the review's requirement 4: "Could not be
   calculated" is reserved for a series that genuinely lacks one negative and
   one positive flow. `NO_TERMINAL_VALUE` already maps to
   `INSUFFICIENT_HISTORY` in `calculationStatus.ts`, so the card now reads
   "Not enough history" with an actionable detail line instead of "Could not
   be calculated — No sign change found for NPV(r)…".
4. The repository now also **discloses** a scheme whose transactions post-date
   its own latest valuation, as a data-quality warning, rather than silently
   absorbing it. The valuation date is never fabricated forward to make the
   series solvable.

### Cash-flow construction used (as the review asks)

For each currency group:

```
flows = Σ over schemes of that scheme's external transactions
          purchase / SIP / reinvestment / fee / tax  →  −|gross_amount|  at transaction_date
          redemption / dividend                      →  +|gross_amount|  at transaction_date
          switch_in / switch_out                     →  excluded (internal transfer,
                                                        no household money moved)
          transfer / merger / adjustment             →  excluded (unit movements,
                                                        no investor cash impact)
        netted by date
      + ONE terminal inflow:
          + Σ scheme.currentValue   at max(scheme.currentValueDate)
```

Solved for `r` in `Σ CF_i / (1+r)^((date_i − date_0)/365) = 0` using ACT/365
and safeguarded Newton–Raphson bracketed by bisection (unchanged).

### Verification

`tests/unit/iiXirrPortfolioTerminalValue.test.ts` — 10 tests.

- **The failure is reproduced against the real solver** before being fixed,
  for both routes in (a purchase after the valuation date; no terminal
  valuation at all).
- **The bracket is proved not to be the cause** — extreme positive and
  negative returns both solve inside the existing domain.
- **The reviewer's own portfolio shape produces a number**: two schemes,
  history from 17-12-2007, statements of differing vintage (one scheme's
  purchase on 2026-08-20 falling after the other's 2026-06-30 valuation),
  total value ₹8,06,724 as at 2026-09-04 — the engine returns
  `status: 'CALCULATED'` with a plausible annualised rate.
- **The engine result reconciles to an independently hand-built series** to 9
  decimal places, where that independent series is written exactly as the
  review describes the construction.
- **It still refuses to invent a return** for a portfolio with no current
  value.

The full Investment Intelligence unit suite (83 files, 1,634 tests) passes,
including the pre-existing R4 XIRR/TWRR/service-layer certification suites.

---

## Item 3 — Internal migration text leaking into user-facing Notes (SMSF)

### Root cause

`supabase/migrations/0084_geo_jurisdiction_smsf.sql`, PART 6, line 614 wrote
the literal string

> `Backfilled by migration 0084 from the pre-existing retirement_accounts row (Summary Mode, value unchanged).`

directly into `smsf_funds.notes` — the user-editable, user-visible Notes field
on the SMSF card (`components/retirement/smsf/SmsfFundCard.tsx` renders it).

### The wider audit (requirement 3 — run, not just noted)

Run twice, by two independent methods, because the first method missed two
tables:

1. **Live read-only data sweep of DEV** across every user-facing name/notes
   column: `smsf_funds`, `retirement_accounts`, `assets`, `liabilities`,
   `investments`, `income_sources`, `expense_items`, `insurance_policies`,
   `user_goals`, `smsf_holdings`, `households`, `business_entities` — matching
   `migration`, `backfilled`, `backfill`, `pre-existing`, `preexisting`,
   `legacy row`, `TODO`, `deprecated`.
2. **Static sweep of every migration file**, looking for a provenance literal
   inside an `insert`/`update` that targets a user-facing column. This is now
   a permanent test (see Verification) and it found two further offenders the
   data sweep's column list had not covered.

**Result — three offenders, 303 affected rows in DEV:**

| Table / column | Rows in DEV | Written by |
|---|---:|---|
| `smsf_funds.notes` | 7 | migration 0084, 1 literal |
| `property_liability_links.notes` | 11 | migration 0078, 3 literals |
| `retirement_members.notes` | 285 | migration 0077, 2 literals |

Every other user-facing column swept came back clean.

### Change made

**`supabase/migrations/0154_app_review_0915_clear_leaked_migration_notes.sql`.**

- Adds `smsf_funds.backfill_source` and `retirement_members.backfill_source` —
  **internal** provenance columns, the correct home for this audit trail
  (requirement 2). Neither is selected by any user-facing query.
  `property_liability_links` needs no new column: 0078 already recorded the
  same fact structurally in `source` (`'backfill_deterministic'`) and
  `confidence` (`'deterministic'`).
- Moves the provenance out of `notes`, matching **only** rows whose `notes` is
  byte-for-byte a known migration literal. A row whose notes the user has
  since edited — even by appending to it — is left completely untouched.
  Nothing this migration does can destroy a user's own words.
- **One note is rewritten rather than cleared.** Migration 0077's conflict case
  reads "…conflicted across this member's accounts (67, 65). No value was
  guessed -- please confirm your target retirement age." That carries a real
  instruction to the household, and the conflicting ages it lists are recorded
  nowhere else. Only the developer framing is removed; the ages are carried
  across verbatim into "Your recorded retirement ages differed across your
  accounts (67, 65). None was assumed — please confirm your target retirement
  age."

**Requirement 2 — "ensure future migrations never do this"** is enforced by a
test, not by a code-review habit: `tests/unit/appReview0915MigrationTextLeakGuard.test.ts`
fails the build if any migration writes a provenance literal into a
user-facing column. The three historical offenders are listed in an explicit,
documented allowlist, because this repo's rule is forward-only — an applied
migration is never edited, its effects are re-emitted forward, which is what
0154 does. Nothing may be added to that list.

### Verification

- **Validated against real Postgres (PGlite)**, not just eyeballed. The
  migration was applied to stand-in tables seeded with each literal plus
  control rows. Results: exact literals cleared and provenance moved to the
  internal columns; a user-edited note that merely *contains* the 0084 literal
  left untouched; users' own notes untouched; the 0077 conflict note rewritten
  with `(67, 65)` preserved; **a second application changes nothing further**
  (idempotent).
- The guard test passes (4 tests), and it correctly failed with 5 findings
  before the remediation list and 0154 existed.

### ⚠ Open blocker

**Migration 0154 needs manual application via the Supabase SQL Editor — DEV
first, then production.** This environment cannot execute DDL (no direct
Postgres connection, no Management API token, no generic `exec_sql` RPC). The
file carries its own post-apply verification queries at the bottom. Until it is
applied, the 303 rows above still show the leaked text.

### Migration numbering

**0154 — verified fresh against DEV, not assumed.** `main`'s
`supabase/migrations` folder ends at `0148`, so the repo's own
`scripts/check-migration-versions.mjs` reports `0149` as next-free. That is
**wrong** here:

| Version | Claimed by | Applied to DEV? |
|---|---|---|
| 0149, 0150 | unmerged AIE-1 closure (commit `121cfd4` renumbered its 0147/0148 → 0149/0150) | 0150's `aie_ai_cost_ledger` — **present** |
| 0151, 0152 | unmerged AIE-1 follow-ups | 0152's `aie_ai_cost_attempt` — **present** |
| 0153 | unmerged PC5 branch (`ii_ownership_allocation`) | absent |

So **0154** is the true next-free version. Live read-only probe, 2026-09-15.

---

## Item 4 — Data Quality & Completeness shows sections as "Missing"

### Root cause

**Two causes, and the review's own leading hypothesis was not one of them.**

The review suspected the per-section "I've added everything relevant to me"
confirmation flag. It is not: `buildDataQuality` tested row *presence* first
and only consulted the confirmation flag in the `else` branch, so a populated
section could never reach "Missing" through that path.

**Cause A — the report was a frozen snapshot (the dominant cause).**
`generateReport()` (`lib/services/reportsData.ts`) short-circuits on an
existing `ready`/`published` report for the same user + type + month and
returns its **stored** `report_sections` verbatim. Every section is built from
live data at build time — neither `buildDataQuality` nor `buildGoals` has any
period filter — so a report generated while only Income and Expenses existed
kept serving that text for the rest of the month, however much the household
entered afterwards. `29% complete` is exactly 2 of 7 sections. This is also
the root cause of item 5.

**Cause B — the table had no vocabulary between "present" and "absent".**
Even regenerated, an entered-but-unconfirmed section had only "Complete" or
"Missing" available. And `dashboard.hasAssets` is deliberately true when
investments **or** retirement rows exist (it feeds report *eligibility*, where
"any wealth at all" is the right question), while `dataFreshness['assets']`
queries only the `assets` table — so the Assets row could render the
self-contradicting combination **"Complete / Not provided / Included"**.

### Change made

**Cause A** — `lib/services/reportSnapshotResolver.ts` gains
`loadReportInputsLastChangedAt()` (the newest `updated_at` across the seven
registers plus `user_goals` and `user_financial_section_status`).
`generateReport()` still honours idempotency while the report is current; when
the underlying data has moved on, it regenerates through the **existing
revision mechanism** — new version, original marked `superseded`, lineage
preserved via `revises_report_id`, `revision_reason` recorded — rather than
silently overwriting or duplicating. This cannot loop: the regenerated row's
`generated_at` is newer than every input timestamp it was built from.

**Cause B** — `lib/engines/reportSections.ts`:

- Adds the **`in_progress`** status. This is not a new concept: `in_progress`
  is already one of the five canonical section statuses in
  `lib/engines/financialSectionStatus.ts` ("data exists but hasn't been
  confirmed complete"), and is already what the section pages tell the user
  ("This section counts as still in progress until you confirm it's
  complete"). This table simply never used it. Report treatment reads
  **"Included — not yet confirmed complete by you"**.
- Presence is now keyed off `dataFreshness[category] !== null` — non-null
  exactly when the register this row is *labelled for* has active rows, and
  the very timestamp rendered in the Last Updated column. Status and Last
  Updated therefore cannot disagree, by construction. This closes the Assets
  contradiction.
- The household-scoped dashboard flag is still used, but only to describe the
  treatment honestly: a register with rows that are all SMSF-owned (excluded
  from household figures per LR-FI-1) now says so rather than claiming
  "Included".
- **"Missing" is reserved for a register with genuinely no rows**, as the
  review requires.
- `IN_PROGRESS_COMPLETENESS_WEIGHT` is exported as a named, documented
  constant — see [Decision 2](#decision-2--the-completeness-weight-for-an-unconfirmed-section).

`components/dashboard/DataQualityPanel.tsx` gains an amber colour for
`in_progress` — deliberately the "something outstanding" amber, not the red
used for a genuinely missing section.

### Verification

**Live DEV, reproducing the reviewer's exact sequence**
(`tests/live-dev/appReview0915LiveDev.test.ts`, run through the real
`generateReport()` that every `app/api/reports/**` route calls, with full
cleanup and an independent zero-residue re-check):

*Phase 1 — only Income and Expenses exist (the reviewer's starting state):*

```
Income=in_progress Expenses=in_progress Assets=missing Liabilities=missing
Investments=missing Retirement=missing Insurance=missing
completeness: 28.57%          ← the reviewer's reported "29% complete"
```

*Phase 2 — the household enters assets, liabilities, investments, an SMSF and
a goal.*

*Phase 3 — the same month's report is requested again:*

```
Income=in_progress (dated) Expenses=in_progress (dated) Assets=in_progress (dated)
Liabilities=in_progress (dated) Investments=in_progress (dated)
Retirement=in_progress (dated) Insurance=missing (not provided)
completeness: 85.71%
```

and, asserted in the same run: the stale report was **not** returned
(`alreadyExisted === false`), a new version 2 was produced with
`revises_report_id` pointing at version 1, version 1's status is
`superseded`, every one of the four reported sections is no longer
`missing`, each has a real `lastUpdated`, and each reads "Included".

Acceptance criteria, all met: no longer Missing/Not provided ✓, Last Updated
shows real dates ✓, completion % rises (29% → 86%) ✓, items included in
calculations ✓.

**Unit** — `tests/unit/appReview0915DataQualityAndGoals.test.ts`, 12 tests,
including one that pins the no-regression property: a household that has
entered data but confirmed nothing still reads **29%**, not less.

---

## Item 5 — Monthly report says "No active goals" although one exists

### Root cause

**Primary cause: the same frozen snapshot as item 4.** The Goals section has
**no period filter at all** — `buildGoals` reads every goal whose `status` is
`'active'` at build time, with no date predicate whatsoever. The report was
simply built before the goal existed.

**Requirement 1, the query comparison, was run.** Both paths already call the
identical function:

- Monthly report: `reportSnapshotResolver.ts:216` →
  `computeGoalsPagePayload(userId, supabase)`
- Financial Goals page: `app/(app)/goals/page.tsx:28` → `loadGoalsPage()` →
  `computeGoalsPagePayload(userId)`

Same query (`user_goals`, `not status in (archived, cancelled)`), same
`status === 'active'` filter. They cannot disagree on which goals are active.

**Two secondary defects found while tracing it:**

- `hasGoals` was computed from `g.summary.activeGoalsCount` while the rendered
  table (and `ReportPreview`'s own guard) used `goalRows.length` — two
  independent definitions of the same fact, able to leave the narrative
  claiming "No active goals" above a populated table, or the reverse.
- **The section never carried the target or funded amount at all.** Even with
  a correctly-populated Goals section, `section_data_json` held only name,
  progress %, contributions, track status and target date — so the acceptance
  criterion ("lists the goal with its target, funded amount and status") could
  not have been met even when the goal appeared.

**Wording:** "No active goals were recorded **for this period**" implied a
period filter that has never existed, which made a stale snapshot look like a
deliberate period exclusion.

### Change made

- The staleness/auto-revision fix described under item 4 (shared root cause).
- `lib/engines/reportSections.ts` — `hasGoals` now derives from `goalRows`
  alone; `targetAmount`, `currentAmount` and `currencyCode` added to the
  section data; narrative changed to "You have no active financial goals."
- `components/reports/ReportPreview.tsx` — renders
  "Target $X · Currently funded $Y · <status>" per goal, using the same
  track-status labels the Goals page itself uses, so the report and the page
  describe the same goal with the same words. Empty-state copy aligned with
  the engine's.
- `lib/services/goalsData.ts` — `loadGoalsPage` now threads its client into
  `computeGoalsPagePayload` rather than letting it resolve a second one
  independently, removing the one latent divergence between the page's reads
  and its writes.

### Verification

Live DEV, same run as item 4. After the goal is created and the report
regenerates, the Goals section contains:

```json
[{"goalName":"Emergency fund","progressPct":49.69,"plannedContribution":541.67,
  "requiredContribution":4986.74,"trackStatus":"off_track",
  "targetDate":"2026-12-01","targetAmount":30000,"currentAmount":15000,
  "currencyCode":"AUD"}]
```

That is the reviewer's goal, with its target ($30,000), funded amount
($15,000) and status — the acceptance criterion in full. The narrative no
longer contains "No active goals".

---

## Item 6 — Consolidated Variance: unexplained Retirement figures and wrong Final Target

### 6.1 — Data lineage of the Retirement figures

**Requirement: "Report this back explicitly (`Retirement value = X + Y from
table Z`)."**

> **Retirement "Actual Till Date" = Σ `retirement_accounts.current_balance`**
> over every row where `user_id = <the user>` and `is_active = true`, each
> converted to the reporting currency at the `fx_rate_aud_inr` assumption.
>
> One table, one column, no second source.

Code path: `getForecastVariance` → `getCurrentActualValue`
(`lib/services/forecastData.ts:1424`) returns `dashboard.totalRetirement`,
which is computed at `lib/engines/dashboard.ts:810`:

```ts
const totalRetirement = input.retirement.reduce(
  (sum, r) => sum + reportingValue(r.currency_code, r.current_balance), 0);
```

`input.retirement` comes from `dashboardData.ts` —
`from('retirement_accounts').select(...).eq('user_id', userId).eq('is_active', true)`.

> **Retirement "Start Value" = Σ `forecast_results.opening_value` for
> `period_number = 1`** of the **earliest completed** retirement forecast run
> for the active scenario (`forecastData.ts:1581`). It is the retained
> original plan's opening position, not a live figure.

**On the review's specific suspicion — "see Item 3, migration 0084 backfilled
a `retirement_accounts` row" — this is a misreading of 0084, and there is no
double-count.** 0084 did *not* create a `retirement_accounts` row. It read the
**pre-existing** `retirement_accounts` row and created a **`smsf_funds`** row
mirroring it, in Summary Mode, explicitly leaving `current_balance` untouched
("zero Net Worth change"). `smsf_funds` is a different table and is **not**
summed into `totalRetirement`. An SMSF's canonical home is its single
`retirement_accounts` row, so its value is counted exactly once.

So a household showing **$271,000** with an SMSF of **$138,000** has
**$133,000 of other active retirement rows** (e.g. an employer super account).
The figure was never wrong — it was **unexplainable**, because the product
offered nothing to check it against. That is now fixed:

`CategoryVariance` carries **`actualBasis`** and **`finalTargetBasis`**,
naming the exact register and column each figure is summed from, rendered
beside every row on both the standalone Consolidated Variance page and the
report. The Retirement row now reads:

> *Sum of current_balance across every active row in your Retirement register
> (retirement_accounts), converted to your reporting currency. Your SMSF is one
> such row — its single canonical home — so its value is counted exactly once
> and is not added again from the SMSF fund record.*

### 6.2 — Final Target `$25`

#### Root cause — found exactly

`lib/services/forecastReportData.ts:103` requested the retirement forecast
with:

```ts
retirementDesiredAnnualIncome: Math.max(1, dashboard.essentialMonthlyExpenses * 12)
```

For a household with **no essential expenses recorded**, that floor supplied a
desired retirement income of **one dollar a year**. `resolveRequiredCorpus`
(`retirementCalculator.ts:97`) then divided it by the withdrawal-rate
assumption:

```
requiredCorpus = desiredAnnualIncome / (withdrawalRate / 100)
               = Math.max(1, 0 × 12) / (4 / 100)
               = 1 / 0.04
               = 25          ←  the reviewer's "Final Target $25"
```

`withdrawal_rate = 4.0` confirmed live in DEV's
`forecast_global_assumptions`. That `25` was written to every retirement
`forecast_results` row's `target_value`, read back by `getForecastVariance` as
`finalTarget`, and rendered as a confident "$25" beside a Remaining Gap of
−$4,258,956.

The calculator already documents the correct contract — *"Returns null when
the method's required inputs weren't supplied — callers must treat that as
'Insufficient Information', not as a zero target"* — and this `Math.max(1, …)`
floor was **the one caller defeating it**.

#### Change made

`forecastReportData.ts` now passes `undefined` when
`essentialMonthlyExpenses` is 0, restoring the calculator's own contract.
`finalTarget` is then `null`, `finalTargetGap` is `null`, the cell renders
"—", and `finalTargetBasis` explains why:

> *The required retirement corpus from your retirement forecast: your desired
> annual retirement income divided by the withdrawal-rate assumption. Shown as
> — when no desired income or target corpus has been set, and when no
> essential expenses have been recorded to derive one from.*

#### Verification — live DEV

Two synthetic households, real `buildForecastReportData()`:

*Household with essential expenses ($4,000/month):*

```json
{"actualTillDate":138000, "finalTarget":1200000,
 "revisedForecast":259045.03, "finalTargetGap":940954.97}
```

`$4,000 × 12 ÷ 4% = $1,200,000` — the **real** required corpus, and
`finalTarget − revisedForecast = finalTargetGap` exactly, so the target and
the gap are now mutually consistent (the acceptance criterion). `actualTillDate`
is `138000`, the sum of that household's `retirement_accounts.current_balance`
— the lineage above, proven live.

*Household with no essential expenses, holding the reviewer's own $271,000
retirement balance:*

```json
{"actualTillDate":271000, "finalTarget":null, "finalTargetGap":null}
```

Where it previously produced `25`, it now produces no target at all, with an
explanation — the reviewer's exact row, fixed, proven live.

### 6.3 — G1 and G2 on this table

Both applied. All ten amount columns on
`app/(app)/forecast/variance/page.tsx` and all six on the in-report table in
`components/forecast/ForecastReportContent.tsx` are right-aligned via the
shared `NUM_CELL_CLASS`/`NUM_HEADER_CLASS`, and every amount renders through
`formatMoneyWhole` (whole units).

---

## Item 7 — Goal Forecasts: unformatted decimals in narrative text

### Root cause

`lib/engines/forecast/goalCalculator.ts` interpolated raw floats straight into
the sentence — `${goal.monthlyContribution}` (giving `541.6666666666666`) and
`${requiredContribution?.toFixed(2)}` / `${contributionGap.toFixed(2)}`
(giving `3690.83`, `3149.16`). These strings are built server-side and
persisted into `forecast_explanations`, so no amount of UI formatting could
have fixed them.

The review asked for the **pattern** to be fixed, not the one string. It was
present in five engine files.

### Change made

`formatMoneyNarrative(amount, currencyCode)` added to `lib/engines/money.ts`
(whole units, per-entity currency), and every money interpolation in every
forecast-engine narrative routed through it:

| File | Fixed |
|---|---|
| `goalCalculator.ts` | contribution, required contribution, gap |
| `debtCalculator.ts` | repayment, total interest, rate-scenario deltas, cure/3-yr/5-yr payments, balances |
| `netWorthCalculator.ts` | planned-event amounts (also gained a real sign — they were unsigned before) |
| `resilienceCalculator.ts` | net worth impact, retirement impact |
| `crossBorderCalculator.ts` | local-currency return, currency gain/loss (signs preserved — a currency loss must not read as a gain) |

Before / after for the reviewer's own card:

> **Before:** `At the current contribution of 541.6666666666666/month plus
> assumed growth, this goal is projected to reach its target in month 25 of
> the forecast. To reach the target by 2026-12-01, the required monthly
> contribution is 3690.83 — a gap of 3149.16 above the current plan.`
>
> **After:** `At the current contribution of $542/month plus assumed growth,
> this goal is projected to reach its target in month 25 of the forecast. To
> reach the target by 2026-12-01, the required monthly contribution is $3,691
> — a gap of $3,149 above the current plan.`

### Verification

- Grep proof: **0** remaining `toFixed(2)` or bare `toLocaleString()`
  renderings of a monetary value in any forecast-engine narrative (was 9
  across 5 files). The only matches remaining are percentages, ratios and
  durations, which are out of G1's scope.
- `tests/unit/appReview0915DebtPayoffTerm.test.ts` asserts the debt narrative
  contains no raw float at all, by regex, in addition to checking specific
  amounts.
- **Note:** these strings are persisted at generation time, so existing
  `forecast_explanations` rows keep their old text. New forecast runs are
  correct. No backfill is proposed — a forecast explanation is a dated record
  of what was said at the time.

---

## Item 8 — Debt payoff forecast: calculation verification

### The amortisation is correct. Here is the proof.

The engine's recurrence (`monthlyPrimitives.projectLoanMonth`) is:

```
interest_n           = B_n × (annualRate / 100) / 12
principalReduction_n = repayment − interest_n − fees
B_(n+1)              = round2(max(0, B_n − principalReduction_n))
```

i.e. exactly the `B_{n+1} = B_n × (1 + r/12) − P` the review names.

The interest rate was recovered **backwards** from the balances in the
reviewer's own screenshots, then used to re-derive those balances
independently. Per loan:

| Loan | Opening balance | Rate (p.a.) | Repayment | 60-month balance | Reviewer saw | 120-month balance | Reviewer saw |
|---|---:|---:|---:|---:|---:|---:|---:|
| **SMSF property loan** | $365,000 | **7.25%** | $2,500/mo | **$343,757.99** | $343,758 ✓ | **$313,268.26** | $313,268 ✓ |
| **Construction Loan** | $290,100 | **6.97%** | $1,924/mo | **$273,002.00** | $273,002 ✓ | **$248,799.63** | $248,801 ≈ |
| **Investment loan 1** | $63,710 | **6.29%** | $0/mo | **$87,184** | $87,184 ✓ | **$119,307** | $119,307 ✓ |

Both of the SMSF loan's balances follow from a **single consistent rate**, to
the cent. That is the verification the review asked for: the maths is right.

The Investment loan 1 reconstruction is confirmed independently by three
further numbers the review itself quotes in item 9 — the cure payment
`333.95`, the 3-year clearing payment `1946.56` and the 5-year clearing
payment `1240.3` all fall out of the same $63,710 / 6.29% pair
(`interestOnlyPayment` → $334, `levelPaymentForPayoff(…, 36)` → $1,947,
`levelPaymentForPayoff(…, 60)` → $1,240). The reconstruction is therefore not
a fit — it is the actual input.

### Requirement 2 — is the rate the user's, or a default?

**In the Debt section: the user's.** `lib/services/forecastData.ts` reads
`liabilities.interest_rate` per loan. No product default is ever substituted.

The only fallback is `?? 0` when the user has left the field blank, which
projects the loan **interest-free** — previously invisible, presented as a
confident amortisation with no indication the rate was missing. Now disclosed:
`interestRateProvided` is threaded through and the explanation says *"No
interest rate is recorded for this debt, so it is projected interest-free. Add
the rate to get an accurate payoff term."*

**Outside the Debt section: NO — and this is a confirmed defect, fixed.**
See the next section.

### Requirement 4 — verification extended to Net Worth, Retirement and Goals

The reviewer's broader suspicion was well founded. Findings per section:

#### Net Worth

**Confirmed defect NW-1 — fixed. Liabilities were amortised at a hard-coded
6%, not the user's loan rates.** `netWorthCalculator`, `resilienceCalculator`
and `crossBorderCalculator` all resolved a `liability_interest_rate`
assumption that is **seeded nowhere**: no file in `supabase/migrations`
mentions the key, and `forecast_global_assumptions` on DEV returns **zero
rows** for it (verified live). So `getAssumptionValue` always fell through to
`DEFAULT_LIABILITY_RATE = 6`.

**A household with a 3.2% mortgage had that same loan amortised at 3.2% in the
Debt section and 6.0% in the Net Worth section of the same report**, off an
identical opening balance. This is the single best explanation of "the
underlying numbers look wrong across all reports": two sections of one report
that could not agree about one loan.

*Fixed:* the household's own balance-weighted rate
(`DashboardSummary.averageInterestRate`, computed from
`liabilities.interest_rate`) is threaded through all three calculators;
cross-border computes the same weighting over its own foreign-currency
population. The never-seeded assumption survives only for a household that
records no rate on any liability. The narrative now names the rate and its
source instead of saying "the standard reducing-balance formula", which
invited the reader to assume their own loan terms were used.

**Confirmed defect NW-2 — fixed. The per-period movement columns did not
reconcile to `closingValue`.** The liability leg's effect on net worth is
`+principalReduction`, but the rows recorded **both** `−interest` **and**
`−principalReduction`, summing to `−repayment`. The columns therefore missed
`closingValue` by `2 × repayment − interest` every single period — $1,500/month
on a $100,000 balance at 6% with a $1,000 repayment. Corrected to `−interest`
plus `+repayment`, which sums to exactly `+principalReduction`.
`closingValue` itself was always correct, and no UI reads these columns today
(the only consumer is the `forecast_results` write), so this corrects stored
data before anything is built on it. Same fix in all three calculators.

**Disclosed, not changed:** contributions are flat nominal for the whole
horizon despite `salary_growth` / `*_contribution_growth` being seeded and
unused; cash freed when a loan is paid off is never redirected into savings;
`businessEntityOwnershipValue` is in `dashboard.netWorth` but is not fed to
the forecast, so the forecast's starting net worth is below the figure quoted
elsewhere in the same report for households with business entities; a
household with no resolved country gets a third rate set (3% / 7% / 6.5%) that
matches neither AU nor IN, because `property_growth` / `equity` / `cash` /
`retirement` have no country-neutral seed rows.

#### Retirement

The core loop is **correct**: accumulation `B_m = (B_{m−1} + C)(1+r)`,
decumulation `B_m = (B_{m−1} − W)(1+r)`, exactly `M` contributions in months
1…M, `balanceAtRetirement` captured at `m === M`. **No off-by-one.** All
divide-by-zero paths are guarded. `withdrawal_rate` (4.0) and
`general_inflation` (3.0) are genuinely seeded.

Confirmed defects found, **reported not fixed** (see
[Decision 4](#decision-4--the-retirement-defects-are-a-workstream-not-a-patch)):

- **RET-1** — when no date of birth is on file, the narrative says
  *"Retirement age could not be projected… this forecast shows the
  accumulation trajectory only"*, but `readinessPct`, `status` and
  `fundingGap` are still computed off the month-120 balance as though month
  120 were the retirement date, and land in the explanation's inputs. The prose
  says it cannot be assessed; the data says `on_track`.
- **RET-2** — in that same branch, `yearsToRetirement ?? 0` makes the required
  corpus a **today's-money** figure compared against a **future nominal**
  balance, so readiness looks materially better than it is.
- **RET-3** — the balance is never floored at zero. Once a retiree's portfolio
  depletes, `(B − W)(1+r)` drives it further negative every month while the
  rows keep reporting the full withdrawal as though income were still being
  drawn.
- **RET-4** — in the per-member (Self/Spouse) split, each leg spreads
  `...input` and overrides only balance, contribution and ages, so
  `targetCorpus` / `desiredAnnualIncome` / `currentAnnualEssentialExpenses`
  (the **whole household's**) / `replacementPercentage` are inherited
  unchanged. Each member is measured against the entire household's target;
  both read as severely underfunded and the two gaps double-count the same
  target. Fires every time the split path runs.
- **RET-5** — `monthsUntilRetirementOverride` is not cleared in the leg input
  and short-circuits the per-member age calculation, so whenever
  `retirement_date` is set **both** members project to the same household
  horizon — silently nullifying the Self/Spouse split the module's own
  contract promises.
- **RET-6 (wording)** — `"Projected retirement balance at age ${retirementAge}
  (in ${months/12} years)"` welds two figures that are unrelated whenever an
  explicit retirement date is supplied: a 45-year-old with `retirement_age =
  67` and a retirement date three years out reads *"at age 67 (in 3 years)"*.

#### Goals

**Confirmed inconsistency GOAL-1 — the app has two live goal engines that
disagree on four separate conventions.** The same goal is projected by
`lib/engines/forecast/goalCalculator.ts` in the Consolidated Forecasting
report and by `lib/engines/goalForecast.ts` on the Financial Goals page and in
the Premium report's goal section:

| | Forecast report | Goals page |
|---|---|---|
| Monthly rate | geometric `(1+a)^(1/12)−1` | nominal `a/12` |
| Contribution timing | annuity-due `(B+C)(1+r)` | end-of-month `B(1+r)+C` |
| Target inflation | **none** | `inflationAdjustedTarget(…)` |
| Return rate | one `cash` rate for every goal | per-category rate × 3 scenarios |
| `target_amount_basis` | not even selected | honoured |

The same goal therefore shows a different completion month and a different
required monthly contribution on two screens of the same product — and the
Forecast version compares a nominal future balance against an **un-inflated**
target, which for a long-horizon goal understates the requirement
substantially. `goalMath.ts` even exports `inflationAdjustedTarget`, which
`goalCalculator.ts` never imports.

Also found, **reported not fixed**:

- **GOAL-2** — a goal with `target_amount = 0` reports *"This goal has already
  reached its target amount"* (`0 >= 0`). The row-level `variancePercentage`
  *is* guarded on `targetAmount > 0`; this completion check is not.
- **GOAL-3** — an overdue goal (past `target_date`) silently loses its
  required-contribution advice entirely, because `monthsToTargetDate` is
  negative.
- **GOAL-4** — the required-contribution solver is an **ordinary** annuity
  (`goalMath.requiredMonthlyContribution`, documented "paid at each
  month-end") used against an **annuity-due** projection, so the quoted
  "required monthly contribution" is ~`(1+r)` too high relative to the
  engine's own trajectory. Same mismatch in the retirement calculator.
- **GOAL-5** — the completion sentence never compares `completionMonth`
  against `monthsToTargetDate`, so a goal completing five years *late* reads
  identically to one completing early.

### Verification

`tests/unit/appReview0915DebtPayoffTerm.test.ts` (14 tests) re-derives the
reviewer's three loans' 60- and 120-month balances from the recovered rates
and asserts them against the screenshot figures.
`tests/unit/appReview0915ForecastSectionAudit.test.ts` (8 tests) pins both
fixed Net Worth defects — including a full
`opening + contributions + investmentReturn + interest + otherMovement ===
closing` reconciliation for every period — and pins the current behaviour of
the two Goals findings so the claims above are reproducible.

---

## Item 9 — "120-month" on every loan; payoff term must be derived

### Root cause

The only payoff figure the engine ever computed was **clipped to the forecast
window**. `debtCalculator`'s projection loop is
`for (let m = 1; m <= input.months && balance > 0; m++)`, and `payoffMonth`
was set inside it — so a loan that pays off in month 326 was literally
indistinguishable from one that never pays off at all. Both fell into the
`payoffMonth === null` branch, which emitted the same sentence:

> `At the current repayment of {X}/month, this debt is not projected to be
> paid off within the {input.months}-month forecast horizon.`

`input.months` defaults to `DEFAULT_MONTHS = 120`. Hence the identical
"120-month" clause on every card regardless of balance or repayment — it was
not hard-coded in the sense of a literal, but it carried no information about
the loan, which is the same thing from the reader's side.

### Change made

**`lib/engines/forecast/monthlyPrimitives.ts`** gains `derivePayoffTerm()` and
`formatTerm()`. `derivePayoffTerm` projects the **same** reducing-balance step
(`projectLoanMonth` — identical rounding, identical `max(0, …)` flooring, so a
derived term can never disagree with the balances rendered on the same card)
forward **past** the forecast window until the balance actually reaches zero,
capped at 1,200 months. It distinguishes three outcomes: a real term, a
balance that is growing because the repayment is below the interest, and a
balance that reduces but not to zero within a century.

**`lib/engines/forecast/debtCalculator.ts`** rewrites the narrative around
that, in the three shapes the review specifies. The forecast window is now
presented only as a window, never as the payoff statement. The derived term,
the horizon balance and the growing/beyond-cap flags are persisted in the
explanation's `inputs`, so the figure in the sentence is auditable. The
`formula` string now also states how the term is derived and that it is **not**
clipped to the window.

### Rate, formula and derived payoff term per loan

Formula, all loans: `B_(n+1) = round2(max(0, B_n − (P − B_n × r/12)))`;
payoff term = the smallest `n` for which `B_n ≤ 0` under that same recurrence,
searched to 1,200 months.

| Loan | Balance | Rate | Repayment | **Derived payoff term** | Balance at 10 yrs |
|---|---:|---:|---:|---|---:|
| SMSF property loan | $365,000 | 7.25% | $2,500/mo | **355 months — 29 years 7 months** | $313,268 |
| Construction Loan | $290,100 | 6.97% | $1,924/mo | **361 months — 30 years 1 month** | $248,801 |
| Investment loan 1 | $63,710 | 6.29% | $0/mo | **never — balance growing**; $334/mo stops the growth, $1,947/mo clears it in 3 years, $1,240/mo in 5 | $119,307 (grown) |

### Actual output, generated by the engine on this branch

> **SMSF property loan** — At the current repayment of **$2,500**/month, this
> debt is projected to be paid off in **29 years 7 months (355 months)** —
> beyond the 120-month forecast window. Balance after 10 years: **$313,268**.
> A 1% rate rise would add approximately $53,471 in total interest; a 1% rate
> cut would save approximately $47,768.
>
> **Construction Loan** — At the current repayment of **$1,924**/month, this
> debt is projected to be paid off in **30 years 1 month (361 months)** —
> beyond the 120-month forecast window. Balance after 10 years: **$248,801**.
> A 1% rate rise would add approximately $41,801 in total interest; a 1% rate
> cut would save approximately $37,358.
>
> **Investment loan 1** — At the current repayment of **$0**/month, this debt
> is **not reducing** — the repayment does not cover the interest accruing on
> it, so the balance grows to **$119,307** in 10 years. A minimum of **$334**/month
> stops it growing; **$1,947**/month clears it in 3 years. A 1% rate rise would
> add approximately $12,473 in total interest; a 1% rate cut would save
> approximately $11,302. $1,240/month would clear it in 5 years.
>
> **Small personal loan** (illustrating the inside-horizon branch) — At the
> current repayment of $1,000/month, this debt is projected to be paid off in
> **1 year 10 months (22 months)**, with $1,125 in total interest.

Every card is now distinct, every term is formula-derived, and every amount is
whole-number formatted per G1.

Note the cross-check this provides on item 8: **$53,471**, **$47,768**,
**$12,473**, **$334**, **$1,947** and **$1,240** are the same values the
reviewer's screenshots show as `53471.34`, `47768.03`, `12473.41`, `333.95`,
`1946.56` and `1240.3`. The new narrative is being generated from the same
engine values the reviewer saw — only the clipped term and the raw floats have
changed.

### Verification

`tests/unit/appReview0915DebtPayoffTerm.test.ts` — 14 tests:

- the derived term is 355 vs 361 months for the two mortgages (they used to
  print the identical sentence);
- `derivePayoffTerm` agrees exactly with the stored projection when the loan
  pays off inside the window (`balanceAt(term) === 0` and
  `balanceAt(term − 1) > 0`);
- "balance growing" is distinguished from "reduces too slowly to ever clear";
- `formatTerm` reads naturally at every boundary (1 month / 7 months / 1 year /
  2 years / 8 years 4 months / 27 years 2 months);
- the narrative no longer contains
  "not projected to be paid off within the 120-month forecast horizon";
- the narrative contains **no raw float at all**, asserted by regex;
- two different loans produce two different sentences.

---

## Decisions needed

### Decision 1 — the two G1 carve-outs

G1 is stated absolutely ("Every screen and every report"). Two categories are
currently exempted via `formatMoneyExact()`, and both are judgement calls:

1. **Literal transcriptions of an external source document**, shown next to
   that document for character-by-character verification —
   `PayslipImportPanel`, `LiabilityImportPanel`,
   `RetirementStatementImportPanel`. Rounding the extracted figure defeats the
   only purpose of the field.
2. **Payment invoice/receipt amounts** (`lib/services/payments/invoices.ts`) —
   these echo the exact amount charged by Stripe/Razorpay. A receipt that says
   $29 when $29.99 was charged is wrong, not tidy, and arguably a compliance
   issue.

If the PO wants G1 to override even these, deleting `formatMoneyExact` and
pointing its four call sites at `formatMoneyCode` is a one-line change per
site.

### Decision 2 — the completeness weight for an unconfirmed section

`IN_PROGRESS_COMPLETENESS_WEIGHT` is set to **1**, i.e. an entered-but-
unconfirmed section counts fully toward the headline percentage. Rationale:
the percentage answers "does the report have the data", and for an
`in_progress` section it does; item 4's requirement 2 says that data must be
included in calculations, and counting it at less than full weight would
contradict that in the one number users read. It is also the only value that
cannot regress an existing household — at 0.5 an income+expenses-only
household **dropped from 29% to 14%** with no data change (confirmed live).

The trade-off: the "I've added everything relevant to me" confirmation no
longer moves the percentage. It still changes the row's status from "In
progress" to "Complete", and the section narrative still reports what is
outstanding; health-score eligibility is unaffected (it uses the stricter
`isReviewed()`). If the PO wants the confirmation to carry numerical weight,
the constant is the single place to change.

### Decision 3 — auto-revision of a published report

Items 4 and 5 are fixed by regenerating a stale report through the existing
revision mechanism (new version, original `superseded`, lineage preserved).
This is the behaviour the review asks for — "ensure the report reflects current
data at generation time (or is regenerated on data change)". It does mean a
*published* monthly report can be superseded by a newer version when the
household edits their data, rather than standing as a fixed point-in-time
record. History is never lost, and the revision reason is recorded
("Automatically revised: your financial data changed after this report was
generated."). If a published monthly report is meant to be immutable, the
alternative is to surface a "this report is out of date — regenerate" banner
instead of revising automatically.

### Decision 4 — the Retirement defects are a workstream, not a patch

Items RET-1 through RET-6 and GOAL-1 through GOAL-5 were **found and verified
but deliberately not fixed on this branch**. RET-4/RET-5 in particular change
what every Self/Spouse household's retirement readiness reports, and GOAL-1 is
a decision about which of two goal engines is canonical — both are product
decisions with certification implications, not bug fixes to fold into a review
response. They are documented above with file/line evidence and pinned in
tests where the current behaviour matters.

Recommendation: scope RET-1…RET-6 as one corrective round, and GOAL-1 as its
own (it requires choosing a single goal engine and re-certifying both surfaces
against it).

---

## Changes on this branch

| Commit | Scope |
|---|---|
| `e87c04f` | G1 whole-unit currency standard; items 7, 8, 9 forecast narratives |
| `97660dc` | Items 1, 3, 4, 5, 6; G2 right-aligned amount columns |
| `2d7e26c` | Item 2 XIRR root cause; item 3 wider audit; test suites |
| `c790e09` | Item 8 req 4 — forecast-wide verification, 2 confirmed defects fixed |
| `182f59f` | Restore original CRLF line endings in one file (whitespace only) |

### Tests added

| File | Tests | Covers |
|---|---:|---|
| `tests/unit/money.test.ts` | 18 | G1 |
| `tests/unit/g2AmountColumnAlignment.test.ts` | 1 (repo-wide) | G2 |
| `tests/unit/iiXirrPortfolioTerminalValue.test.ts` | 10 | Item 2 |
| `tests/unit/appReview0915MigrationTextLeakGuard.test.ts` | 4 | Item 3 + permanent guard |
| `tests/unit/appReview0915DataQualityAndGoals.test.ts` | 12 | Item 4 |
| `tests/unit/appReview0915DebtPayoffTerm.test.ts` | 14 | Items 7, 8, 9 |
| `tests/unit/appReview0915ForecastSectionAudit.test.ts` | 8 | Item 8 req 4 |
| `tests/live-dev/appReview0915LiveDev.test.ts` | 1 (multi-phase) | Items 4, 5, 6 — live DEV |

### Suite status

- `npx tsc --noEmit` — **clean**.
- `npx eslint app components lib` — **0 errors on every file touched** (only
  pre-existing `<img>` warnings).
- `npx vitest run` — **6,465 passing**. The 17 failing files are a strict
  **subset of the pre-existing failures on `main`** (verified by stashing this
  branch's work and re-running): environment-dependent `resources*` /
  `*LiveDev` suites that need credentials this run does not provide, plus
  stale SMSF/DTI engine assertions in files this branch does not touch. **Zero
  new failures**; two previously-failing files (`money.test.ts`,
  `paymentsCheckoutRoute.test.ts`) now pass.
- `npx vitest run --config vitest.livedev.config.ts tests/live-dev/appReview0915LiveDev.test.ts`
  — **passing** against hosted DEV, with zero synthetic residue independently
  re-verified.

### Outstanding

**Migration `0154` must be applied manually via the Supabase SQL Editor — DEV
first, then production.** Nothing else on this branch is blocked. Until it is
applied, 303 rows in DEV still carry the leaked migration text from item 3
(production counts unknown — a read-only production probe was blocked by this
environment's permission policy).

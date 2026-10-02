# Multi-folio fund fix: Performance and X-Ray aggregate across folios

Branch `fix/ii-multifolio-performance-xray-20261001`, cut from `fix/document2-finding5-nav-stripe-types-20261001` (`398a0cb`). Not pushed, not merged. Benchmark (BENCH-1) work is excluded. Ownership semantics are untouched.

**Evidence labels.** *code-complete* = the change exists and compiles. *test-proven* = unit tests with named negative controls pass. *DEV-verified* / *production-verified* = observed on a running environment. **Nothing in this report is DEV-verified or production-verified.** No browser, DEV or production session was used.

---

## 1. The defect, with exact locations (state on `398a0cb`)

A fund held in several folios is several `ii_accounts` rows sharing one `ii_instruments` row. `ii_holding_snapshots` is unique on (account, instrument, as_of_date), so each folio has its own statements.

| Consumer | File and lines (base) | What it did | Effect |
|---|---|---|---|
| **Performance** (scheme and portfolio value, scheme XIRR, portfolio XIRR, valuation series) | `analyticsRepository.ts` `snapRows` select (l.169) carried no `account_id`; `snaps = snapRows.filter(instrument)` (l.317); `valuationSeries = snaps.map(...)` (l.348); latest = the last element (l.365-375); `currentValue = latestSnap.units * latestNav` (l.431) | Snapshots were grouped by **instrument only**. The "latest snapshot" was whichever folio's row had the newest date. Only that folio's units were marked to NAV. The transactions of **all** folios were still in `cashFlows` (filtered by instrument only, l.316). | Terminal value counted one folio; the flows counted all. Scheme value and XIRR understated (in the worked fixture XIRR was **-34.7% instead of +18.5%**). The dated valuation series mixed folios' single values, so weights and drawdown were wrong. |
| **X-Ray** (position value, AMC and category exposure, report data) | `r5Repository.ts` `loadXrayDataset`: `latestByInstrument` / `statementsByInstrument` keyed by instrument (l.349-361); `valueHoldingAsOf({statements: statementsByInstrument.get(id)})` (l.385); one position per instrument (l.436-453) | Same: one folio's latest statement valued the whole fund. Also the NAV read floor (l.376) used the latest date per instrument, not per folio. | Fund exposure understated (the second folio vanished); AMC bucket and portfolio total wrong; a redeemed folio dated later than a live folio zeroed the whole fund. |
| Holdings table | `holdingsRepository.ts` | Already valued per (account, instrument). **Correct.** But `investorXirrByInstrument.get(instrumentId)` (l.174, l.320) gave **every folio row the same scheme-level XIRR**. | Two rows showed one repeated number (and, before this fix, a wrong one). |
| Overview | `overviewSummary.ts` | Already per (account, instrument). **Correct.** | none |
| Folio ledger (modal) | `transactionLedger.ts` l.128, l.176-183 | Per (account, instrument) ledger, but its closing value was the raw statement value (not marked to NAV), so it disagreed with the Holdings row since Finding #5. | Per-folio XIRR in the modal differed from the row. |
| Units after the statement | all consumers | The shared valuation rule used the statement's units only. A transaction dated after the latest statement was never added; only a warning was shown. | Value omitted money the investor had put in (or still showed units already redeemed). |

**Which snapshot was chosen.** In Performance, the last element of the instrument-filtered, ascending-date list. In X-Ray, the first element of the descending-date list for the instrument. In both, a tie on date between two folios resolved to one arbitrary folio.

**Transactions.** Filtered by instrument only (all folios included), which is correct for the scheme's flow union, and was left as is: each flow appears once, nothing is double counted.

---

## 2. What was fixed (code-complete and test-proven)

Only the valuation **input assembly** changed. R4, R5 and R6 arithmetic (XIRR solver, TWRR, benchmark, exposure engines) is untouched. The scheme XIRR is still `computeSchemePerformance` over a cash-flow list; that list is now the union of the folios' flows plus one terminal value equal to the sum of the folios' values.

| Piece | Change |
|---|---|
| `valuation/schemeValuation.ts` (new, pure) | `valueSchemeAcrossFolios`: values each folio from **its own** statements and later unit movements with the shared rule `valueHoldingAsOf`, then sums units and value. A folio with no statement on or before a point-in-time date is `unavailable` and contributes nothing. `aggregateFolioValuationPoints`: dated scheme value = sum over folios of each folio's latest statement on or before each date; one folio returns its points unchanged. |
| `valuation/currentHoldingValuation.ts` | New **rule 8** (optional `unitMovements`): units dated strictly after the statement and on or before the valuation date are added. See section 3. New output fields `statementUnits`, `unitsAfterStatement`, `unitsAfterStatementApplied`. With no movements the output is identical to before. |
| `currentValuationLoader.ts` | `toUnitMovement` / `groupUnitMovements` (signed unit change via the same `unitDeltaForTransaction` direction table the reconciliation engine uses; reversed and review_required excluded) and `loadUnitMovementsSince` (bounded, paged read). |
| `analyticsRepository.ts` (Performance) | Selects `account_id` on snapshots and transactions. Values each folio, sums. Scheme `currentValue` = sum, dated at the latest folio valuation date, **one** terminal flow. `valuationSeries` = folio-aggregated step series. Builds per-folio flows (`folios[]`, only when a scheme has more than one folio). Warns when a folio has transactions but no statement. A redeemed scheme keeps its pinned GOLD-003 date. |
| `analyticsOrchestrator.ts` | `SchemeDataset.folios?` and `SchemeAnalytics.folioXirr?`: each folio's XIRR through the **same** `computeSchemePerformance` call (same history gate, same solver). Additive; no existing number changes. |
| `r5Repository.ts` (X-Ray) | Statements grouped per folio; NAV read floor is the oldest latest statement of **any folio**; unit movements loaded; ONE position per scheme carrying the summed value (exposure counted once; AMC `schemeCount` counts schemes). Report data inherits it. |
| `holdingsRepository.ts` | Passes unit movements per folio. Multi-folio rows show **their own** XIRR (`folioXirr`); single-folio rows are unchanged (scheme figure). |
| `overviewSummary.ts` | Passes unit movements per folio position. |
| `transactionLedger.ts` | Closing value from the shared rule (NAV-marked, later units), so the modal XIRR equals the Holdings row. With no newer NAV and no later units the output is unchanged. |

Joint/owner scoping is untouched: no touched file reads or writes `owner_member_id` or any ownership column (a test greps for that).

---

## 3. Units after the snapshot date (rule 8): what it does, precisely

Movements are the position's own non-reversed, non-`review_required` transactions, signed by the reconciliation engine's own direction table.

- Counted only when dated **strictly after** the statement date and **on or before** the valuation date. A movement on the statement's own date is already inside the statement figure (never counted twice); a future-dated one is ignored.
- Units = statement units + net movements. Priced at the latest eligible market NAV when one is newer than the statement; otherwise at the **statement's own NAV** (basis stays `statement`, and the note says units were added).
- Net exactly 0 gives `redeemed`, value 0, dated at the last movement.
- **Not applied, and disclosed in the note**: a result that would go negative (data inconsistency), and the corner where the statement held 0 units and no newer NAV exists (nothing to price the new units with).
- It is per folio: a purchase in folio 2 lifts folio 2 only.
- If the latest eligible NAV is older than a counted transaction, the later units are valued at that NAV (an approximation, noted).

This is a behaviour change visible on every screen: a holding with transactions after its last statement now shows those units. It is the main thing for the PO to confirm (section 7).

---

## 4. Worked fixture: before and after (INR, today = 2026-09-28)

Fixture (all numbers hand-computed in the test header): S1 HDFC Flexi Cap in **two folios** (F1 600 units, statement 2026-06-30; F2 400 units, statement 2026-08-31; latest NAV 130 on 2026-09-25); S2 ICICI Bluechip 500 units; S3 HDFC Mid-Cap 300 units (same folio as F1). Three schemes, two AMCs.

Both columns were produced by running the same fixture against the **real repositories**; "before" is the pre-fix repository files (`398a0cb`) swapped in temporarily, then restored.

| Quantity | Before | After | Expected (oracle) |
|---|---|---|---|
| Performance, S1 current value | 52,000 (F2 only) | **130,000** | 600x130 + 400x130 |
| Performance, S1 scheme XIRR | -34.73% | **+18.51%** | 18.5106% (independent bisection) |
| Portfolio XIRR | -13.48% | **+14.55%** | 14.546% (independent bisection) |
| X-Ray, S1 position | 52,000 | **130,000** | |
| Report data total portfolio value | 144,000 | **222,000** | 130,000 + 56,000 + 36,000 |
| AMC "HDFC Mutual Fund" | 88,000 (61.1%) | **166,000 (74.8%)** | 130,000 + 36,000 |
| AMC "ICICI Prudential Mutual Fund" | 56,000 | 56,000 | |
| Holdings F1 / F2 value | 78,000 / 52,000 | 78,000 / 52,000 (unchanged, was correct) | |
| Holdings F1 / F2 XIRR | -34.73% / -34.73% (one repeated figure) | **16.62% / 22.49%** | 16.616% / 22.493% (oracle) |
| Overview total | 222,000 | 222,000 (unchanged, was correct) | |
| Dated valuation series S1 on 2026-08-31 | 48,000 | **114,000** (66,000 + 48,000) | |
| Redeemed folio + live folio, S1 value | 0 (the redeemed folio's later statement won) | **78,000** | |

Units after snapshot (single folio, 100 units, statement 2026-06-30 value 10,000, a 20-unit purchase on 2026-09-10, NAV 140 on 2026-09-25): before **14,000**, after **16,800** (120 x 140) in Holdings, Performance, X-Ray, Overview and Report data; XIRR equals the oracle over {-9,500, -2,600, +16,800}.

**Reconciliation to the rupee (test-asserted):** Holdings total, Performance total, X-Ray total, Overview total and Report data total are one set `{222000}`.

---

## 5. Tests (all in `tests/unit/`)

New: `iiMultiFolioAggregation.test.ts` (**23 tests**) and `support/filteringSupabase.ts` (a copy of the Finding #5 filtering double, so that suite stays untouched). Each rule is a check function run against the real code (must pass) and against a broken variant (must throw the rule's own named message). The XIRR oracle is a small independent bisection in the test, not FHIP's `xirr()`.

| Test group | What is proven | Negative control: the failing assertion |
|---|---|---|
| MF-1 two folios aggregate | Holdings per folio; Performance, X-Ray, Overview, Report data and AMC buckets all reconcile (130,000 / 222,000; HDFC 166,000 with 2 schemes) | `RULE MF-1: two folios must aggregate (expected 1000 units / 130000, got 400 / 52000)` for the pre-fix pick-one-statement logic; picking only the older folio gives 78,000, not 130,000 |
| MF-2 XIRR | scheme, per-folio and portfolio XIRR equal independent oracles; folio XIRRs differ from the scheme figure; single-folio row = scheme figure | `MF-2: scheme XIRR must equal the union-of-flows oracle (expected 0.1851, got ...)` when the check is given the one-folio-only expectation |
| MF-3 redeemed + live | scheme = live folio only (78,000); redeemed folio 0 and labelled; XIRR includes the redemption | `RULE MF-3: the live folio must still count next to a redeemed folio (expected 78000, got 0)` |
| MF-4 units after snapshot | +20 units, -30 units, full redemption, same-day not double counted, future-dated ignored, reversed / review_required ignored, negative balance not applied, no-NAV priced at statement NAV, unpriceable disclosed, per-folio attribution | `RULE MF-4: units transacted after the snapshot must be counted (expected 120 units / 16800, got 100 / 14000)` |
| MF-5 different owners | one Holdings row per folio with its own account and value; `folioXirr` keyed by account; no ownership column touched (source grep) | n/a (attribution test); the grep fails if any touched file mentions ownership |
| MF-6 cross-user isolation | another user's folios of the same fund change nothing, both directions | the double without the user filter returns both users' rows, so the green isolation test is not vacuous |
| MF-7 point-in-time | as of 2026-08-15 only F1 exists (72,000); F2's later statement does not leak | `pointInTime:false` gives a different value (leak), `true` gives 72,000 |
| MF-8 valuation series, orphan folio | series sums folios; a folio with transactions but no statement is disclosed | `RULE MF-8: ... on 2026-08-31 must include both folios (expected 114000, got 48000)` |
| MF-9 single folio unchanged | no `folios[]`, no `folioXirr`, same value, row XIRR = scheme XIRR | n/a (regression guard) |
| MF-10 folio ledger | each folio's modal closes on its own 78,000 / 52,000 with its oracle XIRR and equals the Holdings row | n/a |

**Negative control proven against the real pre-fix code.** I restored the four pre-fix repository files (`analyticsRepository.ts`, `r5Repository.ts`, `holdingsRepository.ts`, `overviewSummary.ts` from `398a0cb`) and ran `iiMultiFolioAggregation.test.ts`: **11 of 21 repository-level tests failed with real assertion failures** (the 2 ledger tests were added afterwards; the 10 that still passed are the pure-rule tests, the MF-9 single-folio regression guard and the isolation control, which by design do not depend on the multi-folio assembly). Examples: `expected 52000 to be 130000` (Performance, X-Ray), `expected -0.3473 to be close to 0.1851` (scheme XIRR), `expected +0 to be 78000` (redeemed + live), `expected [100, 14000, 'market_nav'] to deeply equal [120, 16800, 'market_nav']` (units after snapshot), `expected 400 to be 450` (per-folio purchase). Then the fix was restored.

**Unchanged suites, run on this branch, all pass:**
- 10-point golden suite: `iiNavMarkToMarketGoldenFixtures` (15), `iiNavMarkToMarket`, `iiPortfolioTwrrValuationReconstruction`.
- Finding #5: `iiFinding5CurrentHoldingValuationRule` (32), `iiFinding5CrossConsumerNavConsistency` (17).
- Also `iiHoldingsTableAssembly`, `iiHoldingsTransactionLedgerRunningBalance`, `iiXirrPortfolioTerminalValue`, `iiR4AnalyticsRepositoryPagination`, `iiR5AmcMappingWired`, `iiR6P0Beyond1000RowCalculation`, `iiReportImmutabilityMarkToMarket`, `iiPc2WorkspaceUiContract` (13 files, 128 tests before the MF suite was added).
- #15 exactly-once and publication: `lrFi3NetWorthContributionExactlyOnce`, `iiPublishing`, `iiR3NetWorthCertification`, `iiR3RepublishFieldRestoration`, `iiR3ProvenanceClosure`: **5 files, 61 tests pass.** Publication code was not touched.
- Broad sweep (`tests/unit/` prefixes `ii`, `investment`, `pc5`, `pc6`, `pc7`, `nav1`, `xray`, `r5`, `report`, `navCoverage`, `fdh11`): **177 files, 2790 tests: 2784 passed, 5 skipped, 1 failed.** The one failure, `iiAiReviewBeforeWrite` ("a usable AI read stops at ai_review_pending"), is a 20 s test timeout under machine load; re-run in isolation: **4 of 4 pass**.
- `scripts/` artifacts rewritten by test runs were reverted (`git checkout HEAD -- scripts/`).
- ESLint on every touched and new file: exit 0.
- `tsc --noEmit -p .`: the only error, before and after, is the pre-existing `tests/unit/canonicalCertResidueAllSql.test.ts(127,75): TS18046`. No new errors.

---

## 6. Merge hotspots

Trial `git merge-tree` of this branch with `feat/owner-entity-joint-edit-resolutions-20261001` and `feat/owner-before-upload-phase1-20261001`: **no textual conflicts** (those branches are based on `cce323f`, before Finding #5, so they will conflict with Finding #5 itself, not with this change).

**Net Worth branch** (`feat/networth-current-nav-remark-20261001`; its changes are uncommitted in `D:\FHIP\.claude\worktrees\networth-nav-remark`, so I compared files, not commits). No file overlaps. Semantic overlaps to handle at merge:
1. Its `publishedRowRemark.ts` calls `valueHoldingAsOf()` for each published row (one per position/folio). That is compatible with this change (rule 8 is optional), but unless it passes `unitMovements` (use `loadUnitMovementsSince` from `currentValuationLoader.ts`, already imported by `publishedValueRemark.ts`), a Net Worth line will not include units added after the statement while Holdings does. Recommend wiring it in after both merge.
2. `HoldingValuation` gained three always-present fields (`statementUnits`, `unitsAfterStatement`, `unitsAfterStatementApplied`). I found no hand-built `HoldingValuation` literal in that branch, so nothing should break, but a `tsc` run after the merge is the proof.
3. It also edits `lib/read-models/investments.ts` and `investmentPublicationService.ts`, which this change does not touch.

**Owner-edit branch** (`feat/owner-entity-joint-edit-resolutions-20261001`): touches `lib/read-models/investments.ts`, `investmentPublicationService.ts`, `documentProcessing.ts`, `publicationLogic.ts` and adds ownership modules. No overlap with this change. If it later scopes Performance/X-Ray by owner, the natural seam is the per-folio inputs introduced here: `valueSchemeAcrossFolios` takes a list of folios, so an owner filter is "pass fewer folios". Not done here, by instruction.

---

## 7. Limitations (not hidden) and PO decisions

**Not verified.** No browser, DEV or production session. The Holdings UI does not yet show a dedicated tag for "includes units after the statement"; the information is in the existing `valuationNote` tooltip. `tests/live-dev` suites were not run.

**Known limitations:**
- **One terminal value per scheme.** A scheme's folios can be valued on different dates (one from a market NAV, another from a newer statement). The scheme XIRR gets ONE terminal flow of the summed value at the **latest** folio valuation date (the engine's one-terminal invariant). Folio-level XIRR uses each folio's own date. The difference is a few days of timing on part of the value.
- **A folio with transactions but no statement** cannot be valued; it is disclosed as a warning and contributes 0 to value while its flows stay in the scheme's flows.
- **Performance's portfolio `totalValue`** (a chart series figure) comes from the reconstructed/valuation series, not the NAV-marked current value; unchanged and, in the fixture, already 222,000 before the fix.
- **Extra reads.** Holdings, Overview, X-Ray and the ledger each add one bounded read of `ii_transactions` (only rows newer than the oldest statement, columns needed for a signed unit change); normally zero rows.
- **SIP** is per (account, instrument) already and was not changed.
- `lib/read-models/investments.ts` (Net Worth read model) and the positions / professional-proxy routes are per position and were not changed.

**PO decisions:**
1. **Units after the snapshot, no newer NAV.** I price the extra units at the statement's own NAV and keep the label `statement`, with a note. Alternative: hold them back and only warn, so `statement` always means exactly the statement value. Recommended: keep as built (more complete); say if you prefer the stricter reading.
2. **One terminal value per scheme at the latest folio date** (above) versus one terminal flow per folio at each folio's own date. Recommended: keep.
3. Whether the Net Worth branch should pass `unitMovements` (section 6, point 1) so Net Worth, Holdings and Performance agree on later units.

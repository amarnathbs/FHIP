# Document2 Finding #5 closure report, and the `stripe` type-declaration investigation

Branch `fix/document2-finding5-nav-stripe-types-20261001`, cut from `origin/main` at `cce323f`. Not pushed, not merged. Benchmark (BENCH-1) work is excluded throughout.

**Evidence labels used.** *code-complete* = the change exists and compiles. *test-proven* = unit or integration tests with named negative controls pass. *DEV-verified* / *production-verified* = observed on a running environment. **Nothing in this report is DEV-verified or production-verified.** No signed-in browser or database session was available.

---

## 1. Finding #5: consumer inventory (state on `origin/main` before this change)

Requirement: the latest valid NAV is used for the current holding; the correct NAV date is shown; a stale statement NAV does not remain the current NAV once a newer valid NAV exists.

| # | Consumer | File | NAV / value used before | Latest **eligible** NAV? | NAV date shown | Could a statement NAV pass as the current NAV? |
|---|---|---|---|---|---|---|
| 1 | **Holdings table** | `holdingsRepository.ts` (`loadHoldingsTable`) | Statement snapshot only: `value`, `value/units`, `as_of_date`. `ii_prices_nav` never read. | No | Statement date, presented under the "NAV date" heading | **Yes. This is the Finding #5 defect.** |
| 2 | Performance / scheme table | `analyticsRepository.ts` | Mark-to-market (units x latest NAV newer than the snapshot), added 2026-09-30 | Partly: quality `ok` and `<= asOfDate` were enforced; **currency was not**, and a **zero/negative price was not**; the anchoring snapshot was **not** bounded by an explicit `to` date | NAV's own date (`currentValueDate`) | No, except via a later statement leaking into an explicit historical `to` view |
| 3 | **X-Ray** (positions, AMC and category exposure) | `r5Repository.ts` (`loadXrayDataset`) | Statement `value` only | No | "Positions as at" = latest statement date | **Yes** |
| 4 | **Overview** | `overviewSummary.ts` | Sum of statement `value` per currency | No | Latest/oldest statement date under "Valued as at" | **Yes** |
| 5 | **Report data** | `investmentIntelligenceReportData.ts` | Delegates: Performance via #2, X-Ray via #3. No value logic of its own. | Inherits #2 / #3 | Inherits | Yes, through #3 |
| 6 | SIP closing value | `r5Repository.ts` (`loadSipDataset`) | NAV at or before as-of date (10-day window) | Partly: excluded only `superseded`, so `stale` / `suspicious_jump` NAVs were usable; no currency or price check | NAV's own date (`navDateUsed`) | No |
| 7 | Portfolio Truth **publication** | `investmentPublicationService.ts` | Certified statement `snapshot.value`; never reads `ii_prices_nav` | n/a, by design | The statement date is recorded as `valuationAsOfDate` in the audit/preview payload | See section 4: bounded, not changed |
| 8 | Statement-derived values (`ii_holding_snapshots.value`) | all of the above | Source evidence. Unchanged. | n/a | n/a | Only through consumers 1, 3, 4 |

NAV table semantics relied on (verified in migrations `0033`, `0043`, `0155` and in `referenceIngestJob.ts` / `navReconciliationSweep.ts`): `ii_prices_nav` has `unique (instrument_id, price_date)`, so a source **correction is an in-place update** of the single row, with the prior value preserved in `ii_reference_corrections`. "A corrected NAV supersedes the prior value" is therefore true by construction for every reader of the stored row, and the tests pin it. `quality_status` is one of `ok`, `suspicious_jump`, `stale`, `superseded`. A DB trigger (`0155`) rejects future-dated rows. The table carries `currency_code`.

## 2. Precise gap statement (what was partial)

1. **Holdings table, X-Ray and Overview valued every position at its last statement, however old, and labelled that date as the NAV date.** A newer valid NAV in `ii_prices_nav` was ignored by all three. Only Performance had been fixed (mark-to-market, 2026-09-30), so the same holding could show different values on different screens.
2. **The NAV eligibility rule was not uniform.** Performance ignored currency and accepted a zero/negative price; SIP accepted `stale` and `suspicious_jump` rows and also ignored currency.
3. **A historical (`to=`) Performance view could still anchor on a statement dated after that date.**
4. **No consumer carried an explicit label for "this number is a statement value", an explicit "stale" disclosure, or an explicit "redeemed" state.**

Not part of this finding, recorded for honesty in section 6: units after the snapshot date, multi-folio funds in Performance/X-Ray, publication freezing the statement value.

## 3. What was fixed (code-complete and test-proven)

**One rule, one module:** `lib/engines/investment-intelligence/valuation/currentHoldingValuation.ts` (pure, no I/O). `valueHoldingAsOf()` and `selectLatestEligibleNav()`.

- Current value of a non-redeemed holding = units x **latest eligible NAV** when that NAV is **strictly newer** than the statement; otherwise the statement value, **labelled as a statement value**.
- Eligible NAV = dated on or before the valuation date (a future-dated NAV can never influence an earlier valuation), `quality_status` null or `ok`, price finite and greater than 0 (a zero price is a data fault, never a "value of 0"), and in the holding's own currency when both sides state one.
- Same-date duplicates: the later row wins (matches the in-place correction semantics).
- Point-in-time mode (`pointInTime: true`) uses only statements dated on or before the date, so a later statement can never leak into an earlier view. The default current view always keeps the latest statement, because a statement dated "today" in India/Australia can be a day ahead of UTC for part of the day and must not blank a real holding.
- units = 0 gives exactly 0, basis `redeemed`, no NAV consulted.
- No statement gives `unavailable` (null), never a fabricated 0.
- Staleness is disclosed (more than 7 calendar days between the valuation's own date and the valuation date; the number is never altered).
- The statement NAV and date are always retained as evidence (`statementNav`, `statementAsOfDate`, `statementSuperseded`).

**Consumers changed to use it** (minimal; the certified R4/R5/R6 arithmetic is untouched, only the valuation *input* is selected):

| Consumer | Change |
|---|---|
| Holdings table (`holdingsRepository.ts`, `HoldingsTable.tsx`) | `nav`, `navDate`, `marketValue`, gain/loss and return % now come from the shared rule. New fields: `valuationBasis`, `navSource`, `statementAsOfDate`, `statementNav`, `statementSuperseded`, `valuationStale`, `valuationNote`. UI shows **Statement** / **Redeemed** / **Stale** tags beside the NAV date, with a tooltip. |
| X-Ray (`r5Repository.ts`) | Position values and `portfolioAsOfDate` (the "Positions as at" date) come from the shared rule; a `valuation` warning lists positions valued from a NAV/statement older than 7 days. Point-in-time (`asOfDate`) honoured. This flows into Report data automatically. |
| Overview (`overviewSummary.ts`, `OverviewClient.tsx`) | Totals per currency and "Valued as at" dates use the shared rule; new `portfolio.valuation` tally (market NAV / statement / redeemed / stale counts); footnote states the basis and discloses stale positions. |
| Performance (`analyticsRepository.ts`) | Uses `selectLatestEligibleNav` (adds currency and price-validity guards; offers only NAVs newer than the snapshot so the exclusion warning is about rows that matter). An **explicit** `to` date now also bounds the anchoring statement. Default "now" behaviour is unchanged. |
| SIP (`r5Repository.ts`) | NAV load uses the same quality (`ok` only), price and currency eligibility. |
| Shared read helper | `currentValuationLoader.ts`: one batched, paged read of NAV candidates newer than the oldest relevant statement. |

**Existing 10-point #5 golden suite** (`iiNavMarkToMarketGoldenFixtures.test.ts`, `iiNavMarkToMarket.test.ts`, `iiPortfolioTwrrValuationReconstruction.test.ts`): **unchanged and green.**

## 4. Publication: a bounded decision, not changed

Publication writes `current_value = snapshot.value` and a `published_value`, keyed to the exact certified snapshot (idempotency, "exactly once", and the production-verified #15 flow depend on this). Making it mark-to-market would change what "published" means and could break duplicate protection. It was therefore **left as a statement-basis, frozen value**, and a contract test pins both facts (it publishes `snapshot.value` and records the statement date; it never reads `ii_prices_nav`). The Overview footnote now tells the user this. **PO decision needed** (section 7).

## 5. Tests (all in `tests/unit/`), with negative controls

| File | Tests | Negative controls: what fails when the rule is broken |
|---|---|---|
| `iiFinding5CurrentHoldingValuationRule.test.ts` | 32 | Each of 11 rules is a check function run against the real code (must pass) **and** against a deliberately broken variant (must throw the rule's own named message). Controls: statement-only valuation fails `RULE-1` ("expected market value 12000") and `RULE-5`; no date bound fails `RULE-2` ("future-dated NAV leaked"); ignoring point-in-time fails `RULE-3`; first-wins on a same-date duplicate fails `RULE-4` ("expected the corrected 105"); statement NAV shown as current fails `RULE-5` ("statement NAV masquerades as current"); statement labelled market fails `RULE-6`; requiring a NAV for a redeemed holding fails `RULE-7` ("redeemed holding with no NAV must be exactly 0"); a later NAV resurrecting a redeemed holding fails `RULE-7`; no currency guard fails `RULE-8` ("an AUD NAV was applied to an INR holding"); no stale disclosure fails `RULE-9`; no quality guard fails `RULE-10` ("a flagged NAV was used"); accepting a zero price fails `RULE-10`; fabricating 0 for a missing statement fails `RULE-11`. Plus boundary tests (on-the-day NAV, 7 vs 8 days stale, UTC-ahead statement, partial redemption). |
| `iiFinding5CrossConsumerNavConsistency.test.ts` | 17 | Drives the **real** repositories against a filtering Supabase double (real `gte`/`lte`/`is`/`in`/`order`/`range`/head-count; the shared fake treats `gte`/`lte` as no-ops and could not prove a date bound). **Cross-consumer consistency:** Holdings, Performance, X-Ray, Overview and Report data all show 12000 dated 2026-09-25 (100 units, latest eligible NAV 120) while ignoring a wrong-currency NAV, a `stale`-flagged NAV and a future NAV. Also: statement-only fallback, redeemed holding with and without a later NAV, 18-day-old NAV disclosed as stale everywhere, correction (105 vs 98) read by every consumer, point-in-time (11000 on 2026-08-20; 15000 today), as-of before any statement gives no value, SIP uses the same eligible NAV, publication contract. |
| `dependencyTypesIntegrity.test.ts` | 12 | See section 8. |

**Negative control proven against the real pre-fix code.** I restored the four pre-fix repository files (`holdingsRepository.ts`, `analyticsRepository.ts`, `r5Repository.ts`, `overviewSummary.ts` from `cce323f`) and ran the cross-consumer suite: **14 of 17 failed with real assertion failures**, then restored the fix. Examples of the failing assertions on the old code: `expected 10000 to be 12000` (Holdings stale statement value), `expected 14400 to be 11000` (a later statement leaking into the 2026-08-20 view), `expected [10000, 5000, 10000, 10000, 10000] to deeply equal [...]` (the old Performance **applied an AUD NAV of 50 to an INR holding**, giving 5000), `expected 14400 to be +0` (as-of before any statement back-filled with a later statement), and the SIP series still containing the flagged and foreign-currency NAVs. So the tests are demonstrably capable of failing.

**Verification runs (all on this branch):**
- Targeted: the three new files plus `iiNavMarkToMarketGoldenFixtures`, `iiNavMarkToMarket`, `iiHoldingsTableAssembly`, `iiPortfolioTwrrValuationReconstruction`: **7 files, 92 tests, all pass.**
- Broad sweep (`tests/unit/` prefixes `ii`, `investment`, `pc5`, `pc6`, `pc7`, `nav1`, `xray`, `r5`, `report`, `navCoverage`, `fdh11`): **176 files, 2767 tests, 4 failures, every one a 5000 ms timeout under heavy machine load** (`pc5Prohibitions`, `iiR4Certification50Case`, `fdh11Isolation`, `fdh11InvestmentIntegrityPglite`). Re-run in isolation: **4 files, 41 tests, all pass.**
- `scripts/` artifacts rewritten by the test run were reverted with `git checkout -- scripts/`.
- ESLint on every touched and new file: clean (exit 0).
- `tsc --noEmit -p .`: the only error, before and after, is the pre-existing `tests/unit/canonicalCertResidueAllSql.test.ts(127,75): TS18046`. **No new errors.**

## 6. Remaining limitations (not hidden)

- **Browser proof not done.** No signed-in session was available. Protocol: `docs/investment-intelligence/DOCUMENT2_FINDING5_UI_CHECK_PROTOCOL.md`.
- **Units after the snapshot date.** The valuation uses the statement's units. A transaction dated after the latest statement is not added to the units; the existing "transactions after the latest valuation date" warning remains the disclosure.
- **Same fund in more than one folio.** Holdings is per folio. Performance and X-Ray work per fund and read the latest statement's units only (pre-existing). Not changed here.
- **Benchmark column window.** `loadHoldingsTable` still passes the statement date as the benchmark window end. With a market NAV the row's return runs to the NAV date. Left untouched because BENCH-1 is excluded; flagged for that workstream.
- **Overview live-DEV suite** (`tests/live-dev/iiPc2WorkspaceLiveDev.test.ts`) asserts `latestAsOfDate` and totals from seeded data with no newer NAV; it was not run (no DEV access), and should give the same values unless the seed has newer NAVs.
- **Stale threshold of 7 days** is a disclosure threshold chosen here (covers a long weekend plus a holiday); it never changes a number.

## 7. Recommended status and PO decisions

**Finding #5: recommend moving from PARTIAL to "PASS, code-complete and test-proven" for:** latest eligible NAV selection, correct NAV date shown, statement NAV no longer presented as current when a newer valid NAV exists (Holdings, X-Ray, Overview, Report data), future-dated / flagged / foreign-currency / zero-price NAVs ignored, redeemed holding needs no NAV, correction semantics, point-in-time, stale disclosure, cross-consumer agreement.
**Keep "browser / production verification: not done"** until the UI protocol is run on DEV and production.

PO decisions:
1. Should Net Worth publication stay frozen at the certified statement value (current, recommended), or be re-marked to the latest NAV? The latter changes idempotency and the #15 flow and needs its own design.
2. Confirm the 7-day stale threshold.
3. Whether to schedule the multi-folio fix for Performance / X-Ray (separate from Finding #5).

---

## 8. Repository `stripe` type-declaration defect (TS7016)

**Result: does NOT reproduce on the healthy shared install.**

Evidence:
- Full `tsc --noEmit -p .` on a fresh worktree of `origin/main` against `D:\FHIP\node_modules`: the only error is the unrelated `canonicalCertResidueAllSql.test.ts` TS18046. **No TS7016 in `app/api/payments/stripe/webhook/route.ts`, `lib/services/payments/invoices.ts` or `lib/services/payments/stripeClient.ts`**, both before and after this change.
- Declared / locked / installed agree: `package.json` `^22.6.1`, `package-lock.json` `22.6.1`, `node_modules/stripe/package.json` `22.6.1`. The declaration has been `^22.6.1` since the payments commit `b4f58b5`, so there was never a version mismatch in history.
- Stripe 22 has no top-level `types` field. Typings are reachable through the `exports` map (`default.import.types` -> `esm/stripe.esm.node.d.ts`, and `default.require.types` -> `cjs/stripe.cjs.node.d.ts`). The repo's `tsconfig.json` uses `moduleResolution: "bundler"`, which honours `exports`, and the import style (`import Stripe from 'stripe'`, `esModuleInterop: true`) is correct for this version.
- `razorpay` (2.9.8, `types: dist/razorpay`), `pdf-parse` (2.4.5, typed through `exports`), `xlsx` (0.18.5, `types/index.d.ts`) and `@axe-core/playwright` (4.13.0, dev, `types`/`exports`) are each declared, locked, installed at the locked version, and resolve to a `.d.ts`.

**Why the Pass-2 agent saw it (cause, reproduced rather than assumed).** I copied the installed `node_modules/stripe` into a scratch folder, deleted every `.d.ts`, and compiled `import Stripe from 'stripe'` with the repo's resolution settings. Result: **exactly `TS7016: Could not find a declaration file for module 'stripe' ... stripe.esm.node.js implicitly has an 'any' type`**. The same file against an intact copy compiles cleanly. The error therefore means *the installed `node_modules/stripe` lacked its `.d.ts` files* (an incomplete, interrupted or partially extracted install, plausible on a heavily loaded Windows machine), not a repo defect. I could not inspect that agent's `node_modules`, so this is the only mechanism I found that produces that exact message for the declared version; it is not proven to be what happened to them.

**Fix: none to the code, versions or declarations.** A `declare module 'stripe'` shim would have silenced the real typings everywhere and was rejected; no dependency was changed; no Stripe or Razorpay logic was touched. What was added is a guard, `tests/unit/dependencyTypesIntegrity.test.ts` (12 tests): it asks the TypeScript compiler (repo tsconfig) how each of the five packages resolves and fails with the package name if any resolves to untyped JavaScript (the TS7016 condition); it checks declared vs locked vs installed versions; and it has a **negative control** (a synthetic package laid out like stripe 22, one install with its `.d.ts` present and one without, which must resolve `.d.ts` and `.js` respectively). Any future incomplete install now fails this test with a precise message instead of three confusing compile errors.

**Production build path.** A full `next build` was not run (machine heavily loaded). The Next.js build type-check is the same TypeScript program as `tsc --noEmit -p .`, which passes for these files. A clean `npm ci` of the locked versions delivers the package's own declarations; the TS7016 condition only arises if an install is incomplete, and the new test surfaces that. I did not observe the Amplify build itself.

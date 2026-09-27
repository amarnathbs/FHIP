# Manual vs Imported Equivalence Certification (golden pair)

Approved Upload -> Canonical User Data programme, stage 3. Date: 2026-09-27.
Branch: `feature/canonical-upload-cert` (consolidated; the golden-pair certifier's branch
`feature/canonical-cert-golden-pair` @ `1870fe8` is merged in).

## Verdict

**PASS (DEV), with disclosures.** Household M (typed by hand into the input tabs) and Household I (the same
economics entered ONLY as documents: payslip, AUD bank, spouse INR bank, credit card, loan, AU broker,
super -> review -> approve / Apply) produce **$0 unexplained variance** across every consumer the brief
lists. Every difference that exists is assigned to a named, reviewed explanation class; a difference no
class explains fails the run.

Disclosures (none contradicts the verdict; each is repeated in FINAL_COMPLETION_REPORT.md):

1. The golden pair was measured live on the certifier's branch (`1870fe8`), before the stage-3
   consolidation merge. The consolidation did **not** re-run the full M/I journeys on the merged tree (a
   second run would leave another ~12 undeletable applied card/loan rows on DEV, GP-H1). What the merge
   could change is covered instead by: (a) the combined precedence test
   `tests/unit/readModels/effectiveBucketPrecedence.test.ts` (D1 + R9 + rule 10 in one household, with each
   fix reverted in turn as a negative control); (b) the offline re-run of the variance tooling on the
   merged tree against the certifier's saved measurements (PASS, 0 unexplained) and its injected negative
   control (FAIL, 3 headline + 2 leaf variances named); (c) the consolidation's live DEV recheck on the
   merged code (range A, forecast.tc025, 13/13: card $220 never $440 with the repayment user-filed as
   Shopping, the unlinked refund, liability +1,000, Net Worth -1,000, Dashboard expenses == the expense
   read model) and the live R9 recheck (range A, forecast.tc034, 4/4: SELL 15,000 filed as income -> +400
   only).
2. GP-8 (a live injected read failure showing "unavailable", never 0) was not run live; it is covered by
   unit tests (`tests/unit/secrevDashboardFailClosed.test.ts`, the read-model fail-closed suites).
3. The equivalence holds on the COMBINED expense basis every consumer uses. PLANNED and ACTUAL differ by
   design (M typed a plan; I has statements and applied the WP-15 average only for groceries, because rent
   is category-only -- GP-O3). See the live finding on combined-basis group displacement in
   FINAL_COMPLETION_REPORT.md (open PO decision).
4. Two manual-entry limits make M's register rows differ in SHAPE, not value (GP-O1: one catalogue row per
   item type -- a second groceries line in INR and a second share holding are custom rows in M).

## Method (as run by the golden-pair certifier, range A, DEV)

- User: `forecast.tc010@example.test` (existing synthetic fixture user), localhost `127.0.0.1:3971`
  against DEV `vqycarelcoijzwlpkpcz`. M and I ran sequentially on the same user, so profile, goals and
  insurance are identical. The user's 19 standing register rows were neutralised (inactive, catalogue key
  cleared), saved in the residue ledger and restored with 0 drift.
- Household economics: `scripts/canonical_cert/golden_pair/economics.ts`. Journeys:
  `journey_m.ts` (the grid POSTs each input tab makes), `journey_i.ts` (the exact request sequence of each
  import panel). Measurement: `measure.ts` reads every consumer through the real routes (Dashboard, income /
  expense actuals, assets, liabilities, investments, retirement, health score, DNA, resilience, Twin
  generate, 6 forecast runs, monthly report sections).
- Comparison: `variance_table.ts` diffs every leaf of every response. Headline metrics are printed per
  consumer; every other differing leaf must match a named explanation class or it is printed UNEXPLAINED
  and the run exits 1.
- Negative control: an injected measurement (+1 Net Worth, +0.5 on one forecast row, +1 on one score
  component) -> `RESULT: FAIL -- 3 headline + 2 leaf variances unexplained`, naming each.
- Consolidation re-run of the tooling (merged tree, offline, the certifier's saved measure files):
  `variance_table.ts --a M --b I` -> `RESULT: PASS -- 0 unexplained variances` (exit 0);
  `--b I-injected` -> `RESULT: FAIL -- 3 headline + 2 leaf variances unexplained` (exit 1).

## Other live checks in the same run

| Check | Result |
|---|---|
| Before Apply (all 8 documents uploaded, nothing approved) every consumer effect 0 | PASS (only "6 waiting" and the bank-balance "not in Net Worth" note show) |
| After Apply reflected on the next request | PASS (payslip Apply -> Dashboard gross 6,700 / net 5,000 on the next GET) |
| Prior complete month counts | FIXED (GP-D3: the panels never sent the statement period; August now covered, 2,916.55 counted) |
| Currency never added across AUD/INR | PASS (INR 5,600 -> 96.55 AUD, INR 94,400 -> 1,627.59 AUD at 58; never raw) |
| Self vs spouse | PASS (the spouse INR account keeps owner spouse in both households) |
| Repeat Apply after measurement | PASS (7 x 409 ALREADY_APPLIED, publish LEAVE_UNCHANGED, no consumer change) |
| Error != 0 live (injected read failure) | NOT RUN live (unit-tested only) |

## Defects the golden pair found (all fixed, each with a test that fails before the fix)

| Id | Severity | Defect | Fix (now on the consolidated branch) |
|---|---|---|---|
| GP-D1 | P0 | AU "Add to Net Worth" always failed on a real DB (`fdh11:<id>` written to a uuid column) | statement id used as the correlation id (same fix as SUI-3; one implementation kept) |
| GP-D2 | P1 | bank statement approved BEFORE the card/loan statement: repayment never linked | forward match on card/loan approval (`lib/import-bridge/liabilityBankBackMatch.ts`) |
| GP-D3 | P1 | Expenses / Liabilities panels never sent the statement period -> $0 counted | panels collect and send the period (`components/expenses/bankUploadParams.ts`) |
| GP-D4 | P2 | Apply-written card/loan lines never categorised, blank description | classifier gives a FIRST category to source-typed approved rows; raw description shown |
| GP-D5 | P2 | applied bank balance still disclosed "not in Net Worth" | one rule: assets model open-only total + `bankBalancesNotInNetWorth()` (same as econ D3 / SUI-6) |
| GP-D6 | P1 | cash asset from a bank balance had no country (dropped from per-country views) | asset takes the account's upload country |
| GP-H1 | hazard | an applied liability chain cannot be deleted row by row, even by the service role | pinned in `tests/unit/gpImportChainDeletion.test.ts`; PO cleanup SQL (see residue) |

## Variance table (M vs I), verbatim from `scripts/canonical_cert/golden_pair/evidence/variance-M-I-2026-09-27.md`

| Consumer | Metric | M | I | Diff |
|---|---|---|---|---|
| Income | gross monthly (Dashboard) | 6700 | 6700 | 0 |
| Income | net monthly (Dashboard) | 5000 | 5000 | 0 |
| Income | combined gross (income read model) | 6700 | 6700 | 0 |
| Income | combined net (income read model) | 5000 | 5000 | 0 |
| Expenses | combined monthly (Dashboard basis) | 2916.5517 | 2916.5517 | 0 |
| Expenses | combined monthly (expense read model) | 2916.5517 | 2916.5517 | 0 |
| Expenses | essential monthly | 2916.5517 | 2916.5517 | 0 |
| Expenses | lifestyle monthly | 0 | 0 | 0 |
| Expenses | planned monthly (M: typed; I: WP-15 averages applied) | 2916.5517 | 916.55 | -2000.0017 (explained: BASIS (contract section 5): M typed a PLAN; I has approved ACTUALS and applied the WP-15 average only for groceries (rent is category-only -- GP-O3). The combined basis every consumer uses is equal.) |
| Expenses | actual monthly (approved statements) | 0 | 2916.5517 | 2916.5517 (explained: BASIS: M has no statements by definition; the combined basis is equal.) |
| Assets | total assets (core) | 21807.58620689655 | 21807.58620689655 | 0 |
| Assets | assets + investments + retirement | 135951.33620689655 | 135951.33620689655 | 0 |
| Liabilities | total liabilities | 399950 | 399950 | 0 |
| Liabilities | debt service monthly (D-08/D-09) | 2000 | 2000 | 0 |
| Liabilities | register balance sum (Liabilities tab) | 399950 | 399950 | 0 |
| Investments | total investments | 12500 | 12500 | 0 |
| Investments | register value sum (Investments tab) | 12500 | 12500 | 0 |
| Investments | imported, not yet in Net Worth | 0 | 0 | 0 |
| Retirement | total retirement | 101643.75 | 101643.75 | 0 |
| Retirement | employer contribution monthly | 575 | 575 | 0 |
| Net Worth | Dashboard net worth | -263998.6637931034 | -263998.6637931034 | 0 |
| Cashflow | monthly surplus | 83.44830000000002 | 83.44830000000002 | 0 |
| Cashflow | savings rate | 0.016689660000000002 | 0.016689660000000002 | 0 |
| Cashflow | debt service ratio | 0.4 | 0.4 | 0 |
| Cashflow | debt to income | 4.974502487562189 | 4.974502487562189 | 0 |
| Cashflow | emergency fund months | 7.47718142863593 | 7.47718142863593 | 0 |
| Score | overall health score | 46.24400000000001 | 46.24400000000001 | 0 |
| DNA | primary profile | "future_ready_professional" | "future_ready_professional" | 0 |
| DNA | primary score | 90.89 | 90.89 | 0 |
| DNA | confidence | 79.73125 | 79.73125 | 0 |
| Resilience | overall score | 69.64 | 69.64 | 0 |
| Resilience | accessible liquid resources | 21807.58620689655 | 21807.58620689655 | 0 |
| Twin | metrics compared | 54 | 54 | 0 |
| Twin | ahead / aligned / behind | "8 / 0 / 22" | "8 / 0 / 22" | 0 |
| Twin | overall confidence | 55.9 | 55.9 | 0 |
| Forecast | net worth run input hash | "b99858f76399" | "b99858f76399" | 0 |
| Forecast | resilience run input hash | "86fa655b43ac" | "86fa655b43ac" | 0 |
| Forecast | retirement run input hash | "f324157b0488" | "f324157b0488" | 0 |
| Report | net worth (report net_worth section) | -263998.6637931034 | -263998.6637931034 | 0 |
| Liabilities | rows: type/balance/rate/repayment/min/limit/owner/currency | "\"credit_card\"|1500|null|0|30|5000|\"self\"|\"AUD\"|\"AU\" ; \"mortgage\"|398450|6.14|2000|null|null|\"self\"|\"AUD\"|\"AU\"" | "\"credit_card\"|1500|null|0|30|5000|\"self\"|\"AUD\"|\"AU\" ; \"mortgage\"|398450|6.14|2000|null|null|\"self\"|\"AUD\"|\"AU\"" | 0 |
| Assets | rows: class/value/currency/country/owner | "\"cash\"|20180|\"AUD\"|\"AU\"|\"self\" ; \"cash\"|94400|\"INR\"|\"IN\"|\"spouse\"" | "\"cash\"|20180|\"AUD\"|\"AU\"|\"self\" ; \"cash\"|94400|\"INR\"|\"IN\"|\"spouse\"" | 0 |
| Income | rows: type/gross/net/frequency/currency/owner | "\"salary\"|6700|5000|\"monthly\"|\"AUD\"|\"self\"" | "\"salary\"|6700|5000|\"monthly\"|\"AUD\"|\"self\"" | 0 |
| Retirement | rows: balance/currency/country/owner | "101643.75|\"AUD\"|\"AU\"|\"self\"" | "101643.75|\"AUD\"|\"AU\"|\"self\"" | 0 |
| Dashboard | liabilityByType (as a set) | "{\"debtType\":\"credit_card\",\"balance\":1500} ; {\"debtType\":\"mortgage\",\"balance\":398450}" | "{\"debtType\":\"credit_card\",\"balance\":1500} ; {\"debtType\":\"mortgage\",\"balance\":398450}" | 0 |
| Dashboard | assetsByCountry (as a set) | "{\"countryCode\":\"AU\",\"value\":20180} ; {\"countryCode\":\"IN\",\"value\":94400}" | "{\"countryCode\":\"AU\",\"value\":20180} ; {\"countryCode\":\"IN\",\"value\":94400}" | 0 |
| Dashboard | netWorthByCountryConverted (as a set) | "{\"countryCode\":\"AU\",\"value\":-278126.25} ; {\"countryCode\":\"IN\",\"value\":1627.5862068965516}" | "{\"countryCode\":\"AU\",\"value\":-278126.25} ; {\"countryCode\":\"IN\",\"value\":1627.5862068965516}" | 0 |
| Dashboard | countriesInUse (as a set) | "\"AU\" ; \"IN\"" | "\"AU\" ; \"IN\"" | 0 |
| Forecast | net worth projected results | "120 rows; sha 29706089977ad83a" | "120 rows; sha 29706089977ad83a" | 0 |
| Forecast | resilience projected results | "120 rows; sha face9ba970a6ff8e" | "120 rows; sha face9ba970a6ff8e" | 0 |
| Forecast | retirement projected results | "120 rows; sha 517d5c08f610ec8f" | "120 rows; sha 517d5c08f610ec8f" | 0 |
| Forecast | debt projected results | "240 rows; sha 671e9e26ce574695" | "240 rows; sha 671e9e26ce574695" | 0 |
| Forecast | investment projected results | "120 rows; sha 9def1dadb07c79c7" | "240 rows; sha 988ca7d1aa88c052" | DIFFERENT (explained: GRANULARITY (GP-O1): 1 manual portfolio line vs 2 imported holdings -> 120 vs 240 entity rows; per-period totals compared below.) |
| Forecast | cross-border projected results | "120 rows; sha 35ffc69d8633d791" | "120 rows; sha 35ffc69d8633d791" | 0 |
| DNA | propertyDebtBreakdown (as a set) | "{\"purpose\":\"consumer\",\"currencyCode\":\"AUD\",\"liabilityCount\":1,\"totalBalance\":1500} ; {\"purpose\":\"owner_occupied\",\"currencyCode\":\"AUD\",\"liabilityCount\":1,\"totalBalance\":398450}" | "{\"purpose\":\"consumer\",\"currencyCode\":\"AUD\",\"liabilityCount\":1,\"totalBalance\":1500} ; {\"purpose\":\"owner_occupied\",\"currencyCode\":\"AUD\",\"liabilityCount\":1,\"totalBalance\":398450}" | 0 |
| Forecast | net_worth per-period totals, 120 periods (max |diff| any column) | "120 periods" | "120 periods" | 0 |
| Forecast | resilience per-period totals, 120 periods (max |diff| any column) | "120 periods" | "120 periods" | 0 |
| Forecast | retirement per-period totals, 120 periods (max |diff| any column) | "120 periods" | "120 periods" | 0 |
| Forecast | debt per-period totals, 120 periods (max |diff| any column) | "120 periods" | "120 periods" | 0 |
| Forecast | investment per-period totals, 120 periods (max |diff| any column) | "120 periods" | "120 periods" | 0.04 (explained: CENT ROUNDING: each entity row is rounded to the cent every period; 2 rows vs 1 row compound to at most 4 cents over 120 months (period 1 and 120 checked by hand: 13.15 + 52.62 = 65.77; 4,692.80 + 18,771.44 = 23,464.24).) |
| Forecast | cross_border per-period totals, 120 periods (max |diff| any column) | "120 periods" | "120 periods" | 0 |


### Explanation classes for every other differing leaf (from the same run)

```text
All other leaves: 5480 differing, 3705 identity/clock.
    93  REGISTER ROWS: same economics, different row shape (names, provenance labels, row order/granularity; I stores annual contributions and imported line-by-line rows)
   152  PROVENANCE / EVIDENCE VIEW: imported actual lines, statement links and import history exist only for I (M has none by definition)
    23  EVIDENCE VIEW: bank closing-balance proposals exist only for I (already applied, shown as "Already added")
     5  MANUAL-ENTRY LIMIT (GP-O1): M can hold ONE "groceries" catalogue row; the INR groceries is a custom row that the core-survival rule (keyed by master_item_key) does not recognise; I's INR groceries line is categorised groceries
     1  DESCRIPTOR: the part of combined expenses that came from statements (I 100%, M 0%); the combined total is equal
    48  PRESENTATION: top-N lists name planned ITEMS for M and canonical GROUPS for I; employer name read from the synthetic payslip as "PTY LTD" (parser observation GP-O2)
    28  ORDER ONLY: same members and values in a different array order (register row order)
     1  DISCLOSURE (D-09): I knows the 430 interest + 20 fee inside the 2,000 repayment from the loan statement; M cannot; debt service is 2,000 in both
     4  ORDER ONLY: same members and values in a different array order (checked as a set in the table)
     1  MANUAL-ENTRY LIMIT (GP-O1): M records the share portfolio as ONE catalogue line (100% "largest holding"); I imports two holdings (BHP 80%)
     4  FORECAST INPUT HASH: covers row names / row granularity (debt: liability names; investment: 1 vs 2 holdings); the projected results are compared leaf by leaf below
  5083  FORECAST RESULT ROWS: positional leaf diff of entity rows returned in a different order (and, for investment, 1 vs 2 holdings); certified by the order-independent row / per-period-total checks in the table
    36  CLOCK: data-quality "last updated" timestamps of each run
     1  IDEMPOTENT: M was measured twice in the same month, so the second generate returned the existing report for that month (content compared leaf by leaf)

RESULT: PASS -- 0 unexplained variances
```

## Residue

The golden-pair run left 48 DEV rows (8 applied card/loan chains of forecast.tc010) that the service role cannot
delete (GP-H1). They are included, row-count-asserted, in `scripts/canonical_cert/dev_residue_ALL_for_PO.sql`
(see END_TO_END_IMPORT_PROPAGATION_CERTIFICATION.md, Residue).

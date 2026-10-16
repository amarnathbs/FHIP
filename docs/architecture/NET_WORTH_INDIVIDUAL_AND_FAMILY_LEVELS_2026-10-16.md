# Net Worth at two levels: individual and consolidated family (design note, 16-10-2026)

Status: implemented on branch `feat/networth-individual-and-family-20261016`, not pushed. Evidence labels are in section 9.

SUPERSEDED IN PART (16-10-2026, second ruling): sections 2 and 5 and decision 3 of section 7 describe `summary.netWorth` as the family-basis figure. It is now the PERSONAL figure; read section 10 first.

## 1. The PO decisions this implements (16-10-2026, genuine, from the user in chat)

1. Net Worth is presented at TWO levels on the Dashboard, the Monthly Report and the Net Worth section:
   - INDIVIDUAL (personal) level: per person (Self, Spouse/Partner), joint items allocated by the ownership split;
   - CONSOLIDATED FAMILY level: everything, including entity assets (SMSF, Family Trust, HUF, Company).
   Example given: "Other Retirement Assets" (AUD 133,000, owner SMSF) must show in the consolidated family figure.
2. Entity treatment at the family level: SMSF in full; Family Trust in full; HUF in full; Company AS PER SHARE (the household's ownership percentage).
3. This REFINES the 21-09-2026 entity-data-separation ruling. Entity data is still captured separately at input; the consolidated family figure is a reporting-time view that includes entities, clearly labelled, and is never silently blended into the individual figures. It supersedes the old LR-11 model in which entity value flowed into one blended Net Worth without saying so.

## 2. How Net Worth worked before this change (inventory)

| Topic | Behaviour (all verified in code) |
|---|---|
| Formula | `computeDashboard()` (lib/engines/dashboard.ts): `netWorth = assets + investments + retirement - liabilities + businessEntityOwnershipValue`. |
| Registers | ALL owners, unfiltered. A row tagged `smsf`, `family_trust` or `company` counts in full (LR-FI-1 section 28, "wealth stays whole"). `owner` was not even selected for assets/investments/retirement by the Dashboard loader. |
| Registered entities | `business_entities` (Company, Family Trust, HUF): `ownership_percentage x net asset value`, for ALL three types, added on the assets side. |
| SMSF property loan | The fund's retirement balance is already NET of its linked loan (migration 0084: net in Summary AND Detailed mode), and the loan's liability row was subtracted again: the open P0-1 double deduction (an SMSF with 500,000 property and a 365,000 loan reported -230,000, not 135,000). |
| Cash flow / DTI / DSR | SMSF-owned income, expenses, repayments and DTI balance are excluded (householdContext.ts). Unchanged. |
| Excluded from Net Worth by design | Imported-not-yet-published holdings, bank closing balances not applied as assets, entity-owned Investment Intelligence accounts in the "not yet in Net Worth" bucket. Unchanged. |
| Surfaces | Dashboard card (VitalSignsStrip) and "Net Worth Dashboard" section (sections.tsx NetWorthSection); Monthly Report Net Worth section (reportSections.ts buildNetWorth, ReportPreview.tsx). There is no standalone Net Worth page (the only other "net-worth" route is the Forecast projection). |
| Who else reads `summary.netWorth` | Health Score ratios, Financial DNA, Resilience, Forecast opening balance and variance, Financial Twin, AI context, stored monthly `financial_snapshots.net_worth`, report month-on-month movement. |
| Today's reported number | For the PO household: 2,896,298 assets - 1,385,857 liabilities = 1,510,441. That number INCLUDES the 133,000 owner-SMSF row without saying so: it is the consolidated family figure in all but name. |

## 3. The model (single source of truth)

`lib/engines/netWorthLevels.ts` (pure) builds `NetWorthLevels`; `lib/services/netWorthLevelsData.ts` loads it from the SAME canonical snapshot the Dashboard already uses (read models: assets, investments, retirement, liabilities lines, each converted once at the single household rate) plus the registered entities. `loadDashboardContext()` attaches it as `summary.netWorthLevels`. The Dashboard card, the Net Worth section and the Report all read that one object (the report stores it in the Net Worth section data), so they cannot disagree.

Allocation of a register row by its owner tag:

| Owner tag | Where it counts |
|---|---|
| self / spouse | that person's individual figure |
| joint | divided by the ownership split, counted ONCE (shares total exactly 10,000 basis points, largest-remainder rounding, never 200%) |
| child / other / no owner | personal level, own line "Other household items" |
| smsf | SMSF entity block (full) |
| family_trust / company (legacy tags) | their entity block, counted as entered (the tag carries no percentage) |
| registered Company | entity block at the household's ownership percentage (net asset value x percentage; in Detailed mode assets and liabilities are scaled pro rata, net identical) |
| registered Family Trust / HUF | entity block in FULL (the recorded percentage is shown but not applied) |

Joint split rule: a recorded split (Investment Intelligence `ii_ownership_allocation`, by member, mapped to Self/Spouse) when one exists and totals exactly 100%; otherwise the K.6 default of equal shares (50/50). Registers have no stored split field, so plain joint rows use the default and the screen says so.

Reconciliation, line by line: `personal total + SMSF + Family Trust + HUF + Company = family total`.

## 4. No double counting (each rule has a named test)

- Joint: one pool, two shares that add back to the pool.
- SMSF property loan: a liability linked as `smsf_property_loan` to a fund that exists and is active is already inside that fund's NET balance, so it is NOT deducted again. It is listed as a memo on the SMSF block and as an explicit bridge line. A loan whose fund is not found, or a plain SMSF-tagged liability, has no netting anywhere, so it is deducted once, at the SMSF entity.
- A registered entity enters once, as net value x share; its underlying assets are never also counted.
- SMSF member balances (retirement rows owned by a person, such as the PO's SMSF 503,000 owner self) are personal; rows tagged SMSF (such as 133,000) are the fund's own. Neither appears in the other.
- Possible duplicate entry (a legacy company/trust owner tag AND a registered entity of that kind) cannot be detected row by row, so it is warned about on screen.

## 5. Today's figure stays reproducible

`summary.netWorth` is UNCHANGED and remains the basis for ratios, scores, forecasts, snapshots and report month-on-month movement. The model carries a `bridge` that turns the family figure back into that previously reported number with explicit lines, and shows an "unexplained" line if it ever fails to:

- no entities, no linked SMSF loan, no trust/HUF below 100%: the bridge is empty and the previous figure EQUALS the family level (the PO household: 1,510,441);
- `smsf_loan_counted_once`: the earlier figure had the loan deducted twice;
- `trust_huf_included_in_full`: the earlier figure applied the recorded percentage to Trusts and HUFs.

The Dashboard headline is individual-first: "Net Worth (personal)" with the family figure on the line below. The history chart stays on the previously reported basis and says so.

## 6. Classification defect ('House ')

An asset named `House ` (trailing space), null master item key, default `asset_class` 'other' was grouped as other, not property. The grid never collects `asset_class`, so the name is the only signal. Fix (lib/engines/dashboard.ts `bucketAssetClass`): after a real master item key and an explicit asset_class, a WHOLE-name match (trimmed, case-insensitive, spaces collapsed, leading "my"/"the" dropped) against property words only. A name that merely contains such a word ("House insurance refund") is not guessed at. Master item keys are also trimmed and lower-cased. Totals never change; only the allocation grouping and the property concentration ratio.

## 7. PO decisions still open (recommendation first)

1. Headline default: individual-first with the family figure beside it. IMPLEMENTED as recommended. Confirm.
2. SMSF property loan counted once (previously deducted twice for households with a fund-linked loan). IMPLEMENTED with an explicit bridge line; reversible in one place (the loader's netting set). Confirm it is wanted for the previously reported history too.
3. Do downstream readers (Health Score ratios, Resilience, Forecast opening balance, Financial Twin, AI explanations, stored monthly snapshots and month-on-month movement) switch to the family figure? NOT changed (certified formulas); they stay on the previously reported basis, which for entity-free households is identical. Recommendation: switch scores and forecasts to the family figure in one follow-up so they cannot drift from the screen; the AI "explain my net worth" text currently explains the previously reported figure while the card shows the personal one.
4. Is the SMSF member balance (the fund row owned by Self, 503,000) personal, with only rows tagged SMSF in the entity block? Implemented that way, matching the PO's example. Say if the whole fund should move to the SMSF block.
5. Legacy `company` owner tags carry no ownership percentage, so they count in full as entered, not at a share. Recommendation: retire the tags in favour of registered Companies (PO ruling OQ-1 left them as-is).
6. Trust and HUF recorded ownership percentage is shown but not applied. Recommendation: hide the percentage field for those two types in the Entities form (follow-up, not done).
7. Joint split for plain register rows is 50/50 because no split is stored. Recommendation: add an editable split later (needs a migration; none made here).
8. Entity liabilities DO appear (they reduce the entity's net value and are shown in the entity block and the family total); they still never enter personal DTI/DSR.
9. No standalone Net Worth page exists; the Dashboard Net Worth section is the surface. Recommendation: do not add one now.
10. Only Self and Spouse/Partner are individuals; any other household member (child) falls under "Other household items".

## 8. Files

New: `lib/engines/netWorthLevels.ts`, `lib/services/netWorthLevelsData.ts`, `components/dashboard/NetWorthLevelsPanel.tsx`, `components/dashboard/netWorthHeadline.ts`, tests `netWorthLevels`, `netWorthLevelsDashboardReportParity`, `netWorthLevelsPanel`, `assetBucketNameFallback`.
Changed (small hunks): `lib/engines/dashboard.ts` (type field, `bucketAssetClass`), `lib/engines/businessEntityValuation.ts` (two optional fields), `lib/services/dashboardData.ts` (attach the model; select `asset_name`), `lib/engines/reportSections.ts` (import, `netWorthSummarySentence`, `levels` in section data), `components/reports/ReportPreview.tsx`, `components/dashboard/sections.tsx`, `components/dashboard/VitalSignsStrip.tsx`.
No migration. No Admin change (Admin standard not engaged). Free and Premium report gating is unchanged (the Net Worth section is a Free section; Premium adds nothing to it).

## 9. Evidence

- UNIT-TESTED with hand-calculated oracles on the PO household (Self 543,941; Spouse 833,500; personal 1,377,441; SMSF 133,000; family 1,510,441 = the previously reported figure; joint 60/40 totals 100%); real loaders against an in-memory PostgREST fake; negative controls proven to fail by sabotage (SMSF rows reclassified, netting disabled: 11 named failures).
- Layout: a static render of the real components with fixture data checked in the browser pane at 375, 768 and 1280 px (no page-level horizontal scroll; tables scroll inside their labelled region below 768 px). NOT checked against the live app or DEV (no existing signed-in session; passwords are never typed).
- Observed, pre-existing and not changed: a seven-digit value in a half-width card overflows the card by about 30 px at 375 px (MetricCard text-3xl). Applies to the old "Net Worth" card too.

## 10. SECOND PO RULING, 16-10-2026: personal figures exclude entity-held amounts (supersedes sections 2 and 5 where they differ)

Decision note: `docs/decisions/PO_DECISION_2026-10-16_PERSONAL_NET_WORTH_EXCLUDES_ENTITY_AMOUNTS.md`.

The older figure `summary.netWorth` (Health Score, Resilience, Forecast opening balance, Twin, DNA, What-if, AI, stored snapshots) was described above as the family-basis figure. The PO ruled that an SMSF fund-level amount (and any entity-held amount) in a PERSONAL net worth is wrong. So:

- `summary.netWorth`, `totalAssets`, `totalInvestments`, `totalRetirement`, `totalLiabilities`, `totalAssetsCombined`, the allocation chart, liquid and property ratios, debt-by-type and everything derived are now on the PERSONAL basis. The loader (`lib/services/dashboardData.ts`) passes only personal rows to `computeDashboard` (`lib/engines/netWorthBasis.ts`: entity-held = owner `smsf`, `family_trust`, `company`, an SMSF-linked property loan, and registered Companies, Trusts and HUFs). The engine itself is unchanged.
- Entity amounts appear ONLY in the entity blocks and the consolidated family figure of `netWorthLevels` (unchanged: SMSF full, Trust full, HUF full, Company at the ownership share). The family figure stays on the Dashboard card, the Net Worth section and the Monthly Report as its own labelled line.
- `summary.netWorthBasis` records what was left out (`entityHeld`) and the history-basis figures; `levels.bridge.personalParityOk` proves the summary equals the model's personal level (a difference is shown on screen, never hidden).

### 10.1 Surface-by-surface inventory (basis BEFORE -> AFTER)

| Surface / reader | Before | After |
|---|---|---|
| Dashboard cards: Net Worth, Debt Outstanding, Investment Portfolio, Retirement Balance, Core figures | all rows, all entities (the Net Worth card already showed personal first) | personal rows only; the Retirement section notes the fund-level amount left out |
| Net Worth section and wealth charts (allocation, debt composition) | family (all rows) | personal; the levels panel shows both levels |
| Monthly Report: Executive Summary, Net worth totals and stat grid, wealth-by-group chart, liquid / illiquid and property percentages, retirement assets, core figures | stat grid at family level; charts and percentages on all rows | personal totals and charts; a labelled "Family net worth" line; movement labelled |
| Report evidence appendix | every row counted | entity-held rows listed and labelled, NOT counted; reconciliation on personal rows |
| Health Score (net worth ratio, concentration, Retirement Readiness) and pillars | all rows | personal |
| Resilience, Financial DNA, What-if, Recommendations, Goals affordability | summary | personal (via the summary) |
| Forecast opening balances (net worth, retirement, resilience, cross-border, debt, investment) | all rows | personal rows; engine version 1.7.0 so older cached runs are not reused |
| Forecast variance | actual on the live basis | actual on the SAME basis as the original run (older runs: earlier basis) |
| Financial Twin | summary plus raw lines of all rows | summary plus personal raw lines; stored net worth months left unknown when the bases differ |
| AI context and Explain | `net_worth` on all rows | `net_worth` personal, `net_worth_basis: personal`, `family_net_worth` when entities exist |
| Stored `financial_snapshots` | all rows | UNCHANGED (history basis), see 10.3 |
| Register grid footers (Assets, Investments, Liabilities, Retirement) | one total of all rows | personal total plus a labelled "held by an entity" line |
| Goals funding through a linked account | explicit user link | unchanged (the user chose the link); flagged, not changed |
| Investment Intelligence owner-class views | already separate owner classes | unchanged |

### 10.2 SMSF treatment: gross asset, fund liability, net balance, member benefit (explicit)

The fund is an ENTITY with its own balance sheet.

- SMSF assets (rows owned by the SMSF) enter the SMSF block at their value; SMSF liabilities (rows owned by the SMSF, or a loan linked to the fund) enter the SMSF block as liabilities. SMSF net = assets minus liabilities (the fund's net balance). Nothing from the fund enters the personal level.
- THE SMSF FUND ROW IS ENTITY-HELD. The SMSF section stores the fund as a retirement_accounts row with master_item_key = smsf, owned by a person by construction (smsf_create_fund). It is the fund's own net balance (already net of its linked loan, migration 0084), not a member balance, so it is classified by that key as entity-held (`isSmsfFundRow`), whoever owns it: SMSF block and family level only. The linked loan is a memo (netted), so it is counted once. Genuine personal pension and super accounts (other rows) stay personal.
- If BOTH the fund row and a fund-level row (owner smsf) exist, the fund is counted ONCE: the SMSF block counts the fund-level row (the user's explicit entity-level net entry); the fund record is listed on the block as "shown but not counted" (`suppressedFundRecord`), appears in the bridge to the previously reported figure as `smsf_fund_record_not_counted`, and a plain data-quality notice recommends recording the fund once, using its own net balance (assets less liabilities). With only a fund row, it is counted in the SMSF block.
- The member's benefit is the member's share of the fund net balance. Until entity-level input exists it is not a separate figure: it is the SMSF block net. A fund-level (owner smsf) amount is never treated as a member balance (PO ruling).
- No double count (tests in `personalNetWorthBasis.test.ts`): every row lands in exactly one of personal or one entity block; personal plus entities equals the family figure line by line; the SMSF loan is deducted once, at the SMSF block (or inside the netted fund balance).

Numbers for the PO household (hand-calculated in the test header; AUD):

| | Personal assets | Personal liabilities | Personal net worth | Retirement (personal) | SMSF block | Family net worth |
|---|---|---|---|---|---|---|
| Before this change | 2,896,298 (incl. 133,000) | 1,385,857 | 1,510,441 | 636,000 | not shown separately | not shown |
| (A1) data as today, 503,000 is the SMSF-section fund row (key smsf, owner self) + 133,000 owner smsf | 2,260,298 | 1,385,857 | 874,441 | 0 | 133,000 (fund record 503,000 listed, not counted) | 1,007,441 |
| (A2) the same two amounts typed by hand, no fund key (503,000 owner self, named SMSF) | 2,763,298 | 1,385,857 | 1,377,441 | 503,000 | 133,000 | 1,510,441 |
| (B) interim: 503,000 row removed, 133,000 smsf kept as the fund net | 2,260,298 | 1,385,857 | 874,441 | 0 | 133,000 | 1,007,441 |
| (C) entity level: SMSF asset 503,000 and SMSF liability 370,000, no 133,000 row | 2,260,298 | 1,385,857 | 874,441 | 0 | 503,000 - 370,000 = 133,000 | 1,007,441 |

In (A2) the model cannot know that the hand-typed 503,000 row is the fund's own money, so it stays personal; a plain data-quality notice appears when a personal retirement row named like an SMSF sits beside an owner-smsf row ("may be counted twice", no blame). (A1), (B) and (C) give identical personal and family totals (874,441 and 1,007,441), so moving from today's data to the interim shape to the entity-level shape changes no figure.

Score effects, case (A2) (case A1 equals case B below): net worth ratio 1,510,441 / 2,896,298 = 0.5215 -> 1,377,441 / 2,763,298 = 0.4985; property concentration 1,960,000 / 2,896,298 = 0.6767 -> 1,960,000 / 2,763,298 = 0.7093; liquid ratio 21,798 / 2,896,298 = 0.00753 -> 0.00789; retirement balance 636,000 -> 503,000, so the Retirement Readiness balance ratio falls by 20.9 per cent against the unchanged age guideline. Case (B): retirement balance 0 (Retirement Readiness has no personal balance to score); net worth ratio 874,441 / 2,260,298 = 0.3869. Debt ratios (DTI, DSR) are unchanged: SMSF rows were never in them.

### 10.3 Stored history and month-on-month (PO decision needed)

`financial_snapshots` is NOT rewritten and its basis is NOT changed: new months keep being written on the history basis (the figure reported before this ruling, all entities included), so a series never mixes bases. No migration. Rules:

- Entity-free household: personal equals the history basis, identical numbers, movement as before.
- Household with entity amounts: the live personal figure is never compared with a stored month. Month-on-month change, the history chart, Financial DNA growth and the report movement are shown on the history (family) basis and labelled "Family net worth" with a plain note; the Twin leaves stored net worth months unknown; the debt-to-income movement is not available.
- Forecast variance compares like with like: runs created by engine 1.7.0 or later use the personal position; earlier runs are compared on the earlier basis (`lib/engines/forecast/varianceBasis.ts`).

Recommendation (PO to decide): accept this for now. If a personal month-on-month series is wanted for households with entities, add one nullable column (`financial_snapshots.net_worth_personal`) in migration 0288 and compare only months that have it; history before the first personal month stays on the family basis. Not built: it needs a migration applied to DEV and production before the code.

### 10.4 Files (this ruling)

New: `lib/engines/netWorthBasis.ts`, `lib/engines/forecast/varianceBasis.ts`, `tests/unit/personalNetWorthBasis.test.ts`. Changed: `dashboard.ts` (type, comment), `dashboardData.ts` (personal rows, history basis, snapshot write), `netWorthLevels.ts` (personal parity, SMSF double-count notice), `netWorthLevelsData.ts`, `reportSections.ts`, `reportSectionsPremium.ts`, `reportCanonicalAppendix.ts`, `financialDna.ts`, `forecastData.ts`, `forecastCanonicalInputs.ts`, `engine.ts` (1.7.0), `twinData.ts`, `FinancialDataGrid.tsx`, `ReportPreview.tsx`, `NetWorthLevelsPanel.tsx`, `netWorthHeadline.ts`, `sections.tsx`, the AI context type and builder. Updated tests: `netWorthLevelsDashboardReportParity`, `twinCanonicalParity`.

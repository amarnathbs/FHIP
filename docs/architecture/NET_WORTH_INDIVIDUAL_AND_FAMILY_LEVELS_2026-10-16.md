# Net Worth at two levels: individual and consolidated family (design note, 16-10-2026)

Status: implemented on branch `feat/networth-individual-and-family-20261016`, not pushed. Evidence labels are in section 9.

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

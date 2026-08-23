# R6 Tax Legal Source Register

Status: R6-SECURITY-FINAL closure pass (last update 2026-08-22). Originally compiled during R6-FINAL, 2026-08-22; grandfathering 2025-Act continuity (Section 5, former Open Item 2) resolved during R6-SECURITY-FINAL, same date.

This register lists every production tax rule this engine encodes (in
`lib/engines/investment-intelligence/tax/ruleVersions.ts`, mirrored into
migration `0058_ii_r6_p1_tax_engine.sql`'s `ii_tax_rule_versions` seed), the
primary/secondary sources consulted, what was independently corroborated,
and what remains genuinely open. Every claim below was checked via live web
search/fetch on 2026-08-22 (not recalled from training data) — see the
"Sources consulted" list at the end for the actual URLs fetched.

**Verification standard used**: a rule is marked CERTIFIED only where at
least 3 independent, mutually-consistent secondary sources agree AND the
figure could be cross-checked against a legal-database transcription of the
statute itself (indiankanoon.org) or an explicit CBDT/incometaxindia.gov.in
reference found via search. Where the official incometaxindia.gov.in pages
themselves returned HTTP 403 to automated fetches (confirmed, see below),
that is disclosed rather than silently worked around by treating a
secondary source as if it were primary.

## 1. Equity-oriented mutual funds — STCG (Section 111A → Section 196)

| Field | Value |
|---|---|
| Rule code | `equityOriented.stcgRatePct` |
| Topic | Short-term capital gains, equity-oriented fund units |
| Governing Act (pre-2026-04-01) | Income-tax Act, 1961, Section 111A, as amended by Finance (No. 2) Act, 2024 |
| Governing Act (2026-04-01 onward) | Income-tax Act, 2025 [30 of 2025], Section 196 |
| Effective from / to | 2024-07-23 → 2026-03-31 (1961-Act rate); 2026-04-01 → open (2025-Act rate, IDENTICAL rate) |
| Taxpayer scope | Resident individuals/HUF (this engine's stated scope; NRI out of scope, see `disclaimer.ts`) |
| Asset scope | Equity shares, equity-oriented mutual fund units, business trust units — STT paid |
| Rate | 20% (was 15% before 23-Jul-2024) |
| Threshold | None (basic exemption limit offset only, not modelled per-instrument here) |
| Primary source | indiankanoon.org transcription of "Section 196 in The Income Tax Act, 2025" (https://indiankanoon.org/doc/76321359/) — search-result synthesis confirmed the section exists at this citation; a direct WebFetch of the page itself returned HTTP 403, so the verbatim clause text was NOT independently re-read by this session, only the search-engine's summary of it. See "Open items" below. |
| Corroborating sources | ebizfiling.com "Section 196 and 198 of the Income Tax Act 2025" (fetched, quoted 20% STCG rate, STT condition, "corresponds to old Section 111A"); finnovate.in; Business Standard tax-reckoner coverage; mstock.com Income Tax Act 2025 explainer |
| Verified date | 2026-08-22 |
| Engine/rule version | `1961_act_post_20240723` (pre-transition) / `2025_act_post_20260401` (post-transition) |
| Status | **CERTIFIED** — rate figure corroborated by 4+ independent sources; exact statutory clause text not independently re-read (403 on primary site) |

## 2. Equity-oriented mutual funds — LTCG (Section 112A → Section 198)

| Field | Value |
|---|---|
| Rule code | `equityOriented.ltcgRatePct`, `ltcgExemptionThresholdInr` |
| Topic | Long-term capital gains, equity-oriented fund units |
| Governing Act (pre-2026-04-01) | Income-tax Act, 1961, Section 112A, as amended by Finance (No. 2) Act, 2024 |
| Governing Act (2026-04-01 onward) | Income-tax Act, 2025 [30 of 2025], Section 198 |
| Effective from / to | 2024-07-23 → 2026-03-31 (1961-Act rate); 2026-04-01 → open (2025-Act rate, IDENTICAL rate) |
| Taxpayer scope | Resident individuals/HUF |
| Asset scope | Equity shares, equity-oriented mutual fund units, business trust units — STT paid on acquisition AND transfer (equity shares) / on transfer (fund units) |
| Rate | 12.5% (was 10% before 23-Jul-2024) |
| Threshold | Rs 1,25,000 per taxpayer per tax year (was Rs 1,00,000 before 23-Jul-2024) |
| Indexation | Not allowed |
| Primary source | indiankanoon.org "Section 198 in The Income Tax Act, 2025" (https://indiankanoon.org/doc/76321359/) and "Section 198(8)" (https://indiankanoon.org/doc/15318805/) — search-summary confirmed via indiankanoon's indexing; direct WebFetch of indiankanoon pages returned HTTP 403 (see Open items) |
| Corroborating sources | ebizfiling.com (fetched: "Section 198 — Tax Rate: 12.5% on LTCG exceeding Rs 1,25,000... corresponds to Section 112A... apply from 1 April 2026"); Bajaj Finserv "Section 112A of Income Tax Act — LTCG Exemption 2026"; finnovate.in "Mutual Fund Taxation in India (FY 2025–26)"; taxguru.in "Capital Gains under New Income tax Act, 2025 for Tax Period 2026-27" (fetched, confirmed 12.5%/Rs 1,25,000/no-indexation) |
| Verified date | 2026-08-22 |
| Engine/rule version | `1961_act_post_20240723` / `2025_act_post_20260401` |
| Status | **CERTIFIED** |

## 3. "Equity-oriented fund" definition (≥65% domestic equity test)

| Field | Value |
|---|---|
| Rule code | `equityOriented.domesticEquityThresholdPct` |
| Topic | Definition of "equity-oriented fund" for Section 112A/198 purposes |
| Governing Act (2026-04-01 onward) | Income-tax Act, 2025, Section 198(8) |
| Threshold | ≥65% of investible funds in equity shares of domestic companies (listed); a fund-of-funds variant uses a ≥90%/≥90% two-tier test |
| Primary source | indiankanoon.org "Section 198(8)" (search-summary; direct fetch 403'd) |
| Corroborating sources | ebizfiling.com ("Funds must invest at least 65% (or 90% in fund-of-funds structures)... calculated by annual average of monthly opening/closing figures"); this matches the SAME 65% test already used pre-transition (Section 112A Explanation / Rule 4 of the old Act) |
| Verified date | 2026-08-22 |
| Engine/rule version | Unchanged across all three rule versions (`domesticEquityThresholdPct: 65`) |
| Status | **CERTIFIED** — unchanged from the pre-transition rule, corroborated |

## 4. Debt / "specified mutual fund" — always short-term (Finance Act 2023)

| Field | Value |
|---|---|
| Rule code | `debtSpecified.alwaysShortTerm`, `specifiedFundAcquiredOnOrAfter`, `taxedAtSlabRate` |
| Topic | Capital gains on units of a "specified mutual fund" (>65% debt/money-market) |
| Governing Act | Income-tax Act, 1961, as amended by Finance Act, 2023; carried forward into the Income-tax Act, 2025 (Section 196-adjacent slab-rate treatment — general capital-gains-at-slab-rate provisions, not Sections 196/198 which are STT-linked equity provisions) |
| Effective from | 2023-04-01 (acquisition-date rule: units of a specified mutual fund ACQUIRED on/after this date) |
| Rate | Slab rate (this engine does not know the household's slab — reports the gain as short-term/slab-rate-applicable per `taxedAtSlabRate: true`, leaves the exact rate to the user's CA) |
| Indexation | Not allowed |
| Primary source | Multiple secondary sources citing Finance Act 2023 directly (no single indiankanoon citation found for this specific slab-rate carve-out; it is a definitional amendment to the general capital-gains chapter, not a single numbered "112A-style" section) |
| Corroborating sources | ClearTax "Debt Mutual Fund Taxation in India" (definition: "specified mutual fund" = >65% debt/money-market, effective FY2023-24); Tax2win; HDFC Life "Debt Fund Tax Rules 2026"; taxclue.in "Debt Mutual Fund Tax ITA 2025" (fetched: "all gains at slab rate (no LTCG/indexation)... effective 1 April 2023 under Finance Act 2023... No grandfathering exists [for debt funds]") |
| Verified date | 2026-08-22 |
| Engine/rule version | Unchanged across all three rule versions |
| Status | **CERTIFIED**, both the rate/rule AND the per-lot acquisition-date gate. **R6-DEBTFIX (2026-08-22) closed the previously-disclosed gap**: the engine now reads `specifiedFundAcquiredOnOrAfter` as a genuine per-lot gate in `capitalGainsEngine.ts`'s `debt_specified` branch — a lot's own `acquisitionDate` is compared against the 2023-04-01 cutoff before applying the always-short-term treatment. Lots acquired before the cutoff fall through to the `legacyRegime` documented in Section 4a below. See `tests/unit/iiR6FinalDebtFundBoundary.test.ts`, the `DEBTPRE-001..010` case family, and `docs/investment-intelligence/R6_DEBT_FUND_ACQUISITION_DATE_FIX.md` for the full fix history. |

## 4a. Legacy pre-1-April-2023 debt/specified-fund treatment (the fix's own research)

Governs any debt/specified-mutual-fund lot **acquired before** the 2023-04-01 Section 50AA cutoff above — such a lot is not a "specified mutual fund" disposal at all, and falls back to the pre-existing debt-fund capital-gains rules, which Budget 2024 then further split by a *second*, independent boundary (the lot's own acquisition date decides Section 4 vs. 4a; the *disposal* date decides which half of 4a applies).

| Field | Value |
|---|---|
| Rule code | `debtSpecified.legacyRegime` in `ruleVersions.ts`; consumed in `capitalGainsEngine.ts`'s `debt_specified` branch |
| Disposal before 23-Jul-2024 | Holding-period threshold **> 36 months = LTCG**; LTCG rate **20%** with Cost-Inflation-Index indexation under Section 112 as it stood before Budget 2024; STCG otherwise, at slab rate |
| Disposal on/after 23-Jul-2024 | Holding-period threshold shortened to **> 24 months = LTCG**; LTCG rate flat **12.5%**, indexation **removed**; STCG otherwise, unchanged at slab rate |
| Sources (pre-23-Jul-2024 regime) | HDFC Life "Debt Fund Tax Rules 2026"; ICICI Direct "Changes in taxation of non-equity funds from FY23-24" (fetched directly); ValueResearchOnline "How are debt funds bought before 2023 taxed?" (fetched directly, explicit quote: *"If you hold the funds for over three years, gains were qualified as long-term capital gain (LTCG) and are taxed at 20% with indexation"*); ClearTax — 4 independent sources agree exactly |
| Sources (post-23-Jul-2024 regime) | ValueResearchOnline (fetched directly: *"Indexation benefit is available only for debt funds purchased before April 1, 2023, held for more than 36 months, and redeemed before July 23, 2024... After July 23, 2024, the requirement dropped to >24 months with the flat 12.5% rate but no indexation"*); PrimeInvestor "Budget 2024 – how your equity & debt investments are taxed now" (fetched directly, matching quote with exact numbers); ICICI Direct; Business Standard (search-corroborated) |
| Ambiguity resolved | An initial lower-quality search suggested pre-2023 debt-fund lots got an optional 20%-indexed/12.5%-unindexed *choice* after 23-Jul-2024, the same way land/building did. Direct fetches of ValueResearchOnline and PrimeInvestor both explicitly deny this for debt funds ("no optional choice"); the 20%/12.5% choice is confirmed a land/building-only provision. The engine implements the debt-fund rule as mandatory-by-disposal-date, not a taxpayer election. |
| Indexation safety | Where indexation is legally due (pre-23-Jul-2024 disposal window) the engine does **not** fabricate an indexed cost basis — no verified Cost-Inflation-Index table is wired into this codebase yet. `costBasisUsed` stays at the un-indexed acquisition cost, with an explicit note disclosing this and stating the true taxable gain would legally be lower once correctly indexed. No false precision. |
| Verified date | 2026-08-22 (fix's own research), independently re-verified again 2026-08-22 during formal re-certification via a second, separate WebSearch pass (AMFI/TaxBuddy/Bajaj/TaxTMI for the acquisition boundary; ValueResearch/PrimeInvestor/BusinessToday for the disposal boundary) |
| Confidence | **CERTIFIED** — independently corroborated twice, by two separate research passes, with matching conclusions both times |

## 5. Grandfathering — 31-Jan-2018 FMV step-up (Section 55(2)(ac) → Section 90(7)-(9))

| Field | Value |
|---|---|
| Rule code | `grandfathering.ts` `applyGrandfathering()` |
| Topic | Cost-of-acquisition step-up for equity-oriented LTCG lots acquired before 1 Feb 2018 |
| Governing Act (1961, disposals before 2026-04-01) | Income-tax Act, 1961, proviso to Section 55(2)(ac), introduced by Finance Act, 2018 alongside Section 112A |
| Governing Act (2025, disposals on/after 2026-04-01) | Income-tax Act, 2025 [30 of 2025], **Section 90(7)-(9)** — see "R6-SECURITY-FINAL re-verification" row below |
| Formula | `costBasis = max(actualCost, min(fmv31Jan2018, salePrice))` — IDENTICAL under both Acts |
| Cutoff | Lots acquired on/before 2018-01-31 are eligible; 2018-02-01 onward are not |
| Primary source | Formula independently verified by R6-P1 (pre-dating this pass) against ClearTax / HDFC Sky / ICICI Direct explainers, all in agreement — see `grandfathering.ts` header |
| Re-verification (R6-FINAL, 2026-08-22) | WebSearch "Grandfathering Clause in LTCG" (multiple 2025-26-dated sources) all restate the identical max/min formula and 31-Jan-2018 cutoff, with no indication of a formula change |
| **R6-SECURITY-FINAL re-verification (2026-08-22)** | **Direct 2025-Act citation found and verified.** Section 90(7) of the Income-tax Act, 2025 — a cost-of-acquisition provision applying "for the purposes of sections 72 and 73" (the Act's general capital-gains computation sections) — states: "cost of acquisition... in relation to a long-term capital asset, being an equity share in a company or a unit of an equity oriented fund or a unit of a business trust referred to in section 198, acquired before the 1st February, 2018, shall be higher of— (a) the actual cost of acquisition; or (b) the lower of— (i) the fair market value of such asset; and (ii) the full value of consideration received or accruing as a result of the transfer." Section 90(8) defines "fair market value" for the 31-Jan-2018 date identically to the 1961-Act convention (highest quoted price on a recognised exchange on that date, or the preceding trading date). This is the SAME `max(actualCost, min(fmv, saleConsideration))` formula already implemented — **no arithmetic change was required.** Independently corroborated by two separate secondary-source fetches (aubsp.com, eztax.in) quoting matching verbatim statutory text; direct fetches of incometaxindia.gov.in and indiankanoon.org again returned HTTP 403 (same disclosed pattern as Sections 196/198 in Section 1-2 above). |
| Verified date | 2026-08-22 (R6-SECURITY-FINAL; formula-level re-verified 2026-08-22 during R6-FINAL; originally verified during R6-P1) |
| Status | **CERTIFIED** for disposals under both the 1961 Act and the 2025 Act. The prior "OPEN ITEM" for 2025-Act continuity (R6-FINAL, 2026-08-22) is **CLOSED** — see Section 7 below. |

## 6. Effective-date boundaries — re-verified this pass

| Boundary | Real/legally significant? | Source |
|---|---|---|
| 2018-01-31 / 2018-02-01 (grandfathering cutoff) | **YES** — Finance Act 2018 introduced Section 112A + the Section 55(2)(ac) grandfathering proviso, effective for transfers on/after 1 April 2018, with the FMV measured as of 31 Jan 2018 | Multiple sources, unchanged since original R6-P1 verification |
| 2023-03-31 / 2023-04-01 (specified mutual fund rule) | **YES** — Finance Act 2023, "specified mutual fund" always-short-term rule applies to units ACQUIRED on/after 1 April 2023 | ClearTax, Tax2win, taxclue.in (all independently confirm 1-Apr-2023) |
| 2024-07-22 / 2024-07-23 (Budget 2024 rate change) | **YES** — Finance (No. 2) Act, 2024, equity STCG 15%→20%, LTCG 10%→12.5%, exemption Rs 1,00,000→1,25,000, effective for transfers ON/AFTER 23 July 2024 (Budget presentation date) | Already verified during R6-P1; re-confirmed this pass via finnovate.in, Bajaj Finserv, cleartax mapping search. This IS a real, correctly-dated boundary — no correction needed. |
| 2026-03-31 / 2026-04-01 (1961 Act → 2025 Act) | **YES** — Income-tax Act, 2025 [30 of 2025] takes effect 1 April 2026 (Tax Year 2026-27); AY2026-27 filings (income up to 31 March 2026) remain under the 1961 Act | indiankanoon.org section-number search results, taxclue.in, axismaxlife.com, mstock.com, cleartax.in — all consistently state the 1-Apr-2026 effective date |

No additional legally-significant capital-gains-on-mutual-funds boundary was
found during this research pass. Finance Act 2026 was specifically checked
(via the official Act text's own title — "AS AMENDED BY FINANCE ACT, 2026" —
and multiple 2026-dated commentary articles) and its disclosed changes
(buyback-proceeds taxation, Sovereign Gold Bond secondary-market treatment)
do not touch equity/debt mutual-fund capital-gains rates and are outside
this engine's scope (mutual fund unit disposals only).

## 7. Open items — genuinely unresolved, disclosed rather than guessed

1. **Verbatim statutory text of Sections 196/198 not independently re-read.**
   `www.incometaxindia.gov.in` and `indiankanoon.org` both returned HTTP 403
   to this session's automated WebFetch tool (confirmed twice, different
   URLs, both domains). The RATE FIGURES were nonetheless independently
   corroborated by 4-6 mutually-consistent, differently-authored secondary
   sources (ebizfiling.com quotes what it presents as near-verbatim
   sub-section detail, including the Section 156 rebate-restriction clause
   and the IFSC exception, which is a level of specificity inconsistent with
   casual paraphrase) — this session's assessment is that the CERTIFIED
   rulings above are reliable, but a future pass with primary-site access
   should re-confirm by reading the Act PDF directly.
2. ~~**Grandfathering continuity into the 2025 Act era.**~~ **CLOSED
   2026-08-22 (R6-SECURITY-FINAL)** — see Section 5 above. Direct statutory
   authority found: Section 90(7)-(9) of the Income-tax Act, 2025 restates
   the identical grandfathering formula for equity/equity-oriented-fund
   units referred to in Section 198, acquired before 1 February 2018. No
   code change was required (`grandfathering.ts` already applied the rule
   unconditionally by acquisition date, which is now confirmed correct
   rather than merely reasonable-by-inference). See
   `tests/unit/iiR6P1Certification.test.ts`'s GRANDBOUND family and
   `tests/unit/iiR6SecurityFinalClosure.test.ts` (new, this pass) for the
   live behaviour this produces, including a same-facts pre-/post-1-Apr-2026
   disposal-date pair proving numerically identical treatment across the Act
   transition. Left struck-through rather than deleted so the item's history
   stays visible, per this document's own convention (see item 3 below).
3. ~~Debt/specified-fund per-lot acquisition-date gate is not implemented.~~
   **CLOSED 2026-08-22 (R6-DEBTFIX)** — see Section 4 and the new Section 4a
   above. Left here, struck through rather than deleted, so the defect's
   history stays visible in this document rather than silently vanishing.

## Sources consulted (2026-08-22)

- https://indiankanoon.org/doc/76321359/ — "Section 198 in The Income Tax Act, 2025" (search-indexed; direct fetch 403)
- https://indiankanoon.org/doc/15318805/ — "Section 198(8) in The Income Tax Act, 2025" (search-indexed; direct fetch 403)
- https://indiankanoon.org/doc/140834299/ — "Section 198(1) in The Income Tax Act, 2025" (search-indexed; direct fetch 403)
- https://www.incometaxindia.gov.in/documents/d/guest/income_tax_act_2025_as_amended_by_fa_act_2026-pdf — official Act text (direct fetch 403)
- https://ebizfiling.com/blog/section-196-and-198-short-term-and-long-term-capital-gains/ — fetched successfully, detailed Section 196/198 breakdown
- https://taxguru.in/income-tax/capital-gains-income-tax-act-2025-tax-period-2026-27.html — fetched successfully
- https://taxclue.in/blog/debt-mutual-fund-tax-post-2023-ita-2025 — fetched successfully
- https://www.finnovate.in/learn/blog/mutual-fund-taxation-india-fy-2025-26
- https://www.bajajfinserv.in/investments/section-112a-income-tax-act
- https://cleartax.in/s/income-tax-act-2025-section-numbers-old-vs-new
- https://www.mstock.com/articles/income-tax-act-2025
- https://cleartax.in/s/tax-on-debt-funds
- https://www.hdfclife.com/investment-plans/debt-mutual-fund-taxation

## Sources consulted (2026-08-22, R6-SECURITY-FINAL — grandfathering 2025-Act closure)

- https://eztax.in/income-tax-act-2025/section-90 — fetched successfully; quotes Section 90(7) grandfathering formula for equity shares/units acquired before 1 Feb 2018, and Section 90(8)(b) FMV definition
- https://www.aubsp.com/income-tax-act-2025-section-90/ — fetched successfully; independently quotes the SAME Section 90(7) statutory text verbatim ("cost of acquisition... shall be higher of— (a) the actual cost of acquisition; or (b) the lower of...")
- https://www.incometaxindia.gov.in/w/section-90-110 — official Act text (direct fetch 403, same disclosed pattern as Sections 196/198 above)
- https://www.taxtmi.com/tmi_notes?id=1655 — "Clause 198 of the Income Tax Bill 2025 vs Section 112A" (search-indexed, corroborating context)
- https://hivecalc.com/income-tax-india/section-198-long-term/ — fetched; confirmed Section 198 itself does NOT cover grandfathering (correctly scoped to Section 90 instead, not a false lead)

### Added 2026-08-22 (R6-DEBTFIX — Section 4a legacy debt-fund regime research)

- ICICI Direct — "Changes in taxation of non-equity funds from FY23-24" (fetched directly)
- ValueResearchOnline — "How are debt funds bought before 2023 taxed?" (fetched directly)
- ValueResearchOnline — Budget 2024 indexation-removal explainer (fetched directly)
- PrimeInvestor — "Budget 2024 – how your equity & debt investments are taxed now" (fetched directly)
- Business Standard (search-corroborated, 23-Jul-2024 boundary)
- AMFI, TaxBuddy, Bajaj Finserv, TaxTMI (independent second-pass corroboration during formal re-certification)

## Change log

- 2026-08-22 (R6-FINAL closure): replaced the `2025_act_placeholder` row
  (placeholder:true) with `2025_act_post_20260401` (placeholder:false) after
  this research pass. See `ruleVersions.ts`, migration `0058`, and
  `docs/investment-intelligence/R6_1961_TO_2025_ACT_TRANSITION.md`.

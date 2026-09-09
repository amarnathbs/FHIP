# G7 Discovery Batch 2 — Report Sections (G7.005–G7.008)

Repo: `D:\FHIP\.claude\worktrees\agent-a9fdb5d253f9b5fff` @ `cd7b201`. Builds directly on G6's own findings (`docs/country-programme/g6-discovery-batch2-consolidation.md`, §G6.007 net worth and §G6.008 cash flow), re-confirmed independently here from `lib/engines/reportSections.ts`/`reportSectionsPremium.ts` rather than re-derived.

## G7.005 — Domestic sections

**No such section exists.** No report section in `lib/engines/reportSections.ts` (14 Free sections) or `lib/engines/reportSectionsPremium.ts` (18 Premium sections) is scoped to exclude foreign-country holdings. Full section-code vocabulary: `lib/engines/reportEligibility.ts:4-45` (`FreeSectionCode`/`PremiumSectionCode`). Grepping every title in `SECTION_TITLES` (`reportSections.ts:24-39`) and `PREMIUM_SECTION_TITLES` (`reportSectionsPremium.ts:26-45`) for "domestic" returns nothing; a repo-wide search for "domestic" in `lib/`/`app/` returns only unrelated capability-key strings (`DOMESTIC_CALCULATIONS`, `DOMESTIC_RETIREMENT`, `DOMESTIC_TAX_OUTPUTS`) and India/AU tax-domain code — none report-section-related.

What exists is the opposite shape: every headline total (`buildExecutiveSummary`, `buildCashFlow`, `buildNetWorth`, `buildHealthScore` — `reportSections.ts:101-353`) is built from `source.dashboard` (`DashboardSummary`, `lib/engines/dashboard.ts`), whose `netWorth`/`totalAssets`/`totalInvestments`/`totalRetirement`/`grossMonthlyIncome`/`monthlySurplus` are currency-converted, cross-country **blended** totals by construction (`dashboard.ts:750-760`) — never filtered to home-country-only. The only mechanism that singles out countries is `cross_border`/`cross_border_full` (G7.006), and it **adds** foreign detail on top of the blended total; it never subtracts foreign figures to leave a domestic residual.

Structural blocker specific to cash flow: `income_sources`/`expense_items` carry no `country_code` column at all (`lib/services/dashboardData.ts:126-228`) — so a domestic-only Cash Flow section isn't merely unbuilt, there is no data dimension to filter it by.

**Classification: new requirement.** Not backend-only, not unreachable, not stale — never built. Would need (a) a canonically-resolved home country (never currency-derived), (b) a `country_code` dimension that doesn't exist on the two cash-flow registers, and (c) new eligibility/UI wiring.

## G7.006 — Cross-border sections

**Owner:** Free — `buildCrossBorder()` (`reportSections.ts:652-679`, code `cross_border`, order 11). Premium — `buildCrossBorderFull()` (`reportSectionsPremium.ts:463-503`, code `cross_border_full`, order 24). Eligibility: Free via `reportEligibility.ts:130-134` (`countriesInUseCount > 1 ? 'included' : 'omitted'`); Premium duplicates the same threshold inline (`reportSectionsPremium.ts:465`, `<= 1` → `omitted`) — two independently-maintained copies of the identical threshold, not one shared function. Tests: `tests/unit/reports.test.ts:25-42,58-62` — eligibility-status only, no content/currency assertions.

**Inputs:** both builders read `d.countriesInUse`, `d.assetsByCountry`, `d.liabilitiesByCountry`, `d.investmentByCountry`, `d.retirementByCountry`, plus `source.currency` (display label only). Neither reads `profile.countryOfResidence` or any FX rate.

**Output:** `{ countries, assetsByCountry, liabilitiesByCountry, investmentsByCountry, retirementByCountry, reportingCurrency }`. Both `limitationText`s explicitly disclose: "Local-country totals are shown as recorded... A fully converted reporting-currency consolidated view across all modules is not yet implemented."

**Confirmed unchanged from G6's finding**: `dashboard.ts:534-536` states per-country breakdowns deliberately skip `reportingValue()` — shown "as recorded," each in its own currency. `reportingCurrency` in the section output is the household's single reporting currency, not the currency of the per-country rows shown (which carry no currency label in `sectionData` at all, even though the underlying rows have `currency_code`). Matches G6's verdict that reconciling one blended-and-labelled table is a new requirement, not something already built.

**Country paths:** `d.countriesInUse` is not AU/IN-restricted — `country_code` is a plain FK to the 6-row `countries` registry, so a GENERIC code (GB/US/SG/AE) can legitimately appear **as a holding location** for an AU/IN household (explicitly a legitimate scenario per `g6-ownership-decisions.md:44`). What can't happen is the household itself being GENERIC-experience and reaching this section — every `app/api/reports/**` route uses `requireCountryConfirmedUser` (`lib/api.ts:53-68`), defaulting `allowGenericExperience: false`, failing closed with `GENERIC_EXPERIENCE_RESTRICTED` (403). An unconfirmed country is blocked even earlier by the same gate.

**Wiring:** `generateReport()` → `app/api/reports/generate/route.ts` → sections API → `components/reports/ReportPreview.tsx` (lines 160/176 render both codes). **Classification: live and connected**, both tiers, unchanged since G6.

**Controls:** positive — `reports.test.ts` (omitted/included both directions). Negative/cross-tenant: none specific to this section (only generic RLS `.eq('user_id', ...)` scoping plus the report-family RLS hardening in G7.008). No failure-injection test. **Canonical ownership already exists and is unambiguous** — correctly-wired reuse, not a new requirement.

## G7.007 — Consolidated sections

Sections showing ONE blended, currency-converted, country-unlabelled total (all from `source.dashboard`'s already-blended fields):

| Section | Code | Fields |
|---|---|---|
| Executive Summary | `executive_summary` | netWorth, monthlySurplus, savingsRate, DTI movements |
| Household Financial Position | `cash_flow` | grossMonthlyIncome, netMonthlyIncome, totalMonthlyExpenses, monthlySurplus |
| Net Worth and Balance Sheet | `net_worth` | totalAssets(Combined), totalInvestments, totalRetirement, totalLiabilities, netWorth |
| Financial Health Score™ | `health_score` | derived from blended inputs |
| Financial DNA™ / Resilience | `financial_dna`/`resilience` | same |
| 12-Month Trends | `twelve_month_trends` | `netWorthHistory` from blended snapshot rows |
| Full Score Diagnostic | `score_diagnostic_full` | blended component values |
| Retirement Readiness | `retirement_readiness` | single forecast run, currency-converted, never by country |
| Investment Analysis | `investment_analysis` | totals converted+blended, **but also carries an unconverted `byCountry` table in each country's own currency** — a hybrid, not purely consolidated |

**Confirmed: none of these mislabel a blended figure as single-country.** No hardcoded "Australian"/"Indian" wording found in `reportSections.ts`, `reportSectionsPremium.ts`, `reportNarrative.ts`, or `reportInsights.ts`. The only "Australian dollars"/"Indian rupees" strings live in `reportCopy.ts:29-30` (labels currency names, not countries; not on the cross-border/consolidated code path).

**One genuine positive control exists, and it highlights the sections that lack an equivalent:** `buildInvestmentPerformance()` (`reportSectionsPremium.ts:662-688`) explicitly refuses to show one blended return figure for multi-currency portfolios ("converting values at today's exchange rate would misattribute currency movement as investment performance"), reporting XIRR/TWRR separately per currency instead. `net_worth`/`cash_flow`/`executive_summary` carry **no equivalent in-section disclosure** that their headline is a multi-currency/multi-country blend — the only disclosure is in the separate `cross_border`/`cross_border_full` sections, viewable independently of Net Worth. Not a mislabelling defect (the figure is correctly converted and labelled in the one reporting currency), but a **partially wired** disclosure gap relative to Investment Performance's own standard.

`cash_flow`'s "consolidation" isn't really a design choice to blend — there's no per-country dimension on `income_sources`/`expense_items` to un-blend even if desired. `net_worth`'s consolidation IS a deliberate choice on data that does carry `country_code` — the per-country alternative exists (feeding `cross_border`) but as a separate section, not a reconciling same-currency per-country net-worth table (matches G6's verdict: that reconciliation is a new requirement).

**Classification:** all consolidated sections — live and connected, by design (matches G6). Investment Analysis — partially wired (intentional hybrid). Missing in-section "this blends N countries" disclosure on Net Worth/Cash Flow — new requirement if parity with Investment Performance's disclosure pattern is wanted; not currently tracked anywhere as a defect.

## G7.008 — Historical report snapshots

**Schema** (migration `0010_module9_reports.sql`): `reports`, `report_sections`, `report_snapshots`, `report_exports`, `report_generation_runs`, `report_access_events`. `reports.reporting_currency` is `char(3) not null` — explicit, immutable. `reports.country_scope` defaults to `'household'` — a fixed scope *label*, not the household's actual country; **no column stores the country a report was generated under.**

**Generation flow** (`generateReport()`, `reportsData.ts:89-312`): (1) `resolveReportSourceData()` runs live queries against `user_profiles.preferred_currency`/`country_of_residence` and live dashboard/health-score/DNA/resilience/goals data, once, at generation time. (2) Section builders produce fully-computed section objects (numbers, narrative, chart data already resolved). (3) Written verbatim as JSON into `report_sections.section_data_json`/`narrative_text`/`chart_data_json` in the same write as the `reports` row (which stores `reporting_currency: source.currency`). (4) `report_snapshots` rows inserted per data source — `snapshot_metadata_json` only ever holds `{reportMonth}` or `{openItemCount}` — **never an FX rate, never a country value** (confirmed, matches G6's own finding).

**Viewing/re-rendering an old report: confirmed frozen, stronger guarantee than `financial_snapshots`.** `GET /api/reports/[id]` (`getReport()`) reads only stored `reports`+`report_sections` rows — no live engine call. Sections API, same. The print/PDF view renders `report.reporting_currency` (the **stored** column), never live `preferred_currency`. `reportPdfRenderer.ts` drives Playwright against the same frozen print route — no regeneration. Revision (`/revise`) creates a **new** row (`version_number + 1`), marks the original `superseded` — never mutates the original.

So: if `country_of_residence`/`preferred_currency` changes after generation, every already-generated report's figures/narrative/currency label are unaffected. This is a stronger exposure profile than `financial_snapshots` (which can be silently overwritten on a same-month re-load) — `generateReport()`'s idempotency check returns the existing ready/published row rather than recomputing, and correction requires the explicit versioned `/revise` path.

**Residual gap (carries over from G6, confirmed independently):** the specific FX rate and country context used to build an old report are not stored as explicit, auditable fields anywhere — only implicitly baked into frozen output numbers (e.g., stress-testing's `applicabilityNote` uses `homeCountry` resolved once at generation time, but that resolved value is never written to `report_snapshots.snapshot_metadata_json`). Figures/currency/country context ARE preserved (numbers can't silently drift), but provenance is not independently queryable — for a single-country household, no country value is recorded anywhere in the report at all (no `cross_border` section is even built).

**Classification:** report-level immutability against live re-pull — live and connected, confirmed stronger than `financial_snapshots`. `reporting_currency` as a locked column — live and connected. Explicit country/FX-rate-of-generation provenance field — does not exist, new requirement if wanted. `country_scope` — stale/cosmetic (always `'household'`, no reader found anywhere).

**Controls (strongest set found across all G7 topics):** migration `0070_ii_r10_reports_authoritative_write_hardening.sql` documents a live, reproduced-on-DEV same-user forgery class (patching `section_data_json`/`narrative_text` directly, forging `report_snapshots` provenance, stamping `published` bypassing the guard) — 5/5 attacks succeeded pre-fix. Fix drops all `authenticated`-role write policies on all six report-family tables to SELECT-own only, moving writes to the service-role client with `.eq('user_id', userId)` enforcement. Cross-tenant isolation separately verified via `scripts/r10_repro_cross_user.mjs` — **a one-off manual live-DEV script, not a standing automated test.** Same caveat for the forgery-fix repro scripts. Genuine coverage gap: the RLS fix is real and live, but nothing in CI would catch a future accidental re-loosening of the policy.

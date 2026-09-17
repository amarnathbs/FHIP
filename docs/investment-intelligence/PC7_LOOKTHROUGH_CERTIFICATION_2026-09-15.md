# PC7 — Underlying Fund Holdings Look-Through Foundation: Certification

**Phase:** M7 of the "Investment Intelligence + AIE-1 Convergence" mission (phase 8 of 11)
**Branch:** `mission/m7-pc7-2026-09-15`, branched from `6ad2a007da9036a46bbf35c8e7adcb08cf2b7e1b` (M6/PC6 tip)
**Date:** 2026-09-15
**Verdict:** **CONDITIONAL PASS**

---

## 0. The scope question, answered plainly

**There is no original approved PC7 scope.** The M0 master scope ledger
(`II_POST_PC4_MASTER_SCOPE_LEDGER_2026-09-15.md` §3.4, re-read at the start of this phase)
records the entire prior definition of PC7 as one table cell in
`II_PC4_STATUS_2026_09_07.md:137` — *"PC7 — underlying MF holdings / X-Ray"* — mapped from the
PC4 gap *"Fund holdings disclosures (`ii_fund_holdings_snapshots`) — zero rows, no ingestion
code"*. §3.4 marks **Original mandatory requirements: NOT RECOVERABLE**, and §5 records `SL-PC7`
as **NOT FOUND (label + additive Part O only)**.

Alongside that label sits one binding boundary contract, which is real and which this phase
treats as its most important constraint: PC7 owns underlying mutual-fund portfolio/look-through
data, and look-through constituents are analytical decomposition only that must never create
extra household net worth.

**Therefore: Part O of this mission's dispatch — O.1 through O.10 — IS PC7's scope for this
mission, and nothing else.** No fictitious prior specification is reconstructed, exactly as
Phase 5 did for PC5 and Phase 7 did for PC6. If the Product Owner holds an earlier approved PC7
requirement set, it has never been in this repository, on any ref, in any commit, and it must be
supplied before anyone can claim PC7 "preserved" it.

---

## 1. What already existed — verified fresh, not assumed

Part W forbids claiming proof without re-verifying against current state. Three of this phase's
inherited assumptions turned out to need correction.

| ID | Inherited claim | Verified state on 2026-09-15 | Verdict |
|---|---|---|---|
| PC7-B-01 | `ii_fund_holdings` (R1) "is the exact look-through shape you're meant to populate" | **PARTLY WRONG.** Read in full (`0031_ii_reference_foundation.sql:141-155`), that table carries only `(fund_instrument_id, underlying_instrument_id, underlying_name, disclosure_date, weight_pct, source_id)`. It has **no** asset type, sector, industry, market-cap class, credit rating, maturity, duration, quantity, market value, coverage, versioning or supersession. It **cannot express O.4 at all.** The real look-through shape is `ii_fund_holdings_snapshots` / `ii_fund_holdings_lines` from migration `0044` (R5), which carries every one of those fields. PC7 builds on 0044 and leaves 0031's table alone. | **CORRECTED** |
| PC7-B-02 | M0 ledger: `ii_fund_holdings_snapshots` has "zero rows, no ingestion code" | **PARTLY STALE.** Live DEV on 2026-09-15: `ii_fund_holdings_snapshots` = **19 rows**, `ii_fund_holdings_lines` = **0 rows**, `ii_fund_holdings` = **32 rows**. The 19 snapshots are R5 fixture headers (`source_document_version='vc-doc-1'`, `source_id` NULL) with **no lines at all** — the exact "snapshot header with no constituents" shape that reads downstream as a measured zero. Production: **0 / 0 / 0**. "No ingestion code" remains **true**. | **CORRECTED + a real finding** |
| PC7-B-03 | The O.6 analytics need building | **ALREADY BUILT AND CERTIFIED.** `lib/engines/investment-intelligence/xray/` contains `lookThrough.ts`, `overlap.ts`, `concentration.ts` (sector, industry, market-cap, AMC, scheme), `debtXray.ts` (credit quality, maturity buckets, weighted duration, issuer concentration) and `xrayOrchestrator.ts`, all from R5 and all certified. PC7 is the **data foundation beneath them**, exactly as the M0 ledger says. Rebuilding them would have been duplication, not delivery. | **CORRECTED** |
| PC7-B-04 | Migration 0155 (PC6) may have been applied by now | **STILL UNAPPLIED.** Probed on both databases, 2026-09-15 (`scripts/m7_pc7_migration_freshness_probe.mjs`): **0 of 6** PC6 objects present on DEV, **0 of 6** on production. | **CONFIRMED UNAPPLIED** |
| PC7-B-05 | No DDL path exists from this environment | **STILL TRUE.** `scripts/pc5_ddl_capability_probe.mjs` re-run 2026-09-15: no `exec_sql`/`execute_sql`/`run_sql`/`admin_exec`/`sql`/`pg_execute`/`exec`/`query` RPC, no `SUPABASE_ACCESS_TOKEN`/`SUPABASE_MANAGEMENT_TOKEN`/`SUPABASE_PAT`, no `DATABASE_URL`/`POSTGRES_URL`. | **CONFIRMED** |

**Consequence of B-04 + B-05, stated precisely:** migration `0157` **cannot be applied by this
phase**. Everything in PC7 that depends on `0157` (and on `0155` beneath it) is proven at
schema level against a real Postgres rebuild (PGlite), not against DEV. Everything that does
**not** depend on it — including O.7, the single most important item — is proven live on DEV
with real rows. That asymmetry is reported item by item in §4 rather than blurred.

---

## 2. Migration number freshness

Four independent sources, because the standing finding of this whole mission is that any single
source under-reports (`scripts/m7_pc7_migration_freshness_probe.mjs`, 2026-09-15):

| Source | Result |
|---|---|
| This branch's `supabase/migrations/` | max **0155** |
| Every git ref's `supabase/migrations/` | max **0156** — `0156_app_review_0915_clear_leaked_migration_notes.sql`, on `fix/app-review-findings-2026-09-15`, a **separate branch not part of this mission** (it originally claimed `0154` and was renumbered to resolve that collision) |
| DEV `supabase_migrations.schema_migrations` | **UNREADABLE — HTTP 406.** Reported as unreadable, not as zero. |
| PRODUCTION `supabase_migrations.schema_migrations` | **UNREADABLE — HTTP 406.** |

**Number claimed: `0157`.** Collision probe for every object PC7 intends to introduce returned
**absent on both databases**; prerequisite probe for every object PC7 reads returned **present on
both**. The carried-forward instruction that "0157 is the next genuinely free number" is
therefore **confirmed independently**, not taken on trust.

> **Note on the ledger being unreadable.** M6's probe used the same `Accept-Profile:
> supabase_migrations` header and reported parsed versions. Today both databases return 406 to
> that request. This is recorded as a **change in probe access, not as evidence about migration
> state** — the object-level collision probe is what actually establishes 0157's freshness, and
> it ran successfully on both.

---

## 3. What PC7 built

| Artefact | Purpose |
|---|---|
| `lib/config/investment-intelligence/pc7DisclosureSources.ts` | O.3 governed source registry. Licence-aware, every entry `enabled: false`, fetching a disabled source throws with the reason. |
| `lib/services/investment-intelligence/pc7/portfolioDisclosureParser.ts` | O.3/O.4 deterministic SEBI-layout parser. Pure `string[][] → records`. |
| `lib/services/investment-intelligence/pc7/disclosureImportRunner.ts` | O.3/O.5 ingestion planner. **Reuses** PC6's `referenceImportRunner`. |
| `lib/services/investment-intelligence/pc7/lookthroughDataQuality.ts` | O.8/O.9 the six data-quality signals, pure and testable. |
| `lib/services/investment-intelligence/pc7/netWorthSafety.ts` | O.7 asserted three independent ways. |
| `lib/services/investment-intelligence/pc7/lookthroughDataAdmin.ts` | O.9 capability guard (Admin Standard §2/§4). |
| `app/api/admin/investment-intelligence/lookthrough-data-quality/route.ts` | O.9 read-only operator API, eight panels. |
| `app/(app)/admin/.../lookthrough-data-quality/page.tsx` + `components/admin/LookthroughDataQualityClient.tsx` | O.9 operator surface. |
| `supabase/migrations/0157_pc7_lookthrough_foundation.sql` | O.4 schema extension, PC6 ledger extension, O.7 database assertion, admin capability, DISABLED job row. |
| `tests/unit/pc7LookthroughFoundation.test.ts` | 74 assertions. |
| `scripts/pc7_0157_pglite_verification.mjs` | 44 assertions against a fresh 0001..0157 rebuild. |
| `scripts/pc7_networth_safety_live_dev.mjs` | 19 assertions, live on DEV. |
| `scripts/m7_pc7_migration_freshness_probe.mjs`, `scripts/m7_pc7_dev_lookthrough_baseline.mjs` | Read-only probes backing §1 and §2. |

### 3.1 Reuse, not a second ingestion stack (explicit)

Phase 7 built `pc6/referenceImportRunner.ts` to be reused. PC7 **imports and re-exports**
`decideStart`, `backoffMinutes`, `nextAttemptAfter`, `classifyFetch`, `settleBatch` and
`buildAlerts` unchanged, and extends `ii_reference_import_batches.batch_kind` with
`'fund_holdings_disclosure'` rather than creating a parallel ledger. Test **PC7-R-01** asserts
PC6's actual backoff values (15 / 240 / 360-ceiling) through the PC7 module, so a reimplemented
copy that drifted would fail.

One thing is deliberately **not** reused: PC6's `decideUpsert`. A NAV row is an independent
dated scalar; a holdings disclosure is a multi-line document. PC7 states its own
`planSnapshot` with its own reasoning visible, rather than hiding a mismatch behind a familiar
function name.

### 3.2 A real defect found and fixed in certified code (O.8)

`lib/services/investment-intelligence/r5Repository.ts:632` assigned:

```ts
sourceKey: 'db',
```

to **every** holdings snapshot. O.8 requires every X-Ray result to expose **source**, as-of date
and coverage. As-of date and coverage were already honest; source was the literal string `'db'`
— true of everything and informative about nothing. The read did not even select `source_id`.

Fixed: `source_id` is now selected, resolved through `ii_sources` to a real `source_key`, and
`LookThroughResult` gains `sourcesUsed` (per fund: source key, as-of date, that fund's disclosed
coverage) so provenance reaches the surface alongside the other two. Where a snapshot genuinely
carries no source — the state of all 19 DEV fixture rows — it reads **`unattributed`**, which is
a different and more useful answer than `'db'`: it tells the operator the provenance is missing.

---

## 4. O.1 – O.10 verdicts

### O.1 — Scope — **PASS**

Stated plainly in §0: no prior approved PC7 scope exists; Part O is the scope. Recorded in the
migration header and in this document rather than implied.

### O.2 — Terminology — **PASS**

**Underlying Fund Holdings** is used throughout for constituents inside a scheme; the ambiguous
bare "Fund Holdings" is not used in any new artefact. User-owned fund positions are referred to
as *fund positions* and live in the investment register. The admin surface is titled
"Underlying Fund Holdings Quality" and opens by distinguishing the two.

| ID | Assertion | Evidence |
|---|---|---|
| PC7-T-01 | New code and UI use the unambiguous term | `LookthroughDataQualityClient.tsx` header comment + page copy; every new module's header |

### O.3 — Source ingestion — **CONDITIONAL PASS** (blocked on licensing, not on engineering)

**The investigation was done for real, against primary sources.** Findings:

| ID | Finding | Status |
|---|---|---|
| PC7-S3-01 | **SEBI mandates the disclosure.** Master Circular for Mutual Funds `SEBI/HO/IMD/IMD-PoD-1/P/CIR/2024/90` (27 Jun 2024), Chapter 5 clause 5.1.1: AMCs must disclose each scheme's month-end portfolio **with ISIN**, in downloadable spreadsheet form, within **10 days**, on their own site and on AMFI's; **debt schemes fortnightly within 5 days**, with the yield of each instrument. Clause 5.1.5 points at a prescribed format. | VERIFIED |
| PC7-S3-02 | **The prescribed "format" is a print template, not a schema.** SEBI's published formats document prescribes four columns — `Name of the instrument \| Quantity \| Mkt value (Rs in lakhs) \| % to NAV` — with section bands. **ISIN, Industry and YTM are required by the circular text but are not columns in the mandated table.** This is why real files differ materially between publishers. | VERIFIED |
| PC7-S3-03 | **The files are genuinely spreadsheets, not narrative PDFs** — confirming the dispatch's warning against assuming PDF. Concrete examples located: SBI MF publishes one `.xlsx` workbook covering all schemes; Axis MF publishes `.xlsx`; ICICI Prudential publishes `.zip`; Groww MF publishes `.xlsx` and `.zip`. Some AMCs do publish PDF. | VERIFIED |
| PC7-S3-04 | **AMFI publishes NO constituent dataset.** `NAVAll.txt` was fetched and contains only scheme code, both ISINs, name, plan, option, NAV, date. AMFI's Research & Information section lists only aggregate products (AUM, folio counts, commission disclosure). **There is no AMFI equivalent of `NAVAll.txt` for holdings.** Whether AMFI *hosts* the AMC spreadsheets or merely links to them could **not** be verified (host unreachable from this environment). | VERIFIED (negative), with one named unverified sub-question |
| PC7-S3-05 | **There is no stable cross-AMC URL convention.** ~57 AMCs, each with its own path scheme. Axis MF alone uses opaque numeric paths and has served older months from a different host. | VERIFIED |
| PC7-S3-06 | **BLOCKER PO-PC7-1 — the terms are adverse and inconsistent.** AMFI's Terms of Use licence the site *"for your personal and non-commercial use only"* and state *"You shall not store electronically any significant portion of any part of the Site"*. Nippon India MF prohibits *"aggregating, copying or duplicating in any manner any of the content"*. SBI MF's `robots.txt` disallows `/*.xlsx?*` and `/*?*` — and its canonical file URLs carry a `?sfvrsn=` version parameter, so **its actual download URLs are robots-disallowed**. HDFC MF's site returns 403 to non-browser clients. ICICI Prudential's `robots.txt` disallows nothing and its terms carry no scraping clause — absence of prohibition, which is not permission. | VERIFIED — **BLOCKER** |
| PC7-S3-07 | **BLOCKER PO-PC7-2 — the clean path is paid.** Real commercial suppliers of Indian MF constituent data: **ICRA Analytics** (MFI Explorer / MFI360), **Accord Fintech** (ACE MF Nxt, ACE Datafeed), **LSEG Lipper** (Lipper Fund Holdings), **Morningstar** (Direct / Licensed Data), **CRISIL Intelligence**. All require a paid licence. Value Research's licensing could not be verified. | VERIFIED — **BLOCKER** |

**The engineering is complete; the authority to run it is not.** A public disclosure obligation
binding the **publisher** is not a redistribution licence for a **consumer**, and the two are
routinely conflated. Every source therefore ships `enabled: false`, `buildDisclosureUrl()`
throws on a disabled source, both `ii_sources` rows ship `is_active = false`, and the
job-control row ships disabled. Enabling any of it is a Product Owner decision plus a
human-present operator act.

**O.3's AIE boundary is satisfied structurally.** `parsePortfolioDisclosure` takes a cell grid
and nothing else. There is no parameter through which an AIE document, an acceptance lifecycle
or a user-review queue could be passed, so a shared extraction utility can hand over a grid and
stop. No PC7 module imports anything from the AIE user-document intake path.

| ID | Assertion | Evidence |
|---|---|---|
| PC7-S-01 | Every disclosure source ships disabled | Test PC7-S-01; `anyDisclosureSourceEnabled() === false` |
| PC7-S-02 | A disabled source cannot be fetched, and the refusal names the licence state | Test PC7-S-02 |
| PC7-S-03 | An unknown source id throws rather than resolving to something plausible | Test PC7-S-03 |
| PC7-S-04 | Debt schemes carry the fortnightly cadence and a tighter staleness bound (21 vs 45 days) | Test PC7-S-04 |
| PC7-S-05 | AMFI's lack of a constituent dataset is recorded in code, so nobody hunts for it again | Test PC7-S-05 |
| PC7-PG-03/04/05 | 0157 seeds both `ii_sources` rows, both `is_active = false`, both reusing 0155's `reference_data_provider` category | PGlite |
| PC7-PG-38/39/40 | Job-control row exists, ships DISABLED, names the blockers | PGlite |
| PC7-PG-41 | 0157 registers no `cron.schedule` | PGlite |

### O.4 — Snapshot model — **PASS (schema-level), CONDITIONAL on 0157 application**

Every field O.4 names, and where it lives:

| O.4 requirement | Column | Origin |
|---|---|---|
| Scheme identity | `fund_instrument_id` → `ii_instruments`; `scheme_master_id` → `ii_scheme_master` | 0044 + **0157** |
| As-of date | `holdings_as_of_date` (the date holdings *describe*, distinct from `ingested_at`) | 0044 |
| Source | `source_id` → `ii_sources`; `source_url`, `source_sha256`, `source_byte_length`, `source_retrieved_at`, `source_document_version` | 0044 + **0157** |
| Constituent security identity | `underlying_instrument_id` (nullable by design), `isin`, `source_identifier`, `resolution_method` | 0044 |
| Weight / value / quantity | `weight_pct`, `market_value`, `quantity`, plus **`market_value_unit`** | 0044 + **0157** |
| Asset type | `asset_kind` (`security`/`cash`/`derivative`/`other`), `security_type` | 0044 |
| Sector / industry | `sector_code`, `industry_code`, plus **`industry_or_rating_raw`** verbatim | 0044 + **0157** |
| Market-cap bucket | `market_cap_class` (`LARGE`/`MID`/`SMALL`/`OTHER`) | 0044 |
| Debt rating / maturity / duration | `credit_rating_band`, `agency_ratings`, `maturity_date`, `coupon_pct`, `modified_duration`, plus **`yield_pct`** | 0044 + **0157** |
| Cash / other allocation | `asset_kind` buckets, preserved and never redistributed | 0044 |
| Coverage percentage | `disclosed_weight_total_pct` (what was disclosed) + **`resolved_weight_total_pct`** (what resolved) + **`line_count`** | 0044 + **0157** |
| Freshness | `holdings_as_of_date` vs `ingested_at`; `classifySnapshotFreshness()` | 0044 + PC7 code |

**Two O.4 additions worth calling out because they prevent specific, silent, large errors:**

- **`market_value_unit`** (closed domain: units / thousands / lakhs / millions / crores). SEBI-layout
  files state market value in **lakhs**. A pipeline that assumes rupees is out by a factor of
  100,000 and the numbers still look like plausible money. The unit is stored with the values,
  never assumed by the reader.
- **`resolved_weight_total_pct` separate from `disclosed_weight_total_pct`.** These are different
  coverage questions. Conflating them hides unresolved exposure behind a healthy-looking
  disclosure total.

| ID | Assertion | Evidence |
|---|---|---|
| PC7-PG-09..21 | All 13 new snapshot columns exist with the intended types | PGlite |
| PC7-PG-22 | All 5 new line columns exist | PGlite |
| PC7-PG-23/24 | `market_value_unit` accepts `lakhs`, refuses an unknown unit | PGlite |
| PC7-PG-25/26/27 | `source_sha256`, `disclosure_period` shape constraints genuinely refuse bad input | PGlite |
| PC7-PG-42/43/44 | 0044's own weight-range and asset-kind constraints survive PC7's extension | PGlite |

### O.5 — Security master integration — **PASS (design + schema), CONDITIONAL live**

PC7 creates **no** security identity of its own. Scheme identity resolves through
`ii_instruments` (AMFI code, then ISIN) and links to PC6's `ii_scheme_master` via
`scheme_master_id`. Constituents resolve through `ii_instruments` by **ISIN**, then by
**curated alias** (`ii_security_aliases`). There is deliberately **no fuzzy name path**.

The reasoning is stronger here than for PC6's NAV import: a mis-resolved NAV is one wrong
number, whereas a mis-resolved scheme attaches an **entire portfolio** — 60 securities, every
sector weight, every credit band — to the wrong fund, and the result looks completely plausible.
A code/ISIN disagreement is surfaced as `AMBIGUOUS_SCHEME_CONFLICT` rather than broken by
precedence.

`SchemeIdentityIndex.schemeMasterAvailable` records whether `ii_scheme_master` was genuinely
readable. `false` is an honest state (0155 unapplied) that downgrades the recorded resolution
**provenance** rather than silently pretending the scheme master was consulted.

> **Phase 7's ISIN caveat, honoured.** DEV's instrument master contains fixture ISINs that fail
> their ISO 6166 check digit, so ISIN-keyed resolution against DEV is narrower than its row count
> suggests. PC7's parser validates every ISIN and **drops** a failing one with a warning while
> **retaining the line** as unresolved — a wrong ISIN resolves to the wrong company, which is
> worse than no ISIN. Test **PC7-P-10** exercises exactly that with a deliberately bad check digit.

| ID | Assertion | Evidence |
|---|---|---|
| PC7-R-05 | Scheme resolves by AMFI code, then ISIN; **never** by name | Test |
| PC7-R-06 | A code/ISIN disagreement is surfaced, not resolved by precedence | Test |
| PC7-R-07 | An unresolved scheme writes **no** snapshot at all | Test |
| PC7-R-09 | Cash / derivative / other lines are never resolved into a security | Test |
| PC7-R-10 | Constituents resolve by ISIN, then curated alias; a near-name is **not** matched | Test |
| PC7-P-10/11 | Bad ISIN dropped + line retained; missing ISIN flagged + line retained | Test |
| PC7-PG-09 | `scheme_master_id` FK to `ii_scheme_master` exists | PGlite |
| — | **Live proof that anything reads `ii_scheme_master`** | **BLOCKED** — 0155 unapplied on DEV (PC7-LD-00) |

### O.6 — Look-through analytics — **PASS (verified, not rebuilt)**

Every analytic O.6 names already exists in the certified R5 engine. PC7 verified each against
the current code and re-ran its certification rather than duplicating it:

| O.6 requirement | Implementation | Verified |
|---|---|---|
| Underlying stock/bond exposure | `lookThrough.ts` `calculatePortfolioLookThrough` | yes |
| Sector / industry exposure | `concentration.ts` `calculateSectorExposure` / `calculateIndustryExposure` | yes |
| Market-cap mix | `concentration.ts` `calculateMarketCapExposure` | yes |
| Issuer / credit exposure | `debtXray.ts` `calculateIssuerConcentration` / `calculateCreditQuality` | yes |
| Overlap between schemes | `overlap.ts` `calculateFundOverlap` / `calculateOverlapMatrix` | yes |
| Concentration | `concentration.ts` `calculateSecurityConcentration` / `calculateSchemeConcentration` | yes |
| Top underlying holdings | `lookThrough.ts` `topEffectiveHoldings` | yes |
| AMC exposure | `concentration.ts` `calculateAmcConcentration` (by **value**, not scheme count) | yes |
| Coverage ratio | `calculateFundCoverage` + `effectiveCoverage` | yes |
| Debt duration / credit summaries | `debtXray.ts` `calculateWeightedDuration`, `calculateMaturityBuckets` | yes |

**Determinism is preserved** — the engine is pure and every threshold is versioned in
`xrayThresholds.ts` (`xray-thresholds-r5-v1`), stamped into every result.

What PC7 added here is the missing **input** and one missing **output field**: the ingestion
path that produces snapshots at all, and `sourcesUsed` (see O.8). Test **PC7-W-09** drives the
real, unmodified engine over a real parsed disclosure end to end.

| ID | Assertion | Evidence |
|---|---|---|
| PC7-O6-01 | The R5 X-Ray certification still passes after PC7's changes | `iiR5Certification` + `iiR5MathIdentities` + `iiR5NoFabrication`: **284/284 pass** together with the PC6 and PC7 packs |
| PC7-W-09 | The real engine consumes a real PC7-parsed disclosure and closes exactly | Test |

### O.7 — Wealth safety — **PASS (the strongest evidence in this phase)**

> *Look-through constituents are analytical decomposition only. They must never create extra
> household net worth.*

Defended three independent ways, because **any one of them can hold while the system is still
wrong**: a structural check alone passes a system that double-counts inside the engine; an
arithmetic check alone passes a system whose engine is perfect and whose repository quietly
inserts an extra asset row.

**(a) Structural — asserted by the database itself.** Migration 0157 adds
`ii_pc7_networth_safety_violations()`, which returns one row per structural leak: a foreign key
from a net-worth input table (`assets`, `investments`, `retirement_accounts`, `liabilities`,
`business_entities`, `financial_snapshots`) into a look-through table, or a tenancy column
(`user_id`/`household_id`/`owner_user_id`/`profile_id`) on a look-through table. It returns
**rows, not a boolean**, so a failure says what is wrong.

**And it is proven not to be vacuous.** The PGlite run injects each violation shape, confirms the
assertion fires, removes it, and confirms it stops:

| ID | Assertion | Result |
|---|---|---|
| PC7-PG-28 | The function exists | PASS |
| PC7-PG-29 | **Zero violations on the real schema** | PASS |
| PC7-PG-30 | Injecting a tenancy column **makes it fire** | PASS |
| PC7-PG-31 | Removing it makes it stop | PASS |
| PC7-PG-32 | Injecting an FK from `investments` into look-through **makes it fire** | PASS |
| PC7-PG-33 | Removing the FK returns the schema to satisfied | PASS |

**(b) Arithmetic — decomposition is closed.** `assertDecompositionIsClosed()` requires
exposure + cash + derivative + other + unresolved + undisclosed-remainder + no-snapshot ≤ 1,
at a tolerance of 1e-9 — far tighter than any currency rounding, so a double-count of even the
smallest holding fails while summing thousands of floats does not. A **shortfall** is explicitly
*not* a violation: that is honest under-disclosure, reported as coverage and never rescaled.

**(c) Observed — live on DEV, 19/19 assertions.**
`scripts/pc7_networth_safety_live_dev.mjs`, run 2026-09-15 against `vqycarelcoijzwlpkpcz`:

| ID | Assertion | Result |
|---|---|---|
| PC7-LD-01 | 0044's look-through tables ARE live on DEV | PASS |
| PC7-LD-02 / 02b | Disposable synthetic tenant, real `createUser` + real password sign-in, satisfying the real Mandatory Country Confirmation gate | PASS |
| PC7-LD-03 | The user holds **one** fund position worth exactly ₹1,000,000 | PASS |
| PC7-LD-04 | Net worth **before** = exactly 1,000,000 | PASS |
| PC7-LD-05 | A full look-through decomposition is ingested: 1 snapshot + **9 constituent lines** | PASS |
| PC7-LD-06 | The decomposition genuinely sums to **100%** | PASS |
| **PC7-LD-07** | **O.7 SATISFIED LIVE: net worth changed by EXACTLY ZERO.** `{assets 0, investments 1000000, retirement 0, liabilities 0, netWorth 1000000}` before and after — compared by exact equality, **no tolerance**; zero fields moved | **PASS** |
| PC7-LD-08 | Net worth is still the one position, not double it (1,000,000, not 2,000,000) | PASS |
| PC7-LD-09 | Read back from the live database: `{security 97, cash 2.5, derivative 0, other 0.5}` = **exactly 100%**, never more | PASS |
| PC7-LD-10 | In money: decomposed value = 1,000,000 = the position value, not added to it | PASS |
| PC7-LD-11 | **NEGATIVE CONTROL** — an ordinary authenticated user **cannot** insert a look-through line (HTTP 403, RLS) | PASS |
| PC7-LD-12 | **NEGATIVE CONTROL** — nor a look-through snapshot (HTTP 403, RLS) | PASS |
| PC7-LD-13 | **POSITIVE CONTROL for the negative control** — the same user CAN read the same 9 rows, so 11/12 are write denials and not broken requests | PASS |
| PC7-LD-14 | **POSITIVE CONTROL for the measurement** — adding ₹1 of real wealth moves the measurement to 1,000,001, so PC7-LD-07 is not vacuous | PASS |
| PC7-LD-15 | and removing it restores 1,000,000 | PASS |
| PC7-LD-16 | The live `investments` row carries **no** column referencing any look-through table | PASS |
| PC7-LD-16b | The II columns it does carry (`ii_publication_id`, `ii_canonical_account_id`, `ii_canonical_instrument_id`, …) are **publication/identity** links, never constituent links | PASS |
| PC7-LD-17 | **CLEANUP** — independent re-query confirms **zero** synthetic rows remain on DEV | PASS |

> **A false positive found and fixed during this run, recorded because it matters.** The
> structural check first used a loose `/snapshot/i` match and flagged
> `investments.pre_publication_manual_snapshot` — an R3 publication-lifecycle column with nothing
> to do with look-through. It was narrowed to the three look-through table names. A safety check
> that cries wolf is one people learn to ignore.

**Unit-level coverage:** PC7-W-01 through PC7-W-10, including PC7-W-04 (an **empty** check is a
FAILURE, not a vacuous pass) and PC7-W-08 (one paisa of movement fails — there is deliberately
no tolerance).

### O.8 — Freshness UX — **PASS**

Every X-Ray result now exposes all three of source, as-of date and coverage. Source was the
missing one; see §3.2.

**"Never zero as if measured"** is enforced structurally rather than described:

| Situation | What is shown | Never |
|---|---|---|
| No snapshot for any scheme | `status: 'unavailable'`, `MISSING_HOLDINGS`, an explanatory `detail` | 0% exposure |
| Snapshot exists, 44% disclosed | coverage 0.44, remainder 0.56 retained explicitly | rescaled to 100% |
| Snapshot with **no lines** | flagged as a coverage gap, reason `no_lines` | a fund that holds nothing |
| Line cannot be resolved | retained as `unresolvedWeight`, visible exposure | dropped, or name-matched |
| No source recorded | `unattributed` | `'db'`, or a plausible-looking source name |
| Import window with no rows read | rejection rate **`null`** | 0%, which reads as healthy |
| Nothing ever ingested | panel state `never_ingested` | `ok` with zeroes |
| A future-dated snapshot | `MISSING` for an earlier date | "very fresh" |

Freshness uses the **same thresholds as the certified user-facing engine**
(`HOLDINGS_FRESHNESS_DAYS`: CURRENT ≤45, ACCEPTABLE ≤100, STALE ≤210, beyond that VERY_STALE),
so the operator dashboard cannot read green while a user is shown a stale-data warning.
Portfolio-level freshness is governed by the **oldest** contributing snapshot — the weakest link,
never the most flattering one.

| ID | Assertion | Evidence |
|---|---|---|
| PC7-F-01 | Every look-through result exposes source alongside date and coverage | Test |
| PC7-F-02 | An unavailable look-through reports UNAVAILABLE, never zero exposure | Test |
| PC7-Q-02 | Freshness uses the certified engine's own thresholds, all four bands | Test |
| PC7-Q-03 | A future snapshot is MISSING for an earlier date | Test |
| PC7-Q-08 | A zero-row window has an **unknown** rejection rate, not 0% | Test |
| PC7-P-05 | The parser reports the publisher's genuine 44%, never rescaled to 100% | Test |
| PC7-P-17 | A blank/nil cell is `null`, never zero | Test |
| PC7-W-10 | A 44%-disclosed fund yields 45% coverage and a 55% retained remainder | Test |

### O.9 — Admin / data quality — **PASS (code + schema), CONDITIONAL live**

All six required signals, each with an explicit result state:

| O.9 signal | Implementation | Panel |
|---|---|---|
| Missing scheme disclosures | `findMissingDisclosures` — separates *missing* from *missing **and held*** | `missing_disclosures` |
| Stale snapshots | `assessSnapshotStaleness` — one verdict per **fund**, using its newest snapshot | `stale_snapshots` |
| Unmapped securities | `findUnmappedSecurities` — grouped by identity, non-security buckets excluded | `unmapped_securities` |
| Coverage gaps | `findCoverageGaps` — including the dangerous `no_lines` case | `coverage_gaps` |
| Parser / import failures | `summariseImportFailures` — PC7 batches only | `import_failures` |
| Source changes | `detectSourceChanges` — layout, sections, rejection spike | `source_changes` |

Plus `networth_safety` (the live O.7 assertion) and `blocked_sources` (the honest gap), because a
surface that shows only what *is* ingested hides the fact that nothing is.

**Three design decisions worth stating:**

- **Staleness is judged per fund, not per snapshot.** A fund with five years of preserved monthly
  disclosures would otherwise report as "60 stale snapshots" — burying the funds that genuinely
  have none recent. Test **PC7-Q-04** asserts a preserved 2020 snapshot does not make a
  currently-disclosed fund look stale.
- **A column rename is reported even when both imports SUCCEEDED.** A publisher quietly renaming a
  column, the parser continuing to "work", and every number afterwards coming from the wrong
  column, is the worst silent failure in reference ingestion — and the one nobody looks at,
  precisely because it succeeded. Test **PC7-Q-10**.
- **Unmapped securities are grouped by identity.** An operator sees "this name is unresolved in 41
  snapshots at up to 9.5%" — one decision worth 41 fixes — rather than 41 unremarkable rows.

**Admin Architecture Standard compliance** (mandatory per `AGENTS.md`):

| § | Requirement | How PC7 meets it |
|---|---|---|
| §2 | A new surface gets its own NAMED capability, never a coarse flag | `admin_users.can_view_lookthrough_data_quality` (0157), default FALSE. Deliberately **separate from PC6's** `can_view_reference_data_quality`: an operator may be trusted with fund-portfolio quality without the market-data feeds, and vice versa. Tests assert neither grant confers the other. |
| §4 | Navigation is not authorisation — enforce at every layer | L1 `is_pc7_lookthrough_data_admin()` RLS predicate (0157); L2 `requireLookthroughDataAdmin()`; L3 `requireLookthroughDataAdminPage()` redirect; L4 its own `Fund Look-Through` nav group. |
| §5/§14 | Read-only unless a separate capability says otherwise | No POST/PATCH/DELETE in the route. 0157 admits both look-through tables as `ii_reference_corrections` targets for whenever a correction surface is authorised. |
| §8 | Result-state semantics | Three states everywhere: `ok` / `never_ingested` / `unavailable`. |
| §9 | Personal/financial data boundary | The only user-derived input is a per-scheme **boolean** ("held by anyone") plus a count. No user id, no value, no per-user row leaves the route. Everything else is global reference data with no tenancy column — asserted structurally by `ii_pc7_networth_safety_violations()`. |
| §13 | Safe failure | An unknown `panel` value fails closed with 422. A missing relation reports `unavailable` **with the reason**, never an empty healthy dashboard. A missing capability column (0157 unapplied) fails closed to `false` — an unapplied migration must not become a grant. |

| ID | Assertion | Evidence |
|---|---|---|
| PC7-Q-01, 04..13 | All six signals behave correctly, including the non-obvious cases above | 13 unit tests |
| PC7-PG-34..37 | The capability column exists, defaults FALSE, NOT NULL; the predicate exists; it is separate from PC6's | PGlite |
| — | **Live proof of the admin surface end to end** | **BLOCKED** — needs 0155 + 0157 applied |

### O.10 — Certification — **CONDITIONAL PASS**

**Independent oracles used:**

1. **The publisher's own control totals.** Sub Total / Grand Total / Net Assets rows are parsed as
   **oracles, never holdings**, and the parse is checked against them at a 0.5 pp tolerance. When
   they disagree, the **parse wins** and a `CONTROL_TOTAL_MISMATCH` is raised for a human — the
   publisher's arithmetic is a cross-check, not an authority to overwrite what was read
   (**PC7-P-15**, **PC7-P-16**).
2. **The double-count trap, quantified.** Test **PC7-P-04** shows the fixture's Sub Totals sum to
   **42%** on top of a genuine **44%**. A parser that treated them as holdings would report ~86%
   — roughly double. The trap is measured, not asserted.
3. **A totality identity.** Every grid row lands in exactly one of accepted / rejected / control /
   section-header / blank. **PC7-P-25** pins the fixture at exactly **11 accepted, 0 rejected, 4
   control rows** — "the parser returned some records" would pass even if it silently dropped a
   whole section.
4. **The decomposition identity**, at 1e-9 (**PC7-W-06**, **PC7-W-09**, **PC7-LD-09**).
5. **A live before/after net-worth measurement with both controls** (**PC7-LD-07**, **PC7-LD-14**).
6. **Overlap and weights** through the unmodified certified R5 engine (284/284).

**Why CONDITIONAL and not FULL.** Certification "using selected source disclosures" is satisfied
against the **structure** of real SEBI-layout disclosures, verified from primary sources — but
**not against a downloaded real AMC file**, because ingesting one is exactly what PO-PC7-1
blocks. Certifying against a file we are not licensed to retrieve would be certifying the wrong
thing. The fixture is built to the verified real layout, including every trap real files carry;
it is honest evidence about the parser, and it is not evidence about any specific AMC's file.

---

## 5. Evidence summary — exact counts

| Measure | Count |
|---|---|
| PC7 unit assertions | **74 / 74 PASS** (`tests/unit/pc7LookthroughFoundation.test.ts`) |
| PGlite schema assertions, fresh 0001..0157 rebuild | **44 / 44 PASS** (`scripts/pc7-0157-pglite-results.json`) |
| Migrations applied in that rebuild | **151**, ending at `0157_pc7_lookthrough_foundation.sql` |
| Live-DEV assertions | **19 / 19 PASS** (`scripts/pc7-networth-safety-live-dev-results.json`) |
| Live-DEV scenarios exercised | 1 synthetic tenant; 1 instrument; 1 fund position; **1 snapshot + 9 constituent lines**; 2 RLS write denials; 1 RLS read allowance; 1 sensitivity probe; full cleanup |
| R5 X-Ray + PC6 + PC7 packs together | **284 / 284 PASS** |
| Admin nav contract pack | **267 / 267 PASS** |
| **Schemes with disclosures ingested (DEV, production)** | **0 / 0** — no source is enabled; PO-PC7-1 and PO-PC7-2 are open |
| **Holdings snapshots created by PC7 (persisted)** | **0.** The 1 live snapshot was synthetic and was deleted; cleanup re-verified zero residue |
| Pre-existing DEV look-through rows (unchanged by PC7) | 19 snapshot headers with **0 lines**; 32 `ii_fund_holdings` rows |
| TypeScript | `tsc --noEmit` **clean** |
| Full suite | **17 files / 39 tests failing — identical with and without PC7's edits** |

### 5.1 Regression baseline — a correction

The carried-forward baseline was *"16 files / 22 tests failing"*. Measured today on this branch,
the real pre-existing baseline is **17 files / 39 tests**. This was established properly rather
than assumed: PC7's only two edits to pre-existing files
(`xray/lookThrough.ts`, `r5Repository.ts`) were **stashed**, the same 17 files re-run, and they
failed identically — **17 files / 39 tests**. With the edits restored, the full suite reports the
same 17 files / 39 tests.

**PC7 adds zero new failures.** None of the 17 failing files references `lookThrough`,
`r5Repository`, `xray`, `pc7` or `fund_holdings` (verified by grep). They are:
`adminAnalyticsPhaseAMeRoute`, `aiResidualClosureFailClosed`, `countryGateAccessMatrix`,
`fdh1Isolation`, `lr12rSmsfPropertyLoanLinkOverride`, `lrFi2DebtServiceExactlyOnce`,
`lrFi2HouseholdDebtRatios`, `smsfHouseholdIsolation`, and nine `resources*` files that fail at
module-collection level.

### 5.2 PC4's 19-invariant regression contract

Not broken. PC7 writes to no PC4-owned table, changes no PC4 code path, and its only edits to
pre-existing files are (a) additive selection of an existing column plus a lookup, and (b) an
additive field on a result interface. §5.1's stash-and-compare is the mechanical evidence.

---

## 6. Open blockers and risks

| ID | Item | Owner | Blocks |
|---|---|---|---|
| **PO-PC7-1** | **Licensing decision on AMC portfolio disclosures.** SEBI obliges AMCs to publish; AMFI's Terms of Use bar commercial use and bulk electronic storage; Nippon India bars aggregation; SBI's robots.txt disallows its own .xlsx URLs; HDFC edge-blocks bots; ICICI Prudential prohibits nothing. Needs a per-AMC decision, ideally with Indian counsel. | Product Owner | Any real ingestion |
| **PO-PC7-2** | **Or: select and license a commercial vendor.** ICRA Analytics, Accord Fintech, LSEG Lipper, Morningstar, CRISIL Intelligence. The only path with clean redistribution rights. | Product Owner | Any real ingestion |
| **OPS-PC7-1** | **Apply migrations `0153`, `0154`, `0155`, then `0157`, in order.** No DDL path exists from this environment. Until then: `scheme_master_id`, the batch ledger extension, the O.7 database function, the admin capability and the job-control row do not exist in any database. | Operator | O.4/O.5/O.9 live proof |
| **OPS-PC7-2** | **19 orphan snapshot headers on DEV** (`source_document_version='vc-doc-1'`, 0 lines, `source_id` NULL). These are R5 fixtures, but they are exactly the shape that makes the engine compute a measured-looking zero. PC7 detects them (`coverage_gaps`, reason `no_lines`) but does not delete them — deleting data an operator may be relying on is not this phase's call. | Operator | Nothing; recommended cleanup |
| **RISK-PC7-1** | **~57 AMCs, no cross-AMC join key, no stable URL convention, layouts that drift.** Even once licensed, per-AMC crawling is ongoing operational work, not a one-off integration. O.9's source-change detection exists specifically because of this. | Product Owner | Sizing, not correctness |
| **INFO-PC7-1** | Both `schema_migrations` ledgers returned HTTP 406 today where M6 read them. Recorded as a probe-access change; 0157's freshness rests on the object-level collision probe, which ran fine on both. | — | Nothing |

---

## 7. Verdict

**PC7 — CONDITIONAL PASS.**

**What is genuinely done and proven:**

- The complete ingestion, analytics-integration, data-quality and safety machinery, reusing PC6's
  runner rather than growing a second stack.
- **O.7, PC7's defining boundary, proven three independent ways — including 19/19 live on DEV with
  real rows, both a negative control and a positive control, and a database-level assertion
  demonstrated not to be vacuous.** This is the strongest claim in this document and it is the one
  that matters most.
- A real O.8 defect found and fixed in previously-certified code (`sourceKey: 'db'`).
- Three inherited assumptions corrected against current state rather than repeated.
- Migration `0157` verified free against four sources and proven to apply, re-apply and constrain
  correctly on a fresh 0001..0157 Postgres rebuild.

**Why not FULL PASS — two reasons, neither an engineering gap:**

1. **No source is licensed.** Zero real schemes ingested, zero real snapshots created. Not a
   parser limitation: the disclosures exist, are mandated, are spreadsheet-shaped, and the parser
   is written to their verified structure. What is missing is the **authority** to retrieve and
   store them (PO-PC7-1 / PO-PC7-2).
2. **Migrations 0155 and 0157 are unapplied everywhere**, and no DDL path exists from this
   environment. Everything depending on them is proven at schema level against real Postgres —
   which is real evidence about the schema and the constraints, and is **not** evidence that any
   hosted database has them.

Neither is dressed up as done. Per this programme's own standing rule, documentation and
schema-level proof alone never earn a FULL PASS.

---

## 8. Appendix — artefacts

**Code:** `lib/config/investment-intelligence/pc7DisclosureSources.ts`;
`lib/services/investment-intelligence/pc7/{portfolioDisclosureParser,disclosureImportRunner,lookthroughDataQuality,netWorthSafety,lookthroughDataAdmin}.ts`;
`app/api/admin/investment-intelligence/lookthrough-data-quality/route.ts`;
`app/(app)/admin/investment-intelligence/lookthrough-data-quality/page.tsx`;
`components/admin/LookthroughDataQualityClient.tsx`

**Modified:** `lib/services/investment-intelligence/r5Repository.ts` (O.8 source provenance);
`lib/engines/investment-intelligence/xray/lookThrough.ts` (`sourcesUsed`);
`lib/admin/adminNav.ts`, `app/api/admin/me/route.ts` (capability wiring);
`tests/unit/adminAnalyticsPhaseA.test.ts` (nav contract extended for the new group)

**Migration:** `supabase/migrations/0157_pc7_lookthrough_foundation.sql` — requires `0155` first

**Tests:** `tests/unit/pc7LookthroughFoundation.test.ts` (74)

**Scripts + machine-readable results:** `scripts/pc7_0157_pglite_verification.mjs` →
`scripts/pc7-0157-pglite-results.json`; `scripts/pc7_networth_safety_live_dev.mjs` →
`scripts/pc7-networth-safety-live-dev-results.json`;
`scripts/m7_pc7_migration_freshness_probe.mjs`; `scripts/m7_pc7_dev_lookthrough_baseline.mjs`

**Not pushed. Not merged. No production configuration, data or schedule was touched.**

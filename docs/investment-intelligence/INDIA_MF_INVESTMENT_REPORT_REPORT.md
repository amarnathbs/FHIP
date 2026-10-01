# India Mutual Fund Investment Report, plus Market-Index Data

Branch `feat/india-mf-investment-report-20261001` (from `origin/main` `cce323f`). Not pushed, not merged.
Prepared 2026-10-01.

## 0. Evidence labels (read this first)

| Label | Meaning here |
|---|---|
| **code-complete** | Written, type-checked, linted, covered by unit tests that run in this repository. |
| **PGlite-verified** | The migration was replayed, with all 232 earlier migrations, on a real Postgres engine (PGlite/WASM) and exercised, including negative controls. This is NOT the hosted database. |
| **DEV-verified** | Exercised against the real DEV Supabase project. **Nothing in this work is DEV-verified.** |
| **production-verified** | **Nothing in this work is production-verified.** |

Plainly: **migration `0232` is NOT applied to DEV or production.** No DEV credentials were used (none were reachable unattended and none were minted). The PO apply script is `scripts/india_mf_po_apply_0232.sql`. Nothing was written to production. The live NSE/BSE sites were not called by any test or by the build (see section 10 for the single format-confirmation attempt, which timed out).

## 1. What was built

1. **Report section** `india_mf_investment_report`: one table-style section inside the existing Monthly Report, broken up per owner, with the summary tiles A..H, XIRR, the 16-column table and a "Fund Portfolio Total" row for each owner.
2. **Index data**: an Admin upload page and API for historical Nifty 50 / BSE Sensex closing values (preview then attested commit), and a daily updater that ships **disabled**.
3. **Migration `0232`** and its PGlite verification.

## 2. PO decisions applied

| Decision | How it is applied |
|---|---|
| One section inside the existing Monthly Report pipeline | Added as a **premium** section built in `lib/engines/reportSectionsPremium.ts`, loaded by `lib/services/reportSnapshotResolver.ts`, stored as an ordinary `report_sections` row, rendered by `ReportPreview` (screen, print and PDF), NAV-pinned by the existing manifest writer. No new report type, table, or generation path. |
| PDF export Premium-only, as today | Unchanged: the section lives only inside the premium report; the existing export route and entitlement rules apply to the whole report. |
| **Eligibility chosen** | **Premium plan tier** (premium sections are only built when `source.planTier === 'premium'`; same rule as `investment_performance` and `tax_and_cost`) **AND** the user actually holds at least one **INR mutual-fund** position. Nothing else. |
| Gating revision (PO, later): not by home country | Home country is never consulted. An Australian-resident user with an Indian mutual-fund folio gets the section; a user with no India MF holding never does. When there is no India MF holding the section is **not built at all** (not shown as "unavailable", not listed). Server-side, fail closed. |
| Break-up by owner | Section 7. |
| No blanket `n/a` for partial history (PO, later) | Section 8: figures are computed from the best available history and carry a visible basis marker. `n/a` only when mathematically undefined or genuinely absent. |
| Index data: upload ~25 years and update daily | Section 10 and 11. |
| SWP/STP/bonus inside the report only, no change to R4/R6 | Section 6. The certified R4/R6 engines and their persisted results are not modified or read. |
| Ownership selection at upload is a separate workstream | Section 13. |

## 3. Definitions and interpretations

All amounts are INR, as recorded in `ii_transactions`, with `transaction_date <= valuation date`. Rows with status `reversed` or `review_required` are excluded (exactly as R4/R6 exclude them) and footnoted. Code: `lib/engines/investment-intelligence/indiaMfReport.ts` (pure, no DB, no clock).

**Scope.** Mutual funds only (`ii_instruments.instrument_class = 'mutual_fund'`) in an INR account. A *position* is one (folio account, scheme) pair. Non-INR mutual funds and non-mutual-fund instruments are not shown in the tables; they are counted and disclosed in a line under the report ("N holdings ... appear elsewhere in your report").

| Item | Definition |
|---|---|
| **A Purchase** | sum of `abs(gross_amount)` of `purchase` + `sip` |
| **B Switch In** | `switch_in` + `stp_in` |
| **C Switch Out** | `switch_out` + `stp_out` |
| **D Red/SWP** | `redemption` + `swp` |
| **E Div Payout** | `dividend` (cash IDCW payout) |
| **F Net Investment** | **A + B - C - D - E** (always recomputed from the parts, never stored independently) |
| **G Current Value** | units held x latest NAV on or before the valuation date |
| **H Overall Gain** | **G - F** |
| **Reinvestment, bonus, split** | Non-cash. They add units (reinvestment also adds cost at the reinvestment NAV; bonus at nil cost) but are not in A..E, so a reinvested distribution shows up in G and H rather than as a payout. |
| **transfer_in/out, merger, segregation, unlabelled adjustment** | Move units without cash. Applied to the unit balance, **not** to cost, and flagged "not modelled" (footnote e). |
| **Units** | Replayed ledger balance using `reconciliation.ts unitDeltaForTransaction` (the certified signed-unit rule). If a holding snapshot disagrees by more than 0.001 units, the **statement's** units (plus later transactions) win and the position is flagged (footnote i). |
| **Avg NAV** | `costBasis.ts computeCostValue` (average cost), restricted to units with a **recorded** cost; cost value / those units. |
| **Latest NAV** | latest `ii_prices_nav` row on or before the valuation date, shown with its date. If none is stored, the latest holding-snapshot value per unit, labelled "statement value" (footnote j). If neither exists, current value is `n/a` (footnote l) and the fund is left out of the tile. |
| **Unrealised gain** | (units with recorded cost x latest NAV) - cost value. Units bought before the uploaded history are valued in G but not in this figure (marker, section 8). |
| **Realised gain** | R6's FIFO lot functions (`taxLotEngine.ts buildTaxLots` / `consumeLotsFifo`) applied per (account, scheme) to this report's disposal set: `redemption`, `swp`, `switch_out`, `stp_out`. R6 itself does not process SWP or STP. Gain = proceeds apportioned to lots with a recorded cost - those lots' cost. **Not** a tax computation: no holding-period class, grandfathering or indexation. |
| **Avg Days** | Cost-weighted age, in days at the valuation date, of units still held in lots with a recorded acquisition date (FIFO remaining lots). Bonus/split lots have zero weight. `n/a` when no lot carries cost. |
| **Start Dt** | earliest unit-acquiring transaction (`purchase, sip, switch_in, stp_in, reinvestment, bonus, transfer_in`). |
| **XIRR (per folio)** | R4's `xirr()` engine on the position's own cash flows. Outflows: `purchase, sip, switch_in, stp_in, fee, tax`. Inflows: `redemption, swp, switch_out, stp_out, dividend`. Terminal flow: units with recorded cost x latest NAV on the NAV date. Not a cash flow: reinvestment, bonus, split, transfers. |
| **XIRR (owner total)** | Pools the owner's flows **excluding switch/STP legs** (R4's own portfolio rule: a switch moves money between two of the owner's schemes) plus all terminal values. |
| **Valuation date / Report date** | Valuation date = the report's as-of date; report date = generation date. Both shown. |
| **BSE Sensex / Nifty 50** | latest stored price-index close on or before the valuation date, with its date; otherwise the slot reads "not available". Never invented, never carried from a later date. |

**Known, disclosed consequence of two cost methods.** Avg NAV and unrealised gain use average cost (as the PO asked, via `costBasis.ts`); realised gain uses FIFO (R6 lot functions). After partial redemptions the two attribute cost differently, so unrealised + realised + dividends need not equal H exactly. With complete history, no reinvestment and a single cost lot it does (the hand-checked test asserts 40,000 + 8,000 + 2,000 = 50,000). Footnote n says this on the page.

## 4. Column-by-column source map

| Column | Held / derived / needs-new-data | Source |
|---|---|---|
| Folio | held | `ii_accounts.folio_number` |
| Scheme | held | `ii_scheme_master.scheme_name` (current row) else `ii_instruments.instrument_name` |
| Start Dt | derived | earliest acquiring `ii_transactions` row |
| Units | derived | `ii_transactions` replay (+ `ii_holding_snapshots` cross-check) |
| Avg NAV | derived | `costBasis.ts` over `ii_transactions` |
| Latest NAV | held | `ii_prices_nav` (fallback `ii_holding_snapshots`) |
| Inv Amt / Switch In / Red-SWP / Switch Out / Dividend | derived | `ii_transactions.gross_amount` by type |
| Avg Days | derived | FIFO remaining lots (R6 lot functions) |
| Curr Value | derived | units x NAV |
| Unrealised / Realised gain | derived | average cost / FIFO as above |
| XIRR | derived | R4 `xirr()` on ledger flows |
| Header: Sensex, Nifty | **needs-new-data (now supplied)** | `ii_benchmark_series` under the two new `ii_benchmarks` rows (migration `0232`); loaded by the admin upload or the (disabled) daily feed |
| Owner and share | held | `ii_ownership_allocation`, `ii_accounts.owner_member_id`, `household_members`, `business_entities` |
| History completeness | held | `ii_portfolio_truth_status.history_completeness` (used as a corroborating flag only) |

Nothing else needed new data. No new column or table was required on any user-data table.

## 5. How the section reaches the report (and the PDF)

- **Generation / storage / snapshots**: `resolveReportSourceData` loads it with the other premium chapters; `buildPremiumSections` builds it (display order 33); `generateReport` stores it as a normal `report_sections` row with `section_data_json` holding the pure module's result, so a saved report never recalculates. A provenance `report_snapshots` row is not added (the existing `snapshot_type` set is unchanged; the section's own `source_references_json` carries module, version, valuation date and the two index dates).
- **Eligibility union**: `'india_mf_investment_report'` added to `PremiumSectionCode` in `reportEligibility.ts`. `report_sections.section_code` has no CHECK constraint (migration 0010), so no migration is needed for the new code.
- **Lists**: the section is absent unless the user holds India MF funds; `ReportTypeCode` and `/api/reports/types` are untouched (this is a section, not a report type).
- **NAV pinning**: `reportNavDependencyWriter.deriveReportNavDependencyInputs` now also pins every fund of the section with the existing basis `xirr_since_inception` (bounded at the fund's first transaction; for a holding with no transactions at the earlier of its statement date and the NAV date used). No new basis value, no migration. Where R4 already pins the same (instrument, basis) the **wider** window now wins in either order (previously first-wins), which can only widen protection.
- **Print / PDF fit**: the table has 16 columns, wider than the portrait text area (182 mm), so the whole section sits in a CSS **named page** (`@page india-mf-landscape { size: A4 landscape }`, `app/globals.css`) and prints on landscape pages while the rest of the report stays portrait. **Verified in the PDF renderer's own Chromium** (Playwright, same `page.pdf` options as `lib/services/reportPdfRenderer.ts`): a synthetic report rendered as portrait, then three landscape pages (595x842 / 842x595 / 842x595 / 842x595 / 595x842 pt MediaBoxes), then portrait. Rows are kept whole, the header row repeats on a continuation page, owner blocks of up to 8 rows are not split. No change to the renderer was needed. Evidence: `docs/investment-intelligence/india-mf-report-example/`. This was rendered from the component with a Tailwind build, not through the running Next app (no app/DEV was available), so the live `/reports/[id]/print` route is code-complete but not visually proven end to end.

Rendered example (synthetic household, invented people/folios/NAVs): `docs/investment-intelligence/india-mf-report-example/` contains `screen_view.png`, the five PDF page images and `synthetic_example_landscape_section.pdf`.

## 6. SWP / STP / bonus: gap handling and its limitation

The certified engines ignore some transaction types: R4's flow sets (`analyticsRepository.ts OUTFLOW_TYPES/INFLOW_TYPES`) omit `swp`, `stp_in`, `stp_out`, `bonus`, `split`; R6's `DISPOSAL_TYPES` is only `redemption, switch_out, sale`; R4's scheme XIRR is per instrument, not per folio. PO default applied: **handle them inside this report's own calculations and footnote the affected funds; do not touch R4/R6.**

- SWP is in **D** and is a disposal for realised gain and an inflow for XIRR.
- STP legs are treated as switch in (B) / switch out (C), a lot acquisition / a disposal, and an XIRR outflow / inflow at folio level (excluded from the owner-pooled XIRR as internal transfers).
- Bonus units: nil-cost lots; splits change units only.
- Footnotes (a) SWP, (b) STP, (c) bonus/split, (d) reinvestment each **name the affected funds** and say that R4/R6 do not process these and the report's figures for them can differ from those engines'.
- **Limitation, disclosed**: for a fund with SWP/STP the report's XIRR and realised gain can differ from the Investment Performance (R4) and Tax & Cost (R6) chapters of the same report, because those chapters do not process these events. Reconciling the engines is a separate, PO-authorised change (open decision 1).
- Where an SWP/STP/switch **amount** is genuinely absent from the data the cell is `n/a`; the code never estimates an amount.

## 7. Owner break-up design

Resolution (`resolveOwners`), reading only what exists today:

1. Active `ii_ownership_allocation` rows (narrowed to the (account, scheme) if present, else account-level). The group (`allocation_group_id`) must total **exactly 10000 bp**, each row exactly one of member/entity, else it is ignored and the reason is shown.
2. Else `ii_accounts.owner_member_id` at 100%.
3. Else the **"Unallocated / owner not set"** section (never dropped, never guessed).

Each owner gets its own section: tiles, table, total row. Order: Self, Spouse, Partner, Child, Parent, other members, then entities (HUF, Family Trust, Company), then Unallocated. **Entity sections are never added into personal totals** and there is no grand total at all; a note on the page says the sections are not added together (entity data separation ruling, PO 2026-09-21). A joint folio appears in **each** owner's section at that owner's share: units and all amounts are x bp / 10000; NAV, Avg Days and XIRR are share-invariant; the folio cell reads "60% share (joint folio)". The shares of one joint folio sum to the whole (tested). An owner id with no matching member/entity row falls to Unallocated, not dropped. Entity types shown from `business_entities.entity_type` (`huf`, `family_trust`, `company`).

## 8. Partial history: rules (PO decision)

The platform's position is that history is obtained (statements plus NAV1 hydration), so partial history is not the normal case and must not turn into blanket `n/a`. Rules:

- A position is **partial** when any of: units are held that were bought before the earliest uploaded transaction (including an `OPENING_BALANCE` marker row), a disposal consumed such units, a unit adjustment is not modelled, the ledger disagrees with the statement, or reconciliation flags `partial_history`.
- A partial position **still shows** Units, Current Value (every held unit is valued), Avg NAV, Unrealised gain, Avg Days and XIRR, computed on **units with a recorded cost**, and carries a **visible marker under the scheme name**: `from 12-Dec-2022; earlier history not uploaded` (or `holding only; no transactions uploaded`, `transaction history does not match the statement units`, `includes a unit adjustment not modelled in cost`), plus footnote (f) with the PO's wording: *older history is not in the uploaded statements; until MFCentral integration is available, request a full CAS from CAMS or KFintech and upload it here.* No direct-fetch or MFCentral integration is built or referenced in code; the data model is unaffected by it.
- `n/a` is reserved for: XIRR with no sign change / no valuation / multiple roots (the engine's own reason is printed under the table); realised gain when **every** disposal consumed units with no recorded cost; Avg NAV when no unit with recorded cost is held; any amount genuinely absent.
- Tests: "partial history shows a labelled value, never a blanket n/a" and "XIRR is n/a, with the engine's reason, only when mathematically undefined".

## 9. Admin Architecture Standard compliance (index upload)

Capability affected: **`marketIndexDataUpload`** = `admin_users.can_upload_market_index_data` (new, default false). Separately named; not implied by `isAdmin`, PC6 `referenceDataQuality` or PC7 `lookthroughDataQuality` (tested both ways).

| Clause | How it is met | Proof |
|---|---|---|
| s2 named capability, 7 required properties | roles: any admin the PO grants the column to; UI: nav group only with the field; route, API, DB enforcement as below; denial 401/403 | `marketIndexAdminRoute.test.ts` (nav, parser, /me) |
| s4 layer 1 database | `is_market_index_data_admin()`; `commit_market_index_upload()` authorises with `auth.uid()` **inside** the function; RLS on `ii_market_index_batches` (capability read, no write policy) | PGlite IMF-PG-08..16, 34..38 |
| s4 layer 2 API | `requireMarketIndexAdmin()` on every verb; 401 / 403; fails closed on read error or missing column | `marketIndexAdminRoute.test.ts` "API layer" (5 tests) |
| s4 layer 3 route/page | `requireMarketIndexAdminPage()` redirects (`/login`, `/dashboard`) before render | "page layer" tests |
| s4 layer 4 nav | `lib/admin/adminNav.ts`, `/api/admin/me` independent read | "navigation layer" tests |
| s4 direct-URL, direct-API, database-bypass tests | respectively: page test, API test, PGlite direct RPC calls (plain user, admin without capability, anon, no attestation) | as above |
| s6 privileged RPC | internal auth, pinned `search_path`, fixed return type (`jsonb`), no dynamic SQL, `EXECUTE` revoked from `public, anon` and granted to `authenticated` (upload) / `service_role` only (feed), explicit exception for unauthorised callers | PGlite IMF-PG-07, migration static test |
| s8 result states | status shows `never_ingested` as its own state, never a zero; unavailable (migration not applied) is stated | `GET returns status ...` test |
| s9 personal/financial boundary | tables are global reference data with no tenancy; API returns `uploadedByMe`, never another admin's id | same test |
| s11 exports | none: no export exists | n/a |
| s13 safe failure | role-resolution error, missing column, RPC error, malformed body all fail closed | tests |
| s14 no scope expansion | only its own nav entry, capability, endpoints, tests; no unrelated admin code changed; one pre-existing failing test file noted, not fixed | section 14 |
| s15 documentation | this section, section 11 operating notes, `scripts/india_mf_po_apply_0232.sql` (apply, verify, grant, **rollback/disablement**); future-review owner: PO | |
| s16 exceptions | **none requested.** | |

## 10. Index upload design

**Storage (reused, per PO):** `ii_benchmarks` / `ii_benchmark_series`. Two new benchmark rows (`IN_NIFTY_50_PRI`, `IN_SENSEX_PRI`, `return_type 'PRI'`, `licence_status 'unknown'`) are mapped to **no fund**, so loading them changes no existing benchmark comparison. The PC6 licence gate (`csvBenchmarkImporter` and `benchmarkCoverage` refuse `licence_required/unknown` benchmarks for comparison) is **left exactly as it was**. The per-upload attestation recorded in the ledger is the rights evidence for these display-only header values. This is a deliberate reading of the licence semantics: **BENCH-1/PC6 recorded NSE/BSE index levels as `licence_required` (BLOCKER PO-PC6-1)**; this feature does not clear that blocker for benchmark comparison.

**Price index only**, not total return (a TRI series is a different product; the UI and parser say so).

**Accepted layouts** (header-driven, case-insensitive, any column order): niftyindices.com historical export (`Index Name, Date, Open, High, Low, Close`, `02 Jan 2024`), NSE daily `ind_close_all` (`Index Date`, `Closing Index Value`, `02-01-2024`), BSE archive (`Date, Open, High, Low, Close`, `02-January-2024`), generic `date,close`. Dates are **day-first** (US month-first is not interpreted and is rejected). **Honest status of these layouts:** they are written from the publicly visible column conventions of those downloads; the checked-in fixtures are **synthetic** files in those shapes, not recordings of a live download. A single attempt to fetch one public NSE archive file to confirm the format **timed out** (60 s), so the format was **not** confirmed live. The parser is header-driven so a small naming change does not break it, and anything unreadable is rejected per row with a stated reason.

**Flow (stateless, idempotent):** `POST {action:'preview'}` parses and compares with what is published and writes nothing; `POST {action:'commit'}` re-parses the same file, checks the preview hash, then makes **one** call to `commit_market_index_upload()` under the caller's own session (the service-role client is never used on this surface; tested statically).

**Validation:** real calendar date, not future, not before 1979-01-01; positive value inside a per-index plausibility band; identical duplicate rows collapsed; conflicting duplicate dates rejected (all rows of that date); a spike >25% against **both** neighbours rejected as an outlier; moves >10% listed as warnings; Saturday/Sunday rows **held back** unless the operator includes them (special sessions exist); rows for other indices in an all-index file ignored, and a file with none of the selected index rejected (naming what it contains); 5 MB / 20,000-row ceilings; a different value for an already-published date is **never overwritten** (blocks the commit unless the operator chooses "skip conflicting dates").

**Audit:** `ii_market_index_batches` (append-only, trigger-blocked UPDATE/DELETE/TRUNCATE, no write grant): uploader id, file name, file SHA-256, rows submitted/inserted/identical, date range, the **required attestation text** and time. The database refuses an `admin_csv` row without uploader, hash and a >=20-character attestation. The exact attestation statement is fixed in code and shown beside the checkbox; the commit is refused (422, and again in the database) without it. **No shared audit-event CHECK constraint was widened** (so the sibling-branch constraint trap cannot occur); the ledger is this feature's own audit trail.

**Report read:** `latestIndexCloseOnOrBefore` returns the latest stored close on or before the valuation date and its date; no row, no benchmark row, a read error, or a close dated after the valuation date all yield "not available".

## 11. Daily updater design and the licence warning

**WARNING TO THE PO.** NSE and BSE restrict automated scraping and redistribution of their index data. Confirm the NSE/BSE terms (or hold a licence) **before** enabling the updater. It is **disabled by default and was not enabled.** The earlier PC6 mission recorded the same blocker (`SOURCE_DECISION.md`, PO-PC6-1).

Design (`lib/services/investment-intelligence/marketIndex/dailyFeed.ts`, route `app/api/investment-intelligence/cron/market-index-daily/route.ts`):

- **Two independent off-by-default switches, both required:** env `MARKET_INDEX_FEED_ENABLED === 'true'` and `ii_reference_job_control` row `market_index_daily_close` `enabled = true` (a missing row also means off). When off, no request is made and (for the env switch) not even a database read.
- **No schedule is created.** Migration `0232` adds no `pg_cron` job; scheduling is a deliberate, human-present step (same as the PC6 jobs).
- **Same auth as the other cron routes**: `x-cron-secret` vs `CRON_SECRET`.
- **Adapters behind an interface** (`IndexFeedAdapter`): NSE adapter targets NSE's public daily index-closing archive file; the **BSE adapter has no default endpoint** (needs an operator-supplied `https` template, `MARKET_INDEX_BSE_CSV_URL_TEMPLATE`, after terms are confirmed) and otherwise reports `not_configured` and makes no request.
- **Polite**: identifying User-Agent (`FHIP-IndexUpdater/1.0`), no cookies, no browser impersonation, redirects not followed, 2.5 s between real requests, 5 recent weekdays at most.
- **Never bypasses bot protection**: 401/403/429, an HTML/CAPTCHA body, or any block page => `SOURCE_BLOCKED`, **one request, no retry, the run stops**. Only transport errors, timeouts and 5xx are retried (3 attempts, backoff).
- **One row per trading day**; days already published are not fetched again; a 404/absent file is a non-trading day (not an error); a value spiking >25% against the previous close is rejected and alerted; a value that would change a published close is never written (database counts it, alert `FEED_VALUE_CONFLICT`).
- **Writes** through `record_market_index_feed_closes()` (service-role only), which also records a `daily_feed` row in the ledger, atomically.
- **Staleness alerting** with the repository's existing `Alert` shape and `assessFreshness`: `INDEX_STALE` (critical, latest close older than 5 days), `INDEX_NEVER_LOADED`, plus `SOURCE_BLOCKED`, `SOURCE_OUTAGE`, `FEED_WRITE_FAILED`. Critical alerts are logged at error level; the response carries codes only. Consecutive failures drive the existing backoff.
- Tests use a recorded-fixture HTTP double; **no live site was called**.

## 12. Migrations and collision-scan evidence

Added: **`0232_market_index_data_upload_and_feed.sql`** (one file; idempotent; no constraint drop/recreate; RLS on the new table; append-only; revokes; job disabled; no schedule). Rollback is in `scripts/india_mf_po_apply_0232.sql`.

Collision scan (run twice; re-scan before merging): all local and remote refs, and every worktree under `D:\FHIP\.claude\worktrees`. `origin/main` highest = **0229**. Found above it: **`0230_module11_7_ai_coach_prompt_and_model_task_type.sql`** (branches `m11-7-ai-coach-beta-20261001`, `m11-7-latency-validator-20261001`, worktrees `m117-base`, `m117-latency-validator`, one agent worktree) and **`0231_admin_premium_entitlement_grants.sql`** (branch `feat/admin-premium-grant-20261001`, worktree `admin-premium-grant`). Nothing else above 0229 at the first two scans. **Final re-scan (end of work, branches only; the worktree listing had not finished when this was written)** additionally found **`0236_owner_before_upload_phase1.sql`** (branch `feat/owner-before-upload-phase1-20261001`) and my own `0232`; no two branches share a number. Chosen **0232**, above everything found at design time; the later sibling `0236` is above it, so the merge order only needs the usual ledger check (`0232` must apply before `0236` is irrelevant: they touch different objects). The Module 11 stack's `0175-0178` are below main's highest and were not reused. Expect a mechanical merge conflict in `lib/admin/adminNav.ts` and `app/api/admin/me/route.ts` with the admin-premium-grant branch (both add a capability); resolve by keeping both fields.

PGlite verification (`scripts/india_mf_0232_pglite_verification.mjs`, result file `scripts/india-mf-0232-pglite-results.json`): chain 0001..0232 applied from empty; 0232 re-applies as a no-op; **42/42 checks pass**, including each refusal naming its SQLSTATE and the "after the refusal nothing was written" checks.

## 13. Ownership at upload time (separate workstream)

Not touched. The report reads ownership only from `ii_accounts.owner_member_id` and `ii_ownership_allocation` (and `household_members`, `business_entities`). When ownership is later chosen before upload it will arrive in those same two places, so no change to the report is needed. The report never writes ownership and nothing here depends on how it was set.

## 14. Tests

Targeted suites run (all green unless stated):

| File | Tests | Covers |
|---|---|---|
| `tests/unit/indiaMfReport.test.ts` | 28 | tile arithmetic F and H against a hand-checked fund (switch in/out, SWP, dividend, redemption); avg NAV, unrealised, realised (FIFO), avg days (416.5), XIRR NPV~0; STP/SWP/reinvestment/bonus classification; per-owner split, joint-folio bp scaling (shares sum to whole), entity never in personal totals, unallocated surfaced, bad allocation group, cross-user rows ignored; partial-history labelled value; XIRR `n/a` only when undefined; holding-only; index never invented; valuation fallbacks |
| `tests/unit/indiaMfReportIntegration.test.ts` | 18 | loader gating (AU user **with** an Indian folio gets it; AU-only / equity-only / empty get none), cross-user isolation (every user-scoped read carries `user_id`), fail-closed, builder (null / error / included), premium-only registration, NAV pin (bounds, wider-window merge), render (16 columns, owners, markers, "not available"), landscape CSS contract |
| `tests/unit/marketIndexParser.test.ts` | 20 | recorded-fixture parsing (three layouts), every rejection code, weekend hold-back, outlier, wrong index, US dates |
| `tests/unit/marketIndexAdminRoute.test.ts` | 24 | non-admin and capability-less admin -> 403, unauthenticated -> 401, fail closed, page redirect, nav, `/api/admin/me`, preview writes nothing, commit needs the exact attestation, RPC under the caller's session, 42501 -> 403, conflict -> 409, idempotent no-op, skip-conflicts, no service-role client |
| `tests/unit/marketIndexDailyFeed.test.ts` | 31 | disabled by default (5 off-states, no request), cron auth, recorded-fixture adapters, 403/429/401/HTML => one request and stop, bounded 5xx retry, polite headers, rate limit, normal run, outlier/conflict/stale alerts |
| `tests/unit/marketIndexMigration.test.ts` | 9 | no constraint drop / shared audit list, RLS, append-only, revokes, in-function auth, idempotent guards, no schedule |
| `scripts/india_mf_0232_pglite_verification.mjs` | 42 | database-bypass and negative controls on real Postgres |

Existing suites re-run as regression: `reports`, `reportsIIChapters`, `reportCanonicalAppendix`, `reportCanonicalSections`, `reportSectionsPremiumStressApplicability`, `reportStalenessImports`, `reportExportDownloadCacheHeader`, `iiReportImmutabilityMarkToMarket`, `pc6ReportNavDependency{Integrity,Manifest,Writer}`, `appNavCapability`, `appCapabilityManifest`, `g2AmountColumnAlignment` (passes alone; times out at 5 s only when run in parallel with tsc, a known repo hazard), `adminA02Wave2CapabilityMatrix`, `adminA02Wave5GapPrivacy`, `adminA02Wave5ResultStateAndHelp`, `adminAnalyticsPhaseA`, `adminAnalyticsPhaseARouteMatrix`, `countryGateAdminAndHousehold`, `money`, `pc7LookthroughFoundation`, `appCapability`. Observed: the first nine of these groups (reports, report chapters, canonical appendix/sections, NAV-dependency, nav capability, manifest, admin Wave2/5, admin Analytics Phase A, country gate, money, PC7) passed except the pre-existing failure below. **Not completed:** a final run of the whole `tests/unit/pc6*`, `pc7*`, `ii*` families. The shared `D:\FHIP
ode_modules` was deleted and reinstalled by an `npm ci` outside this work during the final stage and had not finished restoring after more than 30 minutes, so vitest could not run; the one attempt made before that (`pc6`+`pc7`+`ii` in a single run) hit the 10-minute tool limit under load and produced no result. Re-run these before merging: `npx vitest run tests/unit/pc6 tests/unit/pc7 tests/unit/ii`.

**Pre-existing failure, not caused by this work and not fixed (Admin Standard s14):** `tests/unit/adminAnalyticsPhaseAMeRoute.test.ts` has 17 failing tests on `origin/main` itself (its expectations omit the PC6/PC7 capability fields). Confirmed by running it against `origin/main`'s `adminNav.ts` and `/api/admin/me`: the same 17 fail. I added one capability field to four literals in `adminAnalyticsPhaseA.test.ts` only so those typed objects still compile.

Gates: eslint clean on all touched files (one pre-existing `<img>` warning in `ReportPreview.tsx`); `tsc --noEmit`: the 66 pre-existing errors (missing `pdf-parse`/`xlsx`/payment SDK types) are unchanged and **no new error** appears (compared by file and message against a baseline captured first).

### Negative controls (each rule was deliberately broken in the code and the named test failed)

**Observed (PGlite, real Postgres):** `scripts/india_mf_0232_pglite_verification.mjs` makes each refusal a named check that returns the SQLSTATE the database raised and then proves nothing was written: plain user / admin without the capability / anon calling the RPC directly (`42501`, anon `permission denied`); no attestation, short attestation, bad hash, index outside the allow-list (`22023`); future date, zero, negative, duplicate dates, pre-1979 date (`22023`); a different close for a published date (`23505`, the non-conflicting row is not written either); UPDATE/DELETE/TRUNCATE on the ledger (`42501`); an `admin_csv` row without attestation (`23514`); a plain user and a capability-less admin reading the ledger (zero rows); the capability holder writing the ledger directly; the feed RPC for an authenticated admin. 42/42.

**Observed while building (unit tests):** the outlier test failed when my fixture value fell outside the per-index plausibility band (it was rejected as `out_of_range` before reaching the outlier rule), which is how the two rules were confirmed to be distinct; the rate-limit test failed against the first runner version (it slept before knowing an adapter was unconfigured) and the runner was corrected.

**Designed, harness written, NOT YET EXECUTED:** `scripts/india_mf_negative_controls.py` breaks one rule at a time in the source, runs the named test file and records which test names fail, restoring the file afterwards. It covers 18 rules: F = A+B-C-D-E, H = G-F, joint-folio bp scaling, entity separation, unallocated surfaced, partial history labelled (not n/a), index never invented, India-MF gate, cross-user isolation (loader drops `user_id`), no home-country gate, NAV-pin wider window, conflicting duplicate dates, attestation required, never overwrite a published value, capability guard fails closed, nav not implied by PC6, updater disabled by default, no retry around a 403. It could not be executed because `node_modules` was unavailable (see section 14). **Until it is run, treat the unit-test negative controls as designed, not demonstrated.** Run: `python scripts/india_mf_negative_controls.py` (writes `docs/investment-intelligence/india-mf-report-example/negative_control_runs.json`).

## 15. What was and was not verified

| Item | Status |
|---|---|
| Pure calculation module, loader gating, builder, NAV-pin, render, CSS contract | code-complete, unit-tested |
| PDF: landscape named page in the PDF renderer's Chromium (mixed portrait/landscape) | verified on a synthetic render, **not** through the live app |
| Migration `0232` | PGlite-verified; **not applied** to DEV or production |
| Admin upload page and API | code-complete, route-tested with doubles; **never run against a real database or browser** |
| Daily updater | code-complete, tested with fixtures; **disabled; never called a live site; NSE format unconfirmed live** |
| End-to-end generation of a real report containing the section | **not done** (needs DEV) |
| DEV / production | **none** |

## 16. PO decisions still open

1. Reconcile the report's SWP/STP/bonus handling with R4/R6 (today the report handles them itself and footnotes the difference). Needs authority to change certified engines.
2. NSE/BSE terms or licence: required before enabling the daily feed, and a supplied permitted BSE URL for the Sensex adapter.
3. Whether the two price-index benchmark rows should ever be set `licensed_held` (this would not change the PC6 comparison gate; today they stay `unknown`).
4. Who receives `can_upload_market_index_data`.
5. Weekend/special-session rows: held back unless an operator includes them (confirm this is the wanted policy).
6. Realised gain label: FIFO is the R6 method and is not a tax computation; confirm no holding-period classification is wanted in this table.

## 17. What the PO must do

1. Apply migration `0232` to DEV using `scripts/india_mf_po_apply_0232.sql` (verify block included), then production after sign-off. Re-scan migration numbers before merging.
2. Grant `can_upload_market_index_data` to the intended administrator(s).
3. Upload the historical Nifty 50 and Sensex CSV files in Admin > Market Index Data.
4. **Confirm NSE/BSE terms before enabling the daily feed**; it stays off until then.
5. Then run an end-to-end report generation on DEV with an India-MF household and open the print/PDF view to confirm the landscape page in the live app.

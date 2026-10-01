# Net Worth follows the latest eligible NAV: inventory, design, implementation, proof

Branch `feat/networth-current-nav-remark-20261001`, cut from `fix/document2-finding5-nav-stripe-types-20261001` (`398a0cb`) and, at the Product Owner's instruction, merged with `fix/ii-multifolio-performance-xray-20261001` (`484af09`). Not pushed, not merged to `main`. No production write, no DEV write. Benchmark (BENCH-1) work is excluded.

**Evidence labels.** *code-complete*: the change exists and compiles (`tsc` clean). *test-proven*: unit tests with named negative controls pass. *DEV-verified* / *production-verified*: observed on a running environment. **Nothing in this report is DEV-verified or production-verified.** No signed-in browser and no database session (DEV or production) was available, and migration `0240` has been delivered but not applied anywhere. The human check is `docs/investment-intelligence/NETWORTH_NAV_REMARK_UI_CHECK_PROTOCOL.md`.

**PO decision implemented (2026-10-01).** Dashboard Net Worth uses the current (latest eligible) NAV for current mutual-fund holdings: `value = units x latest eligible NAV`, the same rule as the Holdings table, with an honest as-of date, kept inside every existing invariant. This reverses the Finding #5 recommendation to keep publication frozen.

**Admin standard.** No `app/(app)/admin/**`, `app/api/admin/**`, admin navigation, roles, capabilities, admin-consumed RLS or RPC, admin analytics or exports were touched. No Admin capability is affected, no Admin standard clause applies, no exception is requested.

---

## 1. Inventory: how a published position becomes a canonical row, and how Net Worth reads it

### 1.1 Publication path (`lib/services/investment-intelligence/investmentPublicationService.ts`)

| Step | What happens | Where |
|---|---|---|
| Eligibility | owner resolved to a household member, certified Portfolio Truth, no blocking reconciliation case, class in {mutual_fund, equity, etf} (R12), value > 0 | `evaluateEligibility` (`publicationLogic.ts`) |
| Idempotency | `idempotency_key = hash(account, instrument, canonical_position_id, target)`; an existing `published` row returns `LEAVE_UNCHANGED` | `publishPosition` |
| Duplicate gate | a manual `investments` row for the same owner/category/institution forces an explicit link or "not a duplicate" decision | `detectDuplicateCandidates` |
| Register write (first) | `ADD_NEW`: **insert** one `investments` row (`source_type='investment_intelligence_published'`, `current_value = snapshot.value`, `ii_canonical_account_id/instrument_id`), or `REPLACE_LINK_EXISTING`: **update the user's manual row in place**, capturing `pre_publication_manual_snapshot` | `publishPosition` |
| Publication write (second) | insert `ii_fhip_publications` (`status='published'`, `published_value = snapshot.value`, `canonical_position_id`, `published_row_id`, `include_in_net_worth=true`, `published_owner`); on failure the register write is compensated | `publishPosition` |
| Back-link | `investments.ii_publication_id = publication.id` | `publishPosition` |
| Refresh | newer certified snapshot: old publication -> `superseded`, new publication inserted pointing at the SAME `published_row_id`, the row's `current_value` set to the new `snapshot.value` | `refreshPosition` |
| Unpublish / republish | archive (or restore the manual snapshot) / re-activate the same row and the same publication from `published_value` | `unpublishPosition`, `republishPosition` |

**Exactly-once is enforced by the database and the service, not by the Net Worth read:** `uidx_ii_fhip_publications_one_active_position` (migration `0042`) allows one `published` row per (account, instrument); `idempotency_key` is unique; refresh supersedes before it inserts; `uidx_investments_user_master_manual` (0042) now applies only to manual rows. Units are **not** copied onto the register row: the publication's `canonical_position_id` points at the immutable `ii_holding_snapshots` row (unique per account, instrument and date) that holds `units` and `value`.

### 1.2 How Net Worth aggregates it

- `computeDashboard` (`lib/engines/dashboard.ts`): `totalInvestments = sum(reportingValue(current_value))` over the active `investments` rows the loader passes; `netWorth = totalAssets + totalInvestments + totalRetirement - totalLiabilities + business-entity value`. SMSF is not special-cased for investments.
- `loadDashboardContext` (`lib/services/dashboardData.ts`) builds ONE `CanonicalFinancialSnapshot` (`lib/read-models/snapshot.ts`) and then reads `investments` again for the composition breakdowns. `selectInvestments` (`lib/read-models/investments.ts`) is the canonical portfolio total (`publishedTotal`), consumed by Goals, Reports, the Twin, the imported-statements API.
- **"Imported, not yet in Net Worth"**: the latest `ii_holding_snapshots` row per (account, instrument) that no active register row or `published` publication covers, units > 0. Reported with that label, **never added to a total** (D-05). It is statement-valued and informational; it is unchanged by this work.
- **Direct readers of `investments.current_value`** (the reason a single materialised value beats an overlay, section 3): `dashboardData.ts` composition query; `loadInvestmentRows` (read model, forecast inputs, Goals); `reportSnapshotResolver.ts` premium register query; `goalFundingAllocation.ts`; `GET /api/investments` (the grid); `portfolioAttribution.ts`; report rows in `ReportPreview`.
- **Caching and snapshots.** There is no HTTP, Next.js or in-process cache between the register and Net Worth (a test asserts no `unstable_cache` / `revalidate*` in those files), so there is nothing to invalidate. `financial_snapshots` (monthly row, written at each Dashboard load) stores `net_worth`; it is written *after* the re-mark, so history records the NAV-based figure. Stored monthly reports pin their numbers at generation. `ii_report_nav_dependencies` (NAV1 report pinning) protects **NAV rows** used by Performance/X-Ray sections from retention; it does not pin register values. The latest NAV the re-mark uses is the newest row, which retention never targets, and the NAV, its date and units are copied onto the register row and into the revision log, so the evidence survives even if a NAV row is later purged.
- **Existing exactly-once evidence.** There is no test literally named "#15"; the publish -> Investments -> Net Worth exactly-once proofs in the repository are `iiR3NetWorthCertification` (NW-001..008), `iiR3DedupScenarioMatrix`, `iiR3ManualReconciliation`, `iiR3RepublishFieldRestoration`, `iiR3ProvenanceClosure`, `lrFi3NetWorthContributionExactlyOnce` and `fdh11AuPublishJourney`; all are re-run below and green.

### 1.3 The gap this closes

Publication wrote `current_value = snapshot.value` and nothing ever moved it, so Net Worth stayed at the certified statement value while the Holdings table (Finding #5) showed units x latest NAV: two screens, two numbers, for the same fund.

---

## 2. Options evaluated

| | (a) Read-time valuation | (b) Scheduled re-mark job | (c) Hybrid (chosen: materialised re-mark, pull-triggered) |
|---|---|---|---|
| Single source of truth | The rule at read time; the stored column stays a stale statement value | The stored column (as fresh as the last run) | The stored column, always produced by the rule |
| Readers that must change | **Every** direct reader of `current_value` (7+, section 1.2). One missed reader silently shows the frozen value | None | None |
| Composes with joint split (owner-edit divides `row.current_value` by basis points) | Overlay must run before the division, in the owner-edit branch's code | Yes, automatically | Yes, automatically |
| Freshness | Always current | Lags until the next run; a missed run is invisible | Current at the next Net Worth / Investments / report read or publish; no run to miss |
| Moving parts | none to schedule | pg_cron migration, secret, environment guard, 28 s platform budget, a production activation that only the PO may perform; hooks into the live NAV ingest | none to schedule |
| Writes | none | batch writes | one in-place `UPDATE` per changed row, plus a revision row |
| NAV correction | immediate | next run | next read |
| Drift risk | readers disagree if any forgets | window between ingest and run | window between ingest and the first read; every surface that reads goes through the chokepoint |

**Chosen: (c), a materialised re-mark that is triggered by reads and publication events, with no scheduler.** Reasons, in order of weight:
1. **The register row already is the one place everything reads.** Keeping `investments.current_value` equal to the rule's output means Dashboard, Goals, Reports, Forecast, the grid and the owner-edit joint division all agree with no reader change. An overlay would have required changing at least seven readers and would leave the column itself permanently wrong.
2. **No scheduler to activate.** A job needs a pg_cron migration, secrets and an environment guard (the 0228/0229 history shows how easily that goes wrong), and an autonomous run may not activate a production job. It would also couple the new write to the live daily NAV ingestion, which this change must not be able to disturb.
3. **Evidence stays immutable.** `ii_fhip_publications.published_value` and the certified snapshot are never touched; the re-mark only moves the one register row, and records every change in an append-only revision table.
4. **Cannot create a duplicate.** The re-mark never inserts into `investments`; it updates the row a publication already names. It cannot add a second contribution to Net Worth by construction (and a test asserts zero inserts).

**Costs, stated plainly.**
- A **write on a read path** (a Dashboard load can update the register). Precedent: `writeFinancialSnapshots` already upserts on every Dashboard load. The write is idempotent and a no-op when nothing changed.
- **Extra queries on a read path** for households that have published funds: ~7 batched queries in 4 round trips, constant in the number of holdings (a test proves it); a household with no published rows pays exactly one indexed query.
- **Freshness is "at the next read", not "at ingestion"**: a direct reader that bypasses every chokepoint (a background SQL report) could see the previous mark until the next Net Worth/Investments read. Its value is always labelled with its own as-of date. A scheduled sweep after NAV ingestion remains possible later as a pure optimisation (open decision 3).
- **A stored monthly report becomes "stale"** (its staleness test is "a register row changed after generation") on the first read after a NAV moves the value. That is correct (the numbers did change) but may be noisy daily; see open decision 4.

---

## 3. What was built (code-complete and test-proven)

### 3.1 Schema: migration `0240_networth_current_nav_remark.sql` (delivered, not applied)

Additive, idempotent, guarded, RLS-safe. Six nullable columns on `investments` (`ii_value_as_of`, `ii_valuation_basis`, `ii_valuation_units`, `ii_valuation_nav`, `ii_valuation_fingerprint`, `ii_valuation_remarked_at`) with one new CHECK on the new `ii_valuation_basis` column under a new name; and `ii_investment_value_revisions` (append-only revision log; RLS on; **select-only owner policy, no authenticated write policy**, service-role inserts only, like `ii_audit_events`). No backfill, no drop, no alteration of any existing column, **no existing CHECK is recreated or widened** (so the drop-and-recreate trap in the ledger discipline does not apply), `ii_audit_events.event_type` is deliberately not widened (the revision table is this mechanism's audit trail), `ii_fhip_publications` is untouched. Applying it changes no number by itself. Deployment order is safe: the read model falls back to the old column list and the re-mark fails soft until the migration is applied.

### 3.2 The rule and the mechanism

| File | Role |
|---|---|
| `lib/engines/investment-intelligence/valuation/publishedRowRemark.ts` (new, pure) | `planRowRemark`: skips entity-owned, non-mutual-fund, no certified position, currency mismatch; otherwise calls the **shared** `valueHoldingAsOf()` (statement = the position's own certified snapshot; `unitMovements` = that folio's later transactions) and returns `unchanged` or an `update` with the columns, a deterministic fingerprint and a reason (`baseline`, `nav_update`, `nav_correction`, `units_changed`, `drift_correction`). It contains no NAV-eligibility logic of its own (a test asserts this). `describeStoredValuation` gives the tag: Latest NAV / Statement value / Stale NAV / Redeemed, with staleness derived from today (never stored). |
| `lib/services/investment-intelligence/publishedValueRemark.ts` (new) | `remarkPublishedInvestments` (batched reads: register rows, active publications, certified snapshots, instrument classes, entity allocations, unit movements, NAV candidates; compare-and-set write on the previous fingerprint; revision row for every landed change) and the fail-soft `ensurePublishedValuesCurrent`. Reads `source_type='investment_intelligence_published'` only. Entity ownership is read **fail-closed**. |
| `lib/read-models/snapshot.ts` | one call, before any selector reads `investments`: covers Dashboard, Goals, Twin, Reports |
| `app/api/investments/route.ts` (GET), `app/api/investments/published-valuations/route.ts` (new), `lib/services/reportSnapshotResolver.ts` | re-mark before reading |
| `investmentPublicationService.ts` | three one-line calls after publish / refresh / republish, so a (re)publication never regresses to the statement value; `published_value` still records `snapshot.value` |
| `lib/read-models/investments.ts`, `dashboard.ts`, `dashboardCanonicalAdapter.ts` | `InvestmentLine.valuation`, `valuationSummary`, `DashboardDataStatus.publishedValuation`; legacy-column fallback |
| `currentValuationLoader.ts` | `loadUnitMovementsSince` gained an optional `instrumentIds` filter so the re-mark reads only its own funds |

**The rule as it applies to Net Worth.** Units = the certified snapshot's units plus that folio's net unit movements dated after the snapshot and on or before today (shared rule 8). NAV = the latest eligible NAV (on or before today, quality ok/null, price > 0, same currency), used only when strictly newer than the certified statement; otherwise the certified statement value, **labelled `statement`**. 0 units = exactly 0, `redeemed`. Missing NAV keeps the last certified value, labelled. A NAV older than 7 days is shown with its own date and the Stale tag; the number is not altered. The stored value is rounded to 2 decimals (the column is `numeric(18,2)`); Holdings shows the unrounded product, so the two agree to the paisa. A same-date NAV correction supersedes (the in-place update of `ii_prices_nav`), as the rule already specifies.

### 3.3 UI

- **Investments tab**: new panel **Mutual funds in your Net Worth**: Fund, Units, NAV, NAV date, Value, tag. Statement-valued rows say **Statement value** (never "NAV"); stale ones say **Stale NAV** with the date; redeemed say **Redeemed**.
- **Dashboard**: the "About these figures" box adds: "Mutual funds in your Net Worth: N at the latest NAV dated A to B, M at a statement value (no newer NAV on file), K redeemed (counted as 0). J are valued on a NAV or statement more than a week old and may be out of date."
- Holdings, X-Ray, Overview, Performance already carry the NAV date and the Statement/Stale/Redeemed tags from Finding #5.

---

## 4. Invariants: where each is proven

Every rule below is a `check` function in `tests/unit/` that passes on the real code and **throws its own named message on a deliberately broken variant** (the variant is a wrapper that models the bug, or a database double that drops the guard).

| Invariant | Real-code proof | Negative control: the failing assertion |
|---|---|---|
| Oracle: 100 units, statement 10,000, latest eligible NAV 112 -> 11,200 dated 2026-09-30 | `iiNetWorthNavRemark` RULE-1 (value, NAV, date, units, Dashboard engine reads 11,200, publication keeps 10,000) | `RULE-1: Net Worth must be units x latest NAV (expected 11200, got 10000)` (NAV-blind), and units from a later statement (got 16800) |
| NAV correction 112 -> 111 supersedes, with revision history | RULE-2: 11,200 -> 11,100; revisions `baseline` 10,000->11,200 then `nav_correction` 11,200->11,100 | `RULE-2: a corrected NAV must supersede the prior one (expected 11100, got 11200)` |
| Future-dated, wrong-currency, quality-flagged, zero-price NAV never change Net Worth | RULE-3 (four cases) | `RULE-3: a future-dated NAV changed Net Worth (expected 10000 / statement, got ...)` (the NAV-eligibility-blind variant) |
| Units come from the position's own certified snapshot | RULE-4 | `RULE-4: Net Worth used units from a later, unpublished statement (expected 100 x 112 = 11200, got 16800)` |
| No newer NAV -> statement value, labelled as a statement | RULE-5 (no NAV; older NAV; same-date NAV) | `RULE-5: a statement value must be labelled as a statement value (got market_nav)` |
| Redeemed = 0 | RULE-6 | `RULE-6: a redeemed (0 units) holding must be exactly 0 and labelled redeemed (got 11200 / market_nav)` |
| Manual investments untouched | RULE-7 (manual row + an inconsistent publication aimed at it) | `RULE-7: a manual investment was changed by the re-mark` (source-type guard removed) |
| Entity-owned excluded | RULE-8 (skipped, value unchanged); RULE-8b (ownership unreadable -> nothing written, error reported) | `RULE-8: an entity-owned account was re-marked into personal Net Worth`; `RULE-8b: ownership could not be read, yet 1 write(s) happened` |
| Idempotent re-mark | RULE-9 (re-run x2: 0 updates, 0 revisions) | `RULE-9: re-running the re-mark must not write again` |
| Cross-user isolation | RULE-10 | `RULE-10: another user's investment was changed` (user filter removed) |
| No N+1 | RULE-11: identical read count for 1 and 30 holdings, <= 10 | `RULE-11: query count grows with the number of holdings (1 holding: 4 reads, 30 holdings: 91 reads)` for a per-holding implementation |
| Only mutual funds are NAV-priced | RULE-12 | `RULE-12: an equity was NAV-priced` |
| Units after the statement counted | RULE-13: (100+20) x 140 = 16,800 | `RULE-13: Net Worth must include units added after the statement (expected 120 units / 16800, got 100 / 14000)` |
| Concurrent writers | RULE-14: compare-and-set; losing call writes nothing, records no revision | `RULE-14: a lost race must write nothing and record no revision` (fingerprint guard removed) |
| Joint 1,000,000 at 60/40 counted once | one register row, Net Worth 1,000,000; 600,000 + 400,000 = 1,000,000; the owner-edit `attributeByBasisPoints` composition test activates after that branch merges | `RULE-15: a joint position must count once (expected 1000000, got 2000000)` |
| Publish -> Investments -> Net Worth exactly once; publish twice; refresh; unpublish/republish | `iiNetWorthNavRemarkPublishFlow` runs the REAL `publishPosition` / `refreshPosition` / `unpublishPosition` / `republishPosition` against a database double that enforces the 0042 unique index: one row, one active publication, 11,200 vs `published_value` 10,000; second publish `LEAVE_UNCHANGED`; refresh to 120 units -> 13,440 on the SAME row, old publication `superseded`; republish re-activates the same row | `RULE EO-1: a published position must reach investments exactly once (found 2 active rows)`; the double without the unique index accepts a second active publication, with it the database refuses (23505) |
| Net Worth = Holdings = X-Ray = Overview to the rupee, multi-folio | `iiNetWorthNavRemarkReconciliation`: two-folio fixture 78,000 + 52,000 + 56,000 + 36,000 = **222,000** everywhere, HDFC bucket **166,000**, one register row per folio, per-folio Net Worth row = Holdings row | `RULE NW-MF: Net Worth must equal Holdings, X-Ray and Overview (Net Worth 205000, Holdings 222000...)` for a NAV-blind re-mark |
| Units after the statement: Net Worth = Holdings | same file: 16,800 = 16,800 | `... for units added after the statement (Net Worth 14000, Holdings 16800)` |
| Migration is additive / idempotent / RLS-safe / no CHECK recreate | `iiNetWorthNavRemarkContracts` lint | the same lint flags each forbidden construct by name (MIG-1..MIG-8) |
| Wiring | re-mark before any investments selector; never inserts into `investments`; never writes `ii_fhip_publications`; no cache layer | the same checks fail on a source with the call moved / an insert / a publication write added |
| UI labels and Dashboard note | rendered components assert 11,200.00, NAV 112.00, 2026-09-30, Latest NAV; Statement value never called a NAV; Stale NAV; Redeemed | the notice says nothing about NAV valuation when there are no published funds |
| Deployment-order safety | selector still returns `ok` with the legacy column list; a genuine failure is still `unavailable` | a missing base column is not masked |

**Honest limits of the controls.** The variants model specific bugs; they prove the assertion can fail and fails by name. They are not a mutation of the shipped source. (See section 6 for a mutation run against the real source files.)

---

## 5. Merge hotspots, stated exactly

### 5.1 `feat/owner-entity-joint-edit-resolutions-20261001` (read-only; not edited)

That branch is based on `cce323f` (before Finding #5), so it already conflicts with Finding #5 itself; the items below are the ones this change adds.

| File | Mine | Theirs | Textual risk |
|---|---|---|---|
| `lib/read-models/investments.ts` | `InvestmentRow` +4 optional fields; `InvestmentLine.valuation`; `InvestmentsReadModelData.valuationSummary`; `computeInvestments` input `today`; the line object gains `...(valuation ? { valuation } : {})`; `loadInvestmentRows` select list + fallback | `entityOwnedAccountIds` / `jointSharesByAccount` inputs, `ownerShares`, `entityHeldExcludedCount`, `loadInvestmentInputs` allocation read | **Adjacent edits** in `InvestmentRow`, the `InvestmentLine` object literal (their `...(ownerShares ...)` and my `...(valuation ...)` spread are consecutive lines), the `computeInvestments` input type and the returned object. Mechanical to resolve (keep both). `loadInvestmentRows` (mine) vs `loadInvestmentInputs` (theirs) are different functions. |
| `lib/services/investment-intelligence/investmentPublicationService.ts` | one import line after `import { emitAuditEvent }` + three single-line calls at the tails of publish / refresh / republish | `loadAccountOwnership` import on the **same line position**, `PositionContext.ownership`, `resolvePublicationOwner`, eligibility input | **The import block will conflict** (both insert after the audit import); the three calls do not. |
| `lib/services/reportSnapshotResolver.ts` | an import after the `resilienceData` import + one call at the top of `resolveReportSourceData` | imports at line 2, `ownerBreakup`, `iiScope` inside the premium block | no overlapping hunk expected (placed apart on purpose) |
| `publicationLogic.ts`, `ownerAttribution.ts`, owner-class modules | not touched | theirs | none |

**Semantic composition (verified by reasoning and by the tests that can run before the merge; the `attributeByBasisPoints` test activates after the merge).**
- *Entity-owned.* Theirs blocks entity accounts at publication (`OWNER_IS_BUSINESS_ENTITY`) so no personal register row is created. Mine additionally **skips** any published row on an account with an active entity allocation (fail-closed if the allocation table cannot be read), so even a row published before the owner change is never NAV-valued into personal Net Worth by this mechanism. The entity holding belongs in their separate owner-class breakup and macro line; this change adds no entity figure to any personal total.
- *Joint.* Theirs divides `row.current_value` by basis points at read time. The re-mark keeps writing ONE value to ONE row, so the division automatically applies to the NAV-valued number: 1,000,000 at 60/40 -> 600,000 + 400,000 = 1,000,000, never 2,000,000.
- *Owner change after publication.* If the owner-change dialog unpublishes/republishes, the republish call re-marks the row; if it only reassigns an account to an entity, the next evaluation skips the row (entity guard) and leaves its last value, which their flow is responsible for removing from personal Net Worth.

### 5.2 `feat/owner-before-upload-phase1-20261001`

No overlap in any file this change touches (it edits upload routes, `documentProcessing.ts`, `aiExtractionReviewApply.ts`, `InvestmentIntelligenceClient.tsx`, ownership modules, and adds migration `0236`). Only the migration number matters (section 7).

### 5.3 `fix/ii-multifolio-performance-xray-20261001`

**Merged into this branch** (no conflict). Used: `loadUnitMovementsSince`, `positionKey`, the `unitMovements` input of `valueHoldingAsOf`. `loadUnitMovementsSince` gained an optional trailing `instrumentIds` parameter (additive; flagged in case that branch later edits the same function).

---

## 6. Verification performed

All on this branch; line endings preserved (the touched files are LF).

- **New suites (4 files)**: `iiNetWorthNavRemark.test.ts`, `iiNetWorthNavRemarkReconciliation.test.ts`, `iiNetWorthNavRemarkPublishFlow.test.ts`, `iiNetWorthNavRemarkContracts.test.ts` plus `support/remarkFakeDb.ts`, `support/remarkScenario.ts`. RESULTS_NEW
- **Regression, targeted**: RESULTS_REG
- `tsc --noEmit -p .`: RESULTS_TSC
- ESLint on every touched and new file: RESULTS_LINT
- `scripts/` artifacts rewritten by test runs were reverted with `git checkout -- scripts/`.
- MUTATION_RESULTS

**Not verified (not hidden).**
- No browser, DEV or production session: **DEV-verified: no. production-verified: no.** The migration has not been applied anywhere, so no real database has executed it, and the `ii_investment_value_revisions` insert path (service-role client) has run only against test doubles.
- The compare-and-set, the unique-index behaviour and RLS are proven against doubles, not Postgres. (The repository has PGlite harnesses for chain-replay proofs; I did not build one for this migration. A `scripts/*_pglite_verification.mjs` for 0240 is a reasonable follow-up.)
- `tests/live-dev` suites were not run.

---

## 7. Migration number and collision evidence

**Chosen: `0240`.** Scan, re-done immediately before finishing: SCAN_RESULT

State at authoring time (and re-checked at the end): `origin/main` highest `0231`; in flight on other branches/worktrees: `0230` (m11-7 branches), `0231` (admin-premium-grant, amplify-size), `0232` (bench1-phase2, india-mf-report), `0236` (owner-before-upload), `0237` and `0238` (admin-premium-grant), `0239` (bench1-phase2). Nothing at `0233`-`0235` or at `0240` or above anywhere. `0240` is the first free number above everything found. It is the only file with its prefix in this branch (a test asserts it) and no existing CHECK is recreated, so there is no predecessor to derive from the ledger.

**Both repository checker scripts are blind to unmerged siblings**, so the scan used `git log --all` over every ref plus a listing of every worktree directory. Re-scan again at merge time: a sibling may take `0240` first.

**Apply to DEV before production.** The file is idempotent. It has not been applied by this change.

---

## 8. Limits, risks, and decisions for the PO

**Known limits.**
1. **Freshness is "next read".** Direct readers that do not pass through the Net Worth snapshot, the Investments list, the report resolver or a publication event could see the previous mark. Mitigation: every value carries its own as-of date and tag.
2. **Write on read and extra queries** for households with published funds (section 2). Net Worth tolerates a failed or blocked write: the row keeps its last labelled value (`M11_READONLY` AI-context clients are reported, never thrown).
3. **A newer certified statement that has not been published.** Net Worth values the published position's own certified units plus the folio's later transactions. If the user imported a newer statement without refreshing the publication and the transactions between are not in `ii_transactions`, Holdings (newest statement) and Net Worth (published statement + transactions) can differ in units until the user refreshes. Not changed here.
4. **Units after the statement with no newer NAV** are priced at the statement's own NAV and stay labelled `statement` (the multi-folio decision the PO already accepted).
5. **Publication preview and `financialImpact`** still show the certified statement value; Net Worth then shows the NAV-valued figure after the first evaluation. Not changed (a candidate follow-up: show the NAV-valued figure in the preview).
6. **"Imported, not yet in Net Worth"** stays statement-valued, so a position's value can step from its statement value to its NAV value at the moment it is published.
7. **Equity and ETF** published positions are not re-marked (there is no price series for them in this schema); they keep their certified value and are counted in `skipped.not_mutual_fund`.
8. **Performance cost of unit movements**: one extra bounded read of the user's transactions for these funds after the oldest certified statement (normally zero rows).

**Open PO decisions.**
1. Accept the chosen mechanism (read-triggered re-mark, no scheduler) or request a scheduled sweep after NAV ingestion as well (needs a separate migration, secret and a PO-present activation).
2. Confirm that Net Worth for a folio uses the **published** statement's units plus later transactions (limit 3), or whether a newer unpublished statement should drive it.
3. Whether the daily "stale monthly report" effect (decision 4 below) is acceptable, or the re-mark should not bump `updated_at` (then a stored report would not be flagged stale when a NAV moves the value).
4. Show the NAV-valued figure in the publication preview and in `financialImpact`.
5. Apply `0240` to DEV, run the UI check protocol, then production.

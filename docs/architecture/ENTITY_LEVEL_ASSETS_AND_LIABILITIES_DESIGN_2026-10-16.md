# Entity-level assets and liabilities (SMSF, Family Trust, HUF, Company): design and plan (16-10-2026)

Status: PHASE 1 IMPLEMENTED on this branch (17-10-2026, after the PO's GO and decisions D1-D15 accepted): SMSF itemised-or-net-only with fund liabilities, migrations 0289 and 0290, API, SMSF screens, the family-view read model, the DEV and production packs. Phases 2-6 are not started. Nothing is pushed, merged, or applied to DEV or production. The loan amount is decided: 370,000 (fund net 133,000, family 1,007,441, personal 874,441). Section 16 is the Phase 1 record; sections 1-15 are the design it follows (sections 8.2-8.4 are superseded for the cutover by section 16.5).

Admin Architecture Standard: not engaged (no `app/(app)/admin/**`, `app/api/admin/**`, Admin role, capability, RLS/RPC consumed by Admin, or Admin report is created or changed). If Phase 5 adds an Admin diagnostic, the standard applies at that point.

Evidence labels used below: READ (code read in this branch), UNIT-TESTED (vitest), PGLITE (real migration ledger 0001..0285 replayed into an isolated in-memory Postgres), NOT VERIFIED (not run anywhere). Nothing here is DEV-verified or production-verified.

## 1. The PO decisions this implements (genuine, from the user in chat, 16-10-2026)

1. There must be a way to enter ASSETS and LIABILITIES separately at ENTITY level (SMSF, Family Trust, HUF, Company), so the picture is clear.
2. 21-09-2026 ruling: entity data is captured entirely separately from personal at every input field and consolidated ONLY at reporting time. Refined 16-10-2026: Net Worth has an INDIVIDUAL level and a CONSOLIDATED FAMILY level (SMSF full, Trust full, HUF full, Company by ownership share) (`docs/architecture/NET_WORTH_INDIVIDUAL_AND_FAMILY_LEVELS_2026-10-16.md`).
3. The PO's household, confirmed: personal assets 2,260,298 (assets register 1,670,298 + investments 590,000, SMSF excluded) less personal liabilities 1,385,857 = personal net worth 874,441. No SMSF property or SMSF loan is in the personal lists. The SMSF's asset 503,000 and loan 370,000 (net 133,000) have no place to be entered: this design fills that gap. Correct family net worth = 874,441 + 133,000 = 1,007,441.
4. EITHER-OR recording per entity: the user chooses "Itemised" (assets and liabilities entered, net DERIVED, net input disabled/removed) OR "Net value only" (single typed net, asset and liability inputs disabled/hidden). Never both counted. Recommended default: itemised. Net value only carries a plain note that it hides the structure. The rule must hold in the database and API, not only the UI; a data-quality check must detect the legacy double entry; switching mode must be safe (convert or retire the other representation with confirmation, keep history, never leave both counted).

## 2. What exists today (READ, with references)

| Topic | Fact | Where |
|---|---|---|
| Company / Family Trust / HUF | Already stored SEPARATELY from personal: `business_entities` plus child tables `business_entity_assets` and `business_entity_liabilities` (label, value, currency per line). `valuation_mode` is `summary` (one typed net value) or `detailed` (itemised, net derived). Entity currency `currency_code`, `ownership_percentage`. Debts never enter personal DTI/DSR (structural: personal engine never reads the table). | `supabase/migrations/0134_lr11_business_entity_registry.sql`, `0136`, `0154`; `lib/services/businessEntityData.ts`; `lib/engines/businessEntityValuation.ts` |
| The gap for them | Summary-vs-detailed exclusivity is application-layer only (a row can store a net value AND lines; only one is counted). Line items are label + value only (no type, no as-at date, no lender/rate/repayment, notes not surfaced). Default mode is `summary`. Page is titled "Companies & Trusts" and has no SMSF. | `app/(app)/companies/page.tsx`, `lib/validation/businessEntity.ts` |
| SMSF | NOT a business entity. A fund is a `retirement_accounts` row (`master_item_key='smsf'`, owner self/spouse/joint, never `smsf`) plus `smsf_funds` (mode summary/detailed, `summary_balance` = NET), `smsf_holdings` (assets, own currency), `smsf_fund_members`. `retirement_accounts.current_balance` mirrors the fund NET value through triggers; migration 0090 guards direct writes. | `supabase/migrations/0084_geo_jurisdiction_smsf.sql`, `0089`, `0090`, `0137`, `0148`; `lib/services/smsfData.ts`; `components/retirement/smsf/*` |
| SMSF liabilities | There is NO place to enter an SMSF debt. The only route is to enter a PERSONAL `liabilities` row and link it with `property_liability_links` (`link_type='smsf_property_loan'`) from the SMSF workspace ("Link existing liability"). Detailed net = holdings minus linked loans. | `smsf_compute_detailed_net_value` (0084), `components/retirement/smsf/SmsfDetailedWorkspace.tsx` lines 246-293 |
| One fund per person | `unique (user_id, master_item_key)` on `retirement_accounts` (0004): at most ONE SMSF fund row per user, and an ARCHIVED fund row still occupies the key. `smsf_create_fund()` is a plain insert, so after archiving the fund row, "Create SMSF" fails with a unique violation. | `0004_financial_data_grid.sql` line 79; `0084` `smsf_create_fund` |
| Fund row is NOT an entity row to the engines | `smsf_create_fund` takes owner self/spouse/joint (`lib/validation/smsf.ts`), so the fund row is classified PERSONAL by the owner-tag rule (`isHouseholdOwner`: only owner `smsf` is excluded; `entityKindOfOwner` in `netWorthLevels.ts`). This is why the PO's 503,000 sits in the personal lists unless deleted. | `lib/read-models/core/types.ts` line 91; `lib/engines/householdContext.ts` header lines 18-30; `lib/engines/netWorthLevels.ts` |
| Owner tag on every register | `owner` accepts `self, spouse, joint, child, family_trust, company, smsf, other` on all seven registers (migration 0004). The grids offer `SMSF` as an owner on Assets, Liabilities, Investments, Retirement, Income, Expenses; only `company` and `family_trust` are hidden for NEW rows (`restrictedOwnerValues`). Insurance gates SMSF to AU. | `lib/constants.ts` lines 81-130; `lib/grid/configs.ts` |
| SMSF income and expenses | Also live in the PERSONAL income/expense registers as `owner='smsf'` rows; the SMSF P&L reads them plus linked personal loans. Out of scope this round (section 11, D14). | `lib/services/smsfData.ts` 204-228, `lib/services/smsfReportData.ts` |
| Net Worth today | `computeDashboard`: `netWorth = assets + investments + retirement - liabilities + businessEntityOwnershipValue`. `totalLiabilities` sums ALL owners (including SMSF-owned and SMSF-linked). | `lib/engines/dashboard.ts` line 1146-1153; `lib/read-models/liabilities.ts` (`totalBalance` all, `householdBalance` filtered) |
| Net Worth levels (main) | `netWorthLevels.ts` puts register rows tagged owner smsf in an SMSF block, treats an owner-self SMSF fund row as PERSONAL, and counts a linked SMSF loan once only when the fund exists and is active (netted memo). | `lib/engines/netWorthLevels.ts`, `lib/services/netWorthLevelsData.ts` |
| Navigation | `/companies` ("Companies & Trusts") is the only entity page; SMSF lives in Retirement. | `lib/nav/appNavGroups.ts` line 113 |

## 3. Exactly why a personal-level liability assigned to an SMSF double counts (and the other two ways the SMSF is wrong)

1. DOUBLE DEDUCTION (the debt counted twice). The SMSF fund value is a NET figure in both modes (0084: Summary = net by definition; Detailed = holdings minus linked loans). If the same loan is also a personal `liabilities` row (owner `smsf`, or linked), `computeDashboard` subtracts it AGAIN, because `totalLiabilities` has no owner filter. Example from the netWorth note: an SMSF with a 500,000 property and a 365,000 loan reports -230,000 instead of 135,000. Main's levels model avoids this ONLY when the loan is linked to an active fund; an unlinked `owner='smsf'` liability is deducted once at the SMSF block, which is again a second deduction if the fund value the user typed was already net.
2. DOUBLE ASSET (the fund counted twice). The PO household: fund row 503,000 (owner self, in the SMSF section) AND grid row "Other Retirement Assets" 133,000 (owner smsf). Both are active retirement rows; before the personal-basis change the family figure added 636,000 for one fund whose real net is 133,000 (1,510,441 shown vs 1,007,441 correct, overstatement 503,000). The production diagnosis (section 8.1) shows why the fund row reads 503,000: the fund is itemised (holdings 503,000) and its property loan is inactive and unlinked, so the fund's own net computes to 503,000; the 133,000 is the real net typed by hand as a second row. On main today the model counts only the 133,000 row while both exist (fund record shown, not counted), so the family figure is 1,007,441 by offsetting, not by design.
3. PERSONAL BASIS LEAK (RESOLVED on main by `a2a0f24`). The fund row has owner self, so an owner-tag rule alone would keep it in the PERSONAL figure; main now classifies `master_item_key='smsf'` as entity-held (`isSmsfFundRow`, `lib/engines/netWorthBasis.ts`), so personal is 874,441 with the row present. See O1 (section 14).

All three are the same root cause: entity money is stored in personal registers and kept apart only by a runtime filter on an `owner` text tag that seven separate read models and several engines each have to remember. Migration 0134's header already named this class of defect and chose structural separation (dedicated tables the personal engine never reads) for Company/Trust/HUF. SMSF is the one entity that was never given that treatment for its liabilities.

## 4. Options compared

| | A. `entity_id` on the existing registers | B. One new polymorphic ledger `entity_assets` / `entity_liabilities` | C. RECOMMENDED: extend the structural pattern already in the codebase: child tables per entity family, one shared read model |
|---|---|---|---|
| Idea | Add `entity_id`/`entity_kind` to assets, liabilities, investments, retirement; filter personal reads | One pair of tables for SMSF + Trust + HUF + Company | SMSF gets `smsf_liabilities` beside `smsf_holdings`; Company/Trust/HUF keep and enrich `business_entity_assets/liabilities`; a single `EntityBalanceSheet` read model feeds the family view |
| Personal separation | RUNTIME filter again: every register read, import path and engine must remember it; the exact defect class we are fixing | Structural (personal reads never touch it) | Structural |
| Migration risk | HIGH: columns on seven hot tables, unique master-key constraints, FDH imports, grids | MEDIUM-HIGH: moves live SMSF and entity data, replaces certified 0084/0134 objects | LOW-MEDIUM: additive tables and columns; certified objects kept; one function (`smsf_compute_detailed_net_value`) extended |
| RLS / tenant isolation | Existing policies, but a missed filter leaks into personal totals | New policies to certify | Copy the proven 0134/0084 policy shape (owner-only parent, cross-referenced child check) |
| Reuse of existing grids | Full (but grids assume owner/master-items) | Needs a new UI anyway | New small shared table component; no `FinancialDataGrid` (its zero-confirmation, master items and owner column do not apply) |
| Reporting | Needs a filter everywhere | One query | One read model, two sources behind it |
| Legacy rows | Tag rows in place (never separated) | Must be migrated | Adopt or retire explicitly, per entity, with audit |

Recommendation: C. It is the smallest change that makes the separation structural for every entity, reuses the SMSF holdings/summary-detailed mechanics and the entity registry already certified, and keeps the 0084/0090/0134 guards.

SMSF stays in `smsf_*` (not folded into `business_entities`): merging would re-open FDH-12's SMSF boundary refusals, the 0090 balance guard, the SMSF P&L and reports, and the AU gate for no user-visible gain. The UX presents one "Entities" hub over both sources (section 8).

## 5. The recommended data model

### 5.1 Common rule: one recording mode per entity (EITHER-OR)

Reuse the two existing mode columns instead of inventing a third: `smsf_funds.mode` and `business_entities.valuation_mode`. Meaning:

- `detailed` = ITEMISED (assets and liabilities are entered; the net is DERIVED; no typed net exists).
- `summary` = NET VALUE ONLY (one typed net; no itemised lines are active).

UI labels: "Itemised assets and liabilities (recommended)" and "Net value only". The net-only option carries this note: "A single net value hides what the entity owns and owes. FHIP cannot show its debts, its structure, or how it changes when a loan is repaid." New entities default to itemised (today both default to summary: changed for NEW rows only, in the create route and the create RPC default, not by a column default on existing data).

### 5.2 New and changed objects (numbers in section 10)

1. `smsf_liabilities` (new, child of `smsf_funds`): `id, user_id, smsf_fund_id, liability_name, liability_type (property_loan|other_loan|tax_payable|other), lender, balance numeric(18,2) >=0, interest_rate, monthly_repayment, currency_code, country_code, notes, is_active, created_at, updated_at`. Same RLS shape as `smsf_holdings`/0134 (owner-only plus a check that the fund belongs to the caller, so a forged fund id from another tenant cannot be attached). Interest rate and repayment are kept so the SMSF P&L can read them from here instead of from linked personal loans.
2. `smsf_compute_detailed_net_value` becomes holdings minus `smsf_liabilities` (minus any still-linked legacy loans while those exist, each loan counted exactly once). The 0090 certified-write bracket (`fhip.smsf_balance_write`) is reused unchanged; the function is replaced with the predecessor read from the ledger, not from memory (memory note: drop-and-recreate traps).
3. `business_entity_assets` / `business_entity_liabilities` (existing): additive columns `asset_type` / `liability_type`, `as_at_date`, `lender`, `interest_rate`, `monthly_repayment` (liabilities), `is_active` (soft retire; today a delete is a hard delete), all nullable or defaulted.
4. `entity_figure_mode_log` (new, append-only): `id, user_id, entity_kind (smsf|company|family_trust|huf), entity_id, from_mode, to_mode, net_before, net_after, variance, retired_representation jsonb (the typed net, or the full set of lines, as they were), confirmed_variance boolean, created_at`. Select-only for the owner by RLS; written only by the RPCs below.
5. RPCs (SECURITY DEFINER, `search_path` pinned, `auth.uid()` checked, the caller must own the entity, as in 0231/0084 style):
   - `entity_switch_to_itemised(kind, id, assets jsonb, liabilities jsonb, confirm_variance boolean)`: ATOMIC. Inserts the lines, derives the net, compares with the current typed net. If the variance is not zero and `confirm_variance` is false it returns the preview and changes NOTHING. On confirmation it retires the typed net into the log, clears the net column, flips the mode. The user enters the lines inside the switch step, so there is never a moment with "neither" or "both".
   - `entity_switch_to_net_only(kind, id, net numeric, confirm boolean)`: the mirror: snapshot of lines into the log, lines `is_active=false` (not deleted), typed net set, mode flipped. Preview first, same rule.
   - `entity_undo_last_switch(kind, id)`: restores the previous representation from the log snapshot, retiring the current one (so undo itself never leaves both).
6. DATABASE ENFORCEMENT of "never both" (not only UI):
   - Mode changes and the net column can only be written by the RPCs: a trigger raises unless a transaction-local bracket `set_config('fhip.entity_mode_switch','certified',true)` is open (the established 0090 technique; no superuser needed).
   - `business_entities`: constraint `valuation_mode = 'summary' OR summary_net_asset_value IS NULL`, and a trigger on the two line tables refusing an ACTIVE line unless the parent is `detailed`.
   - `smsf_funds`: when `mode = 'detailed'`, `summary_balance` must be null; a trigger on `smsf_holdings` and `smsf_liabilities` refuses an ACTIVE row unless the fund is `detailed`.
   - Constraints are added `NOT VALID` first (they bind every NEW write at once) and `VALIDATE`d only after the data-quality check shows no violating row, because EXISTING rows may already hold both (for example an SMSF in Summary mode with preview holdings, which 0084 deliberately allowed while staging). Existing violators are never retired silently: the user is shown a notice and chooses (section 7.2).
   - API: the create/patch routes reject a body that carries both representations with a coded 422 (`ENTITY_BOTH_REPRESENTATIONS`); the PATCH schemas stop accepting `valuation_mode` and the net column directly (today a client can flip `valuation_mode` with a bare PATCH: `lib/validation/businessEntity.ts` comment).
7. Engine rule that backs the database: an entity's net is read from exactly one source, chosen by its mode. A stray inactive-mode value is never read (already true in `computeBusinessEntityNetAssetValue`; the same rule is applied to SMSF).

### 5.3 Entity-level currency

Each entity carries its own currency (`business_entities.currency_code`, `smsf_funds.currency_code`, fixed AUD for an AU SMSF). Each line carries its own currency (SMSF holdings already do: "never force AUD", 0084 section 32). Net is shown in the entity currency AND in the household reporting currency; conversion happens once, at the household's single rate (`lib/engines/fx.ts`), and a line that cannot be converted is counted and disclosed, never zeroed.

### 5.4 How the consolidated family view reads it

A new pure read model `EntityBalanceSheet { kind, id, name, currency, mode, assets[], liabilities[], net, includedPercent, source }` is built by one loader from (a) `smsf_funds` + `smsf_holdings` + `smsf_liabilities` and (b) `business_entities` + their lines. `netWorthLevels.ts` consumes it: SMSF in full, Trust in full, HUF in full, Company at `ownership_percentage` of its net (the 16-10-2026 rule, unchanged), a negative net flows through as negative (no clamp). The owner-tag path for `smsf`/`family_trust`/`company` register rows becomes a legacy fallback (section 6). Entity liabilities never enter personal DTI/DSR (structural: they are in tables personal readers never query).

SMSF fund row rule (decision D3): the `retirement_accounts` row with `master_item_key='smsf'` is the fund's MIRROR (it carries the net via the existing triggers, and retirement planning keeps reading it). Engines classify it as the SMSF entity by `master_item_key`, never by its owner tag, so it can never be in a personal figure whoever the "member" is.

## 6. Legacy data: no silent double counting

Legacy shapes and their handling (every action is user-confirmed, logged and reversible; nothing is deleted):

| Legacy shape | Detection | Resolution |
|---|---|---|
| Fund row (owner self) PLUS grid rows owner `smsf` (the PO household) | `smsf_recorded_twice` (slice, section 12; SQL section `DATA QUALITY: SMSF recorded twice`) | Adopt: the SMSF screen offers "Use these existing SMSF rows as the starting net value": archives the grid rows, writes their total to the fund's net, logs it. Variance gate as in 5.2. |
| Personal liability owner `smsf` or linked as SMSF property loan | `smsf_debt_in_personal_liabilities` | "Move to SMSF": creates the `smsf_liabilities` row (name, balance, rate, repayment copied), archives the personal row and unlinks it, one transaction, logged. Allowed only when the fund is itemised (else offers the mode switch first). Never a silent conversion. |
| Entity with a typed net AND itemised lines | SQL section `DATA QUALITY: entity with both ...`; same check in the app | Notice with a two-button choice (keep itemised: retire the net; keep the net: retire the lines), through the switch RPCs so history is kept. |
| Register rows tagged `company` / `family_trust` (legacy tags) | existing `duplicateRisk` warning | Unchanged this phase; the move action is extended to them in Phase 3. |

Counting rule that makes the double count structurally impossible: once an SMSF has an entity-level figure (a fund record with a net source), register rows tagged `smsf` are NOT counted in the SMSF block; they are listed as "legacy rows not counted" with the adopt/archive action. Until the fund record exists they keep counting as they do today. Creating the fund therefore adopts the legacy rows in the same step, so the family figure never dips or doubles between steps. NOTE (17-10-2026): main today does the OPPOSITE while both exist: it counts the fund-level row (owner smsf) and shows the SMSF section's fund record uncounted (`suppressedFundRecord`). That is a sound stop-gap against double counting, but it hides every SMSF edit until the row is removed (trap T5, section 8.2). Phase 3 reverses the precedence so the entity record wins.

## 7. UX

### 7.1 Where users find it

- A single "Entities" hub (rename of "Companies & Trusts", `/companies` redirects) with one card per entity: SMSF (AU users; links to and embeds the same fund object), Family Trust, HUF (India), Company. Each card shows assets, liabilities and the derived net, the recording mode, and the household's included share.
- The SMSF section in Retirement keeps working and gains a "Fund balance sheet" panel (Assets = holdings, Liabilities = new, Net derived), with a link to the hub card.
- Personal Liabilities page: see 7.3.

### 7.2 Entity page behaviour

- First control: "How do you want to record this entity?" radio group: "Itemised assets and liabilities (recommended)" / "Net value only" with the note from 5.1.
- Itemised: Assets table, Liabilities table, and a read-only "Net position (derived)" figure (assets minus liabilities, announced politely to screen readers on change). The net-value input does not exist on screen (removed, not just disabled) and the explanatory line says why.
- Net only: one money field "Net value (assets minus debts)"; the asset and liability tables are removed and replaced by one sentence naming how many itemised lines are kept (archived) behind it.
- Switching opens a confirmation dialog that shows before and after (net, variance), what will be retired and where it is kept, and offers Undo afterwards. Initial focus on the dialog heading, focus returns to the switch control on close (the pattern the Liabilities import fix established).
- Underwater entity (liabilities above assets): the net shows in the risk colour AND with words ("owes more than it owns"), never colour alone.

### 7.3 Personal Liabilities (and the other registers) stop being a route into an entity

- Owner dropdown on NEW rows no longer offers SMSF (or Company/Family Trust, already hidden) on Liabilities, Assets, Investments and Retirement; helper text under the dropdown: "Debts and assets of your SMSF, trust, HUF or company are entered on the Entities page so they are never counted twice."
- Server: POST/PATCH on `/api/liabilities` (and the other registers) refuse an owner change TO an entity value with a coded 422; an existing entity-tagged row can still be read, edited in its other fields, and moved.
- DB trigger on the owner column is a later step (Phase 4), after every writer is audited: FDH-10 statement apply and the owner-before-upload path (migration 0236 lets a document owner be `smsf`) must first route entity-owned liabilities to `smsf_liabilities`, otherwise a trigger would break imports.
- The read-only notice delivered now (section 12) warns existing households in the meantime.

### 7.4 Copy that explains the separation (plain, no jargon)

- Entities hub intro: "Your SMSF, trusts, HUF and companies are recorded here, separately from your personal finances. Enter what each one owns and owes; FHIP works out its net value. Your personal net worth never includes them; your family net worth adds them back, clearly labelled."
- Liabilities helper: as in 7.3.
- Personal vs family: reuse the existing wording in `NET_WORTH_PERSONAL_EXPLANATION` / `NET_WORTH_FAMILY_EXPLANATION` so every surface says the same thing.

### 7.5 Mobile, keyboard, accessibility, dates

Tables collapse to stacked cards below 640 px (no page-level horizontal scroll); all controls reachable in DOM order; add-row by keyboard with Enter, delete through a confirm dialog with focus management; every input has a visible label and `inputMode="decimal"`; error text tied with `aria-describedby`; derived net in a polite live region; no colour-only meaning. Dates: AU day-first `dd/mm/yyyy`, India `dd-mm-yyyy`, through the existing `formatDateShort`/`fmtDate` helpers; never ISO or US order in visible text (standing PO rule). "As at" dates on lines are optional.

## 8. Household repair plan (PO household, AUD). Nothing here is run by this agent.

### 8.1 Production diagnosis (read-only, reported by the coordinator 17-10-2026) and what it changes in this design

The read-only run (`01b`, user `d03a4dcc...`) returned:

| Register | Row | Detail |
|---|---|---|
| Retirement | `SMSF` 503,000 | owner self, `master_item_key` smsf, ACTIVE: the fund row |
| Retirement | `Other Retirement Assets` 133,000 | owner smsf |
| Retirement | `Spouse Contribution` 0 | owner spouse |
| `smsf_funds` | one fund | mode DETAILED, `summary_balance` 138,000, `detailed_net_value` 503,000; the fund row is the 503,000 retirement row |
| `smsf_holdings` | residential property 475,000 ("250 Elizebth st Melbourne 3000 "), Bank Australia cash 3,000, "Secured finance" cash_account 25,000 | sum 503,000 |
| Liabilities | personal `SMSF property loan`, joint, 365,000 | INACTIVE and not linked to the fund (the PO says the loan is 370,000: to be confirmed) |
| Assets | `Trust Assets` 495,000 | owner smsf, INACTIVE |
| Data quality | "SMSF recorded twice" | 636,000 (503,000 + 133,000) |

Corrections to my earlier inferences (section 3): the 503,000 is NOT a gross value typed into a net field. The fund is already itemised on the asset side (Detailed mode, three holdings); the stored `summary_balance` 138,000 is 503,000 minus the 365,000 loan from when the loan was active and linked. The loan was later deactivated, and the existing trigger recomputed the fund net to 503,000 (PGLITE-reproduced). So the real gap is the one the PO described: the debt is not attached to the fund. The earlier Option B (set the fund's value to 0) is NOT available here (the fund is in Detailed mode; the balance is derived and guarded by migration 0090). Option A (SQL archive of the fund row, files 02-04) still runs but is no longer recommended: it archives a fund that has holdings, and an archived `smsf` row blocks re-creating the fund.

With the personal-basis change now on main (`a2a0f24`, merged here with origin/main `f2831a7`) production shows personal 874,441 and family 1,007,441. That 1,007,441 is not because the fund is counted at its net: main's model counts the fund-level row (owner smsf, 133,000) and shows the SMSF section's fund record (503,000) as "shown but not counted" while both exist (`suppressedFundRecord` in `lib/engines/netWorthLevels.ts`). The family figure is right today because the 133,000 row happens to equal the true net; it becomes right for the correct reason after the steps below.

### 8.2 Interim path using ONLY the existing UI (click by click)

SUPERSEDED for the cutover by section 16.5 (the pack does the same retirement in one guarded, backed-up transaction and also retires the leftover typed net). Kept because it is the only route on today's main before the Phase 1 code is deployed, and because its numbers (365,000 gives 138,000 and family 1,012,441, 370,000 gives 133,000 and family 1,007,441) are still the oracles. After Phase 1, linking a personal liability to an itemised fund is refused by the API.

Goal: the SMSF's own net (503,000 minus the loan) is computed by the fund itself (migration 0084, Detailed mode), and the duplicate `Other Retirement Assets` 133,000 row is removed. The loan amount you type decides the fund net.

Before you start: have the loan amount confirmed (365,000 or 370,000). Do the steps in one sitting, in this order, and do not open the Dashboard or the Monthly Report between steps 1 and 3 (the Dashboard stores this month's history point every time it loads).

| Step | Where and what to click | What it does to Personal / SMSF / Family |
|---|---|---|
| 0 | Dashboard: note personal 874,441 and family 1,007,441. | Nothing changes. |
| 1 | Sidebar "Liabilities" > "+ Add Liability" > "What are you adding?" choose "Custom item..." > Name "SMSF property loan" (add the lender to the name if it is refused as a duplicate) > Owner "SMSF" > Outstanding Balance **0** > Currency AUD > Save. | Nothing moves (a zero loan changes nothing). If the form refuses 0, see T3. |
| 2 | Sidebar "Investment & Retirement" > "Retirement" tab > "SMSF" section (the fund card already reads "Detailed Mode - Active valuation") > "Associated Debt" > in the "Link existing liability..." list choose the new "SMSF property loan" > "Link". | Personal: unchanged (a linked loan is the fund's debt, not yours). Fund net: still 503,000. Family: unchanged 1,007,441. |
| 3 | Sidebar "Liabilities" > "Edit" on "SMSF property loan" > set Outstanding Balance to the confirmed amount (365,000 or 370,000) > Save. | The database recomputes the fund: Detailed Net Value = holdings 503,000 minus the linked loan: 365,000 gives 138,000; 370,000 gives 133,000. The fund row in Retirement follows the new net. **Personal 874,441 (unchanged). Family still 1,007,441**: while the 133,000 row exists, main counts only that row for the SMSF and shows the fund record without counting it, so this step is invisible in the family figure (T5). Check the SMSF card: "Detailed Net Value" 138,000 (or 133,000) and "Linked SMSF Liabilities" the loan. |
| 4 | "Investment & Retirement" > "Retirement" tab > in the grid find "Other Retirement Assets" (133,000, owner SMSF) > "Remove". | The duplicate is archived (soft; nothing is deleted). The fund record is no longer suppressed: SMSF block = the fund net. **Loan 365,000: SMSF 138,000, family 874,441 + 138,000 = 1,012,441. Loan 370,000: SMSF 133,000, family 874,441 + 133,000 = 1,007,441.** Personal 874,441 either way. The "possible double count" note disappears. |
| 5 | Dashboard: confirm personal 874,441 and family 1,012,441 (365,000) or 1,007,441 (370,000). | Done. |

Outcomes (UNIT-TESTED in `tests/unit/entityLevelInterimPathNetWorth.test.ts` with the real `computeNetWorthLevels`; the fund recompute is PGLITE-tested in `tests/unit/entityLevelSqlPackPglite.test.ts` against the real migration ledger):

| State | Personal | SMSF block | Family |
|---|---|---|---|
| Today (fund record 503,000 + 133,000 row, no loan) | 874,441 | 133,000 (503,000 shown, not counted) | 1,007,441 |
| After step 3, loan 365,000 | 874,441 | 133,000 (the row still masks the fund) | 1,007,441 |
| After step 4, loan 365,000 (fund net 138,000) | 874,441 | 138,000 | **1,012,441** |
| After step 4, loan 370,000 (fund net 133,000) | 874,441 | 133,000 | **1,007,441** |

The 5,000 between the two loan amounts is real money: confirm the amount rather than choose it by the family number.

What the personal-basis model does once the 133,000 row is removed and the fund row's balance is the computed net: the fund row (`master_item_key='smsf'`) is classified as the SMSF entity whoever owns it, so it is never in the personal figure; it counts once in the SMSF block at its balance (the computed net); the linked loan is recognised as already inside that balance (netted memo, not deducted again) and is excluded from personal figures, from personal DTI/DSR and from the family deduction. Nothing is counted twice.

Traps (all found in the code; none needs a code change):

- T1 ORDER. Removing the 133,000 row BEFORE the loan is linked and entered makes the fund record count at its gross 503,000: family 1,377,441 until the loan is linked (tested). Do step 4 last.
- T2 TRANSIENT DIP. A loan entered with a real balance and not yet linked is deducted at the SMSF (owner SMSF) or from you personally (owner joint/self): family 642,441, and personal 509,441 in the joint case (tested). That is why step 1 enters the loan at 0, links it, then sets the amount. Do not open the Dashboard during a dip.
- T3 ZERO BALANCE. The API accepts 0 (`balance` min 0). If the Add form refuses 0, enter 1, link, then Edit to the real amount; the arithmetic is the same (not browser-tested).
- T4 ARCHIVED ROWS AND UNIQUE KEYS. The inactive "SMSF property loan" (joint, 365,000) and inactive "Trust Assets" (495,000) cannot be reactivated from the UI (the grids list active rows only; custom rows are never resurrected). Leave them inactive: reactivating "Trust Assets" would add 495,000 to the SMSF. Step 1 creates a NEW loan row. Removing "Other Retirement Assets" archives it and its `master_item_key` stays reserved by `unique(user_id, master_item_key)`, so adding that item again later reuses the same row. The `smsf` key is held by the existing fund row: never archive the fund row (an archived one blocks "Create SMSF" until migration 0289).
- T5 THE 133,000 ROW WINS WHILE IT EXISTS. With both a fund-level row and the fund record, main counts only the fund-level row and shows the fund record uncounted. So SMSF edits (holdings, the loan) do not move the family figure until step 4; step 3 looks like it did nothing. Expected, not a fault. (This precedence is the opposite of what section 6 recommends for the build: the entity record should win and legacy rows be listed. Phase 3 reverses it.)
- T6 SUMMARY VALUE STAYS 138,000. The fund card's "Summary Value" is a recorded reference that cannot be edited in Detailed mode. With a 370,000 loan the Reconciliation panel shows "Difference -5,000" in red against it. Informational only (the mode is already Detailed and nothing blocks); do not switch the fund back to Summary to "fix" it.
- T7 HISTORY BASIS (the one defect-like effect on this path). The stored monthly history point and the history chart are kept on the pre-decision all-rows basis, which still subtracts a linked loan a second time (the known P0-1 behaviour). For the 365,000 loan this month's stored point is 647,441 (874,441 + 138,000 - 365,000) while the headline family figure is 1,012,441; the bridge line "SMSF loan counted once" (-365,000) explains it exactly (tested). It affects only the history chart and month-on-month movement, never the headline, and is labelled on screen. Not changed here (the history basis is a certified, PO-owned choice, item 2 of the net-worth note); reported.
- T8 THE LINKED LOAN STAYS LISTED. After linking, the loan is still listed on the Liabilities page but is not in personal totals; the grid footer shows it on the entity-held line. Expected.
- T9 OWNER TAG. Choosing Owner "SMSF" for the new loan is optional once linked (the link already makes it the fund's debt); it keeps the loan out of personal figures even if the link is ever removed. Phase 4 will stop offering "SMSF" on NEW rows; this row is already entered.

Rollback at any time: Retirement > SMSF card > Associated Debt > "Unlink" returns the fund net to 503,000; add "Other Retirement Assets" 133,000 again (owner SMSF) to restore today's counting. Nothing was deleted.

### 8.3 Diagnose again after the steps (read-only)

`docs/architecture/entity_level_assets_liabilities_2026-10-16/01_diagnose_entity_rows_READ_ONLY.sql` (PGLITE-tested read-only): expect the fund row at 138,000 (or 133,000), "Other Retirement Assets" shown inactive, one active SMSF-linked liability, and no "SMSF recorded twice" row.

### 8.4 Cutover to entity-level rows once built (asset 503,000 + liability 370,000 at the SMSF)

Invariant at EVERY step: family net worth equals the interim result (1,007,441 for 370,000) and the SMSF contributes its net exactly once.

1. Re-run the diagnosis; keep the output.
2. Open the new SMSF screen: the fund already has three itemised holdings (503,000) and one linked loan. The "Move to SMSF" action turns the linked personal liability into an `smsf_liabilities` row (370,000) and archives and unlinks the personal one in one logged transaction. Fund net stays 133,000; family stays 1,007,441.
3. The fund is already itemised (Detailed): there is no typed net to retire. The stale `summary_balance` (138,000) is cleared into the mode log by the first mode-rule step, with the user's confirmation, never silently.
4. Re-run the diagnosis: no SMSF-related personal liability, no SMSF-owned active retirement row.
5. Rollback: "Undo last change" from the mode log; the archived personal loan row and any copy tables remain.

Because this household is already itemised on the asset side, Phase 1 is smaller for the PO than for a net-only fund; the interim links above are exactly what the build converts.

## 9. PO decisions, with recommendation (ALL ACCEPTED by the PO on 17-10-2026; the loan amount 370,000 is decided)

| # | Decision | Recommendation |
|---|---|---|
| D1 | Storage model | C (section 4): structural child tables, one read model. |
| D2 | SMSF stays in `smsf_*`, presented in one Entities hub | Yes. |
| D3 | Engines classify the SMSF fund row by `master_item_key='smsf'`, not by owner tag | Yes (otherwise a fund row owned by Self is personal). |
| D4 | Default recording mode for new SMSF/Trust/HUF/Company | Itemised. Net value only stays available with the "hides the structure" note. |
| D5 | Switching mode when the new net differs from the old | Allowed ONLY with an explicit confirmation showing the variance; zero variance needs no extra step. (Alternative: keep the current 0084 hard $0-variance gate for SMSF; stricter, but it blocks a user whose old typed net was simply wrong, as the PO's 503,000 was.) |
| D6 | New personal-register rows with owner SMSF (and other registers' entity owners) | Block in UI and API now (Phase 4); DB trigger only after writers are audited. Existing rows get a "Move to SMSF" action. |
| D7 | SMSF loans entered via personal liability + link | Keep readable; stop offering "link a liability" once the fund is itemised; offer "Move into the fund". |
| D8 | Interim now | SUPERSEDED by the production diagnosis: use the existing-UI path of section 8.2 (add the loan at 0, link it in the SMSF card, enter the amount, remove the 133,000 row). Options A and B are withdrawn (B is impossible in Detailed mode; A archives a fund that has holdings). Confirm the loan amount (365,000 or 370,000): it changes family net worth by 5,000. |
| D9 | More than one SMSF per person | Not supported by the schema today (one `smsf` row per user). Confirm one is enough; supporting two means changing the unique key and the fund-row model (own phase). |
| D10 | Underwater entity (net negative) | Show and count as negative; no clamping. |
| D11 | Company: ownership share applied; Trust and HUF: full (already decided 16-10-2026) | Keep as decided; hide the percentage field for Trust/HUF (open item 6 of the net-worth note). |
| D12 | Richer line fields (type, as-at date, lender, rate, repayment) for Trust/HUF/Company | Yes, optional fields only. |
| D13 | Switch history | Keep forever (append-only), visible on the entity page ("Mode history"). |
| D14 | Move SMSF income and expenses (still owner `smsf` in personal registers) to the entity: when | Separate later phase (Phase 6), after the balance sheet is live. |
| D15 | Rename "Companies & Trusts" to "Entities" and add SMSF to it | Yes; keep the old URL as a redirect. |

## 10. Phased delivery plan, migrations and numbering

Migration numbering (re-checked 17-10-2026 across origin/main, every local and remote branch via `git log --all`, and every worktree directory): main ends at `0285_income_sources_tax_amount.sql`. `0286_module11_prompt_v3_coach_and_pack.sql` exists on `integration/module11-0-to-11-7-20261014`. `0281_nav2_report_idempotency_key.sql` and `0282_nav2_ambiguity_case_summary.sql` exist only on NAV2 branches. `0287` and `0288` are reserved by other work. **`0292_property_use_and_rent.sql` and `0293_income_rental_derived_from_properties.sql` exist in the worktree `property-use`** (found 17-10-2026). Used by Phase 1: **0289 and 0290**. Free for the next phases: `0291`, then `0294` and above. Every new migration must re-run the all-branches scan immediately before it is written (the two checker scripts are blind to unmerged siblings).

| Phase | Scope | Migrations | Agent sessions (estimate) |
|---|---|---|---|
| 0 (this round) | Design, SQL pack, read-only notice | none | done |
| 1 SMSF itemised + mode rule | `smsf_liabilities`; recompute includes it; either-or triggers and certified bracket; `smsf_create_fund` reuses an archived fund row; switch RPCs + log table + undo; API + SMSF workspace "Fund balance sheet"; 0084/0090 certification suites updated | `0289` (tables, RLS, functions, triggers; NOT VALID constraints), `0290` (`entity_figure_mode_log` + RPCs) | 2 build + 1 independent review |
| 2 Entities hub + Trust/HUF/Company | Additive columns and `is_active` on the two line tables; either-or constraints for `business_entities`; mode UI with the note; hub page; redirect | `0291` | 2 |
| 3 Family view + legacy adoption | `EntityBalanceSheet` loader and engine switch (after the other agent's branch merges, O1); "adopt grid rows" and "move liability to SMSF" RPCs; fund-row classification by master key | `0292` (adoption/move RPCs) | 1-2 |
| 4 Personal-register guards | Owner dropdown and API refusal on all registers; audit and re-route every writer (FDH-10 apply, owner-before-upload); then the DB trigger; VALIDATE the NOT VALID constraints | `0293` (trigger + validate) | 1-2 |
| 5 Household cutover | DEV rehearsal on the PO's shape, evidence, production hand-off pack (preview-first, backed up, reversible), PO-attended | none (data only) | 1 |
| 6 (separate decision D14) | SMSF income/expense separation; SMSF P&L reads entity rows | later | 2+ |

Total through Phase 5 about 8 to 11 agent sessions. The PO pushes; production migrations are applied by the PO after a DEV pass; production has no managed backups, so every destructive step is preceded by copy tables (DB size is already 260% of the Free plan).

## 11. Risks

1. Touching certified SMSF behaviour: 0084 deliberately let holdings exist in Summary mode while staging; the either-or rule changes that, so the SMSF suites and the 0084 cert script (`scripts/db-rebuild-check/smsf_jurisdiction_cert.mjs`) must be rewritten deliberately, not patched to green. Mitigation: NOT VALID constraints, wizard that submits the itemised set atomically.
2. Drop-and-recreate traps (memory: a re-created function or CHECK silently revokes a sibling's values): `smsf_compute_detailed_net_value`, the audit-event CHECKs (the new log should reuse the existing delta-based map, not widen by hand). Derive predecessors from the ledger.
3. Overlap with `feat/personal-networth-excludes-smsf-fund-20261016` (section 14). Phase 3 must wait for it and rebase.
4. A fund row archived by Option A blocks "Create SMSF" (unique key) until 0289.
5. Every register writer must be found before the owner trigger (imports, FDH-12 apply refuses SMSF rows by design, owner-before-upload 0236).
6. Multi-currency lines and the single household rate; unconvertible lines must be disclosed, not zeroed.
7. Data size: production is over its Free-plan quota; the log and copy tables are small but nonzero.
8. User confusion between personal member balance and fund net: the copy in 7.4 and the single recording-mode choice are the mitigation; test with the PO household wording.
9. Unique `smsf` fund per user: a household with two SMSFs cannot be modelled (D9).

## 12. The first slice (delivered 16-10-2026, extended in Phase 1): the read-only register notice

READ-ONLY diagnostic that tells a user their personal registers may double count the SMSF. It changes no figure, hides nothing, writes nothing, touches no migration.

- `lib/engines/entityRegisterDiagnostics.ts` (pure): two findings. `smsf_recorded_twice` (an active fund row plus active grid rows owned by the SMSF, amounts shown only when all rows share one currency) and `smsf_debt_in_personal_liabilities` (an active liability owned by the SMSF or linked as its property loan).
- `components/entities/EntityRegisterNotice.tsx`: fetches the existing `/api/retirement`, `/api/liabilities`, `/api/smsf` and `/api/smsf/{id}/property-loan`, renders an amber `role="note"` box, renders NOTHING when there is nothing to say and nothing on any read failure.
- Mounted with one line each in `app/(app)/retirement/page.tsx` and `app/(app)/liabilities/page.tsx`.
- Why not "block assigning a personal liability to an entity" as the slice: today the SMSF-owned or linked personal liability is the ONLY way to record an SMSF loan; blocking it before the replacement exists would remove the user's only route. The block is Phase 4.
- Tests: `tests/unit/entityRegisterDiagnostics.test.ts` (12, UNIT-TESTED; PO oracle 503,000 + 133,000 = 636,000; quiet on the interim and corrected shapes; mixed currencies never added; input not mutated; pages wired; sabotage run: reversing the owner test and the linked test made 6 named tests fail, restored, 12 pass). `tests/unit/entityLevelSqlPackPglite.test.ts` (17, PGLITE replay of the real ledger 0001..0285: the SQL pack on the PO fixture, plus six tests that rebuild the production fund shape - Detailed, summary 138,000, holdings 475,000 + 3,000 + 25,000, loan inactive - and prove the interim path: unlinked loan changes nothing, linking at 0 keeps 503,000, 365,000 gives net 138,000, 370,000 gives 133,000, unlinking returns 503,000). `tests/unit/entityLevelInterimPathNetWorth.test.ts` (10, UNIT-TESTED against the real post-merge `computeNetWorthLevels`: every step of section 8.2, both loan amounts, the wrong-order and transient traps, the history-basis bridge, one negative control).
- Not done and not claimed: a browser check of the notice (no signed-in session; no passwords typed), DEV or production verification.

## 13. Tests required for the build phases (hand oracles first)

Hand oracles, all AUD unless stated:

- SMSF itemised: asset 503,000 + liability 370,000 => derived net 133,000. SMSF net-only: typed 133,000 => net 133,000.
- Either-or: an itemised SMSF that also receives a typed net is REJECTED (DB trigger and API 422); a net-only SMSF that receives an active holding or liability is REJECTED; with both representations present in legacy data the net counted is the active-mode one only and the data-quality check names the entity.
- Mode switch: net-only 133,000 to itemised 503,000/370,000: variance 0, family unchanged at 1,007,441, typed net retired into the log, net column null. Itemised to net-only: lines archived (not deleted), snapshot in the log, family unchanged. Undo restores. A switch with variance and no confirmation changes nothing and returns the preview.
- PO household: personal 874,441; SMSF block 133,000; family 1,007,441 (today 1,510,441: difference 503,000 = the fund counted at 503,000 + 133,000). Legacy double entry (fund record exists AND grid rows owner smsf): counted once.
- Joint 60/40: a joint pool of 1,000,000 splits 600,000 / 400,000, shares total exactly 100% (10,000 basis points), and adding entity data changes neither share.
- Trust itemised assets 1,000,000, liabilities 400,000: family contribution 600,000 in full; HUF identical in full (India user); Company net 250,000 at 40%: 100,000; underwater entity assets 100,000 liabilities 150,000: -50,000 flows through.
- Entity liabilities never enter personal DTI/DSR (existing structural test extended to `smsf_liabilities`).

Negative controls (each must be demonstrated to fail when the rule is removed, with the named test): remove the either-or trigger (both accepted: the "rejected" tests fail); remove the certified bracket (a direct mode flip succeeds: bypass test fails); count legacy owner-smsf rows alongside a fund record (the 133,000 doubles: the family oracle fails); classify the fund row by owner tag (503,000 returns to personal: the personal oracle fails); drop the cross-tenant check in the child RLS (forged fund id attaches: isolation test fails); skip the log write (history test fails).

Other required suites: RLS and tenant isolation on the new tables as the real roles (PGlite, as in `adminPremiumGrantPglite.test.ts`); API route tests for 422 codes; component render tests for the two modes (net input absent in itemised, tables absent in net-only); date-format guard; the existing `dataTableGuard`, `dateFormatVisibleTextGuard`, SMSF and FDH-12 suites; migration ledger and collision scripts; tsc, eslint.

## 14. Overlap with the other agent (`feat/personal-networth-excludes-smsf-fund-20261016`, worktree `D:/FHIP/.claude/worktrees/personal-networth`)

(Historical, as of 16-10-2026; that branch has since merged to main as `a2a0f24`.) Its changes touched: `lib/engines/netWorthLevels.ts`, `lib/services/netWorthLevelsData.ts`, `lib/engines/dashboard.ts`, `lib/services/dashboardData.ts`, `lib/engines/financialDna.ts`, `lib/engines/forecast/engine.ts`, `lib/services/forecastCanonicalInputs.ts`, `lib/services/forecastData.ts`, `lib/services/twinData.ts`, `lib/engines/reportSections.ts`, `lib/engines/reportSectionsPremium.ts`, the Dashboard components, `ReportPreview.tsx`, and new `lib/engines/netWorthBasis.ts`, `lib/engines/forecast/varianceBasis.ts`.

This round touches NONE of those. Files this round changed: two one-line mounts (`app/(app)/retirement/page.tsx`, `app/(app)/liabilities/page.tsx`) plus new files only. Future overlaps to coordinate:

- O1 RESOLVED by that branch (merged on main as `a2a0f24`): the SMSF section's fund row is now classified as entity-held by `master_item_key='smsf'` (`isSmsfFundRow`), so it is not in the personal figure whoever owns it. My D3 therefore only needs to be kept when Phase 3 moves the SMSF block to the `EntityBalanceSheet` loader. A related behaviour to revisit in Phase 3: while a fund-level row (owner smsf) and the fund record both exist, main counts only the fund-level row (section 6 note, trap T5).
- O2: Phase 3 replaces the SMSF block's source inside `netWorthLevels.ts` and its loader: sequence after that branch merges.
- O3: the retirement grid and any "register grid applies the same basis" work there may touch `components/grid/FinancialDataGrid.tsx`; this design needs only `restrictedOwnerValues` (`lib/grid/types.ts`, `lib/grid/configs.ts`) in Phase 4.

## 15. Verification summary (honest)

- tsc: one error in `tests/unit/canonicalCertResidueAllSql.test.ts(127,75)` (`s.preUpdates` unknown), a file this branch does not touch (so present on origin/main `984ac2b`). No error in any changed or new file. eslint: clean on all changed and new files.
- New tests: 12 + 17 + 10 pass (after merging origin/main `f2831a7`). Related suites run before the merge: `dataTableGuard`, `dateFormatVisibleTextGuard`, `dateFormatsDayFirstSourceContract`, `fdh12Isolation`, `fdh12FinancialIntegrity`, SMSF tests, `canonicalIntegrationCrossPackage`: pass, except two failures in files this branch does not touch (`countryGateAccessMatrix` MC-15 and `smsfHouseholdIsolation` owner-select); re-run after the merge, see the final report.
- `scripts/` artifacts restored with `git checkout -- scripts/` after the run.
- Not done: any DEV or production access, browser verification, any migration, any push.

## 16. Phase 1 as built (17-10-2026)

### 16.1 What was built

| Piece | Where | Notes |
|---|---|---|
| `smsf_liabilities` (the fund's own debts) | `supabase/migrations/0289_smsf_fund_liabilities.sql` | Same RLS shape as `smsf_holdings`. Recompute trigger is security definer (account deletion cascades through it). `smsf_compute_detailed_net_value` is now holdings minus fund liabilities minus any still-linked legacy loans. |
| Mirror floor | 0289 | `retirement_accounts.current_balance` has `CHECK >= 0` (migration 0003), so a fund that owes more than it owns would have broken every holding insert. `smsf_recompute_fund` now floors only the register mirror at zero; the true (possibly negative) net lives in `smsf_funds.detailed_net_value` and `smsf_fund_counted_net()`. Found by a failing test. |
| `smsf_create_fund` reuses an archived fund row | 0289 | The 7-argument version is dropped and replaced by an 8-argument version with `p_mode` (default itemised). Closes the unique-key trap of section 2. |
| Either-or rule in the database | `0290_smsf_either_or_mode_rule_and_switch_rpcs.sql` | `trg_smsf_funds_mode_rule` (mode changes only inside a switch function, an itemised fund cannot carry a typed net), `trg_smsf_holdings_mode_rule` and `trg_smsf_liabilities_mode_rule` (an active line needs an itemised fund). They act on a change of mode, typed net or `is_active` only, so legacy rows (the PO fund with a stale typed 138,000) are not broken by ordinary maintenance. |
| Switch, undo, retire, move, adopt | 0290 | `smsf_entity_switch_mode` (preview-first, atomic: inserts the new representation, archives the old, writes the history), `smsf_entity_undo_last_switch`, `smsf_entity_retire_typed_net`, `smsf_entity_move_linked_loan`, `smsf_entity_adopt_register_rows`. All security definer, scoped to `auth.uid()`, execute revoked from public and anon. |
| History | 0290 `entity_figure_mode_log` | Append-only (update raises, the owner cannot delete under RLS), owner-readable. |
| Data-quality function | 0290 `smsf_mode_rule_violations()` | Lists funds holding both representations. |
| API | `app/api/smsf/[id]/{switch-mode,undo-switch,retire-typed-net,move-loan,adopt-register-rows,history,liabilities}` | Preview is the default (`confirm` false). `lib/services/smsfErrors.ts` maps the rule to 409 `ENTITY_BOTH_REPRESENTATIONS`. The earlier `switch-to-detailed` and `switch-to-summary` routes are removed. Linking a personal liability to an itemised fund returns 409 `ENTITY_USE_FUND_LIABILITIES`. |
| Family view | `lib/engines/entityBalanceSheet.ts`, `lib/services/entityBalanceSheetData.ts`, `lib/engines/netWorthLevels.ts` | The SMSF block reads the fund's own sheet (itemised: assets and liabilities, net derived; net-only: the typed net). The fund record in the register, linked personal loans (they are inside the sheet) and register rows owned by the SMSF are not added a second time; the latter are listed as `legacyRowsNotCounted`. Block `source` is `entity_record`; `block.sheet` carries the lines. The bridge to the previously reported figure gained `smsf_legacy_rows_not_counted` and `smsf_fund_row_differs`. |
| Screens | `components/retirement/smsf/` (`SmsfModeSwitch`, `SmsfDetailedWorkspace`, `SmsfLiabilityForm`, `SmsfNetPosition`, `SmsfFundCard`, `SmsfCreateForm`) | Radio choice with the "hides the structure" note; itemised shows Assets, Liabilities and a derived net with no input for it; net-only shows one value and no lines; preview then confirm; Undo; Mode history; "Move into the fund" for a legacy linked loan; "Retire the typed value" for the stale net. |
| Register notice | `components/entities/EntityRegisterNotice.tsx`, `lib/engines/entityRegisterDiagnostics.ts` | Now three findings, worded to match the new counting. |
| SMSF P&L | `lib/services/smsfReportData.ts` | Fund liabilities feed the P&L and cash flow beside any still-linked loan (typed, not unit-tested). |
| Packs | `sql_parts/`, `dev_pack/`, `production_pack/`, `README_PO_STEPS.md` | Section 16.5. |

### 16.2 Counting rules now in force (family view)

- The SMSF is counted from ONE source: its own sheet. Fund record in the register: not added (it mirrors the same net, floored at zero). Personal loan linked to the fund: inside the sheet, not deducted again. Register rows owned by the SMSF (for example "Other Retirement Assets" 133,000): listed, not counted, with a plain notice. This reverses main's stop-gap (where the fund-level row won and hid every SMSF edit, trap T5): the entity record now wins, as section 6 recommended.
- A debt owned by the SMSF in the personal Liabilities register and NOT linked is also not deducted; the notice says to add it to the fund's liabilities. Entity-free households (no fund): identical to before.
- Net-only funds count the typed net; stray lines are ignored. Itemised funds count the lines; a stale typed net is ignored and flagged.
- Personal figures do not change at all (874,441 for the PO household).

### 16.3 Hand oracles (all UNIT-TESTED or PGLITE-tested, AUD)

Assets 475,000 + 3,000 + 25,000 = 503,000; liability 370,000; derived net 133,000; net-only 133,000; typed 138,000 against the same itemised set is a variance of -5,000; both representations rejected by the database (trigger removed: accepted, proving the rule is the cause); mode switch preview changes nothing, confirm applies, undo restores; underwater fund (assets 100,000, liabilities 150,000) is -50,000 in the family view with the register mirror at 0; personal 874,441, family 1,007,441; 365,000 gives 138,000 and family 1,012,441; joint 60/40 of 1,000,000 splits 600,000 / 400,000 and totals 100% with an SMSF present; Trust 600,000 and HUF in full, Company 40% of 250,000 = 100,000 beside the SMSF; entity-free household unchanged.

### 16.4 Negative controls (each shown to bite)

Engine: itemised net ignoring liabilities, legacy rows counted, loader missing `is_active` made 14 named tests fail, restored, 26 pass. Database: rule trigger disabled accepts the typed net, line trigger disabled accepts an asset on a net-only fund. Pack: wrong expected assets, wrong duplicate total, unknown e-mail, loan 600,000, no backup, second run, all refuse and change nothing. Cross-tenant: another household cannot switch, undo, move or adopt, cannot attach lines, cannot read the history; an unauthenticated caller is refused.

### 16.5 The packs and the PO steps in order

See `docs/architecture/entity_level_assets_liabilities_2026-10-16/README_PO_STEPS.md`. DEV: the eight migration parts, then `dev_pack/D1_build_po_shape_for_rehearsal.sql` on a test account, then the production pack against it, then try the screens. Production: P0 diagnose, migration parts, P1 backup, P2 preview, P3 apply (loan 370,000 default, guarded: assets 503,000, exactly one duplicate row worth 133,000, no fund liabilities yet), P4 verify, then push. P9 rolls the cutover back. The SQL is applied BEFORE the code is deployed (otherwise the family figure reads 1,377,441 until P3 runs; PGLITE-tested). Every SQL file passes `tests/unit/support/sqlEditorHazards.ts` (no dollar-quote pairs, no percent signs, nothing the editor misreads), including the migrations themselves.

### 16.6 What is NOT done or NOT verified

- Phase 2 (Entities hub, Trust/HUF/Company enrichment and the same either-or rule for `business_entities`) is not started. The either-or rule is therefore enforced for the SMSF only; Company / Trust / HUF keep their existing application-level exclusivity.
- Phase 4 (blocking SMSF and other entity owners on new personal-register rows, and the DB owner trigger) is not started; the personal-register notice remains the only guard.
- NOT run against DEV or production. NOT checked in a real browser (no signed-in session; layout at 375 / 768 / 1280 px, keyboard focus order and the dd/mm/yyyy date fields are covered only by static render and source contracts).
- `scripts/db-rebuild-check/smsf_jurisdiction_cert.mjs` and `scripts/smsf_production_readonly_schema_check.mjs` still call the two replaced switch functions; they certify the 0084-0090 ledger and are not part of the vitest suite. They need a deliberate update, not a patch to green.
- The SMSF report "Reconciliation" panel still shows detailed net against summary; for an itemised fund it shows the typed value as empty. Cosmetic.
- Net Worth Statements (merged to main from `feat/net-worth-statement-report-20261016` while this was being built): `lib/engines/netWorthStatement.ts` `buildEntityInputs` now builds the entity input straight from `block.sheet` (source `entity_level_rows`, the stable `EntityStatementInput`), so the SMSF page itemises assets and liabilities from the fund itself with no loader change, and `shownNotCounted` lists the register rows that the fund replaces. `tests/unit/netWorthStatementParity.test.ts` was updated: the pre-cutover production shape now reads family 1,377,441 (the fund counts at its 503,000 holdings until the loan is recorded, which is why the pack runs before the deploy) and a new block covers the post-cutover shape (personal 874,441, SMSF 133,000, family 1,007,441, itemised both sides).
- Joint ownership of the SMSF fund row itself, more than one SMSF per person (D9), and SMSF income/expense separation (D14) are unchanged.

### 16.7 Verification (17-10-2026, after merging origin/main `5883b95`)

- tsc: one error, in `tests/unit/canonicalCertResidueAllSql.test.ts(127,75)`, a file this branch does not touch (present on origin/main). eslint: clean on every changed and new file.
- New and changed suites: 125 tests in 8 files pass (`smsfEntityLevelPglite` 27, `entityLevelProductionPackPglite` 15, `entityLevelSqlHygiene` 19, `entityBalanceSheetNetWorth` 19, `entityBalanceSheetLoader` 7, `smsfEntityLevelUi` 15, `entityRegisterDiagnostics` 13, `entityLevelInterimPathNetWorth` 10), plus `netWorthStatementParity` (26, updated).
- Sweeps in small batches (name filters smsf, entity, netWorth, personalNetWorth, fdh12, lr12r: 953 tests; retirement, liabilit, dashboard, grid, report, income, countryGate, dataTable, dateFormat, ownership: 1,020 tests). Three failures, ALL reproduced unchanged on a clean checkout of origin/main (`5883b95`) and not touched by this branch: `smsfHouseholdIsolation` (loadDashboard selects owner on income_sources), `iiNetWorthNavRemarkPublishFlow` (a dated NAV remark), `countryGateAccessMatrix` MC-15 (an `account-deletions` admin route exists).
- `scripts/` artifacts restored with `git checkout -- scripts/` after every full-suite run.
- PGlite proves: both migrations replay on the real ledger; the eight editor parts reproduce them exactly, run twice, and the rule works afterwards; the pack runs end to end on the production shape; the DEV fixture builds the same shape; every negative control named above bites.


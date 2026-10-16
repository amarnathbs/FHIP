# Entity-level assets and liabilities (SMSF, Family Trust, HUF, Company): design and plan (16-10-2026)

Status: DESIGN AND PLAN, plus one small read-only slice (section 12). No migration is written, nothing is applied anywhere. Branch `feat/entity-level-assets-liabilities-design-20261016`, based on origin/main `984ac2b`. Not pushed.

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
2. DOUBLE ASSET (the fund counted twice). The PO household: fund row 503,000 (owner self, in the SMSF section) AND grid row "Other Retirement Assets" 133,000 (owner smsf). Both are active retirement rows; the family figure adds 636,000 for one fund whose real net is 133,000. The 503,000 is the property GROSS typed into a field that means NET; the 133,000 is the real net typed again as a second row; the 370,000 loan is nowhere. Overstatement 503,000 (1,510,441 shown vs 1,007,441 correct).
3. PERSONAL BASIS LEAK. The fund row has owner self, so any "exclude entity rows by owner tag" rule keeps it in the PERSONAL figure (the PO's 874,441 only holds once the 503,000 row is out). See overlap O1 (section 14).

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

Counting rule that makes the double count structurally impossible: once an SMSF has an entity-level figure (a fund record with a net source), register rows tagged `smsf` are NOT counted in the SMSF block; they are listed as "legacy rows not counted" with the adopt/archive action. Until the fund record exists they keep counting as they do today. Creating the fund therefore adopts the legacy rows in the same step, so the family figure never dips or doubles between steps.

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

### 8.1 Diagnose first (read-only, safe, run now)

`docs/architecture/entity_level_assets_liabilities_2026-10-16/01_diagnose_entity_rows_READ_ONLY.sql`: one select statement (PGLITE-tested to be read-only and to show only the named user). It lists the retirement register, `smsf_funds`, holdings, the liabilities register with link status, entity-tagged assets/investments, registered entities, and four data-quality/total rows. The PO household should return: fund row 503,000 owner self; "Other Retirement Assets" 133,000 owner smsf; personal assets plus investments 2,260,298; personal liabilities 1,385,857; no SMSF-related liability; "SMSF recorded twice" 636,000. The statements about the production rows (that 503,000 is the SMSF-section fund row, that 133,000 is a grid row) are INFERRED from the PO's description and the code; the diagnosis is what proves them. NOT VERIFIED against production.

### 8.2 Interim shape the PO can use now (so personal = 874,441 and family = 1,007,441)

The PO's stated interim: remove the 503,000 owner-self SMSF row; keep the 133,000 owner-smsf row as the fund's net.

- There is no way to delete the fund row in the UI (the Retirement grid excludes it and the SMSF card has no archive). Two ways, both reversible:
  - Option A (the PO's words), SQL: `02_interim_option_a_PREVIEW_READ_ONLY.sql`, then `03_interim_option_a_APPLY.sql` (guarded, one transaction, makes its own copy tables with row level security on because production has no managed backups, archives rather than deletes), `04_interim_option_a_ROLLBACK.sql`. PGLITE-tested including two negative controls (wrong amount and unknown e-mail refuse and change nothing) and a rollback. HAZARD (found in the code, section 2): an archived fund row keeps the unique key, so "Create SMSF" will fail until migration 0289 makes fund creation reuse the archived row.
  - Option B (recommended, no SQL): in Retirement > SMSF, set the fund's summary value to 0. Same effect on every total, no archived row, nothing to repair later, undone by typing the value back. Not browser-tested.
- Expected effect (hand calculation, UNIT-TESTED in `tests/unit/entityLevelSqlPackPglite.test.ts` for the personal side): personal 2,260,298 - 1,385,857 = 874,441; family 874,441 + 133,000 = 1,007,441. Today's reported 1,510,441 falls by exactly 503,000.

### 8.3 Cutover to entity-level rows once built (asset 503,000 + liability 370,000 at the SMSF)

Invariant at EVERY step: family net worth stays 1,007,441 and the SMSF contributes 133,000 exactly once.

1. Take the diagnosis again and keep the output (also the "before" evidence). Take a backup copy of the SMSF-related rows with the pattern of `03` (copy tables with row level security on).
2. Open the new SMSF fund screen. The fund exists (Option B) or is re-activated (Option A, thanks to the 0289 reuse fix). Choose "Use these existing SMSF rows as the starting net value": the 133,000 grid row is archived and the fund records net-only 133,000 in one step (logged). Family stays 1,007,441.
3. Choose "Itemised (recommended)". Enter, inside the switch dialog: asset "Property" 503,000 AUD; liability "Property loan" 370,000 AUD. The dialog shows derived net 133,000, variance 0, and "the typed net value of 133,000 will be kept in history and removed from the figures". Confirm. Family stays 1,007,441; the net input is gone.
4. Check: the diagnosis shows no `SMSF recorded twice`, no SMSF-owned active retirement row, no SMSF-related personal liability; the Net Worth panel reconciles personal 874,441 + SMSF 133,000 = family 1,007,441.
5. Rollback at any time: "Undo last mode change" (restores the typed net 133,000 and retires the lines); the adopted grid row is restored from its log entry; the SQL copy tables remain.
6. If the PO keeps an Option A archived fund row: step 2 uses the reuse path; if the fund record was created fresh, the archived row is reused, not duplicated (tested in Phase 1).

DEV rehearsal first (the PO household's shape seeded on DEV with the PO attending), then production. No production access is requested or used by this agent.

## 9. PO decisions, with recommendation (answer these before Phase 1)

| # | Decision | Recommendation |
|---|---|---|
| D1 | Storage model | C (section 4): structural child tables, one read model. |
| D2 | SMSF stays in `smsf_*`, presented in one Entities hub | Yes. |
| D3 | Engines classify the SMSF fund row by `master_item_key='smsf'`, not by owner tag | Yes (otherwise a fund row owned by Self is personal). |
| D4 | Default recording mode for new SMSF/Trust/HUF/Company | Itemised. Net value only stays available with the "hides the structure" note. |
| D5 | Switching mode when the new net differs from the old | Allowed ONLY with an explicit confirmation showing the variance; zero variance needs no extra step. (Alternative: keep the current 0084 hard $0-variance gate for SMSF; stricter, but it blocks a user whose old typed net was simply wrong, as the PO's 503,000 was.) |
| D6 | New personal-register rows with owner SMSF (and other registers' entity owners) | Block in UI and API now (Phase 4); DB trigger only after writers are audited. Existing rows get a "Move to SMSF" action. |
| D7 | SMSF loans entered via personal liability + link | Keep readable; stop offering "link a liability" once the fund is itemised; offer "Move into the fund". |
| D8 | Interim now: Option A (SQL) or B (set fund value to 0) | B: no SQL, no archived-row trap. |
| D9 | More than one SMSF per person | Not supported by the schema today (one `smsf` row per user). Confirm one is enough; supporting two means changing the unique key and the fund-row model (own phase). |
| D10 | Underwater entity (net negative) | Show and count as negative; no clamping. |
| D11 | Company: ownership share applied; Trust and HUF: full (already decided 16-10-2026) | Keep as decided; hide the percentage field for Trust/HUF (open item 6 of the net-worth note). |
| D12 | Richer line fields (type, as-at date, lender, rate, repayment) for Trust/HUF/Company | Yes, optional fields only. |
| D13 | Switch history | Keep forever (append-only), visible on the entity page ("Mode history"). |
| D14 | Move SMSF income and expenses (still owner `smsf` in personal registers) to the entity: when | Separate later phase (Phase 6), after the balance sheet is live. |
| D15 | Rename "Companies & Trusts" to "Entities" and add SMSF to it | Yes; keep the old URL as a redirect. |

## 10. Phased delivery plan, migrations and numbering

Migration numbering (checked across origin/main, every local and remote branch, and every worktree directory on 16-10-2026): main ends at `0285_income_sources_tax_amount.sql`. `0286_module11_prompt_v3_coach_and_pack.sql` exists on `integration/module11-0-to-11-7-20261014` only. `0281_nav2_report_idempotency_key.sql` and `0282_nav2_ambiguity_case_summary.sql` exist only on NAV2 branches (not on main: main goes 0280 then 0283; a file named `0281_income_sources_tax_amount.sql` exists on a branch while main carries the same change as 0285). `0287` and `0288` are reserved by other work. No `0289` or above exists anywhere. This design therefore proposes `0289` onward, and every migration must re-run `node scripts/check-migration-versions.mjs` and `scripts/check-migration-versions-against-branch.mjs --against=origin/main` immediately before it is written (both are blind to unmerged siblings, so also repeat the all-branches scan used here).

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

## 12. Delivered now: the small, safe first slice (code, on this branch)

READ-ONLY diagnostic that tells a user their personal registers may double count the SMSF. It changes no figure, hides nothing, writes nothing, touches no migration.

- `lib/engines/entityRegisterDiagnostics.ts` (pure): two findings. `smsf_recorded_twice` (an active fund row plus active grid rows owned by the SMSF, amounts shown only when all rows share one currency) and `smsf_debt_in_personal_liabilities` (an active liability owned by the SMSF or linked as its property loan).
- `components/entities/EntityRegisterNotice.tsx`: fetches the existing `/api/retirement`, `/api/liabilities`, `/api/smsf` and `/api/smsf/{id}/property-loan`, renders an amber `role="note"` box, renders NOTHING when there is nothing to say and nothing on any read failure.
- Mounted with one line each in `app/(app)/retirement/page.tsx` and `app/(app)/liabilities/page.tsx`.
- Why not "block assigning a personal liability to an entity" as the slice: today the SMSF-owned or linked personal liability is the ONLY way to record an SMSF loan; blocking it before the replacement exists would remove the user's only route. The block is Phase 4.
- Tests: `tests/unit/entityRegisterDiagnostics.test.ts` (12, UNIT-TESTED; PO oracle 503,000 + 133,000 = 636,000; quiet on the interim and corrected shapes; mixed currencies never added; input not mutated; pages wired; sabotage run: reversing the owner test and the linked test made 6 named tests fail, restored, 12 pass). `tests/unit/entityLevelSqlPackPglite.test.ts` (11, PGLITE replay of the real ledger 0001..0285; PO fixture; personal assets 2,260,298, personal liabilities 1,385,857, net 874,441, family 1,007,441; read-only proof; cross-user isolation; apply/rollback with two negative controls).
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

Its uncommitted changes touch: `lib/engines/netWorthLevels.ts`, `lib/services/netWorthLevelsData.ts`, `lib/engines/dashboard.ts`, `lib/services/dashboardData.ts`, `lib/engines/financialDna.ts`, `lib/engines/forecast/engine.ts`, `lib/services/forecastCanonicalInputs.ts`, `lib/services/forecastData.ts`, `lib/services/twinData.ts`, `lib/engines/reportSections.ts`, `lib/engines/reportSectionsPremium.ts`, the Dashboard components, `ReportPreview.tsx`, and new `lib/engines/netWorthBasis.ts`, `lib/engines/forecast/varianceBasis.ts`.

This round touches NONE of those. Files this round changed: two one-line mounts (`app/(app)/retirement/page.tsx`, `app/(app)/liabilities/page.tsx`) plus new files only. Future overlaps to coordinate:

- O1 (decision, not yet a conflict): `netWorthBasis.ts` classifies "entity-held" by OWNER TAG only (`smsf`, `family_trust`, `company`), and its own comment says "an SMSF member balance recorded against a person (owner self/spouse/joint) is personal". The SMSF section's fund row is owner self by construction (`smsf_create_fund`, `lib/validation/smsf.ts`), so after that branch merges the fund row stays in the PERSONAL figure unless the row is removed (as in the PO's interim). Recommend that branch (or Phase 3 here, D3) classify `master_item_key='smsf'` as entity-held. This matters for every household with a fund, not only the PO's.
- O2: Phase 3 replaces the SMSF block's source inside `netWorthLevels.ts` and its loader: sequence after that branch merges.
- O3: the retirement grid and any "register grid applies the same basis" work there may touch `components/grid/FinancialDataGrid.tsx`; this design needs only `restrictedOwnerValues` (`lib/grid/types.ts`, `lib/grid/configs.ts`) in Phase 4.

## 15. Verification summary (honest)

- tsc: one error in `tests/unit/canonicalCertResidueAllSql.test.ts(127,75)` (`s.preUpdates` unknown), a file this branch does not touch (so present on origin/main `984ac2b`). No error in any changed or new file. eslint: clean on all changed and new files.
- New tests: 12 + 11 pass. Related suites run: `dataTableGuard`, `dateFormatVisibleTextGuard`, `dateFormatsDayFirstSourceContract`, `fdh12Isolation`, `fdh12FinancialIntegrity`, SMSF tests, `canonicalIntegrationCrossPackage`: pass, except two failures in files this branch does not touch: `countryGateAccessMatrix` MC-15 ("no account-deletion route under app/api" found one) and `smsfHouseholdIsolation` ("loadDashboard selects `owner` on all four cash-flow registers", income_sources). They read `app/api/**` and `lib/services/dashboardData.ts`, which this branch does not change; not compared against a separate clean checkout run.
- `scripts/` artifacts restored with `git checkout -- scripts/` after the run.
- Not done: any DEV or production access, browser verification, any migration, any push.

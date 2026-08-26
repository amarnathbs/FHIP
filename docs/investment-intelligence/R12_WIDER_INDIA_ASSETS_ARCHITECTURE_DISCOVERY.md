# R12 — Wider India Assets: Architecture Discovery

Status: COMPLETE. Verdict: **GO — R12 SCOPE FROZEN** (see `R12_ASSET_CLASS_SCOPE_MATRIX.md` for the exact freeze).

Canonical baseline: `origin/main` at `e285374335dbaaf046f56fb4af3827f808487b2d` (confirmed current via
`git fetch --all --prune` + `git rev-parse origin/main` at dispatch time — matches the SHA the
orchestrating session already recorded from R11's production closure).

Branch: `feature/investment-intelligence-r12-wider-india-assets`, cut from `origin/main` at the same
SHA, in worktree `D:/FHIP/.claude/worktrees/r12-wider-india-assets`.

## 1. Migration collision guard (spec sections 8–9, 136)

Ground truth gathered by actually walking `git ls-tree` on `origin/main` and every sibling
worktree/branch under `D:/FHIP/.claude/worktrees/`, not from memory:

- `origin/main` migration tail: `0090_smsf_current_balance_integrity_guard.sql`. Gap `0079`-`0081`
  exists on `main` (not sequential) — those three numbers are claimed by the **unmerged**
  `feature/app-review-remainder-input-ux-currency-onboarding` branch
  (`0079_app_review_profile_phone.sql`, `0080_app_review_expense_catalogue_education_land_tax.sql`,
  `0081_app_review_onboarding_backfill.sql`), confirmed via `git ls-tree` on that branch and
  `git merge-base --is-ancestor` returning NOT MERGED.
- `0091_fdh9_payslip_income_intelligence.sql` is claimed by the **unmerged**
  `fdh9-payslip-income-intelligence` branch (worktree `agent-aa66123832b7e337b`), confirmed still
  unmerged today (`git merge-base --is-ancestor fdh9-payslip-income-intelligence origin/main` →
  NOT MERGED). This matches the standing hard-rule's warning that this claim might be stale, but on
  re-check it is **still live and still unmerged**.
- `g0-jurisdiction-applicability-discovery` (the other named concurrent branch) claims no migration
  numbers above `0090` — confirmed by `git ls-tree`; it is a docs-only discovery branch.
- A full scan of every `.claude/worktrees/*/supabase/migrations` directory found no migration number
  anywhere above `0091`.

**Result: `0092` is the first genuinely free migration number.** R12 migrations are allocated
starting at `0092`. Migrations `0082`-`0090` are not touched, edited, or renumbered anywhere in this
branch (verified by diffing this branch's `supabase/migrations/00{82..90}*.sql` against `origin/main`
after every commit in this round).

## 2. Existing canonical Investment Intelligence architecture (read from real code, not assumed)

### 2.1 Instrument model (`ii_instruments`, migration `0031`)
`instrument_class` is **already** a checked enum containing `'equity', 'mutual_fund', 'etf', 'bond',
'fixed_deposit', 'gold', 'crypto', 'cash', 'other'`. Direct equity, ETF and bond are **already
representable today** without any enum change — R1/R2 architects explicitly future-proofed this
column years before R12 was commissioned. `ii_instrument_identifiers` (same migration) already
supports `isin`, `amfi_scheme_code`, `nse_symbol`, `bse_code`, `sedol`, `internal_provisional` with a
correct global-unique-vs-country-scoped uniqueness split — i.e. NSE/BSE symbol identity for the same
ISIN is **already** structurally de-duplicatable via the shared `instrument_id`, satisfying spec
section 25/27 with zero schema change.

`ii_accounts` (migration `0032`) already has `account_type = 'demat'` in its check constraint — a
direct-equity brokerage/demat account was already anticipated as a first-class account type.

### 2.2 Transactions/holdings/tax-lots (`0033`)
`ii_transactions.transaction_type` currently allows `'purchase','sip','redemption','switch_in',
'switch_out','dividend','reinvestment','transfer','merger','fee','tax','adjustment'`. This is
generic enough for equity BUY (`purchase`) and dividend (`dividend`); it has no explicit equity-SELL
semantic distinct from a mutual-fund `redemption` (redemption implies unit redemption from a scheme,
not a market sale) — R12 adds exactly one new value, `sale`, for this (see
`R12_TRANSACTION_SEMANTICS.md`). `ii_tax_lots` (FIFO cost-basis) and `ii_holding_snapshots` (point-
in-time certified balance) are both instrument-class-agnostic already — nothing in their schema or
the code that writes them assumes mutual funds.

### 2.3 A real, live, pre-existing security gap found during this discovery (fixed in this round)
`ii_holding_snapshots` (migration `0033`) still carries the original `"own ii_holding_snapshots" for
all using (auth.uid() = user_id) with check (...)` policy — the exact same defect class R11 found
and fixed on `ii_transactions`/`ii_reconciliation_cases` (migration `0087`) and R9/R7/R8 found on
their own tables in earlier rounds (same-user, column-level authoritative forgery: row ownership is
enforced, but every column — including the engine-derived `units`/`value`/`quality_status` — is
freely writable by the owning user via a raw PostgREST PATCH). A full grep of `app/` + `lib/` for
`.insert(`/`.update(`/`.upsert(` against `'ii_holding_snapshots'` found **zero** authenticated-client
call sites — every real write goes through `createAdminClient()` in `manualImporter.ts`,
`documentProcessing.ts`, or `investmentPublicationService.ts`. Because R12 is about to make this
exact table carry equity/ETF valuations too, this is directly in R12's own remit (spec sections
76–81, 140's "same-user authoritative holding forgery" critical-fail condition) and was fixed in
migration `0092` alongside the R12 schema additions, using the same "SELECT-only for authenticated,
service-role for every real write" shape as `0087`. Live-reproduced RED→GREEN — see
`R12_NEGATIVE_CONTROL_CERTIFICATION.md` NC6 and `R12_SECURITY_VERIFICATION.md`.

### 2.4 Publishing bridge — the no-double-count mechanism (R3, `investmentPublicationService.ts` /
`publicationLogic.ts`)
`ii_fhip_publications` records exactly one active publication per `(user, account, instrument)` via
a unique index, and the "target FHIP row" a canonical II position publishes into is decided by
`computePublicationTarget(instrumentClass, accountType)`:
- `accountType === 'retirement'` → `retirement_accounts` (already routes NPS/EPF/PPF-classified
  accounts away from II, satisfying spec section 15 with existing code)
- `instrumentClass ∈ {'fixed_deposit','cash'}` → `assets` (satisfies spec section 16 with existing
  code — FDs already have a single canonical home)
- everything else → `investments` (the legacy Module-2 household register, migration `0003`)

Crucially, `isProductionCertifiedAssetClass(instrumentClass)` **today returns true only for
`'mutual_fund'`** — every other instrument class is structurally blocked from ever reaching
household net worth (`NOT_ELIGIBLE` / `ASSET_CLASS_NOT_YET_CERTIFIED`), regardless of what a user
enters into Investment Intelligence. The mapping table
`INSTRUMENT_CLASS_TO_MASTER_ITEM_KEY` even carries an explicit code comment anticipating this exact
release: *"Future releases (not R3 production): equity -> 'australian_shares' |
'international_shares' (country-dependent, needs its own resolution rule), etf -> 'etfs', bond ->
'bonds' ..."*. R12's job is precisely to turn that comment into real, tested code for the classes it
freezes — see `R12_CANONICAL_INSTRUMENT_MODEL.md` section on publication targets.

`master_item_key` precedent for country-dependent equity routing already exists and was actually
run in production: migration `0073` (AIR consolidation) reclassified every existing `investments` row
with `master_item_key='shares'` into `'international_shares'` when `country_code='IN'`, else
`'australian_shares'`. R12 reuses this exact, already-shipped rule rather than inventing a new one.

### 2.5 R4 Performance / R5 X-Ray / R6 Tax / R9 Goals / R10 Reports — instrument-class coupling audit
A full grep of every engine file for `instrument_class`/`mutual_fund` found:
- **R4 performance** (`lib/engines/investment-intelligence` outside `tax/`): **zero** instrument-class
  references anywhere. XIRR/TWRR operate purely on `ii_transactions` cash flows and
  `ii_holding_snapshots` values — already fully asset-class-agnostic.
- **R5 X-Ray** (`lib/engines/investment-intelligence/xray/*`): the core engine
  (`calculatePortfolioLookThrough` in `lookThrough.ts`, and everything in `concentration.ts`) is
  built entirely around a `LookThroughResult` — it does not know or care what instrument class fed
  it. The **coupling is only in the repository layer** (`r5Repository.ts:353-354`), which today
  hard-filters positions to `cls === 'mutual_fund' || cls === 'etf'` and requires a real
  `ii_fund_holdings_snapshots` disclosure row for every position — a position with no disclosure
  contributes to `noSnapshotWeight` (effectively "missing"), never to a real security exposure. A
  direct-equity (or an ETF with no disclosed constituents) position, if simply added to this filter
  unchanged, would silently vanish from every X-Ray output. R12 closes this by **synthesizing a
  self-referencing single-holding "fund disclosure"** (weight 100% to the security's own canonical
  id) for any position whose instrument class does not require or have real look-through data —
  this feeds the *existing, unmodified* engine rather than building a second one (spec section 47),
  and is exactly what spec section 48 asks for ("direct equity is already itself the underlying
  security... do not attempt fund-style look-through").
- **R6 tax** (`lib/engines/investment-intelligence/tax/*`): `schemeClassification.ts`'s
  `classifyScheme()` is explicitly mutual-fund-only (allocation-based equity-oriented/debt-specified
  test against `ii_fund_holdings` look-through disclosure — the code's own header comment says so).
  The FIFO/holding-period/grandfathering/gain engine it feeds
  (`capitalGainsEngine.ts::computeDisposalTax`) is, however, generic: it takes a
  `SchemeClassificationResult` (any `classification` value) and a `SchemeTaxClass` of
  `'equity_oriented' | 'debt_specified' | 'other_hybrid'`. Legally, Section 111A/112A of the Income
  Tax Act taxes **listed equity shares** and **equity-oriented mutual fund/ETF units** identically
  (same 12-month STCG/LTCG holding-period threshold, same rate structure, same Section 55(2)(ac)
  31-Jan-2018 FMV grandfathering scope — grandfathering was never mutual-fund-specific, it always
  covered "equity share... or unit... in respect of which STT is paid"). This means direct listed
  equity and equity-oriented ETFs can be classified `'equity_oriented'` by a **much simpler,
  non-look-through classifier** and fed into the *existing, unmodified* `computeDisposalTax` — again
  extending R6, not duplicating it (spec section 53).
- **R9 Goals** (`goalAllocations.ts`) and **R10 Reports** (`investmentIntelligenceReportData.ts`):
  **zero** instrument-class references. Both already operate at the canonical-position level and
  require no code change to accept new asset classes, provided the position reaches them through the
  same publishing/holding-snapshot path everything else already uses.

### 2.6 Manual entry — the biggest real gap found
A search of `app/api/investment-intelligence/**` for a POST/create route on `positions` or
`instruments` found **none** — the only routes are `positions` (GET, list), `positions/[id]/publish`,
`positions/[id]/refresh`. Every real (non-fixture) row in `ii_transactions`/`ii_instruments` today is
created by `documentProcessing.ts` from an uploaded CAS statement (mutual-fund-only by construction).
`manualImporter.ts`'s `iiManualFixtureSchema` exists, but it is a **certification-fixture loader**
used by test scripts, not a user-facing endpoint — it takes a fully pre-resolved fixture object, not
raw user input, and is invoked only from `scripts/`, never from an `app/api` route.

**This means Investment Intelligence currently has no live, user-facing manual-entry path for ANY
asset class, including the already-certified mutual fund.** Spec section 20 ("every R12-certified
asset class should have at least one reliable canonical entry path... manual entry acceptable") is
therefore not an incremental extension — it requires building the first one. R12 builds a single,
generic, service-role-mediated manual-entry orchestration function reusable for any future asset
class, not an equity-specific one-off (see `R12_CANONICAL_INSTRUMENT_MODEL.md` /
`R12_UI_UX_SPEC.md`).

### 2.7 Household boundary: the legacy `investments` register (migration `0003`)
`investments.investment_type` (Zod: `lib/validation/investment.ts`) already allows
`'shares','managed_fund','etf','crypto','business_equity','other'` — no `'bond'` value exists yet.
This is one of the reasons Bonds/NCDs/G-Secs are deferred rather than frozen into R12 scope this
round (see scope matrix) — extending this enum is a small change in isolation, but bond tax rules
(distinct holding-period/indexation treatment, see `R12_INDIA_TAX_AND_COST_INTEGRATION.md`) were
judged the larger, genuinely un-shortcuttable piece of work, and shipping the FHIP-register enum
without the tax engine behind it would create a value nothing downstream can compute correctly for.

## 3. Non-II asset registers inspected (to avoid duplicating canonical ownership — spec sections 4-6, 15-17)

- `assets` (migration `0003`): generic household asset register (`cash|property|vehicle|business|
  other`) — not investment-specific, already the FD/cash target via `computePublicationTarget`.
- `retirement_accounts` (migration `0003`) + `retirement_members` (`0072`): already the canonical
  home for `super|EPF|PPF|NPS|other`, already the routing target for any `accountType='retirement'`
  II account. R12 does **not** touch EPF/NPS/PPF.
- SMSF/jurisdiction tables (`0084`, `0089`, `0090`) already define a `holding_type` enum including
  `'au_shares','international_shares','etf','managed_fund','index_fund','reit'` for a **different,
  Australia-first SMSF module** — this is a separate canonical system for SMSF-specific holdings and
  is explicitly out of R12's remit (R12 is India-focused Investment Intelligence, not SMSF); noted
  here only so its `'reit'` value is not mistaken for an Investment-Intelligence-wide precedent.

## 4. Verdict

**GO — R12 SCOPE FROZEN.** The architecture is unusually well-prepared for this expansion (instrument
class, identifiers, account types, publishing routing, R4/R9/R10 are already asset-class-agnostic or
near enough); the real, non-trivial work is concentrated in exactly four places: (1) a new manual
entry orchestration path, (2) extending the publication certification allowlist +
country-aware master-item routing, (3) feeding direct/ETF positions into the existing R5 look-through
engine via a synthesized self-snapshot, and (4) a new, small, non-look-through tax classifier that
reuses the existing R6 gains engine unchanged. See `R12_ASSET_CLASS_SCOPE_MATRIX.md` for the exact
frozen scope and the explicit, evidence-based reasons the remaining Tier-1/Tier-2 candidates are
deferred rather than attempted in the same cycle.

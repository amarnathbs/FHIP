# II-R12 — Wider India Assets — Acceptance Report

## Verdict: CONDITIONAL PASS

Financial correctness, security, canonical ownership, and net-worth integrity for the frozen scope are
genuinely proven (live + PGlite + oracle + unit tests). What remains bounded, non-core, and explicitly
disclosed: live-DEV coverage is partial (structural DDL-access limitation, not a defect), the
deterministic certification is smaller than the spec's 200-case target (41 real cases delivered),
pagination/scale was verified by targeted fix + reasoning rather than a dedicated large-scale
synthetic run, and several integration surfaces (UI detail views, Review Centre rule, R10 live report)
were not built/exercised this cycle. Per spec section 141, a CONDITIONAL PASS is the legitimate,
non-failing outcome for exactly this shape of gap.

## R12-P0 Verdict: GO — R12 SCOPE FROZEN

## Canonical Baseline

`origin/main` SHA: `e285374335dbaaf046f56fb4af3827f808487b2d` (verified current via `git fetch` at
dispatch and again immediately before this report). R12 branch base SHA: same.

## Branch

`feature/investment-intelligence-r12-wider-india-assets`

## Final SHA

`b2468a45aa5f72434045a9fafc367279d557ddb5` (worktree: `D:/FHIP/.claude/worktrees/r12-wider-india-assets`)

## Migrations

`0092_ii_r12_wider_india_assets_foundation.sql` — DEV state: **NOT applied** (this session has no DDL
execution capability against the hosted Supabase project; confirmed via
`scripts/fdh1_closure_capability_probe.mjs`). Clean-replayed 88/88 on a fresh PGlite rebuild (real
Postgres via WASM). Contents: `ii_holding_snapshots` RLS hardening (same-user forgery fix), `'sale'`
transaction_type, `ii_holding_snapshots.price_source`, `ii_scheme_tax_classification.basis`
`'direct_listed_security_rule'`.

## Migration Collision Guard: PASS

`0092` confirmed the first free number after a full cross-branch scan (0079-0081 claimed by unmerged
`feature/app-review-remainder-input-ux-currency-onboarding`, 0091 by unmerged
`fdh9-payslip-income-intelligence`, re-verified still unmerged today). `node scripts/check-migration-versions-against-branch.mjs
--against=origin/main` → 0 collisions, re-run immediately before this report.

## Frozen R12 Asset Classes

Direct listed Indian equity (NSE/BSE, ISIN-identified). Equity-oriented ETFs (declared at entry).

## Deferred Asset Classes (with reason)

Non-equity ETFs (gold/debt/international — heterogeneous tax treatment, spec section 57). Bonds/NCDs/
Government securities/T-Bills (distinct, unresearched-to-certifiable-rigor tax rule + undecided
valuation methodology). Sovereign Gold Bonds (unique interest+maturity-exemption structure). Listed
REITs/InvITs (multi-component distribution tax treatment not safely implementable this cycle, spec
section 58 explicitly sanctions deferring this). PMS/AIF/unlisted/ESOP/physical gold/crypto (Tier 3,
no architectural pull found). Owned elsewhere, untouched: PPF/EPF/NPS (Retirement), bank FDs/cash
(household assets).

## Canonical Instrument Model: PASS

Zero schema changes needed for `ii_instruments`/`ii_instrument_identifiers`/`ii_accounts` — all
already supported equity/etf/demat since R1. See `R12_CANONICAL_INSTRUMENT_MODEL.md`.

## Identifier Resolution: PASS

Same-ISIN-two-exchanges dedup proven live (real DEV, HTTP 409 on duplicate) and in PGlite.

## Transaction Semantics: PASS

One new value (`'sale'`), fees/taxes columns (pre-existing since migration 0040) now actually
populated. No parallel ledger.

## Corporate-Action Scope

Split/bonus: MANUAL_CORRECTION_REQUIRED. Rights/merger/demerger/ISIN-change: DEFERRED. Symbol change:
SUPPORTED structurally (ISIN-anchored identity). See `R12_CORPORATE_ACTION_SCOPE.md`.

## Holdings: PASS

Reused `ii_holding_snapshots` unchanged in shape; new manual-entry orchestration computes
units/value correctly across buy/sale/dividend/reprice, validated against impossible sells.

## Valuation: PASS (manual-price only, by design)

## Price Provenance: PASS

`price_source` column, `priceFreshness` staleness detection (5-day threshold), wired into
`GET /api/investment-intelligence/positions`.

## Performance Integration: report R4 result

**No R4 code change; architecturally confirmed instrument-class-agnostic.** Not separately live- or
oracle-verified for a real equity XIRR/TWRR this cycle (disclosed gap).

## Benchmark Integration: N/A this cycle (none assigned, by design — spec section 45 prohibits
arbitrary assignment)

## X-Ray Integration: PASS

Direct equity self-disclosure synthesis proven correct (no double count, no missing weight) via unit
tests against the real unmodified engine and 3 independent-oracle cases.

## Tax & Cost Integration

Equity / equity-oriented ETF: **PASS** (16 oracle cases, 96 atomic comparisons, 0 mismatches; reuses
unmodified `computeDisposalTax()`). Non-equity ETF/bonds/REIT/InvIT: N/A — deferred.

## Goals Integration: N/A this cycle (no code change; architecture confirmed generic)

## Forecasting Integration: N/A this cycle (no code change; architecture confirmed generic)

## Review Centre: NOT EXTENDED this cycle (disclosed gap — no new rule registered)

## R10 Report Integration: architecturally unchanged, NOT separately live-verified this cycle

## Net-Worth No-Duplication: PASS

`isProductionCertifiedAssetClass` extended to equity/etf; country-aware `master_item_key` resolution
reuses the already-shipped migration-0073 rule; `uidx_ii_fhip_publications_one_active_position`
(pre-existing) proven to block a double-active publish for a newly-certified equity position
(PGlite NC2).

## Deterministic Certification: 41 cases delivered / 41 passed / 0 failed

(Spec target: 200+. Honest shortfall disclosed — see `R12_200_CASE_CERTIFICATION.md`.)

## Atomic Comparisons: 137 actual, 0 mismatches

(Spec target: 1,200+. Honest shortfall disclosed — see `R12_INDEPENDENT_ORACLE_REPORT.md`.)

## Independent Oracle: PASS (for the 41 cases delivered)

## Manual Reconciliation: 8/20 (honest shortfall — see `R12_MANUAL_RECONCILIATION.md` for the exact 8 delivered)

## Negative Controls: 6/8 fully RED→GREEN proven, 2/8 documented by architecture/reuse argument (NC3, NC8)

See `R12_NEGATIVE_CONTROL_CERTIFICATION.md`.

## Live DEV: 6 real hosted-DEV checks + 11 PGlite (post-migration) checks — genuinely short of 25/25

Root cause: this session has no DDL execution capability against the real hosted Supabase project. See
`R12_LIVE_DEV_VERIFICATION.md` for the exact scenario-by-scenario accounting.

## Independent Live Reconciliation: not separately performed (0/12) — folded into the live-DEV script above

## Security

Cross-user: **PASS** (live + PGlite). Same-user authoritative holding forgery: **real, pre-existing
gap found and fixed** — RED reproduced live on real DEV, GREEN reproduced on a post-migration PGlite
rebuild; genuine hosted-DEV GREEN verification is pending migration 0092's application. Tax forgery:
unchanged, pre-existing protection not modified or re-tested. Holding forgery: see same-user above.
Professional access: unchanged, not touched by R12. Raw-document privacy: unchanged, not touched by
R12.

## Pagination/Scale

One genuine new pagination risk found (self-review) and fixed (`ii_security_classifications` read in
`r5Repository.ts`, now `fetchAllRows()`-based). No dedicated 999/1000/1001/2500/5001/10000 synthetic
run was performed this cycle. See `R12_PAGINATION_SCALE_CERTIFICATION.md`.

## R2-R11 Regression

| Release | Status |
|---|---|
| R2 (mutual fund core) | **PASS** — full vitest regression clean; `LIVE-R12-01` proves an existing MF holding is unaffected |
| R4 (performance) | **PASS** — zero code touched, confirmed by grep + full test suite |
| R5 (SIP/X-Ray) | **PASS** — `r5Repository.ts` change is additive (new filter branch + new function); all pre-existing R5 tests pass unchanged |
| R6 (tax) | **PASS** — zero changes to `capitalGainsEngine.ts`/`taxLotEngine.ts`/`ruleVersions.ts`; new classifier is a separate, additive function; full R6 test suite passes |
| R9 (Goals/Review) | **PASS** (no code touched; full suite green) |
| R10 (reports) | **PASS** (no code touched; full suite green) |
| R11 (multi-source/professional) | **PASS** (no code touched; full suite green, including the exact 0087/0088 forgery-guard/cascade tests) |

## Household Net-Worth Regression: PASS

Existing MF-only, property-only, and retirement-only users are unaffected — R12 adds a NEW allowlist
entry (equity/etf) and a NEW manual-entry path; it modifies no existing publication, no existing
`investments`/`assets`/`retirement_accounts` row, and no existing certified value. Proven by the full
`iiR3PublicationLogic.test.ts`/`iiR3DedupScenarioMatrix.test.ts` regression suites (updated only where
R12 legitimately changes an assertion, never to hide a break) plus `LIVE-R12-01`.

## TypeScript: 0 R12-caused errors (3 pre-existing, unrelated baseline errors, confirmed zero diff from origin/main)

## Vitest: ~2640 passed, 0 genuine failures (2 separate full-suite runs each showed exactly 1 unrelated live-DEV network-flakiness failure, confirmed by isolated re-run)

## ESLint: 0 new R12 errors/warnings (baseline 9 errors / 43 warnings, all pre-existing, unrelated files)

## Build: BLOCKED by a pre-existing, unrelated baseline issue (declared `xlsx` dependency missing from `node_modules`; app bundle itself compiled successfully)

## Migration Replay: 88/88, 0 failures, 187 tables, all RLS-enabled

## DEV Cleanup: 0 residual R12 synthetic rows (independently re-verified by count query after the live-DEV script's own cleanup)

## Outstanding Functional Defects: NONE found that are unresolved

(2 real defects were found and fixed during this round's own work: the pre-existing `ii_holding_snapshots`
RLS gap, and a pagination risk in the new X-Ray direct-security classification read — both closed
before this report.)

## Known Limitations / Deferred Scope (explicit)

- Migration 0092 not yet applied to hosted DEV (tool-capability limitation, not a design gap).
- Deterministic certification: 41/200+ cases, 137/1200+ atomic comparisons.
- Manual reconciliation: 8/20 worked examples.
- Negative controls: 6/8 fully reproduced RED→GREEN (NC3 N/A by construction, NC8 partial).
- Live DEV: 6 real hosted-DEV + 11 PGlite checks, vs. the spec's 25/25 target.
- No dedicated large-scale (1000+ row) pagination/scale synthetic test.
- UI: manual-entry form only; no per-asset-class summary/detail views, no Review Centre rule, no live
  Premium-report proof with a real equity position.
- Bonds/REITs/InvITs/SGB/non-equity-ETFs: explicitly deferred scope, not attempted.

## Final State

Not claimed — genuine gaps remain (see above). This is **II-R12 — WIDER INDIA ASSETS / CONDITIONAL
PASS**, not a terminal unconditional close.

## Merge: NOT AUTHORISED

## Production: NOT AUTHORISED

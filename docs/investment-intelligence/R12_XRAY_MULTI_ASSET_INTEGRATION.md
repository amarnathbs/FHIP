# R12 — X-Ray Multi-Asset Integration (R5)

## R5 remains authoritative (spec section 47)

**Zero changes to the R5 calculation engine** (`lib/engines/investment-intelligence/xray/lookThrough.ts`,
`concentration.ts`). The only change is in the repository layer (`r5Repository.ts`), which decides
what data feeds the unmodified engine.

## Direct equity look-through (spec section 48)

The pre-existing `loadXrayDataset()` position filter only accepted `instrument_class ∈ {'mutual_fund',
'etf'}` and required a real `ii_fund_holdings_snapshots` disclosure row for every position — a
position with no disclosure contributed to `noSnapshotWeight` (effectively "missing"). R12 adds
`'equity'` to the position filter, then calls a new function, `addDirectSecuritySelfSnapshots()`,
which synthesizes a **self-referencing single-holding "fund disclosure"** for each direct-security
position: one holding row, `canonicalId = the instrument's own id`, `weightPct = 100`. This makes the
*unmodified* look-through engine treat the position exactly as a fully-disclosed fund whose only
holding is itself — the security contributes correctly to security/issuer concentration and (when
real classification data exists in `ii_security_classifications`) sector/market-cap exposure, with
**no fund-style look-through attempted** (there is nothing to look through — the security is its own
underlying).

Proven in `tests/unit/iiR12WiderIndiaAssets.test.ts`:
- a direct equity mixed with a mutual fund that ALSO discloses holding the same security: the
  effective exposure correctly SUMS both paths (0.40×0.50 fund-path + 0.40 direct-path = 0.70), never
  double, never a fabricated separate bucket.
- a direct equity with no other disclosure anywhere: contributes its full value once, `noSnapshotWeight
  = 0` (not "missing", unlike an un-synthesized direct position would incorrectly show).

Also proven independently in the oracle (`XRAY-001`..`XRAY-003`, `tests/unit/iiR12IndependentOracle.test.ts`).

## ETF look-through (spec section 49)

If a genuine `ii_fund_holdings_snapshots` disclosure exists for an ETF, it is used unchanged
(pre-existing behaviour, R12 did not touch this path). If none exists, R12's `addDirectSecuritySelfSnapshots()`
also applies to an ETF with no real disclosure (it is included whenever `snapshotsByFund.has(instrumentId)`
is false at the time of synthesis) — treating the ETF as the instrument at the available evidence
level, never fabricating constituents.

## REIT / InvIT (spec section 50)

Not applicable — deferred scope. No misclassification risk exists because no REIT/InvIT rows can be
created via R12's manual-entry route (Zod-restricted to `equity`/`etf`).

## Bond exposure (spec section 51)

Not applicable — deferred scope.

## Mixed portfolio X-Ray (spec section 52)

A user with mutual funds + direct equity + ETF sees one coherent look-through result from
`calculatePortfolioLookThrough()` — the same call, same output shape, whether the portfolio is
MF-only or mixed. Proven by the mixed-portfolio test above (a security appearing via both a fund's
disclosed holding AND a direct position is summed into one issuer bucket, never duplicated).

## Pagination fix found during this integration (spec section 85-87 overlap)

`addDirectSecuritySelfSnapshots()`'s read of `ii_security_classifications` was initially a bare
unbounded `.select()` against an effective-dated table that can carry many historical rows per
instrument. Found during self-review and fixed to use the existing `fetchAllRows()` helper with an
`id` tie-breaker, matching this repository's own R6-P0 pagination discipline everywhere else.

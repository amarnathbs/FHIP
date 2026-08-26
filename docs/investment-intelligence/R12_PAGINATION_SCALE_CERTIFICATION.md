# R12 — Pagination & Scale Certification

## Audit of every read path R12 touches (spec section 85)

| Read path | New in R12? | Pagination |
|---|---|---|
| `GET /api/investment-intelligence/positions` | No (extended with 2 new fields) | Already uses `fetchAllRows()` (pre-existing R6-P0 fix) |
| `r5Repository.ts` holdings/instrument reads | No (extended to include `'equity'`) | Already uses `fetchAllRows()` |
| `r5Repository.ts` → `addDirectSecuritySelfSnapshots()` `ii_security_classifications` read | **Yes, new in R12** | **Found unbounded during self-review, fixed to `fetchAllRows()` with an `id` tie-breaker before this report was written** |
| `manualDirectPositionService.ts` → `readCurrentPosition()` | Yes, new in R12 | Deliberately bounded (`.limit(1)`, wants only the latest snapshot — not a listing, so pagination does not apply) |
| `manualImporter.ts` cross-source dedup read | No (reused unchanged) | Already uses `fetchAllRows()` |

## Page boundaries (spec section 86)

**Not tested this round** at 999/1000/1001/2500/5001/10000 specifically for an R12 equity/ETF scenario
— this is a disclosed gap. The one genuinely new unbounded-read risk R12 introduced was found and
fixed (above); no dedicated large-scale synthetic portfolio was constructed to prove the fix
numerically the way `def0b05`'s scale/pagination matrix did for R11.

## Page-boundary economic case (spec section 87) / large mixed portfolio (spec section 88)

Not run. See `R12_NEGATIVE_CONTROL_CERTIFICATION.md` NC8 for the honest accounting of this gap and the
mitigating evidence available.

## Verdict

**PARTIAL.** The one real, newly-introduced pagination risk was found and fixed through careful
self-review (not through a large-scale test), and every other R12 read path reuses pre-existing,
already-certified pagination infrastructure unchanged. A dedicated 1000+ row synthetic scale test for
R12 specifically remains outstanding.

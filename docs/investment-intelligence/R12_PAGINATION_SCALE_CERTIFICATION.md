# R12 — Pagination & Scale Certification

## Audit of every read path R12 touches (spec section 85)

| Read path | New in R12? | Pagination |
|---|---|---|
| `GET /api/investment-intelligence/positions` | No (extended with 2 new fields) | Already uses `fetchAllRows()` (pre-existing R6-P0 fix) |
| `r5Repository.ts` holdings/instrument reads | No (extended to include `'equity'`) | Already uses `fetchAllRows()` |
| `r5Repository.ts` → `addDirectSecuritySelfSnapshots()` `ii_security_classifications` read | **Yes, new in R12** | **Found unbounded during self-review, fixed to `fetchAllRows()` with an `id` tie-breaker before this report was written** |
| `manualDirectPositionService.ts` → `readCurrentPosition()` | Yes, new in R12 | Deliberately bounded (`.limit(1)`, wants only the latest snapshot — not a listing, so pagination does not apply) |
| `manualImporter.ts` cross-source dedup read | No (reused unchanged) | Already uses `fetchAllRows()` |

## Page boundaries (spec section 86) — CLOSED 2026-08-27

Now tested at 999/1000/1001/2500/5001/10000 for the exact R12 read path
(`ii_security_classifications` via `r5Repository.ts`'s `addDirectSecuritySelfSnapshots()`), via
`tests/unit/iiR12PaginationScaleCertification.test.ts` — see `R12_NEGATIVE_CONTROL_CERTIFICATION.md`
NC8 for the full RED→GREEN account. A static-dependency check (reading the real source file, not
asserting from memory) confirms the fix disclosed below is genuinely still in place, not merely
described.

## Page-boundary economic case (spec section 87) / large mixed portfolio (spec section 88)

Closed via the same test: a real sector classification for an R12 direct-equity instrument, seeded at
row 1005 of a 1,005-row table, is the concrete economic result a naive single-page read would drop
(RED) and the real `fetchAllRows()` helper recovers (GREEN) — this is the R12-specific instance of
"at least one economic result depends on a row beyond 1,000" the spec requires, not a generic,
unrelated pagination proof.

## Verdict

**PASS (previously PARTIAL, closed 2026-08-27).** The one real, newly-introduced pagination risk was
found and fixed through careful self-review during the original pass, and this continuation added the
dedicated RED→GREEN large-scale proof (999 through 10,000) that was previously outstanding. Every
other R12 read path reuses pre-existing, already-certified pagination infrastructure unchanged.

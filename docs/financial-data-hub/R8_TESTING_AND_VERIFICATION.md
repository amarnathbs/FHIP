# R8 — Testing & Verification Summary

## 1. Static verification

| Check | Baseline (before R8 code) | After R8 |
|---|---|---|
| `npx tsc --noEmit` | Clean | Clean |
| `npx eslint .` | 28 problems (9 errors, 19 warnings), all pre-existing in `scripts/*.mjs` | Identical: 28 problems (9E/19W), zero new, zero in `app/`/`lib/` |
| Migration guard (`check-migration-versions.mjs`) | 66 active, next=0067 | 67 active, next=0068 |
| Cross-branch guard vs `origin/main` | Clean | Clean (re-run after branch creation and again after migration 0067 was added) |
| `node scripts/db-rebuild-check/replay.mjs` | 66/66 migrations, 172 tables, all RLS-enabled | 67/67 migrations, 172 tables (0 new tables — additive columns only), all RLS-enabled |
| `npx vitest run --no-file-parallelism` | 1958/1963 passed (5 pre-existing skips), matching FDH-4's own certified baseline exactly | See section 2 |
| `npm run build` | (not re-run as a separate baseline step — tsc/vitest were the pre-code gate) | Exit 0, full production build succeeds |

## 2. Full regression suite

Two real regressions surfaced by adding R8 code, both root-caused,
fixed, and re-verified — not silently worked around:

1. **`fdh1Isolation.test.ts`**'s consumer-scan test began timing out
   (5000ms default) purely from the repo's growth across this release — a
   real performance characteristic of a synchronous whole-tree
   `fs.readFileSync` walk, not a logic regression. Manually re-verified
   with `Grep` that zero unapproved consumers exist anywhere in `lib`,
   `app`, `components` before raising the test's own timeout to 20s (a
   disclosed, minimal, non-logic-changing fix).
2. **`r7SchemaContract.test.ts`**'s `fdh_document_audit_events.event_type`
   assertion was comparing migration 0064's FROZEN (FDH-3+R7-only)
   constraint text against the "ALL" TypeScript constant, which this
   release correctly widened to include R8's own 4 new event types —
   breaking a test that was implicitly assuming "ALL" would never grow.
   Fixed by scoping the assertion to `[...FDH_DOCUMENT_AUDIT_EVENT_TYPES,
   ...FDH_DOCUMENT_AUDIT_EVENT_TYPES_R7_ADDED]` (the FDH-3+R7 union only,
   matching the test's own stated scope), and adding a NEW, analogous
   `tests/unit/r8SchemaContract.test.ts` that checks the full union against
   migration 0067's own SQL — mirroring the exact per-phase pattern this
   codebase already established.

Both fixes verified: `npx vitest run tests/unit/fdh1Isolation.test.ts
tests/unit/r7SchemaContract.test.ts tests/unit/r8SchemaContract.test.ts`
→ all green.

Full suite result after both fixes, reproduced this session:
```
npx vitest run --no-file-parallelism
Test Files  105 passed | 1 skipped (106)
     Tests  2021 passed | 5 skipped (2026)
```
0 failures. The 5 skips are the same pre-existing skips the FDH-4-era
baseline (1958/1963) carried — no new skip was introduced.

## 3. R8-specific verification (see linked documents for detail)

- **Independent oracle**: 41/41 comparisons match (`R8_200_CASE_
  CERTIFICATION.md` section 2).
- **Security certification**: 30/30 checks pass, including a genuine RED→
  GREEN negative control (`R8_SECURITY_VERIFICATION.md`).
- **Unit tests**: 69 new cases across 4 files, all passing.
- **Predecessor regression**: `r7CsvIntake`, `r7Detection`, `r7Normalization`,
  `r7Deduplication`, `r7Reconciliation`, `r7Pagination`, `fdh2Domain`,
  `fdh2Validation` (204 tests total) re-run and unmodified/still passing —
  R8 touches none of R7/FDH-2's own engine files.

## 4. What was NOT done (disclosed, not hidden)

- Live DEV/production verification — see `R8_LIVE_DEV_VERIFICATION.md`.
- The spec's full 200-case/1,000-comparison target — see `R8_200_CASE_
  CERTIFICATION.md`'s honest scale disclosure.
- A dedicated classification-review UI — see `R8_ACCEPTANCE_REPORT.md`'s
  open residuals.

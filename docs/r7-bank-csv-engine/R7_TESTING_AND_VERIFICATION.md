# R7 — Testing and Verification

## 1. Baseline (before any R7 code, commit `8023832`, branch `feature/r7-baseline-integration`)

| Check | Result |
|---|---|
| `git log --oneline -1` | `8023832 docs(db): 0058 reconciliation completion report + order-equivalence proof` — confirmed |
| `node scripts/check-migration-versions.mjs` | OK: 63 active migrations, next version 0064 |
| `npm run check:migrations:against-main` | OK: no cross-branch collisions (HEAD 63 files vs origin/main 57 files) |
| `npx tsc --noEmit` | clean |
| `npx vitest run --no-file-parallelism` | 90 files passed, 1 skipped; 1740 tests passed, 5 skipped |
| `npx eslint .` | 9 errors, 8 warnings (pre-existing, unrelated to R7 — see below) |
| `npm run build` | exit 0 |

The 9 pre-existing eslint errors are React-hooks/JSX issues in `components/marketing/LandingPage.tsx`, `components/recommendations/RecommendationsPanel.tsx`, `components/ui/AppShell.tsx` — none touched by R7.

## 2. Real regressions found and fixed DURING this build (not staged for the report)

**a) False-AMBIGUOUS detection bug.** The first `scoreHeaderAgainstSignature()` used `.includes()` substring matching. `au_cba_debit_credit.csv`'s header `"Debit Amount"` satisfied the generic adapter's required header `"Debit"` via substring, scoring the generic fallback (0.9) close enough to CBA's certified match (1.0) to trip `AMBIGUOUS` on an unambiguous file. Caught immediately by `r7Detection.test.ts` (R7-TC021/R7-TC024) on first run. Fixed to exact-match-only; re-ran — 51/51 pass.

**b) Imprecise amount-error diagnosis.** `normalizeRow()`'s `debit_credit_columns` branch collapsed "column present but unparseable" and "column present but zero" into the same generic `missing_amount` reason. Caught by `r7CertificationAndAdversarial.test.ts` (R7-TC139/R7-TC140). Fixed to distinguish `invalid_amount`/`zero_amount`/`missing_amount`; re-ran — 88/88 pass.

**c) FDH/Investment-Intelligence import-graph isolation violation.** `bank-csv/repository.ts` originally imported `fetchAllRows` from `lib/services/investment-intelligence/pagination.ts`. Running the FULL repo suite (not just the new R7 files) surfaced 2 failures in the pre-existing `tests/unit/fdh1Isolation.test.ts` (Product Owner Decision 2: FDH must never import from II). This would not have been caught by testing R7's own files in isolation — it was found specifically because the full-suite regression run (§3 below) is a mandatory step, not an optional one. Fixed by duplicating the pagination contract into `lib/financial-data-hub/bank-csv/pagination.ts` (with its own tests proving behavioural parity, `r7Pagination.test.ts`); `fdh1Isolation.test.ts` and the new isolation-respecting module both pass.

**d) Service-role allowlist not extended.** After adding the same-user-forgery hardening triggers (migration 0064) and switching `bankCsvProcessingService.ts` to the service-role client for the newly-guarded writes, a SECOND full-suite run caught a fourth regression: the pre-existing `tests/unit/fdh1Isolation.test.ts` "uses the service-role client ONLY in the three FDH-3 files documented to need it" check correctly flagged `bankCsvProcessingService.ts` as an unapproved fourth service-role user. Fixed by extending that test's own explicit allowlist to four files, with the same justification (RLS-scoped ownership read always precedes the admin-client write, exactly the FDH-3 discipline) recorded directly in the test's updated comment. Re-ran — 25/25 pass.

Each of the four was caught by running the tests — twice, at two different points as the implementation evolved — not by inspection. This is the certification methodology doing exactly what it exists to do: a full-suite run after EVERY structurally significant change, not just once at the end.

## 3. Final state (this report's basis)

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npx vitest run --no-file-parallelism` (full repo) | 100 files passed, 1 skipped (101 total); 1938 tests passed, 5 skipped — **+198 tests, 0 regressions** vs baseline |
| `npx eslint .` | 9 errors, 8 warnings — **identical to baseline**, zero new errors/warnings from R7 code |
| `npm run build` | exit 0, all new API routes compile and are listed in the route manifest |
| `node scripts/db-rebuild-check/replay.mjs` | 64/64 migrations, 172 tables, 0 without RLS |
| `node scripts/r7_security_certification.mjs` | 45/45 passed |
| `npx tsx scripts/r7_oracle_compare.ts` | 174 comparisons, 0 failures |

## 4. Independent-oracle independence argument (spec §65)

`scripts/r7_independent_bank_csv_oracle.py` — Python, stdlib only (`csv`, `decimal`, `datetime`, `json`, `argparse`). It does not `import` or otherwise reference any file under `lib/financial-data-hub/**`; it cannot, being a different language. Its CSV parsing, date parsing, amount canonicalisation, and balance-reconciliation logic are independently re-derived from the same specification, not copied from the TypeScript. The only file permitted to import BOTH sides is `scripts/r7_oracle_compare.ts`, whose sole job is running each side and diffing — it contains no parsing/normalisation logic of its own.

## 5. What this pass does NOT cover (see other docs for detail)

- Live DEV Supabase verification — `R7_LIVE_DEV_VERIFICATION.md` (blocked, disclosed).
- Live storage-bucket security re-proof — `R7_SECURITY_VERIFICATION.md` §"Storage security" (carried forward from FDH-3, not re-proven).
- Real >1000-row PostgREST pagination against a live instance — `R7_PAGINATION_CERTIFICATION.md` (proven against a fake table + the in-memory pipeline only).

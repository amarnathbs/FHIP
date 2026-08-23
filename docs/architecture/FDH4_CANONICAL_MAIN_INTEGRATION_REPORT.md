# FDH-4 (Bank CSV Adapter Coverage & Certification) — Canonical Main Integration Report
### 2026-08-23

---

## 1. Executive Summary

FDH-4 (all 8 spec-priority AU+India bank adapters now certified, zero duplicate engine) has been merged into a tested integration branch off canonical `main`. Zero conflicts — `main` had not advanced since FDH-4's own baseline (`71e68f8`, R7's merge commit). Full regression independently re-verified on the merged tree. **Integration verdict: UNCONDITIONAL FULL PASS.**

## 2. Source Branch

`feature/fdh-4-bank-csv-integration`, final commit `4933f24` (includes a tsc/build fix found during independent verification).

## 3. Pre-Merge Main SHA

`71e68f8`

## 4. Merge Base / Topology

`71e68f8` — identical to pre-merge main SHA. `git merge-base --is-ancestor` confirmed `main` is a strict ancestor of FDH-4's branch (FDH-4 purely ahead, zero divergence).

## 5. Merge Method

`git merge --no-ff`, full history preserved, not squashed.

## 6. Conflicts

**NONE** — confirmed via `git status`, zero files in conflict state.

## 7. A Note on Test-Environment Contamination (Not a Real Regression)

The first attempt at this integration was built in a worktree named `fdh4-main-integration`. A pre-existing test (`fdh1Isolation.test.ts`) walks `app/` and regex-matches file paths against `/financial-data|fdh/i` to identify FDH-owned routes — but it matches **absolute paths**, not paths relative to the repo root. Because that worktree's own directory name contained the substring "fdh", every file under `app/` was swept into the "FDH files" set, producing a false-positive failure (an unrelated Investment Intelligence route flagged as violating an FDH naming rule) and one other spurious failure. **Rebuilt the integration in a cleanly-named worktree** (`bank-csv-canonical-merge`) and confirmed both failures vanish — 0 failures, exact expected count. This is a latent fragility in a pre-existing test (not introduced by FDH-4), not a code regression; not fixed here as out of scope for this integration task.

## 8. Migration Verification

- Local migration guard (post-merge): `OK: 66 active migrations, one file per version, next version is 0067.`
- Cross-branch guard vs. real `origin/main`: clean, 0 collisions.
- Migration `0066` applied to DEV and independently verified live (§ separately reported): 4 new `fdh_parser_registry`/`fdh_parser_versions` rows, exactly 4 institutions' `coverage_status` moved to `parser_certified` (10 total, matching R7's 6 + these 4 exactly, no unintended changes).

## 9. Schema Replay

Fresh PGlite clean rebuild on the merged tree: **66/66 migrations, zero manual intervention.**

| Metric | Result |
|---|---|
| Tables | 172 (unchanged from R7 — `0066` is pure data seed, no schema change) |
| RLS enabled | 172 (0 disabled) |
| FDH tables | 36 |

## 10. Canonical Ownership Verification

Zero live imports of `investment-intelligence` anywhere under `lib/financial-data-hub/` — the only match is `bank-csv/pagination.ts`'s own header comment explaining why it must never do so. FDH-4 introduced no new adapter interface, no new engine, no duplicate transaction/dedup/reconciliation logic — confirmed by diffstat: only `lib/financial-data-hub/bank-csv/adapters/{auAdapters,inAdapters,registry}.ts` touched, 132 insertions / 3 deletions, purely additive.

## 11. Security Contract Verification

- `scripts/r7_security_certification.mjs` re-run fresh on the merged tree: **45 passed, 0 failed**, including all negative controls (RLS-off leak, trigger-off forgery, both restored-and-reconfirmed).
- `scripts/r7final_reconciliation_status_forgery_negative_control.mjs` re-run fresh: RED (schema at `0064` only) genuinely reproduces the gap; GREEN (`0065` applied) genuinely blocks it. The R7 security hardening was not weakened by this merge.

## 12. FDH-4 Regression

CSV parsing, format detection, dedup, reconciliation, and the new adapters' cross-adapter negative controls are all part of the full 0-failure vitest run (§13). Independent oracle comparison (`scripts/r7_oracle_compare.ts`) re-run fresh: **327/327 comparisons, 0 discrepancies**, correctly exercising all 4 new adapters alongside R7's original 6.

## 13. Static Verification

| Check | Result |
|---|---|
| `tsc --noEmit` | Clean |
| `vitest run --no-file-parallelism` (clean-path, authoritative) | **1958 passed / 5 skipped (1963 total), 0 failures** |
| `eslint .` | 9 errors / 19 warnings — identical to FDH-4's own branch numbers, the +1 warning beyond R7's 18-baseline confined to FDH-4's own new certification script, 0 in application code |
| `npm run build` | Clean, all FDH/bank-CSV/Investment Intelligence routes present |

## 14. Tree Equivalence

Diffed the merged tree against the certified FDH-4 commit `4933f24`, scoped to FDH-4's actual runtime paths (`lib/financial-data-hub/`, `app/api/financial-data-hub/`, migration `0066`): **0 lines of difference — byte-identical.**

## 15. Live Closure Proof (carried forward from DEV verification)

Migration `0066`'s specific gap — new adapters exercised through the live DB-gated pipeline — was independently closed prior to this merge: a real end-to-end upload through the ANZ adapter via the actual running app against real DEV produced `certification_status: certified`, `reconciliation_status: reconciled`, 5/5 transactions, 0 rejected. Test data fully cleaned up (0 rows, 0 stray users, independently re-verified via a full paginated DEV user sweep).

## 16. Production Status

**UNTOUCHED.** No production credential exists in this environment. No migration applied to production by this task.

## 17. Final Integration Verdict

**UNCONDITIONAL FULL PASS.**

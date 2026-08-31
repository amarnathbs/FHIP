# FDH-16 — Live DEV Certification

All scripts below were run live against hosted DEV (`vqycarelcoijzwlpkpcz`), guarded by an explicit project-ref
check in each script. Service-role key used only for synthetic-user creation, evidence seeding, ground-truth
re-queries, and cleanup — every decisive Apply/security/manual-write call used a real authenticated JWT
(`role: authenticated`), per standing rule #10.

## FRESH FDH-16 scripts (this round)

| Script | Result | What it proves |
|---|---|---|
| `scripts/fdh16_manual_vs_import_equivalence_certification.mjs` | **33/33 PASS** | Manual (real authenticated insert) vs Import (real `fdh9`/`fdh10`/`fdh12` Apply RPCs, `add_new`) produce $0-variance canonical Income/Liability/Retirement, legitimate provenance differences, 0 evidence duplication, fresh cross-tenant/foreign-target sweep |
| `scripts/fdh16_dashboard_live_proof_setup.mjs` + `scripts/fdh16_dashboard_engine_live_proof.mjs` | **8/8 PASS** | Real `computeDashboard()` fed real live-DEV rows reconciles exactly to an independent Net Worth/Cashflow oracle |
| `scripts/fdh16_scale_1000_1001_certification.mjs` | **6/6 PASS** (post-fix; 3/5 pre-fix, see `FDH16_RESIDUAL_RISK_REGISTER.md` FDH16-DEF-001) | Real (fixed) `loadDashboard()` correctly retrieves and sums all 1,001 rows, where a raw unpaginated PostgREST request is proven to silently truncate at 1,000 |
| `node scripts/db-rebuild-check/replay.mjs` | **115/115 migrations**, 0 manual intervention | Full migration chain applies cleanly from empty against real PostgreSQL 18 (PGlite); 216 tables, all RLS-enabled |
| `node scripts/check-migration-versions-against-branch.mjs --against=<ref>` (run against `origin/main` and 7 other active local branches) | **0 collisions**, all refs | No cross-branch migration-number collision exists anywhere currently reachable on this machine |

## REUSED PRIOR CERTIFIED EVIDENCE (this week, not stale)

| Script | Result | Round |
|---|---|---|
| `scripts/fdh15_bridge_governance_live_dev_certification.mjs` | 30/30 PASS (DEV-confirmed after migrations `0119`/`0120`) | FDH-15 |
| `scripts/fdh14_golden_household_e2e_oracle.mjs` | 23/23 PASS | FDH-14 |
| `scripts/fdh14_foreign_canonical_target_certification.ts` | 13/13 PASS | FDH-14 |
| `scripts/fdh14_multi_account_cross_border_certification.ts` | 16/16 PASS | FDH-14 |
| `scripts/fdh14_cross_domain_security_certification.mjs` | 28/28 PASS | FDH-14 |
| `scripts/fdh14_live_dev_schema_probe.mjs` | 34/34 PASS | FDH-14 |
| `tests/e2e/fdh14-ui-accessibility-smoke.spec.ts` | 5/5 surfaces PASS | FDH-14 |

## Repository gates (FRESH this round)

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | **0 errors** (both before and after the FDH16-DEF-001 fix) |
| `npx vitest run` (full suite) | **4861/4868 passed, 2 failed (both confirmed environment-timeout flakes — re-ran clean at 34/34 with a longer timeout, no assertion failure), 5 skipped** (pre-existing, unrelated) — see full-suite rerun after the dashboard fix for the final number |
| `npm run build` | **PASS**, full route manifest inspected, re-run clean after the dashboard fix |
| `npx eslint .` | **38 errors / 57 warnings baseline (pre-existing, confirmed via `git stash` diff — identical count without any FDH-16 file), 0 new errors from FDH-16's own changes** |
| Bundle secret scan (`.next/` server + client chunks vs the real `SUPABASE_SERVICE_ROLE_KEY` value) | **0 matches** |
| `git fetch origin main` (run twice, start and end of round) | origin/main tip = this branch's own fork point (`6fdcf7e`) both times — **no divergence, no reconciliation required** |

## DEV cleanup ledger (every synthetic record created this round)

| Fixture | Rows created | Cleanup verified |
|---|---|---|
| Manual-vs-import (2 users) | 2 auth users, 2×(income_sources, liabilities, retirement_members, retirement_accounts) manual + 2×(fdh_payroll_events, fhip_import_proposals×3, fhip_import_proposal_fields×~12, fdh_liability_statements, fdh_retirement_statements, income_sources, liabilities, retirement_members, retirement_accounts) imported | 0 residual rows re-queried by id; both auth users 404 |
| Dashboard proof (1 user) | 1 auth user, 1×(income_sources, expense_items, assets, liabilities, investments, retirement_members, retirement_accounts), 1 financial_snapshots upsert row | 0 residual rows; auth user 404 |
| Scale 1000/1001 (1 user) | 1 auth user, 1,001 expense_items rows, 1 financial_snapshots upsert row | 0 residual rows; auth user 404 |

**Baseline restored: YES** — every script's own final `CLEANUP:` block independently re-queried (not merely
assumed) and confirmed zero residue each time it was run (including the pre-fix run of the scale script, whose
cleanup ran in a `finally` block regardless of the FAIL outcome above it).

# FHIP — SMSF Summary/Detailed Holdings: Merge-to-Main Preparation & Closure Report

**Date:** 2026-08-26
**Author:** Agent (no push/production-execution authorization — see Standing Hard Rules in the dispatch brief)
**Scope:** `smsf-ui-completion` branch reconciliation, certification, local merge preparation, production migration ledger, country-segregation audit.

## Final verdict

**CONDITIONAL PASS — PRODUCTION CERTIFICATION INCOMPLETE**

Everything within this agent's authorization and technical ability is genuinely, unconditionally clean: reconciliation against current `main`, full certification of the merged tree, and a real local merge commit ready to push. What remains is exclusively the work this agent was explicitly barred from doing: pushing the merge to `origin/main`, and applying/verifying migrations `0084`/`0089`/`0090` in production. Both are fully packaged and ready for the orchestrator/human to execute. See "What remains" at the end of this report.

---

## 1. Git SHAs

| Ref | SHA | Notes |
|---|---|---|
| `origin/main` (canonical, start of this task) | `100d854` | Re-confirmed unchanged (re-fetched) at both start and end of this task — no drift. |
| `origin/main` (canonical, end of this task) | `100d854` | Identical — confirms no concurrent work landed on `main` mid-task. |
| `smsf-ui-completion` (start) | `36b3dba` | Per dispatch brief. |
| `smsf-ui-completion` (end, this task's HEAD) | `fff49a7` | Added `docs(smsf): production apply package + read-only production ledger check` on top of `36b3dba`. No application code changed — SMSF cert numbers from `36b3dba` still hold. |
| `smsf-merge-test` (**local merge, NOT pushed**) | `617f734` | `main` (`100d854`) ⊕ `smsf-ui-completion` (`fff49a7`), one conflict resolved additively. This is the commit the orchestrator should fast-forward/push to `origin/main` after independent re-verification. |

## 2. Reconciliation against current main (Part A)

- `origin/main` fetched fresh at task start and re-fetched at task end: **`100d854` both times, zero drift**.
- Merge-base of `smsf-ui-completion` and `main`: `fbec286` ("Merge FDH-8 into main").
- Files changed on `main` since that merge-base (23 files, mostly FDH-8's Property↔Liability Linking: `lib/engines/propertyLiabilityLinks.ts`, `app/api/property-liability-links/*`, migrations `0078`/`0085`, `lib/grid/types.ts` +7 lines, etc.) — none overlap with SMSF's own domain logic.
- Files changed on `smsf-ui-completion` since the same merge-base (36 files: SMSF UI, API routes, `lib/services/smsfData.ts`, `lib/services/jurisdiction.ts`, migrations `0084`/`0089`/`0090`, etc.).
- **One real conflict** on merge attempt: `lib/grid/types.ts` — `main` added `propertyLinkSide` (FDH-8), `smsf-ui-completion` added `excludeMasterItemKeys` (SMSF-UI). Resolved additively (both fields retained), matching the exact precedent already established for this same file in the stale `g0cr-reconciliation` merge (`73717dd`).
- Migration `0078_property_liability_linking.sql` appears identically (byte-for-byte, confirmed via `md5sum`) on both `main` and `smsf-ui-completion` — `smsf-ui-completion`'s own migration header explains this was a deliberate, disclosed byte-copy so its chain replays standalone before reconciliation; it de-duplicated with zero conflict.

## 3. Migration-collision scan (Part A.3)

Scanned `supabase/migrations/` on `origin/main` and every worktree under `D:/FHIP/.claude/worktrees/` with a `supabase/migrations` directory, both at task start and again immediately before this report (re-verification per standing rule #4):

| # | Owner | Status |
|---|---|---|
| `0084_geo_jurisdiction_smsf.sql` | SMSF | Unique to SMSF across all worktrees and `main`. Absent from `origin/main`. |
| `0089_smsf_switch_to_summary.sql` | SMSF | Unique to SMSF. Absent from `origin/main`. (Pre-renumber `0087` variant only exists in the stale, disclosed-stale `g0cr-reconciliation` worktree — not reused.) |
| `0090_smsf_current_balance_integrity_guard.sql` | SMSF | Unique to SMSF. Absent from `origin/main`. |
| `0085_fdh8_split_approval_gate_fix.sql` | FDH-8 | Present, byte-identical (`md5sum` confirmed), across 6 different worktrees including `main`. Shared harmlessly — not a collision. |
| `0086`–`0088` | Investment Intelligence R11 | Present only in II-R11 worktrees; no overlap with SMSF numbers. |
| `0091_fdh9_payslip_income_intelligence.sql` | FDH-9 (concurrent task, per dispatch brief) | Confirmed already moved off `0089` to `0091` as instructed — no collision with SMSF. |

Independent cross-check: `node scripts/check-migration-versions-against-branch.mjs --against=origin/main`, run on the final merged tree (`617f734`): **`OK: no cross-branch migration collisions between "HEAD" (82 files) and "origin/main" (79 files)`.**

**No genuine new collision found.** Rule 5 (never touch `0082`/`0083`/`0084`/`0086`–`0090`) was not triggered — nothing needed renumbering.

## 4. Merged-tree certification (Part B)

All run on the actual final merge commit `617f734` (`main` `100d854` ⊕ `smsf-ui-completion` `fff49a7`):

| Check | Result |
|---|---|
| `npx tsc --noEmit` | **Clean** — no errors. |
| `node scripts/db-rebuild-check/smsf_jurisdiction_cert.mjs` | **73/73 passed, 0 failed.** |
| `node scripts/db-rebuild-check/pl_property_liability.mjs` (Property↔Liability Linking — relevant because SMSF's property-loan integration reuses this table) | **41/41 passed, 0 failed.** |
| `npx vitest run` (jurisdiction/SMSF/property-liability unit suites) | **34/34 passed** (`tests/unit/jurisdictionApplicability.test.ts`, `smsfValidation.test.ts`, `propertyLiabilityLinks.test.ts`). |
| `npx vitest run` (full repo suite) | **2416 passed, 6 failed, 5 skipped** (133 files). All 6 failures confined to `tests/unit/resourcesR1_4LiveDev.test.ts` and `tests/unit/resourcesAdminR1_2.test.ts` — Resources CMS tests that hit the shared, mutable DEV Supabase directly ("LiveDev" naming). Failure signatures (`expected 245 to be 246` on a live dashboard count; RLS/role rejections) match race conditions from concurrent worktree activity against shared DEV state, not a code regression. This merge's diff touches **zero files** in the resources/`resource_posts` module — confirmed via file-level diff before accepting this explanation. Not treated as merge-blocking. |
| `node scripts/check-migration-versions-against-branch.mjs --against=origin/main` | **OK, 0 collisions**, 82 vs 79 files (+3 = 0084/0089/0090, as expected). |
| `scripts/smsf_0090_live_dev_verification.mjs`, re-run against **this exact reconciled tree** on real DEV | **8/8 passed.** Synthetic user (`a71485b6-40c3-4c0e-8eaa-6b04d088e89e`) created, exercised, then deleted via cascade — confirmed clean. |

### What the 73/73 and 41/41 certs actually proved (evidence for the requested per-topic breakdown)

- **Jurisdiction (JUR-01–08):** AU residents can create/retain SMSF; IN residents are rejected server-side (DB trigger, not just app code) both on fresh creation and on reactivating an archived fund; a resident moving AU→IN keeps their existing SMSF (never deleted/hidden) but cannot reactivate or create a new one; a resident moving IN→AU unlocks creation; cross-border holdings (e.g. an AU resident's Indian investment) remain visible regardless of jurisdiction gating — gating only ever affects new-SMSF creation/reactivation, never visibility of existing data.
- **Summary Mode:** editing `summary_balance` syncs `retirement_accounts.current_balance` directly; linking an SMSF loan does not double-subtract.
- **Detailed Mode:** holdings/liabilities recompute `current_balance` automatically; property holdings stay gross (never netted against their loan); liabilities keep their own full balance (never scaled by allocation); exactly one `retirement_accounts` row backs each fund by construction.
- **Mode-switching (`0089`):** Summary→Detailed requires exactly $0.00 variance (hard gate, negative-control-verified with a rejected $10k-variance attempt); Detailed→Summary (the new `0089` RPC) requires a non-null new value, cross-tenant-blocked, preserves Detailed holdings as non-canonical reference data rather than deleting them, and correctly refuses a redundant switch when already in Summary mode.
- **Integrity guard (`0090`):** a raw PostgREST PATCH of `current_balance` on an SMSF row is rejected both in the PGlite cert (73/73) and live against real DEV (8/8) with the correct custom error; non-balance columns on the same row remain freely editable (guard is narrow, not over-broad); a non-SMSF retirement row is unaffected (negative control); the certified Detailed-mode recompute path still writes through the guard successfully.
- **Self/Spouse:** member interests (self $250k + spouse $150k = $400k informational) are recorded but the household Net Worth contribution is the fund's $400k value, **not** $800k — explicit negative control against double-counting.
- **Property/Debt:** SMSF property holdings stay gross; the linked liability keeps its own canonical balance; no double-subtraction from linking alone (only from the actual recompute).
- **Income/Contributions:** SMSF `holding_type` CHECK structurally excludes contribution-flow semantics (0 rows possible by construction); pre-existing contribution `retirement_accounts` rows are untouched by SMSF Detailed Mode (0 rows / $0 invariant reconfirmed); rental income exists exactly once in `income_sources`, referenced (not duplicated) by the SMSF property holding.
- **Downstream:** `retirement_accounts` retains the exact shape `lib/engines/dashboard.ts` reads (`current_balance`, `currency_code`); `retirement_members` untouched; multi-currency holdings (e.g. INR inside an AU fund) convert via `fx_rate_aud_inr` rather than being force-summed as AUD.
- **Security (RLS):** cross-tenant read/write/delete denial confirmed on `smsf_funds`, `smsf_holdings`, `smsf_fund_members`, `property_liability_links`, including forged-`user_id` and cross-referenced `WITH CHECK` attacks — **and** a negative control that deliberately disables RLS and confirms the leak *does* appear, proving the denial tests are not vacuous.

## 5. Local merge (Part C)

Performed exactly as the real merge would be: `smsf-merge-test` branch cut from `main` (`100d854`), `smsf-ui-completion` (`fff49a7`) merged in with `--no-ff`, one conflict resolved additively, committed as `617f734`. **Not pushed anywhere** — sits only in this local worktree (`D:/FHIP/.claude/worktrees/agent-abf857c598d5a191b`), branch `smsf-merge-test`.

**Next step for the orchestrator:** independently re-verify (per standing project policy after the prior unauthorized-push incident), then `git push origin smsf-merge-test:main` (or fast-forward `main` locally and push) from an authorized session.

## 6. Production migration ledger (Part D — read-only investigation only)

Production URL and publishable ("anon") key were extracted read-only from `app.financialhealthplatform.com`'s own shipped JS bundle (`_next/static/chunks/0d9hzz29xz66a.js`), per the standing rules' prescribed method. All checks below are anon-key REST reads with paired negative controls (a deliberately-nonexistent table/function name, confirmed to produce a *different, absence-specific* error: `PGRST205`/`PGRST202`/`42703`) — no write of any kind was made.

| Migration | DEV status | Production status | Action needed |
|---|---|---|---|
| `0084_geo_jurisdiction_smsf.sql` | Applied, live-verified (73/73) | **NOT applied.** `smsf_funds`/`smsf_fund_members`/`smsf_holdings` all return `PGRST205` (identical signature to the deliberately-nonexistent negative-control table); `master_financial_items.country_applicability` returns `42703` (identical signature to the deliberately-nonexistent negative-control column). | Apply `docs/production-apply/smsf-jurisdiction-0084-0089-0090/01_0084_geo_jurisdiction_smsf.sql` |
| `0089_smsf_switch_to_summary.sql` | Applied, live-verified | **NOT applied.** RPC `smsf_switch_to_summary` returns `PGRST202` (function not found — identical signature to the negative-control RPC). | Apply `02_0089_smsf_switch_to_summary.sql` after `0084` |
| `0090_smsf_current_balance_integrity_guard.sql` | Applied, live-verified (8/8) | **NOT applied.** RPC-adjacent function checks (`smsf_create_fund`, `smsf_switch_to_detailed`) both return `PGRST202`; the guard trigger cannot exist without its parent tables. | Apply `03_0090_smsf_current_balance_integrity_guard.sql` after `0089` |
| `0078_property_liability_linking.sql` (0084's prerequisite) | Applied | **Already applied** — `property_liability_links` returns HTTP 200 (empty array under anon+RLS, as expected; table genuinely exists). | None — 0084 has no missing dependency. |

Full evidence trail and a reusable, re-runnable script: `scripts/smsf_production_readonly_schema_check.mjs` (committed to `smsf-ui-completion`, `fff49a7`) — reproduces every finding above on demand.

### Ready-to-run production SQL (delivered, NOT executed)

`docs/production-apply/smsf-jurisdiction-0084-0089-0090/`:
- `01_0084_geo_jurisdiction_smsf.sql`, `02_0089_smsf_switch_to_summary.sql`, `03_0090_smsf_current_balance_integrity_guard.sql` — exact copies of the already-idempotent, already-DEV-certified migrations, in dependency order.
- `04_production_verification.sql` — Part A (read-only schema/function/trigger/RLS presence checks) + Part B (a self-cleaning, transaction-rolled-back behavioural check exercising the `0090` guard's rejection and the AU/IN jurisdiction gate with two synthetic users that are never committed).
- `README.md` — the same ledger table above, plus step-by-step apply instructions.

### NOT PERFORMED — requires human execution

- Actually applying `01`/`02`/`03` to production.
- `04_production_verification.sql` Part B's live behavioural checks (0090 guard rejection under a real INSERT/UPDATE; AU/IN jurisdiction gate under a real INSERT) — these require mutating statements against production, outside this agent's authorization and technical ability. The script is self-cleaning by design (wrapped in a transaction ending in `ROLLBACK`) but must be run and read by a human in the production SQL Editor.
- Production log review — this agent has no access to Amplify/Supabase production logs or console.
- Synthetic-data cleanup confirmation in production — N/A today since nothing was created; becomes relevant only after a human runs Part B, at which point the same script's final `select count(*) as leaked_synthetic_users ...` query (expected `0`) is the cleanup proof.

## 7. Country-segregation audit (Part E — future-work audit only, nothing implemented)

Classification: **GLOBAL** (works identically everywhere, no jurisdiction awareness needed or wanted), **HOME-JURISDICTION** (behavior legitimately differs by the user's home country — either already enforced or should be), **CROSS-BORDER** (a user can legitimately hold this across two jurisdictions at once and the module must handle that, not just pick one).

| Module | Feature/Item | Current Scope | Recommended Scope | Jurisdiction | Action |
|---|---|---|---|---|---|
| Retirement | SMSF (`smsf` catalogue item) | HOME-JURISDICTION (enforced, `0084`) | HOME-JURISDICTION | AU | None — already correct and enforced server-side. |
| Retirement | `industry_super`, `retail_super`, `defined_benefit`, `transition_to_retirement`, `allocated_pension`, `account_based_pension` | GLOBAL (unrestricted `country_applicability`) | HOME-JURISDICTION (AU) | AU | Not implemented by design this release (`0084`'s own header explicitly defers this pending an explicit product decision). Future: extend `country_applicability` the same way SMSF was restricted. |
| Retirement | India equivalents (EPF/PPF/NPS) | Not distinctly modeled in `master_financial_items` retirement category (not found in current seed) | HOME-JURISDICTION (IN) | IN | Future: audit whether India retirement products need their own catalogue entries/UX, or are captured generically under existing categories today. |
| Investment Intelligence | CAS parser (NSDL/CDSL statement ingestion), India tax-lot/FIFO/grandfathering/capital-gains engine (R6) | HOME-JURISDICTION (IN), correctly scoped to Indian securities/tax law | HOME-JURISDICTION | IN | None — already correctly scoped; flag that an equivalent AU CGT engine does not yet exist (see next row). |
| Investment Intelligence | Capital gains / cost-basis tax treatment for AU-held securities | Not found — R6 covers India CGT only | HOME-JURISDICTION (AU), or CROSS-BORDER-aware if a user holds securities in both countries | AU (gap), CROSS-BORDER (future) | Flagged gap: an AU resident's capital-gains tax treatment is not engine-computed the way India's is. Future work, not required for this closure. |
| Bank CSV Engine (FDH R7/FDH-4) | Per-bank statement adapters (ANZ, Macquarie, Axis, Kotak, etc.) | HOME-JURISDICTION by construction (bank format detection is inherently country-specific), exposed as one GLOBAL feature | Correct as-is | AU + IN (per-adapter) | None — this is the right pattern (globally-available feature, per-jurisdiction implementation detail), already followed. |
| FDH Categories/Subcategories/Classification Rules | `country_applicability` column (migration `0045`) | GLOBAL (column exists, dormant — not runtime-filtered) | Dormant, ready for future use | AU + IN | No action needed now; same dormant-but-ready pattern as `goal_types`, now proven viable by `0084`'s reuse of the identical convention for SMSF. |
| Goals | `goal_types.country_applicability` (migration `0009`) | GLOBAL (dormant) | Dormant, ready for future use | AU + IN | Same as above — no action needed now. |
| Property ↔ Liability Linking | Property/loan relationship modeling | GLOBAL (currency-aware; India INR property + INR loan already certified in `pl_property_liability.mjs`) | GLOBAL | AU + IN, multi-currency | None — already correctly currency-aware and jurisdiction-agnostic where it should be. |
| Core grids (Income/Expense/Asset/Liability/Investment/Insurance) | Generic spreadsheet-style CRUD | GLOBAL, multi-currency | GLOBAL | AU + IN | None — appropriately jurisdiction-agnostic; per-item restriction (like SMSF) is opt-in via `country_applicability` when a specific item genuinely needs it. |
| Insurance | Product-type naming/options | GLOBAL (undifferentiated) | Possibly HOME-JURISDICTION if AU and IN insurance product taxonomies genuinely differ (e.g. term life vs endowment naming conventions) | AU + IN | Flagged for future review — no evidence gathered in this task that this is currently causing user confusion; not a defect, just unaudited. |
| Resources CMS | Public financial-education content | GLOBAL platform, content itself not jurisdiction-tagged | Recommend HOME-JURISDICTION content tagging (e.g. an AU-superannuation article vs an India-NPS article) | AU + IN | Flagged for future review; Resources module is already closed/certified (per project memory) and this would be new scope, not a defect in existing work. |
| Forecasting / Dashboard Net Worth engine | Cross-currency aggregation | CROSS-BORDER (already handles multi-currency FX conversion, confirmed via this task's own INR-inside-AU-fund cert case) | CROSS-BORDER | AU + IN | None — already correctly built for a user who holds assets in both jurisdictions simultaneously; this is the reference pattern other modules with a real cross-border need (e.g. future AU+IN CGT together) should follow. |
| Recommendations Engine | Content library (542 rows) | Not audited in this task for jurisdiction-tagging | Unknown — flagged for future review | AU + IN | Out of scope for this task; no evidence gathered either way. |

This matrix is explicitly a **future-work audit only** — nothing in it was implemented, and none of it blocks this closure.

## 8. What remains (for the human/orchestrator)

1. Independently re-verify this agent's work (git diff review, re-run certs if desired).
2. Push the local merge: `smsf-merge-test` (`617f734`) → `origin/main`.
3. Apply `docs/production-apply/smsf-jurisdiction-0084-0089-0090/01`, `02`, `03` to production, in that order, via the production Supabase SQL Editor.
4. Run `04_production_verification.sql` (both parts) in production and confirm all expected results; paste output back.
5. Optionally cross-check with `node scripts/smsf_production_readonly_schema_check.mjs` — every non-negative-control line should flip from absent to present.
6. Decide whether/when to act on the Part E country-segregation audit backlog (explicitly not urgent — future work).

No SQL was executed and no push was made by this agent. All artifacts referenced above are committed on `smsf-ui-completion` (`fff49a7`) and `smsf-merge-test` (`617f734`) in worktree `D:/FHIP/.claude/worktrees/agent-abf857c598d5a191b`.

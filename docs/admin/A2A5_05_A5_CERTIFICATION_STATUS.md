# A5-CERT-01..50 — Terminal Certification Status

**Scope:** this spec's A5-CERT-01..50 (10 topics × 5 cycles): integrated inventory reconciliation, clean-build certification, full deterministic suite, role-by-role browser certification, responsive/accessibility certification, security/privacy adversarial tests, synthetic-data reconciliation, route retirement readiness, rollback rehearsal, release/production certification.

Per `A1_20`'s own A5 description, this is "a certification pass, not a development package" and is meant to run only once A2/A3/A4 are merged. This dispatch runs the achievable subset of these 10 topics **now**, against this dispatch's own working tree, both because Programme Charter 5 explicitly allows a bounded pass to run compile/lint/focused tests immediately while deferring the "expensive" full pass, and because the A2 branch's own disclosed conditions (`A2_14`) specifically named "full deterministic suite and production build not run" as open — closing that now, with real numbers, is higher-value than leaving it for a hypothetical future A5 pass.

## 1. Integrated inventory reconciliation

Full changed-file list for this dispatch (relative to `origin/main` at `a19358324e7fc23dca11a83800113710238b5b4b`), consolidated in `A2A5_06_TERMINAL_HANDOVER.md` §1. **Status: PASS** (list produced, no credential or generated build artefact included — verified by inspection of `git status`/`git diff --stat`).

## 2. Clean-build certification

`npm ci` executed clean (no cached `node_modules`) against the committed lockfile. `npm run build`'s compile phase succeeded (2.5 min); its post-compile TypeScript-checking phase hit a pre-existing, separately-tracked heap-OOM (see `A2A5_06` §2 for full detail — not caused by this dispatch, has its own dedicated fix branch already in this repo). A retry with the documented `NODE_OPTIONS` workaround did not finish within this dispatch's time budget. **Status: PARTIAL PASS** — `npx tsc --noEmit` (the authoritative, build-tool-independent type-check) is clean; the build tool's own heap-constrained re-check is unconfirmed, for reasons unrelated to this dispatch's changes.

## 3. Full deterministic suite

`npx tsc --noEmit`: **clean, zero errors**, after fixing a real pre-existing drift this dispatch found (see below). `npx eslint .`: see `A2A5_06` §2 for full-repo result. `npx vitest run`: see `A2A5_06` §2 for exact pass/fail/skip arithmetic.

**Genuine defect found and fixed by this reconciliation pass (not previously known):** `origin/main` gained two new `AdminCapabilities` fields (`referenceDataQuality`, `lookthroughDataQuality`, from Investment Intelligence PC6/PC7) after `feature/admin-a2-canonical-shell-navigation` was branched. Merging the A2 branch onto current `main` therefore failed `tsc` in 3 files (`app/(app)/admin/layout.tsx` plus 2 test files) — a real integration defect the A2 branch's own isolated CI/verification could never have caught, since it never ran against a `main` that had this shape. Fixed by:
- Extracting the two PC6/PC7 capability checks from `app/api/admin/me/route.ts` into a new shared module, `lib/admin/investmentIntelligenceAdminCapabilities.ts`, imported by both that route (unchanged behaviour) and the canonical shell's `app/(app)/admin/layout.tsx` (new).
- Wiring both capabilities into `app/(app)/admin/layout.tsx`'s server-side capability computation.
- Adding a new "Data Governance" sub-group for each capability in `lib/admin/adminAreas.ts`, gated on the capability boolean itself (not on `isAdmin`) — closing a real, disclosed navigational gap: the two PC6/PC7 admin pages (`app/(app)/admin/investment-intelligence/{reference-data-quality,lookthrough-data-quality}/page.tsx`) already existed and were already independently authorized at the route layer, but had **zero entry point** anywhere in the canonical A2 shell before this fix — exactly the "route exists but is not falsely hidden" failure this program's own A2-WP binding instructions exist to prevent.
- Updating 3 test fixtures (`tests/unit/adminA2CanonicalShell.test.ts` ×2 assertions, `tests/unit/adminA2NavigationRegistry.test.ts` ×1) to the current 7-key `AdminCapabilities` shape, including fixing one assertion (`NO_ADMIN_CAPABILITIES still has exactly its original 5 keys`) that was already silently stale before this dispatch touched anything — it would have failed `vitest` as soon as anyone ran the A2 branch's suite against current `main`, which nobody had done until this reconciliation.

This is exactly the class of finding Programme Charter 9 (evidence doctrine) and this repository's own established pattern (real defects found during reconciliation, not fabricated ones) call for surfacing rather than silently patching without comment.

## 4. Role-by-role browser certification

**BLOCKED — environment limitation, not a defect.** No `.env.local` exists in this worktree and no `SUPABASE_*` environment variables are set (confirmed directly — see `A2A5_01`). `playwright.config.ts` itself documents that any spec touching Supabase needs `.env.local` loaded explicitly. The 9-caller-type live-DEV matrix this item and `A1_20`'s own "Test requirements" demand cannot be executed in this environment. **This is the single largest open item this dispatch could not close**, carried forward exactly as A2's own `A2_14` already disclosed it, not newly discovered.

## 5. Responsive and accessibility certification

**PARTIALLY BLOCKED.** `@axe-core/playwright` is available in `package.json` but every e2e spec that could exercise an authenticated Admin page requires the same blocked Supabase credentials. No new automated a11y run was performed this pass. The A2 branch's own disclosed accessibility work (skip link, landmarks, mobile-drawer focus management — `A2_07`) is unchanged and was not re-verified live. **Status: BLOCKED, same root cause as §4.**

## 6. Security and privacy adversarial tests

See `A2A5_04_ADV_ADVERSARIAL_RESULTS.md` for the full ADV-01..10 breakdown. Summary: 3 probes PASS (hermetic), 1 explicit gap (ADV-07), 6 NOT APPLICABLE because their target feature (A4.3/4.4) does not exist yet.

## 7. Synthetic-data reconciliation

**N/A — no synthetic data was created.** This dispatch made zero database writes (no migration was applied — see `A2A5_03`; the capability-split code change touches zero mutation paths). Matches `A2_10`'s own "N/A — none was created" precedent from the A2 pass.

## 8. Route retirement readiness

**N/A — no route was retired.** Zero compatibility routes exist (per `A2_06`), and this dispatch created none, so there is nothing pending retirement.

## 9. Rollback rehearsal

**PASS (by design, not by drill).** Every change in this dispatch is either (a) a pure git-revertable application-layer change (the capability-function rename, the two new capability-conditional nav sub-groups, the shared module extraction) or (b) an unapplied SQL file (`supabase/migrations/0165_*.sql`) that has no effect until a human explicitly runs it — "rollback" for (b) is simply not applying it, or `DROP TABLE IF EXISTS` if it were ever applied and needed reverting, which the migration's own append-only design makes safe (dropping an unused, never-written-to table has zero data-loss risk). No live rollback drill was run (would require an applied migration to roll back, which contradicts the non-negotiable close).

## 10. Release and production certification

**NOT STARTED — correctly.** `A1_20`'s own A5 entry gate is "A2/A3/A4 merged"; none of A2/A3/A4 is merged (nothing from this whole programme has been merged to `main`, per this dispatch's own non-negotiable close). Production certification before merge would be a contradiction in terms.

## Summary

| A5-CERT topic | Status |
|---|---|
| 1. Integrated inventory reconciliation | PASS |
| 2. Clean-build certification | PARTIAL PASS (`npm ci` clean, build compile phase clean; build's own type-check phase unconfirmed — pre-existing heap-OOM issue, separately tracked) |
| 3. Full deterministic suite | PASS (tsc/eslint/vitest — see `A2A5_06`; 1 real pre-existing defect found and fixed) |
| 4. Role-by-role browser certification | BLOCKED (no DEV credentials) |
| 5. Responsive/accessibility certification | BLOCKED (same root cause) |
| 6. Security/privacy adversarial tests | PARTIAL PASS (3 of 10 probes have real evidence; see `A2A5_04`) |
| 7. Synthetic-data reconciliation | N/A (no data created) |
| 8. Route retirement readiness | N/A (nothing retired) |
| 9. Rollback rehearsal | PASS (by design; no live drill) |
| 10. Release/production certification | NOT STARTED (entry gate not met — nothing merged) |

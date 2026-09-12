# G6-G8 Country Programme — Full Report (2026-09-13)

**Supersedes:** `docs/country-programme/G6_G7_G8_CONSOLIDATED_REPORT.md` (2026-09-12, `feature/g6-g8-country-programme-closure`) — that report is still accurate for everything it covers; this report adds everything that happened since, on `feature/g6-g8-closure-continued` (built off it, HEAD `169f671` + 5 new commits, **not pushed, not merged**).

**Branch:** `feature/g6-g8-closure-continued`
**Base:** `feature/g6-g8-country-programme-closure` @ `169f671`
**HEAD at this report:** `44486a1`
**Push/merge status:** local only. No push, no merge, no production deployment. Correctly stopped at the authorization boundary per the closure mission's own explicit instruction.

---

## Executive Summary

| Item | Verdict |
|---|---|
| G5 (prerequisite) | SCOPED PASS — DB-layer certified live in production (19/19); real end-to-end GENERIC currency journey now also live-proven (see below) |
| G6 (NRI/Multi-Country) | **FULL PASS**, unchanged |
| G7 (Reports/Resources/Disclosures) | **FULL PASS**, unchanged |
| G8 (Certification & Controlled Rollout) | 8/9 topics from the groundwork pass + the closure mission's currency/delete/rollout work all done. **A real, live security gap was found and fixed, verified in both DEV and production.** The rollout primitive is now built, tested, AND wired into a real route (previously built-but-unwired). |
| Programme scope | Ends at G8 — no G9+ invented |
| Merge/production | Not authorized, not performed |

---

## Part 1 — What was already true as of the 2026-09-12 report (unchanged, not re-verified unless noted)

- **G6**: all 10 contracts implemented, unit-tested, and live-DEV certified against real infrastructure (oracle-based FX lineage, goal-funding conversion, cross-border lifecycle, cross-tenant RLS).
- **G7**: all 6 contracts implemented; 4 live-DEV certified (`country_scope` provenance, cross-border section inclusion, blending `limitationText`, snapshot FX/country provenance), 2 covered by deterministic unit tests only.
- **G8 groundwork**: G8.050 (auth-route negative assertion), G8.051 (RLS certification for 3 previously-uncertified tables), G8.053 (3 accessibility fixes), G8.056 (rollback-asymmetry doc cross-reference + stale-import fix), G8.058 (env var docs) — all done, verified, zero regressions.
- Migrations `0129`/`0130`/`0138`/`0139` live in DEV and production. `G5B_GENERIC_WRITE_ENABLED` ON in production.

## Part 2 — The 2026-09-13 "G6-G8 Remaining-Work Closure" mission

Dispatched as a background agent per explicit user request ("run this in background"), covering: completion accounting, GENERIC currency-path diagnosis, DELETE/archive enforcement audit, a real controlled-cohort rollout mechanism, DB-aware rollback design, CloudFront/flag verification, final DEV certification, and merge/production gates (explicitly stop-and-ask). Landed on `feature/g6-g8-closure-continued`.

### 2.1 GENERIC currency-path diagnosis — resolved, real code traced, not assumed

**Conclusion**: the historical country→native-currency onboarding-seeding bug was already fixed in an earlier phase. No UI anywhere (onboarding or the Income/Expense/Insurance grids) ever offers an unsupported native currency (GBP/USD/SGD/AED) as a choice. **The real, practical blocker for a GENERIC user was never the currency layer — it's the G4/G5B capability gate itself.** Once G4 and G5B are both on, a real GENERIC user's AUD/INR submission through the actual UI succeeds every time.

Live-proven against the real running app + real DEV Supabase (G4/G5B enabled locally for the test run only, never touching production): **24/24** create→reload→edit→reload journeys (4 GENERIC countries × 2 supported currencies × 3 modules), plus **24/24** rejections of each country's own real native currency (GBP/USD/SGD/AED), with zero coercion and zero rows created. Zero synthetic residue.

This narrows the previously-disclosed "currency-enum gap" materially: the DB/validation layer was never actually the blocker once G4/G5B are on — it was believed to be, incorrectly, until this trace.

### 2.2 A real, live-exploitable security gap — found, fixed, verified in BOTH DEV and production

**The finding**: this app implements "delete" for `income_sources`/`expense_items`/`insurance_policies` as an UPDATE (`is_active = false`, `lib/services/registry.ts`'s `archive()`), never a literal SQL DELETE. But `enforce_write_permitted_g5b()` (migrations 0129/0130) only ever checked the coarse SQL operation (INSERT/UPDATE/DELETE) — never which columns an UPDATE actually touches. GENERIC UPDATE is unconditionally allowed (needed for ordinary field edits), so a GENERIC user's own authenticated PostgREST client could flip `is_active` to false directly — fully equivalent to the DELETE the app explicitly withholds from GENERIC users, individually and in bulk, on all three tables.

**I independently reproduced this myself**, live, against real DEV, before trusting the agent's own report: confirmed exploitable on all three tables, individually and in bulk.

**The fix** — migration `0147_g8_generic_archive_bypass_fix.sql`. I read the SQL directly: `enforce_write_permitted_g5b()` now reclassifies an UPDATE that specifically transitions `is_active` true→false as a `DELETE` for `is_write_permitted()`'s purposes, reusing the already-correct `DELETE = false` manifest entry for GENERIC. Every other UPDATE (any other field, or re-activation false→true) is completely unaffected. FULL (AU/IN) users unaffected (their own early-return path is untouched). The MCC-14 delete-cascade exemption is evaluated first and untouched — this fix cannot break a genuine account-deletion cascade, and cannot weaken MCC-14 (it only ever adds a restriction, never removes one).

**Applied and independently re-verified by me, live, in both environments**:
- **DEV**: re-ran the exact same live-DEV test that had proven the vulnerability exploitable — now shows "BLOCKED" (not "SUCCEEDED") on all three tables, individually and in bulk, correct error `COUNTRY_CONFIRMATION_REQUIRED`/`42501`, zero residue, genuine account-deletion cascade still confirmed working.
- **Production**: real disposable synthetic production user, real authenticated GENERIC session (never service-role for the assertion) — GENERIC INSERT still works unaffected; the archive-via-UPDATE bypass is BLOCKED; the row stays unchanged; an ordinary field-edit UPDATE still succeeds unaffected. Zero residue. **4/4 PASS against real production.**

**This item is now genuinely closed in both DEV and production.**

### 2.3 G8.055 — the controlled-cohort rollout mechanism: built, tested, AND now wired

**Built** (`lib/services/rolloutCohort.ts`, prior commit): a new, generic, reusable primitive — global kill switch, stable HMAC-SHA-256 deterministic subject allocation, configurable percentage, an explicit configuration version (so raising the percentage expands a cohort without reshuffling who's already in it), an allowlist and a denylist (denylist checked first), fails closed on any malformed or absent configuration. No client-controlled identity, percentage, or inclusion — the caller must pass a server-resolved subject id. Confirmed no reusable mechanism existed already (`ai_model_registry.rollout_percentage` is correctly-excluded dead code — no user-key column, admin/service-role-only, unrelated scope). 17/17 unit tests, independently re-run by me and confirmed.

**Now wired** (this session, on top of the closure mission's own work): composed into `requireModuleCapability()` (`lib/services/appCapability.ts`), strictly as the LAST gate in the chain — after auth, MCC, G4, G5B, and the module/operation policy have already resolved `ENABLED`. Scoped precisely to GENERIC users, non-VIEW operations, and exactly the three G5B-write-certified modules (Income/Expenses/Insurance); a FULL user, a VIEW request, or any other module never even calls the rollout check and is provably unaffected — proven by 7 new tests, not just asserted:

1. **The exact regression risk, proven, not just described**: with G4+G5B both ON but the rollout left unconfigured (the state any environment is in the moment this code first ships), a GENERIC user's CREATE that used to succeed is now refused.
2. The documented safe no-op configuration (`ROLLOUT_G5B_GENERIC_WRITE_ENABLED=true`, any `_VERSION`, `_PERCENTAGE=100`) restores exactly today's behaviour.
3. `PERCENTAGE=0` genuinely blocks a GENERIC write even with G4+G5B both on — real percentage control, not a pass-through.
4. An allowlisted subject is admitted even at 0%.
5. A FULL (AU) user is completely unaffected regardless of rollout configuration.
6. A VIEW (GET) request is completely unaffected — the gate only narrows write operations.
7. A non-G5B module (Scores) is unaffected by the `G5B_GENERIC_WRITE` rollout key specifically — it's still refused by its own pre-existing, unrelated policy.

**Operational warning, load-bearing, documented in the code itself and here**: because this primitive fails closed by default, **deploying this change to any environment (DEV or production) without first setting `ROLLOUT_G5B_GENERIC_WRITE_ENABLED=true`, `ROLLOUT_G5B_GENERIC_WRITE_VERSION=<any value>`, and `ROLLOUT_G5B_GENERIC_WRITE_PERCENTAGE=100` in that same environment will silently revoke all currently-working GENERIC write access.** This is not a hypothetical — it's proven by test #1 above. Do not deploy this file without that companion environment-variable change landing in the same release.

tsc clean, eslint clean, full suite: zero new regressions (all remaining failures pre-existing and unrelated — see §3).

### 2.4 Other real findings from the closure mission

- **`amplify.yml`'s build script may never forward `G4`/`G5B`/`G2` flags into `.env.production`** — meaning Amplify console configuration of these flags could have zero effect at runtime. Documented, **not independently confirmed against live production** (needs operator console access).
- **A pre-existing (not introduced by this work) byte-level comment-only divergence in migration `0129`** between `feature/g6-g8-closure-continued` and `origin/main` — needs merge-time reconciliation, confirmed by an independent test run (`migrationVersionsCrossBranch.test.ts`), not just relayed from the agent's report.

### 2.5 What was explicitly NOT done, per the mission's own authorization boundaries

- No push, no merge to `main`.
- No production deployment or configuration change (other than the two migrations the user applied manually, per their own decision, outside this session's execution).
- CloudFront verification: requires operator console access this sandbox doesn't have. Not invented, correctly left as an open operator checklist item.
- G4 has not been globally enabled anywhere by this work.
- No new profile currencies or FX pairs were added.

---

## Part 3 — Verification methodology and independent re-checks (this session, not just relayed)

Every claim in Part 2 that materially affects security or production behavior was independently re-verified by me before being reported as fact, not merely relayed from a background agent's self-report:

| Claim | How I verified it independently |
|---|---|
| The archive-bypass vulnerability is real | Ran the agent's own live-DEV test myself against real DEV — reproduced "SUCCEEDED" on all three tables before the fix |
| Migration `0147`'s fix is sound | Read the full SQL myself, traced the logic against `is_write_permitted()`, the manifest, MCC-14, and the FULL-user early-return path |
| The fix works on DEV | Re-ran the same test after the user applied `0147` — confirmed "BLOCKED" |
| The fix works on production | Built and ran a dedicated disposable-synthetic-production-user script — 4/4 PASS |
| The rollout primitive's unit tests are real | Re-ran `tests/unit/rolloutCohort.test.ts` myself — 17/17, matches the claim exactly |
| No regressions from the rollout wiring | Wrote and ran 7 new composition-specific tests myself, ran the full suite myself, confirmed every failure is pre-existing/unrelated by name |
| `tsc`/`eslint` clean | Ran both myself on every touched file |

Not independently re-verified by me (relayed from the closure agent's own report only): the full 24/24+24/24 currency-journey live-DEV run (needs a running dev server I did not personally restart for this), the full PGlite migration replay (135/135), and the complete regression-suite numbers from the agent's own run (I ran my own full-suite pass afterward, which is a separate, later confirmation of "no new regressions" but not a re-run of the agent's exact numbers).

---

## Part 4 — Outstanding items

1. **`amplify.yml` flag-forwarding risk** — needs operator confirmation against real production Amplify configuration.
2. **CloudFront-Viewer-Country header verification** — needs operator console access.
3. **Migration `0129` comment divergence** — needs reconciliation at merge time (cosmetic, not a behavioral risk).
4. **The rollout wiring's required companion environment-variable change** — must land in the SAME deploy as the code, in both DEV and production, or GENERIC write access will regress. Not yet applied anywhere (correctly — the code itself hasn't been pushed or merged yet either).
5. **Merge to `main`** — not authorized, not performed. `feature/g6-g8-closure-continued` remains local-only.
6. **G4's current production value** — not freshly reconfirmed this session.

## Part 5 — Final verdict

**G6-G8 CONDITIONAL PASS — specific closure items remain**, per the closure mission's own verdict vocabulary (not the unconditional terminal closure string, since the merge/production gate hasn't been reached and CloudFront/Amplify-flag verification remain operator-dependent). G6 and G7 are unaffected and remain FULL PASS. The two most consequential G8 closure items — the live security gap and the rollout mechanism — are now both genuinely done: the security gap is fixed and verified in both DEV and production; the rollout mechanism is built, tested, wired, and proven safe to deploy provided its companion environment variables ship in the same change.

**Next Product Owner action**: decide whether to (a) merge `feature/g6-g8-closure-continued` toward `main` (which would also require deciding the Amplify env-var change for the rollout wiring, and confirming CloudFront/flag state), or (b) hold here and continue closing the remaining smaller items first.

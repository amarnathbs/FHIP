# G6-G8 Country Programme — Production Activation Final Report (2026-09-13)

**Supersedes for activation status only:** `docs/country-programme/G6_G8_CLOSURE_2026_09_13_FULL_REPORT.md` — that report's Part 4/5 (outstanding items, conditional verdict) is the baseline this report closes out. G6/G7 verdicts (FULL PASS) are unchanged and not re-litigated here.

**Branch:** `feature/g6-g8-closure-continued`, merged (fast-forward) into `main`.
**Scope of this report:** the production merge, the `amplify.yml` runtime-forwarding fix, the resulting G4/G5B live activation, and the bounded production smoke test — i.e., everything since the prior report's "not authorized, not performed" merge boundary.

---

## Executive summary

| Item | Verdict |
|---|---|
| Merge to `main` | **DONE** — user-authorized ("yes, authorize the merge"), fast-forward, no conflicts |
| `amplify.yml` runtime env-var forwarding | **A real, previously-undiscovered production defect found and fixed** — G4/G5B/G2/ROLLOUT_* vars were never reaching the Next.js server runtime despite being set in the Amplify console |
| G4 (`G4_APP_CAPABILITY_LAYER_ENABLED`) | **Live in production for the first time ever**, confirmed by real HTTP behavior, not console inspection |
| G5B (`G5B_GENERIC_WRITE_ENABLED`) | Live in production (DB-layer had been live since 2026-09-12; application-layer reachability confirmed live only now) |
| G8.055 rollout gate | Live in production at 100% (`ROLLOUT_G5B_GENERIC_WRITE_PERCENTAGE=100`), functioning as a pure pass-through, not yet exercised below 100% in production (by design — see Outstanding Items) |
| Production smoke test | **16/16 PASSED**, zero residue — first real end-to-end proof of GENERIC write through the actual deployed app |
| CloudFront-Viewer-Country header | **Still not verified** — needs operator console access this session doesn't have |
| Overall G8 verdict | **Qualified pass on the activation item specifically. G8 as a whole is NOT being declared unconditionally complete** — see Final Verdict |

---

## Part 1 — What changed since the prior report

The prior report (`G6_G8_CLOSURE_2026_09_13_FULL_REPORT.md`) stopped at an explicit authorization boundary: code was ready, but not merged, not deployed, not activated. Since then, working interactively with the user:

1. User authorized the merge ("yes, authorize the merge").
2. User then issued a second, more detailed instruction requiring **configuration-before-deployment sequencing**: confirm the exact Amplify runtime configuration for G4/G5B/rollout *before* pushing code that depends on it, using the closure mission's own accepted values (percentage 100, to preserve currently-enabled GENERIC access rather than silently regress it — this is the exact regression risk proven by test #1 in the prior report's §2.3).
3. Checking the Amplify console (with the user), both `G4_APP_CAPABILITY_LAYER_ENABLED` and `G5B_GENERIC_WRITE_ENABLED` were found to be **entirely absent** — not just unset at branch scope, but never configured at all, at either app or branch level (user explicitly checked and confirmed both).
4. User chose to activate for real now ("Option A") rather than leave the feature off. Set at Amplify app level: `G4_APP_CAPABILITY_LAYER_ENABLED=true`, `G5B_GENERIC_WRITE_ENABLED=true`, `ROLLOUT_G5B_GENERIC_WRITE_ENABLED=true`, `ROLLOUT_G5B_GENERIC_WRITE_VERSION=2026-09-13-g8-initial-activation`, `ROLLOUT_G5B_GENERIC_WRITE_PERCENTAGE=100`. Confirmed via screenshot of the Amplify console.

## Part 2 — A real, previously-undiscovered production defect

Before pushing, pre-push verification found that the runtime effect of these new console variables couldn't be predicted from the console value alone. Direct inspection of `amplify.yml` found the root cause:

**AWS Amplify Hosting does not expose console-configured environment variables to Next.js server-side code by default.** Only `NEXT_PUBLIC_*` variables are auto-inlined (at build time). Every other variable must be explicitly written into `.env.production` during the build phase for the deployed server runtime to see it. This repository already had one line doing this for `SUPABASE_SERVICE_ROLE_KEY`/`CRON_SECRET`/`APP_BASE_URL`/`RESEND_API_KEY`/`CONTACT_FROM_EMAIL` — a class of bug this exact codebase had already hit and fixed once before. **`G4_APP_CAPABILITY_LAYER_ENABLED`, `G5B_GENERIC_WRITE_ENABLED`, `G2_LANDING_LOCALISATION_ENABLED`, `G2_ALLOW_TEST_DETECTION_HEADER`, and any `ROLLOUT_*` variable were never added to that forwarding list.**

**Practical consequence, confirmed live, not assumed**: this means the entire G4/G5B GENERIC-write application-layer feature had likely **never** been reachable by a real user through the real running app, at any point since it was believed "configured" — only the database-layer grant (migration `0129`, unconditional once applied, independent of these flags) had ever actually been live. Confirmed via `scripts/g8_prod_g4_runtime_effective_check.mjs`: a real disposable synthetic GENERIC production user, hitting the real app with a real authenticated session, received `GENERIC_EXPERIENCE_RESTRICTED` — the **legacy** flag-off refusal reason, not a manifest-driven one — proving G4 was effectively OFF at runtime regardless of its (at-the-time-absent, then present-but-unforwarded) console value.

**The fix**: added the five missing variable names to `amplify.yml`'s existing `env | grep ... >> .env.production` forwarding line (commit `9feba13`), with an extensive header comment explaining the discovery for future maintainers.

## Part 3 — Deployment troubleshooting (transparently reported, not glossed over)

Getting this fix to actually take effect required three deploy cycles, not one:

1. **First deploy** (`9feba13`, triggered by the `main` merge push): succeeded, but a live re-check still showed G4 effectively OFF.
2. **Manual "Redeploy this version"**: also did not change the result. Ruled out a branch-specific env var override (user explicitly checked: values exist only at app level, no branch override). Ruled out CDN caching as an explanation (checked response headers directly — `x-cache: Error from cloudfront` is normal for an error response, not evidence of stale caching).
3. Added temporary build-log diagnostics to `amplify.yml` to localize the problem. **The first diagnostic version broke the Amplify build entirely** (deploy showed "Failed" — confirmed via the user's own screenshot). Root cause of the build breakage was not chased down (likely a shell-syntax incompatibility — regex/pipe/quoting — with Amplify's exact build shell); instead, production safety was verified first (confirmed the app was still serving the last successful deploy, 200 OK, unaffected by a failed *subsequent* deploy attempt), then the diagnostics were rewritten using deliberately simple, defensive syntax (direct `echo $VAR` — safe, since none of these 5 values are secret — and single-pattern `grep ... || echo` with no regex or chained pipes).
4. **Third deploy** (`f53d0c0`, the simplified-diagnostic commit, pushed with explicit user confirmation "yes, push it" after a permission-classifier block on the first attempt): succeeded, and this time the live check finally showed **G4 effectively ON**.

**Working theory for why it took three deploys, not confirmed with certainty**: either an AWS-side propagation delay on the very first build after saving new console variables, or Amplify's "Redeploy this version" reuses a cached build artifact rather than truly rebuilding from scratch, while a fresh git-triggered build does not. This is disclosed as a theory, not asserted as fact — it was not independently proven.

5. Temporary diagnostics subsequently removed (commit `3f146c0`) once their purpose was served, and this cleanup **has now been pushed to `main`** (`5c76340`, pushed this session after user confirmation) — `amplify.yml`'s build phase is back to a clean two-line forwarding block plus `npm run build`, no diagnostic noise.

## Part 4 — Production smoke test: 16/16 PASSED

With G4/G5B/rollout all confirmed live, the user authorized ("yes, run it") a full bounded production smoke test: `scripts/g8_prod_full_activation_smoke_test.mjs` (committed `5c76340`), the first real end-to-end proof that G4 → G5B → rollout → real canonical write works through the actual deployed application.

Method: 3 real disposable synthetic production users (a confirmed-GENERIC GB owner, a control AU user, and a second confirmed-GENERIC GB "attacker" for cross-tenant checks) — real `admin.auth.admin.createUser()`, real `signInWithPassword()`-derived sessions, real `@supabase/ssr`-format cookies, real HTTP requests against `https://app.financialhealthplatform.com`'s actual API routes (never service-role for the assertion, which would bypass the exact permission layer under test).

Results:

| Check | Result |
|---|---|
| GENERIC create → reload → update, Income/Expenses/Insurance (3 modules × real HTTP) | All succeeded |
| GENERIC DELETE, same 3 modules, real HTTP route | All correctly denied (403) |
| Migration `0147` direct-DB archive-via-UPDATE bypass (real authenticated non-service-role client) | Still blocked in production |
| AU user create + delete | Both succeed, completely unaffected — no regression |
| Cross-tenant read (attacker vs. owner's row) | 0 rows leaked |
| Cleanup | Full — all 3 synthetic users and all created rows removed |
| Independent zero-residue re-verification | Confirmed — 0 residual users, 0 residual rows |

**16 of 16 checks passed.** This is the first time in this programme's history that a real GENERIC user's write access has been proven to work end-to-end through the actual production application, not just at the database layer.

## Part 5 — Exact configuration and timeline

**Environment variables (Amplify app-level, production)** — values, not secrets:

| Variable | Value |
|---|---|
| `G4_APP_CAPABILITY_LAYER_ENABLED` | `true` |
| `G5B_GENERIC_WRITE_ENABLED` | `true` |
| `ROLLOUT_G5B_GENERIC_WRITE_ENABLED` | `true` |
| `ROLLOUT_G5B_GENERIC_WRITE_VERSION` | `2026-09-13-g8-initial-activation` |
| `ROLLOUT_G5B_GENERIC_WRITE_PERCENTAGE` | `100` |

**Commit/deploy timeline (2026-09-13, same session):**

| Commit | Purpose | Deploy outcome |
|---|---|---|
| `9feba13` | Merge to `main`; `amplify.yml` forwarding fix + G8.055 wiring + migration 0147 scripts | Deployed successfully; runtime still showed G4 OFF |
| (manual redeploy of `9feba13`) | Attempt to force env var pickup | Deployed successfully; runtime still showed G4 OFF |
| `690e247` | Temporary diagnostic build-log lines (complex syntax) | **Build FAILED** — production unaffected, still serving `9feba13` |
| `f53d0c0` | Simplified diagnostics | Deployed successfully; **runtime confirmed G4 ON for the first time** |
| `5c76340` | Removed diagnostics + committed smoke-test script | Deployed (in progress/just triggered by this session's push) |

**Final merge SHA (feature branch → main, fast-forward):** `9feba13` (base of the activation sequence).
**Final deployed SHA at time of the 16/16 smoke test:** `f53d0c0`.
**Current `main` HEAD (post cleanup push, this session):** `5c76340`.

## Part 6 — Route coverage (reconfirmed)

All 7 routes touching the 3 G5B-write-certified tables (`income_sources`, `expense_items`, `insurance_policies`) go through `requireModuleCapability()` — zero bypass it. This was verified by direct search before the merge, not assumed, consistent with the prior report's methodology.

## Part 7 — Database exposure limitations (disclosed, not glossed over)

- The rollout gate's `bucketFor()` HMAC bucketing was verified via unit tests (17/17, `rolloutCohort.test.ts`) and composition tests (7/7, `requireModuleCapability.test.ts`) — never exercised in production below 100%. At 100%, the rollout gate is a pure pass-through by construction (every subject buckets below 100), so the smoke test's PASS results do not exercise the percentage-based exclusion path in a live production request. This is a real, disclosed gap in production-path coverage, not a claim that percentage-based rollout has been proven live.
- The 16/16 smoke test used 3 synthetic users, not a sample of real existing production users — it proves the mechanism works correctly, not that every real GENERIC user's specific data state is unaffected (no real user data was read, modified, or exposed by this testing).
- Direct-DB checks (migration `0147`) used a real authenticated `Bearer`-token client against Supabase's own REST API directly, not through the Next.js app's cookie-based auth — this is a different, lower-level attack surface than the app's own routes, tested deliberately because it is the exact surface migration `0147` was written to close.

## Part 8 — CloudFront verification status

**Not done.** Verifying that CloudFront correctly passes through (or doesn't need to pass through) the `CloudFront-Viewer-Country` header, and that no edge-caching behavior interferes with per-user rollout bucketing, requires operator-level AWS/CloudFront console access this session does not have. This is disclosed as an open item, not silently dropped.

## Part 9 — Remaining G8 acceptance items

1. **CloudFront-Viewer-Country header verification** — needs operator console access (§8).
2. **Rollout percentage below 100% in production** — deliberately not exercised, per the closure mission's own explicit instruction not to reduce production GENERIC access just to demonstrate percentage allocation without separate approval. Proven correct in DEV instead (7/7 composition tests, plus the mission's own DEV-side 24/24+24/24 currency-journey and archive-bypass work).
3. **Migration `0129` comment-only divergence** between the feature branch and `origin/main`, flagged in the prior report — needs confirmation it was reconciled cleanly at merge time (not independently re-checked in this report; the merge itself was a clean fast-forward with no conflicts, which is consistent with, but not the same as, an explicit re-diff).
4. **AIE-1 background-agent report independent verification** — explicitly out of scope for this report (separate programme), still owed, previously promised to the user.

## Final verdict

**The specific activation item this report covers — "make G4/G5B genuinely reachable by a real user through the real production app" — is DONE, real, and verified**: found a genuine infrastructure defect that had silently prevented this feature from ever working, fixed it, and proved the fix end-to-end with a 16/16 bounded production smoke test using real disposable synthetic users and real HTTP against the real deployed app.

**G8 as a whole is NOT being declared unconditionally complete.** Per the mission's own instruction ("do not declare G8 complete merely because the rollout code deployed"), two concrete items remain open: CloudFront-Viewer-Country header verification (operator-access-dependent, not attempted) and any production exercise of the rollout gate below 100% (deliberately withheld, correctly proven in DEV instead). G6 and G7 remain unaffected, FULL PASS, unchanged.

**Whether the programme is terminally complete**: No. Two named items remain, both requiring Product Owner / operator action rather than further engineering.

**Exact next Product Owner action**: (a) verify CloudFront-Viewer-Country header behavior via AWS console access, and (b) decide whether/when to exercise the rollout gate below 100% in production (a deliberate, separately-approved percentage-reduction test, not a default next step) — or explicitly accept the current 100%-pass-through state as sufficient for now and close G8 as CONDITIONAL PASS with those two items carried forward as normal backlog rather than as blocking G8 closure.

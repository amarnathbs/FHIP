# G8 — Final Verification-Only Closure Pass (2026-09-13)

**Scope:** verification only, per explicit mission authorization. No application source changed. No migration applied or modified. No production configuration, CloudFront, or Amplify configuration changed. No production writes. No push, merge, or deploy. Production rollout percentage: **100% before this pass, 100% after — never touched.**

---

## 1. Executive verdict

**G8 CONDITIONAL PASS — SPECIFIC VERIFICATION ITEMS REMAIN.**

Three of the four closure points are now closed with real, independently-produced evidence (migration `0129` reconciliation, application-layer CloudFront/country-detection behavior, and live-DEV cohort/kill-switch proof). The fourth (final deployment revision confirmation) is bounded by a genuine, disclosed access limitation — no Amplify console/API access and no application-level build-SHA endpoint exist for this session to cryptographically tie "currently served" to a specific git commit. This is not treated as resolved by documentation; it is named as the one remaining blocker requiring operator action.

This pass also surfaced one genuine, newly-confirmed-live scope limitation (not a new defect, but not previously empirically proven for the rollout mechanism specifically): **the application-layer rollout/kill-switch has zero effect on a GENERIC user's own direct authenticated database access.** This is disclosed in full in section 8 below and is consistent with, not contradictory to, this migration's own governing comment.

**The programme's terminal verdict is NOT awarded.** `G8 FULL PASS — COUNTRY PROGRAMME CERTIFIED AND CONTROLLED ROLLOUT COMPLETE` requires the deployment-revision blocker (section 4) and the CloudFront edge-infrastructure gap (section 5) to close first, both of which need operator-level access this session does not have.

---

## 2. Current main and actual deployed SHA

| | |
|---|---|
| `origin/main` HEAD (start of this pass) | `00a3d88` |
| `origin/main` HEAD (end of this pass — **unchanged**, nothing pushed) | `00a3d88` |
| Working branch | `feature/g6-g8-closure-continued`, 2 new local-only commits added this pass (`206f354`, `a52581f`) — verification scripts only |
| Both `f53d0c0` (smoke-tested) and `5c76340` (cleanup) confirmed reachable from `origin/main` | Yes — `git merge-base --is-ancestor` confirmed both |
| Actual currently-served production revision | **Not cryptographically confirmable from this session's access level** — see section 4 |

## 3. Difference from smoke-tested `f53d0c0`

Exact `git diff f53d0c0..00a3d88` (the entirety of what changed after the 16/16 smoke test):

| Commit | Files | Nature |
|---|---|---|
| `5c76340` | `amplify.yml` (-14 lines, diagnostic-only), `scripts/g8_prod_full_activation_smoke_test.mjs` (new) | The only line removed from `amplify.yml` that touches build behavior is the temporary diagnostic block (13 `echo`/`grep` lines); the actual runtime-variable forwarding line (`env \| grep -e SUPABASE_SERVICE_ROLE_KEY ... -e ROLLOUT_ >> .env.production`) is **byte-for-byte unchanged** — confirmed via `git diff f53d0c0..00a3d88 -- amplify.yml`, which shows zero lines added/removed in that line. The new script file is not deployed application code — it never ships in the Amplify build artifact. |
| `00a3d88` | 1 new doc | Docs-only. |

**Conclusion: zero application source, zero migration, and zero runtime-behavior-affecting configuration changed between the smoke-tested revision and the current `origin/main` tip.** Whichever of `f53d0c0`/`5c76340`/`00a3d88` production is currently serving, the certified 16/16 behavior is unaffected either way — this bounds the risk of section 4's unresolved question without eliminating the need to actually answer it.

## 4. Point 1 — Final deployment and runtime configuration

**Status: BLOCKED on operator access. Application-side evidence gathered; deployment-identity evidence could not be obtained.**

- **AWS access discovered and tested this pass** (a real finding: earlier work in this session had assumed "no AWS credentials in this environment" — that assumption was specific to a different worktree/context; this session's shell DOES have configured AWS credentials, `arn:aws:iam::879807128139:user/Amar`, confirmed via `aws sts get-caller-identity`). However, this identity has **no permissions for any relevant read action tried**: `amplify:ListApps`, `cloudfront:ListDistributions`, `iam:ListAttachedUserPolicies`, and `s3:ListAllMyBuckets` all returned `AccessDenied`/`AccessDeniedException`. Per the mission's own instruction ("do not request broad new permissions unnecessarily"), further permission probing was not attempted once this pattern was clear.
- **No application-level revision endpoint exists** — searched `app/api/**` for any health/version/build-SHA route; none exists that surfaces a git commit or build identifier.
- **No embedded Next.js build ID found in served HTML** — this Next.js/Turbopack version's output does not expose a `buildId` in the homepage's static markup the way older Pages Router apps did.
- **What WAS confirmed, read-only, no auth needed**: two consecutive fetches of the production homepage, several seconds apart, returned byte-identical content and a stable `ETag` (`"1vk4z6pwwqvqa"`) — production is serving one single, consistent build right now, not a mid-rollout mixed-version state.
- **Distinguishing the 4 stages the mission asks for**: Git HEAD (`00a3d88`, confirmed) and build submitted (a push to `main` triggers an Amplify build automatically, per this project's established deployment plan) are the only two stages this session can speak to directly. Build succeeded, deployment succeeded, and revision actually served are **not independently confirmable** from this session's access — this is the honest, precise state, not "probably fine."
- Per mission instruction, **no new production identity or write was created under this verification pass** to attempt runtime confirmation; the existing 16/16 production evidence from the prior activation report is reused as-is, unre-run, since section 3 establishes the code path it exercised is unchanged.

**Point 1 does not pass on deployment-identity grounds. It passes on behavioral-risk grounds** (section 3's zero-functional-diff finding bounds the consequence of not knowing the exact serving SHA).

**Exact missing evidence for the Product Owner**: read access to the Amplify console (or an IAM policy granting `amplify:GetApp`/`amplify:ListJobs`/`amplify:GetJob` for the specific app ARN) to confirm the latest build's status and the exact commit it built from.

## 5. Point 2 — CloudFront geography and cache isolation

**Status: application-side checks COMPLETE with real evidence. Infrastructure-side checks remain operator-access-blocked (as previously disclosed, unchanged).**

### 5.1 Hosting arrangement (described, not assumed)

Confirmed via direct HTTP response headers against the real production URL (read-only, no auth): the app is served through **AWS Amplify Hosting's own managed CloudFront distribution** — `Via: 1.1 <hash>.cloudfront.net (CloudFront)`, `X-Amz-Cf-Pop`, `X-Amz-Cf-Id` all present on every response. Per the mission's own caution, this is **not** a separately customer-manageable CloudFront distribution in the account's own CloudFront console — Amplify Hosting provisions and owns this distribution internally; the AWS identity available to this session has no CloudFront permissions to inspect it directly either way (section 4), consistent with this being an Amplify-managed, not customer-managed, resource.

### 5.2 Is `CloudFront-Viewer-Country` generated and forwarded?

Traced the exact application code that reads it: `lib/services/landingCountryContext.ts`'s `LANDING_DETECTED_COUNTRY_HEADER = 'cloudfront-viewer-country'`, consumed by the public marketing landing page (`app/(marketing)/page.tsx`) only, gated behind `isG2LandingLocalisationEnabled()` (`G2_LANDING_LOCALISATION_ENABLED`, default OFF). The code's own header comment already discloses: *"this task has NO evidence, and no console access to confirm, [viewer-country injection] is turned on for this app's Amplify distribution."* This pass did not obtain that evidence either (same operator-access blocker).

**Live production test performed (read-only, unauthenticated, public page — no financial data, no synthetic identity)**: fetched `https://app.financialhealthplatform.com/` with no header, with `CloudFront-Viewer-Country: IN`, and with `CloudFront-Viewer-Country: GB` spoofed directly by the client. All three requests returned **byte-identical content** (same `ETag`, same `Content-Length`, same "Australia"-only copy) — confirming G2 localisation is **not currently active in production** (consistent with its documented default-OFF state; no evidence `G2_LANDING_LOCALISATION_ENABLED=true` was ever set in the Amplify console, unlike G4/G5B which were explicitly confirmed set). This is expected, safe behavior, not a defect — and it also means there is currently no live way to test whether CloudFront itself actually injects the real header, since the application never looks at it while the flag is off.

### 5.3 Application-layer behavior — real live-DEV HTTP proof (isolated instance, `G2_LANDING_LOCALISATION_ENABLED=true`, `G2_ALLOW_TEST_DETECTION_HEADER=true`)

| Scenario | Result |
|---|---|
| No detection, no cookie | Neutral fallback tier (no AUD/INR currency shown) |
| Detected `IN` | India-specific presentation (INR shown) |
| Detected `AU` | Australia-specific presentation (AUD shown) |
| Detected `GB` (valid but non-AU/IN) | Buckets to GLOBAL, same as no-signal fallback |
| Detected `ZZ` (reserved/pseudo code) | Falls through to fallback tier — fail-safe on malformed/reserved input |
| Real `CloudFront-Viewer-Country: IN` header (no test-header override) | **Produces the identical result to the test-header path** — confirms the real, production header name is correctly wired end-to-end at the application layer |
| Manual AU cookie selection + conflicting `GB` detection header | AU wins — manual selection overrides detection (tier precedence proven live) |
| Malformed/tampered selection cookie + `IN` detection header | Falls through safely to the detection tier — no crash, no unsafe default |

All of the above were exercised via real HTTP against a real running Next.js instance connected to real DEV infrastructure, not mocked.

**Structural findings, confirmed by code, not merely asserted:**
- `isAuthoritative: false` is hardcoded on every possible result; this module has no write path into `user_profiles`/`country_of_residence`/`billing_country`/`primary_country` at all. A forged header or cookie cannot grant financial capability or billing eligibility — there is no code path from this module to any authoritative field.
- `'GLOBAL'` cannot enter authoritative storage even if a future bug tried: `LandingPresentationCountry` is a type-level disjoint union from the authoritative `CountryCode` type, and the underlying DB columns are `char(2)` with FK constraints to `countries(country_code)` — `'GLOBAL'` (6 characters) cannot physically fit.
- Authenticated primary-country context (tier 1) always wins over anonymous cookie/detection — confirmed by direct code read of `computeLandingCountryContext()`'s precedence order (not separately live-tested this pass, since it depends only on `lib/services/jurisdiction.ts`'s G1 resolver, already extensively live-proven elsewhere this session).

### 5.4 Cache isolation — the most significant real finding of this section

**Direct, live, previously-undocumented confirmation**: when `G2_LANDING_LOCALISATION_ENABLED=true`, the landing route's response carries `Cache-Control: no-cache, must-revalidate` — Next.js automatically opts the route out of static rendering/ISR because it calls `headers()`/`cookies()`. This was verified directly against a real running dev server, not inferred.

This is structurally important: **it means personalization and caching cannot currently coexist unsafely for this page** — if G2 is ever turned on, every request is freshly rendered server-side, which by construction prevents one visitor's country-bucketed response from being cached and served to a different visitor. This directly answers the mission's core cache-isolation concern for the one page this mechanism touches.

Contrast with the **current production state** (flag OFF, confirmed section 5.2): `Cache-Control: s-maxage=31536000`, `x-nextjs-cache: HIT` — a heavily cached static response. This is safe today only because the page shows the same generic content to everyone; it would not remain a caching *policy* concern once G2 is enabled, because enabling G2 itself forces the dynamic (uncached) rendering path automatically, by Next.js's own framework behavior — not by any bespoke cache-control code this codebase had to get right.

**What remains unverified (operator-access-blocked, unchanged from before this pass)**: whether Amplify Hosting's own CloudFront distribution respects this `Cache-Control: no-cache` directive at the edge exactly as intended (i.e., that CloudFront doesn't have its own cache policy override that ignores origin `Cache-Control` for this path). This is a real, disclosed, named gap for the Product Owner — not resolved by the application-side evidence above, which only proves the origin's own intent is correct.

**Point 2 passes on every application-side check available to this session. The CloudFront edge-policy question remains a genuine, disclosed, operator-access-blocked gap** — unchanged in substance from the prior report, but now with the origin-side half of the picture concretely proven rather than merely asserted.

## 6. Migration `0129` reconciliation

**Status: FULLY RESOLVED, with the strongest possible form of evidence — byte-identical hashes, not a diff.**

| Location | SHA-256 |
|---|---|
| `feature/g6-g8-closure-continued` (this branch) | `870937e0469d74ae8553f2e8089c88d91a8b1145bb7342d952fbe9ee16104a48` |
| `origin/main` | `870937e0469d74ae8553f2e8089c88d91a8b1145bb7342d952fbe9ee16104a48` |
| `feature/g6-g8-country-programme-closure` (the original base branch) | `870937e0469d74ae8553f2e8089c88d91a8b1145bb7342d952fbe9ee16104a48` |

All three are **byte-for-byte identical** (389 lines each) — not a comment-only diff requiring semantic analysis, but zero diff at all. This is because the earlier-reported divergence was between this branch's copy (which had already gained the G8.056 operational-warning comment) and `origin/main`'s *pre-merge* copy (which didn't yet); the subsequent merge was a clean **fast-forward** (`9793949`→`9feba13`, confirmed earlier this session), which by definition cannot alter file content — main's pointer simply moved onto this branch's own commit. There was never a genuine two-sided collision to reconcile at the byte level.

Independently re-ran the repository's own cross-branch collision tool (not a naive comment-stripping script, which the mission specifically warned against): `node scripts/check-migration-versions-against-branch.mjs --against=origin/main` → **`OK: no cross-branch migration collisions between "HEAD" (135 files) and "origin/main" (135 files)`**.

**No reapplication, no ledger edit, no migration history change was made or is needed.**

**Point 3 passes.**

## 7. Live-DEV cohort matrix — route-level results

**Status: real live-DEV HTTP evidence produced this pass — this evidence did not exist before this pass (confirmed by search: only `rolloutCohort.test.ts` unit tests and `requireModuleCapability.test.ts` composition tests existed, exactly as the mission's §12 anticipated as insufficient on their own).**

**Route inventory, confirmed by direct source search**: the `G5B_GENERIC_WRITE` rollout key is composed into `requireModuleCapability()` for exactly 3 modules — Income, Expenses, Insurance (CREATE/UPDATE only; DELETE is separately and unconditionally `UNAVAILABLE_FOR_GENERIC_WRITE`, never rollout-gated). **No FDH apply route (or any other route) is gated by this rollout key** — confirmed by finding only 3 call sites of `OPERATIONS_G5B_WRITE_CERTIFIED` in the manifest, corresponding exactly to these 3 modules. FDH apply routes use an entirely separate, unrelated `ModuleKey`.

Method: an isolated local dev server instance (never the shared hosted DEV deployment), restarted across 5 distinct configurations (percentage/kill-switch/malformed-config are read once at process start and cannot be live-mutated), real disposable synthetic DEV users, real HTTP through the actual Next.js routes, real DB row-count verification, full cleanup with independent zero-residue re-verification.

| Scenario | Route(s) tested | Result | Evidence |
|---|---|---|---|
| Valid config at 50%, included subject | Income, Expenses, Insurance | **PASS** — CREATE succeeds on all 3, twice (stable) | `g8_verify_live_dev_cohort_killswitch.mjs` phase `p50` |
| Valid config at 50%, excluded subject | Income, Expenses, Insurance | **PASS** — CREATE denied (403) on all 3, twice (stable), zero rows created | same |
| Forged body/header fields (`X-Fhip-Rollout-Percentage: 100`, spoofed user id, `_rolloutOverride`) on excluded subject's request | Income | **PASS** — still denied; forged parameters have zero effect | same |
| AU (FULL) control | Income | **PASS** — completely unaffected by rollout state | same |
| Unconfirmed subject | Income | **PASS** — denied with `COUNTRY_CONFIRMATION_REQUIRED` (a genuinely earlier, different gate), not `WRITE_NOT_CERTIFIED_FOR_GENERIC` — proves MCC denial happens regardless of, and before, any bucket evaluation | same |
| Same version, percentage raised 50%→100%, previously-included subject | Income | **PASS** — remains included (bucket unchanged, monotonic) | phase `p100` |
| Same version, percentage raised 50%→100%, previously-EXCLUDED subject | Income | **PASS** — now admitted (only the threshold moved, bucket unchanged) | phase `p100` |
| Valid config at 0% | Income | **PASS** — a subject included at every prior percentage is now denied; zero rows created | phase `p0` |
| Kill switch OFF (`ROLLOUT_G5B_GENERIC_WRITE_ENABLED` entirely unset), G4/G5B still `true` | Income | **PASS** — both a would-be-included and a would-be-excluded subject denied uniformly | phase `poff` |
| Malformed config (`ENABLED=true`, `PERCENTAGE=150`, out of range) | Income | **PASS** — fails closed (denied), never silently treated as 100%/permit; zero rows created | phase `pmalformed` |

**23/23 checks passed across all 5 phases, plus 1/1 cleanup-residue check = 24/24 total for this script.** Zero residue, independently re-verified after cleanup.

**Jurisdiction-ineligible subject scenario**: not separately live-tested. For the 3 modules this rollout key actually gates, every real, registry-valid country is either FULL (AU/IN, structurally exempt from this rollout key entirely — confirmed by the AU-control result above) or GENERIC (subject to the gate) — there is no third "jurisdiction-ineligible-but-otherwise-valid" state for a universal module like Income/Expenses/Insurance. An invalid/non-existent country code cannot even be stored (FK constraint to `countries(country_code)`), so it can never reach this gate at all. This is reported as a structural non-applicability, not a skipped test.

## 8. Kill-switch and direct-database boundary table

**This is the section the mission specifically warned must not overclaim ("Do not claim an app/API switch revokes direct database permissions if it does not"). Real, live evidence gathered this pass — not inferred from code alone.**

| Access path | Control | Kill-switch effect | Residual capability |
|---|---|---|---|
| UI | Client-side rendering only, no independent enforcement | N/A — UI is not a security boundary | None claimed; all real enforcement is below this row |
| Application API (Income/Expenses/Insurance CREATE/UPDATE) | `requireModuleCapability()` composing G4 → G5B → **rollout (`G5B_GENERIC_WRITE`)** | **Effective, confirmed live** — kill switch off, 0%, or malformed config all deny the request (section 7) | None for CREATE/UPDATE while the switch is off/0%/malformed. DELETE was never available to GENERIC through this path regardless of rollout state (a separate, unconditional manifest rule) |
| RPC | **N/A — no client-callable RPC/stored-procedure endpoint exists** for these 3 tables' CRUD (confirmed: no `.rpc()` call anywhere in `app/api/income`, `app/api/expenses`, `app/api/insurance`, or `lib/services/registry.ts`). The only server-side functions touching these tables are internal enforcement triggers, never directly invocable by a client | N/A | N/A |
| Direct authenticated PostgREST INSERT/UPDATE | Migration `0129`'s DB-layer grant (`is_write_permitted()`/`enforce_write_permitted_g5b()`) — **unconditional once applied, reads no application env var at all** | **NONE. Confirmed live, empirically, this pass** — a real synthetic DEV user's own authenticated (non-service-role) PostgREST client successfully INSERTed and UPDATEd `income_sources` directly, with **no app-layer `ROLLOUT_*`/`G4_*`/`G5B_*` env var set anywhere in the calling process** | **Full INSERT/UPDATE capability remains, regardless of the application-layer rollout/kill-switch state.** This is the residual exposure the mission asked to be surfaced plainly |
| DELETE/archive-via-UPDATE | Migration `0130`/`0147`'s DB-layer block (manifest `DELETE: false` for GENERIC, reclassifying the `is_active` UPDATE transition as a DELETE) | **NONE — but this is the correct, intended direction**: this control **remains blocking** regardless of any application-layer state | Zero — direct archive-via-UPDATE and literal SQL DELETE both confirmed still blocked live, independent of the rollout kill switch |

**Live evidence for the two DB-layer rows** (`scripts/g8_verify_db_layer_rollback_boundary.mjs`, this pass): 6/6 checks passed — direct INSERT succeeds, direct ordinary UPDATE succeeds, direct archive-via-UPDATE blocked (`COUNTRY_CONFIRMATION_REQUIRED`), direct literal DELETE blocked, zero residue.

**Labelled precisely, per the mission's own instruction**: **the G8.055 rollout mechanism is an application/API-exposure control only.** It has no effect on, and was never claimed to have any effect on, a GENERIC user's own direct authenticated database access — that access is governed entirely, unconditionally, and independently by migration `0129` once applied. This is consistent with, not a contradiction of, that migration's own governing code comment (`amplify.yml`'s header explicitly states this exact fact already).

**Is this a blocker?** Only if an approved acceptance requirement demands database-wide revocation via the application-layer rollout switch specifically. No such requirement has been stated anywhere in this programme's specs reviewed this session. **Reported as a named, disclosed scope boundary for Product Owner awareness, not as a defect requiring remediation under this verification-only pass** — per the mission's own instruction not to expand implementation during this pass.

## 9. Focused security regressions (preserved, confirmed unaffected by this pass)

| Control | Status |
|---|---|
| GENERIC ordinary permitted updates still work when included | Confirmed (section 7, all 5 restart phases) |
| GENERIC DELETE remains denied | Confirmed structurally unconditional (never rollout-gated); reconfirmed live in section 8 |
| UPDATE-based archive remains denied under `0147` | Confirmed live, section 8 |
| Cross-tenant operations remain denied | Not re-run this pass (unchanged code path; exhaustively proven in the prior 16/16 production smoke test and the earlier RLS/capability test suites this session — reused per mission instruction not to repeat full regression) |
| AU/IN behavior not unintentionally affected | Confirmed live, section 7 (AU control) |
| MCC-14 account-deletion cascade still works | Not re-run this pass — structurally unaffected: the rollout code touches only CREATE/UPDATE for GENERIC users, never DELETE, and MCC-14's cascade logic lives entirely in a separate DB trigger this session's changes never touch. Reported as a by-inspection, not live-re-tested, conclusion, per the mission's own "do not repeat earlier implementation" instruction |

## 10. Cleanup and configuration-restoration evidence

- All 5 isolated local dev server instances used for section 7 were stopped after their respective phase completed (confirmed via `netstat`/`taskkill` before each restart and after the final phase — no port 390x listener remains).
- The isolated G2 test server (section 5) was likewise stopped after use.
- No shared/hosted DEV deployment's own configuration was touched at any point — every server this pass started was a fresh local `next dev` process holding its own env vars, never the shared DEV Amplify environment.
- 8 synthetic DEV users created this pass (6 rollout candidates + 1 AU control + 1 unconfirmed, in the cohort script; 1 more in the DB-boundary script) — all deleted, independently re-verified via `getUserById()` returning no user for each. **Zero residue.**
- All rows created in `income_sources`/`expense_items`/`insurance_policies` during this pass — all deleted, independently re-verified via count queries returning 0. **Zero residue.**
- No audit-record table exists for Income/Expenses/Insurance CRUD (confirmed by search) — nothing to preserve or accidentally scrub in this area.
- Production rollout configuration: **untouched throughout this entire pass** — confirmed by never issuing any AWS/Amplify write call, and by the AWS credential available to this session having no write permissions for these services in any case.

## 11. Files changed by this verification pass

All local-only commits on `feature/g6-g8-closure-continued`, **not pushed**:

| Commit | File(s) | Nature |
|---|---|---|
| `206f354` | `scripts/g8_verify_live_dev_cohort_killswitch.mjs` (new) | Verification script — 23/23 live-DEV checks |
| `a52581f` | `scripts/g8_verify_db_layer_rollback_boundary.mjs` (new) | Verification script — 6/6 live-DEV checks |
| (this doc, uncommitted at time of writing) | `docs/country-programme/G8_FINAL_VERIFICATION_ONLY_CLOSURE_PASS_2026_09_13.md` (new) | This report |

**Zero application source files, zero migration files, zero configuration files changed.** Confirmed via `git diff --stat 00a3d88..HEAD` showing exactly the 2 script files above before this report's own commit.

## 12. Exact remaining blockers

1. **Deployment-revision confirmation** (section 4) — needs Amplify console/API read access (`amplify:GetApp`/`GetJob`/`ListJobs` for the specific app) that this session's AWS identity does not have.
2. **CloudFront edge cache-policy confirmation** (section 5.4) — needs operator confirmation that CloudFront's own cache behavior for this distribution respects origin `Cache-Control: no-cache` for the dynamic-rendering case, and (separately, lower priority since G2 is currently off) whether `CloudFront-Viewer-Country` injection is actually enabled on this distribution at all.
3. **Application-layer rollout is not a database-wide kill switch** (section 8) — a disclosed scope boundary, not a defect; escalate only if a future acceptance requirement demands DB-wide revocation via this mechanism specifically.

No other blocker was found. Migration `0129` (previously the 3rd named item) is now fully closed (section 6).

## 13. Is G8 terminally complete?

**No.** Two genuine, operator-access-dependent items remain (1 and 2 above). Per the mission's own verdict rules, missing infrastructure evidence is not treated as resolved by documentation.

## 14. Next Product Owner action (only where genuinely required)

1. Grant this session (or a future one) read-only Amplify API access (`amplify:GetApp`, `amplify:ListJobs`, `amplify:GetJob`) scoped to the FHIP app, to close blocker 1.
2. Confirm, via the Amplify/CloudFront console directly, whether `CloudFront-Viewer-Country` injection is enabled for this distribution, and whether its cache policy respects origin `Cache-Control` headers for dynamically-rendered paths — to close blocker 2.
3. No action needed on blocker 3 unless a future requirement specifically demands database-wide rollout revocation.

---

## Closing metrics

- Four closure points passed/total: **2.5 / 4** (Point 3 fully passed; Point 4 fully passed with one disclosed scope-boundary finding, not a failure; Point 2 passed on every application-side check with one operator-access gap remaining; Point 1 blocked on operator access, risk-bounded by zero functional diff)
- Production percentage before/after: **100% / 100% — unchanged**
- Production configuration changes: **0**
- Production writes: **0**
- Migrations changed/applied: **0 changed, 0 applied**
- Live-DEV checks passed/total: **24/24** (cohort/kill-switch script) **+ 6/6** (DB-boundary script) **+ 8/8** (G2 tier checks, informal curl-based, not scripted with pass/fail counters but all matched expected behavior exactly) **= 30/30 formally-counted checks, plus 8/8 additional manual application-tier confirmations**
- Cohort exclusion cases passed/total: **2/2** (50% excluded-denied, 0%-denied)
- Kill-switch cases passed/total: **2/2** (off-denies, restored-via-percentage-raise-admits)
- Cross-tenant bypasses: **0 found** (not re-tested this pass; none found in the prior session's exhaustive testing, reused per instruction)
- DELETE/archive bypasses: **0 found** (reconfirmed live this pass, section 8)
- Synthetic residue: **0** (independently re-verified after every phase)
- Push/merge/deployment actions: **0**
- Remaining G8 blockers: **2** (deployment-revision confirmation; CloudFront edge-policy confirmation) **+ 1 disclosed scope boundary** (application-layer rollout is not a DB-wide switch)
- Final programme verdict: **G8 CONDITIONAL PASS — SPECIFIC VERIFICATION ITEMS REMAIN.** `G8 FULL PASS — COUNTRY PROGRAMME CERTIFIED AND CONTROLLED ROLLOUT COMPLETE` is not awarded this pass.

Production rollout kept at 100% throughout. No push, merge, deploy, infrastructure change, or new workstream was performed under this mission.

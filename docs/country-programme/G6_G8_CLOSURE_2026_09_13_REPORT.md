# G6-G8 Country Programme — Remaining-Work Closure Report (2026-09-13)

**Branch:** `feature/g6-g8-closure-continued` (isolated off `feature/g6-g8-country-programme-closure` — that branch was already checked out in another worktree, so this session created a clearly-named continuation branch rather than reusing it; it carries the entire 34-commit history of `feature/g6-g8-country-programme-closure` plus 3 new commits, see §2 and §17)
**Source mission:** "FHIP G6-G8 — Remaining-Work Closure and Controlled Release" (2026-09-13 dispatch)
**Prior authoritative record:** `docs/country-programme/G6_G7_G8_CONSOLIDATED_REPORT.md` (2026-09-12, commit `169f671`) — **not redone, not reopened**; this report only covers what that report left outstanding.

---

## 1. Executive verdict

> **G6-G8 CONDITIONAL PASS — SPECIFIC CLOSURE ITEMS REMAIN**

Per the mission's own exit-criteria rules, the higher verdicts ("TECHNICAL/DEV FULL PASS — RELEASE CANDIDATE CERTIFIED", the controlled-cohort pass, or terminal closure) are not available here because two real engineering/process items remain even at the DEV level:

1. A pre-existing (not introduced this session) byte-level divergence in the already-applied migration `0129` between this branch and `origin/main` (comment-only, but unresolved) — see §12.3 and §13.
2. Infrastructure evidence this codebase cannot self-provide (CloudFront-Viewer-Country forwarding on the real Amplify distribution; whether the Amplify build actually forwards `G4`/`G5B`/`G2` server-only flags at all — see §10) is still outstanding and requires operator access.

**Environment qualification**: every live claim in this report was made against the real DEV Supabase project (`vqycarelcoijzwlpkpcz`) with real, disposable, non-service-role authenticated sessions, using this worktree's own `.env.local` (copied verbatim from the primary checkout, values never printed or committed). No production write, no production synthetic user, and no migration application of any kind was performed, per this session's authority boundary.

**What this session actually closed, with live proof:**
- The GENERIC currency-path ambiguity (§6 of the mission) — diagnosed precisely (not a currency-validation bug at all) and live-proven 48/48 (24 supported-currency journeys + 24 unsupported-currency rejections).
- A genuine, previously-unproven, live-confirmed security gap: GENERIC users could bypass "Delete unavailable" via a direct authenticated UPDATE (archive bypass) on all three G5B tables. A minimal forward migration (`0147`, **prepared and locally tested only, not applied anywhere**) closes it.
- The canonical G8.055 controlled-rollout primitive — built, unit-tested, and deliberately **not wired into any route**, so its existence cannot regress any current production behaviour.
- A real, previously-undocumented infrastructure risk in `amplify.yml`'s environment-variable forwarding, found by source inspection (§10).

**What remains genuinely open** (all pre-existing, from the mission's own baseline, none of them newly discovered as blocking except where noted): CloudFront verification, the Amplify env-var-forwarding risk (confirmed by source, not by live production evidence), the pre-existing `0129` comment divergence, and the merge/production authorization gates themselves (out of this session's scope by explicit instruction).

---

## 2. Branch, base, HEAD, origin/main, deployed SHA

| Item | Value |
|---|---|
| Working branch | `feature/g6-g8-closure-continued` |
| Forked from | `feature/g6-g8-country-programme-closure` @ `169f671` (identical history up to that point — this branch adds 3 new commits on top) |
| HEAD (this session) | `c27b1fb` |
| `origin/main` | `9793949` |
| Merge base (HEAD, origin/main) | `9793949` — **identical to origin/main's own tip**: origin/main has not advanced since `feature/g6-g8-country-programme-closure` forked from it, so this branch is a clean 37-ahead / 0-behind descendant, modulo the one file-level divergence in §12.3 |
| Divergence | 0 commits on `origin/main`'s side, 37 on this branch's side |
| Deployed production SHA | **Not independently confirmed this session** — no Amplify console/build-log access from this sandbox. The consolidated report's own G5 production certification (19/19, 2026-09-11) implies *some* SHA containing migrations `0129`/`0130` is deployed, but this session cannot name it precisely. Operator action needed (see §17). |
| Working tree | Clean at session start (0 untracked/modified files) and at session end except this session's own 7 new/changed files, all committed |

Why a new branch rather than reusing `feature/g6-g8-country-programme-closure` directly: that branch is checked out in a different, concurrently-locked worktree on this machine (`D:\FHIP\.claude\worktrees\agent-aa9950e39944375fa`), which Git does not allow checking out twice. This is exactly the "genuinely need a new branch for isolation" case the dispatch anticipated; the new branch is named clearly as a continuation and its full history is identical to the source branch up to the fork point (verified: `git rev-parse` of both names matched `169f671` before this session's first commit).

---

## 3. Requirement-to-evidence matrix

### 3.1 G6 (NRI/Multi-Country) — carried forward unchanged from the 2026-09-12 consolidated report

No G6 code, contract, or test was touched this session. Full contract-level evidence is in `G6_G7_G8_CONSOLIDATED_REPORT.md` §3 and is **not re-litigated here** per the mission's own "do not restart completed G6/G7 implementation" instruction. Summary only:

| Requirement | Owner | Evidence | Status | Remaining action |
|---|---|---|---|---|
| India cross-border access for international users | Contracts 7/10 | `g6LiveDevFxCrossBorderCertification.test.ts` | FULL PASS (2026-09-12) | None |
| Supported overseas interests for India-primary users | Contract 2 (`country_code` on income/expense/insurance) | Live-DEV, real rows GB/IN/AE | FULL PASS | None |
| Original and reporting currencies | Contract 3 (FX lineage) | Live-DEV `financial_snapshots` upsert | FULL PASS | None |
| Exchange-rate lineage | Contract 3 | Live-DEV, real `fx_rate_aud_inr`/`fx_rate_date` | FULL PASS | None |
| Domestic vs overseas totals | Contract 5 (`netWorthByCountryConverted`) | Live-DEV hand-calculated oracle, buckets sum to `netWorth` exactly | FULL PASS | None |
| Net worth/cash flow/goals/forecasting reconciliation | Contract 6 (goal-funding conversion) | Live-DEV oracle match | FULL PASS | None |
| Regulatory limitations | Contract 9 (NRI disclaimer cross-check) | Unit + live-DEV | FULL PASS | None |
| Historical preservation | Migration replay (0001→0139, 134/134 clean, both new columns nullable/no-default) | PGlite replay | FULL PASS | None — see §11 for this session's own re-confirmation that 0140-0147 (this session's own new number) does not disturb this |

### 3.2 G7 (Reports/Resources/Disclosures) — carried forward unchanged

No G7 code, contract, or test was touched this session. Full evidence in the consolidated report §4. Summary:

| Requirement | Status | Evidence |
|---|---|---|
| Free and premium reports | FULL PASS | `g7LiveDevReportCertification.test.ts` |
| Primary country, base/reporting currency, reporting date | FULL PASS | Contracts 1-2, live-DEV |
| Domestic/cross-border/consolidated values | FULL PASS | Contract 4, live-DEV |
| Resources filtering | Unaffected — no Resources code touched this session | Carried forward |
| Generic-country regulatory limitations | FULL PASS | Contract 4 blending `limitationText` |
| Appropriate disclosures | FULL PASS | Contract 9 (G6), Contract 4 (G7) |

### 3.3 G8 — this session's actual scope

| Requirement | Implementation owner | Evidence/SHA/environment | Status | Remaining action |
|---|---|---|---|---|
| Visitor/account country matrix | Unchanged, G0-G1/G2 (pre-existing) | Not touched this session | Carried forward (FULL, per consolidated report) | None |
| Manual selector, VPN, missing-location cases | Unchanged, G2 (`landingCountryContext.ts`) | Not touched this session | Carried forward | None |
| Missing-country users | Unchanged, MCC | Not touched this session | Carried forward | None |
| Domestic-feature negative controls | Unchanged, `countryGateAccessMatrix.test.ts` | Full-suite run, this session (see §12) | Carried forward, 1 known pre-existing failure (MC-15, unrelated — see §12.2) | None new |
| Country-change workflow | Unchanged | Not touched | Carried forward | None |
| **Multi-currency reconciliation (GENERIC currency-path ambiguity)** | **This session** | `scripts/g8_generic_currency_journey_live_dev.ts`, live DEV, 48/48 PASS | **RESOLVED — see §6** | None (residual scope-exclusion: no GBP/USD/SGD/AED support authorised or built, by design) |
| Authentication, RLS, production sessions | G8.051 (consolidated report), + this session's own archive-bypass suite | `g8LiveDevRlsCertification.test.ts` (prior) + `g8LiveDevGenericArchiveBypassCertification.test.ts` (this session) | G8.051 FULL PASS; **new archive-bypass gap found and fixed (migration prepared, not applied) — see §7** | PO review + application of migration `0147` |
| Pricing/checkout protection | Unchanged, `paymentsCheckoutRoute.test.ts` | Re-run this session, isolated pass (see §12.2) | Carried forward | None |
| Mobile, accessibility, SEO | G8.053 (consolidated report, 3 real fixes) | Not re-touched | Carried forward for a11y; **SEO/G2 visibility still an open PO scope decision (G8.054), unchanged by this session** | PO decision on G8.054 (a) vs (b) — unchanged from consolidated report |
| DEV, controlled production cohort, full rollout | **This session — G8.055** | `lib/services/rolloutCohort.ts` + `tests/unit/rolloutCohort.test.ts`, 17/17 PASS | **Primitive built and certified; deliberately NOT wired to any feature — see §8** | PO decision on which feature(s) to wire it to and at what percentage |

### 3.4 Explicit gap disclosure (mission section 5's own instruction: "If a substantive requirement is missing beyond this closure scope, record the exact gap and request direction")

- **CloudFront-Viewer-Country verification (G8.060/061)** — genuinely cannot be checked from this sandboxed environment (no AWS/Amplify console or CLI access, no way to inspect the live CloudFront distribution's origin-request policy or cache-key configuration). See §10 for the exact operator checklist this produces instead of invented evidence.
- **Amplify env-var forwarding for G2/G4/G5B flags** — a real, previously-undocumented risk found by source inspection, not confirmed against live production. See §10.
- **G4's live production value** — still not independently reconfirmed (same disclosed gap as the 2026-09-12 report; this session has no way to query it either, for the same reason as CloudFront).
- Neither gap is a silently invented exclusion — both were explicit "cannot verify from here" items named by the mission itself (§10's own "If infrastructure access is unavailable, return exact operator checks... Do not invent proof").

---

## 4. Completed work retained without unnecessary reruns

Per the mission's own instruction not to restart completed implementation:
- G6's 10 contracts, G7's 6 contracts, and their live-DEV certifications: **not re-implemented, not re-run** (the underlying code was not touched this session, so the existing evidence remains valid without a fresh live-DEV pass, per "historical evidence remains valid for unchanged components").
- Migrations `0129`, `0130`, `0138`, `0139`: **read-only** this session (confirmed unchanged in content by this session — except for the pre-existing `0129` divergence discovered, not created, this session — see §12.3). Not re-applied anywhere.
- `G5B_GENERIC_WRITE_ENABLED` production state: not re-tested in production (out of authority — no production writes).
- G8.050/051/053/056/058: not redone. G8.051's own live-DEV suite (`g8LiveDevRlsCertification.test.ts`) was left untouched and unre-run since nothing this session touched `business_entity_liabilities`, `report_access_events`, or `user_entitlements`.

---

## 5. GENERIC currency diagnosis and 24-case result matrix

### 5.1 Diagnosis (mission section 6's four hypotheses)

Traced end-to-end per the mission's own required path (`Confirmed account → Profile currency selection → persisted preferred_currency → new-row defaults → form/grid state → request payload → validation → persisted row → reload/edit`), reading the actual code rather than assuming:

- `lib/validation/{income,expense,insurance}.ts` all hardcode `currency_code: z.enum(['AUD', 'INR'])` — confirmed, unchanged, and **correctly matches the fixed product policy** ("all supported account countries may choose AUD or INR"; GB/US/SG/AE do **not** get GBP/USD/SGD/AED automatically).
- `OnboardingWizard.tsx`'s country→currency seeding (lines 343-360) **already correctly leaves a GENERIC country's `preferred_currency` blank** (`next === 'IN' ? 'INR' : next === 'AU' ? 'AUD' : ''`), forcing an explicit AUD/INR pick, with an inline comment recording that the old `=== 'IN' ? 'INR' : 'AUD'` bug (which would have silently defaulted every GENERIC user to AUD) was already fixed in an earlier phase. **Hypothesis 2 (incorrect client seeding) is FALSE — already fixed.**
- No UI surface anywhere (onboarding, or the Income/Expense/Insurance grid forms) offers GBP/USD/SGD/AED at all — the `<select>` options are hardcoded to exactly `AUD`/`INR` in both places. **A real GENERIC user, using the real app, cannot construct a request containing an unsupported currency at all** — hypothesis 1 (as literally worded, "a request containing an intentionally unsupported native currency") does not describe anything a real UI flow produces; it only describes a forged/direct API call.
- `lib/api/income/route.ts` (and expenses/insurance) take `currency_code` directly from the request body with **no server-side derivation from the user's profile at all** — this is correct and intentional (there is nothing to derive; the user has already explicitly chosen AUD or INR).
- **Hypothesis 3 (a supported AUD/INR request incorrectly rejected) is FALSE**: once the G4/G5B capability gate admits a GENERIC user at all, an AUD/INR submission is never rejected by the currency schema. The real, practical blocker for a GENERIC user today is the **G4/G5B capability gate itself** (a 403 before the Zod schema is ever reached) — which is a deliberate, disclosed, flag-driven rollout gate, not a currency-validation defect. This is **hypothesis 4** ("another unrelated validation failure") in the sense that the true gate is upstream of currency validation entirely.
- **One genuine, narrower, disclosed residual gap** (not itself a live defect, since no client can ever construct the payload that would exploit it): `income_sources`/`expense_items`/`insurance_policies`.`currency_code` carry **no DB-level CHECK constraint** restricting values to AUD/INR (unlike `user_profiles.preferred_currency`, which got one in migration `0127` specifically because a direct PostgREST write could otherwise set an unsupported value). The DB currently accepts any of the 6 seeded `currencies` rows (AUD/INR/USD/GBP/SGD/AED) via the plain FK, relying entirely on Zod for enforcement. **Not fixed this session** (adding a new CHECK constraint to 3 tables was not explicitly authorised by this closure's own scope, and the mission's boundary list forbids "new profile currencies or new FX pairs" without separately authorising new constraint additions either) — named here as a residual, DB-layer-only exposure to a **direct, forged PostgREST write bypassing the app entirely**, which this session's live tests separately confirmed the app itself always rejects (422, zero coercion, zero rows).

### 5.2 Live 24-case + 24-rejection result matrix

Run: `npx tsx scripts/g8_generic_currency_journey_live_dev.ts` against a locally-started `next dev` server with `G4_APP_CAPABILITY_LAYER_ENABLED=true`/`G5B_GENERIC_WRITE_ENABLED=true` set **only in this worktree's own local `.env.local` for the duration of the test run, then reverted** — never touching production. Every account was a real, disposable synthetic DEV user (`admin.auth.admin.createUser` + `signInWithPassword`), confirmed via the real `confirm_country_of_residence`-equivalent field set (including the G3 §7.2 generic-disclosure-acknowledgement columns, which a first run correctly failed against, proving that trigger is live and enforced — see §5.3), never service-role for the actual HTTP requests under test.

| Country | Currency | Income | Expense | Insurance |
|---|---|---|---|---|
| GB | AUD | PASS | PASS | PASS |
| GB | INR | PASS | PASS | PASS |
| US | AUD | PASS | PASS | PASS |
| US | INR | PASS | PASS | PASS |
| SG | AUD | PASS | PASS | PASS |
| SG | INR | PASS | PASS | PASS |
| AE | AUD | PASS | PASS | PASS |
| AE | INR | PASS | PASS | PASS |

**24/24 create → reload → edit → reload journeys PASS**, currency preserved verbatim through every step, zero coercion.

Unsupported-native-currency rejection (each country's own real native currency — GBP/USD/SGD/AED — attempted against both the AUD-profile and INR-profile account for that country, across all 3 modules = 24 cases, exceeding the mission's own 12-case minimum):

**24/24 rejections PASS** — HTTP 422, zero rows created, zero coercion, verified via an independent service-role row-count check before/after each attempt.

**Total: 48/48 PASS, zero synthetic residue** (independently re-verified: 0 auth.users rows, 0 rows in any of the 3 tables, after cleanup).

### 5.3 A real trigger discovered and correctly satisfied, not bypassed

The first attempt at this certification failed all 8 account-setup steps with `GENERIC_DISCLOSURE_ACKNOWLEDGEMENT_REQUIRED` (migration `0127`'s `enforce_generic_disclosure_acknowledgement()` trigger) — proving this genuinely-live database trigger cannot be bypassed by a naive service-role profile PATCH that only sets `country_of_residence`/`country_confirmed_at`. The certification script was corrected to also set the three `generic_disclosure_*` columns together (as the trigger requires), which is legitimate account-setup seeding via service role (a role this trigger's sibling `enforce_controlled_confirmation_columns()` trigger explicitly exempts from its own authenticated-only controlled-workflow check) — never a bypass of the behaviour under test, which remained entirely driven through the real app with each user's own authenticated session throughout.

---

## 6. DELETE/archive enforcement evidence

### 6.1 Inventory (mission section 7)

- `income_sources`/`expense_items`/`insurance_policies` all carry `is_active boolean default true` since migration `0003`; **no `deleted_at` or `status` column exists**.
- The app's own "delete" (`registry.archive()`, called from each module's `DELETE /api/.../[id]` route) is **implemented as `UPDATE ... SET is_active = false`**, never a literal SQL `DELETE`.
- Migration `0129`'s manifest (`mcc_generic_write_capabilities`) correctly seeds `DELETE = false` for GENERIC on all three tables. The app's own capability layer (`appCapability.ts`'s `OPERATIONS_G5B_WRITE_CERTIFIED`) correctly maps the app's `DELETE` route to `'UNAVAILABLE_FOR_GENERIC_WRITE'` for GENERIC.
- **The gap**: neither the DB trigger (`enforce_write_permitted_g5b()`, pre-fix) nor the single RLS policy (`FOR ALL using (auth.uid() = user_id)`, no column restriction) distinguished "an UPDATE that changes `amount`" from "an UPDATE that changes `is_active`". `is_write_permitted()` unconditionally permits GENERIC UPDATE on all three tables. Nothing before this session's fix stopped a GENERIC user's own direct authenticated PostgREST client from archiving (or bulk-archiving) their own rows — fully equivalent to the delete the app's UI/route explicitly withholds from them.
- No bulk-archive endpoint exists in the app itself; the bulk-attack vector tested is a direct `.in()` PostgREST filter, which hits the exact same trigger path as a single-row UPDATE.
- No RPC (`fdh9_apply_income_proposal`, the payslip-apply sibling) can touch `is_active` — both have hard allow-lists of writable columns that exclude it.

### 6.2 Live-DEV attack matrix (`tests/live-dev/g8LiveDevGenericArchiveBypassCertification.test.ts`, real DEV, real disposable non-service-role sessions)

| Attack | Table(s) | Pre-fix result | Post-fix result (migration `0147`, PGlite-verified only, see §6.3) |
|---|---|---|---|
| Ordinary permitted field UPDATE (positive control) | all 3 | Succeeds | Succeeds (unaffected) |
| HTTP-DELETE-equivalent literal DELETE via authenticated PostgREST | all 3 | **Blocked** (already correct, pre-existing) | Blocked (unaffected) |
| **UPDATE-based archive bypass (`is_active` true→false)** | all 3 | **SUCCEEDED — confirmed exploitable, live** | **Blocked** (PGlite-verified) |
| Bulk UPDATE-based archive (`.in()`) | all 3 | **SUCCEEDED — confirmed exploitable, live** | **Blocked** (PGlite-verified) |
| Ownership forgery (cross-tenant archive attempt) | all 3 | **Blocked** (already correct, pre-existing — RLS ownership) | Blocked (unaffected) |
| Cross-tenant impersonation-INSERT | all 3 | **Blocked** (already correct) | Blocked (unaffected) |
| Genuine account-deletion cascade | all 3 | Succeeds | Succeeds (PGlite-verified, unaffected) |
| service_role write | income_sources | Succeeds unconditionally | Succeeds unconditionally (unaffected) |

The live-DEV test file (run against real DEV, migration `0147` **not applied there**) intentionally documents the pre-fix "SUCCEEDED" result as the currently-true state on real DEV/production infrastructure today, with an explicit in-line comment naming it a known gap — it does not silently pass over a defect it found.

### 6.3 Remediation: migration `0147` (prepared, PGlite-tested, NOT applied)

`supabase/migrations/0147_g8_generic_archive_bypass_fix.sql` (renumbered from an initial `0140` — see §12.3 for why) modifies only `enforce_write_permitted_g5b()`: when an UPDATE specifically flips `is_active` from `true` to `false`, the trigger now re-asks `is_write_permitted()` using the operation string `'DELETE'` instead of `'UPDATE'`, reusing the already-correct `DELETE = false` manifest entry. No change to `is_write_permitted()` itself, the manifest table, its seeded rows, or any RLS policy. Re-activation (`false → true`) and every other field UPDATE are untouched. FULL/AU/IN users and `service_role` are unaffected (both bypass this check earlier in `is_write_permitted()`'s own logic). The MCC-14 DELETE-cascade exemption is evaluated first and is completely untouched — this fix cannot weaken it, only adds a narrower classification for the ordinary (non-cascade) UPDATE path.

**Verified via a fresh, full local PGlite replay of every migration `0001` → `0147` (135/135 files replay cleanly), plus 11 targeted checks** (`scripts/g8_0147_archive_bypass_pglite_certification.mjs`): ordinary UPDATE still succeeds; archive-transition UPDATE is now blocked (single and bulk); re-activation still succeeds; a FULL (AU) user's archive-transition UPDATE is unaffected; literal DELETE for GENERIC remains blocked; the genuine account-deletion cascade (auth.users DELETE, MCC-14 exemption) still succeeds and cascades all three tables cleanly; `service_role` is unaffected. **11/11 PASS.**

**This migration has NOT been applied to DEV or production** — it is prepared and locally tested only, per this session's explicit authority boundary ("Prepare and test the migration locally, then stop for review"). **Stops here for Product Owner review before any application.**

---

## 7. Controlled-rollout design and canonical owner

### 7.1 Investigation result

No reusable percentage/cohort/hash-allocation primitive exists anywhere in this codebase. The one candidate, `ai_model_registry.rollout_percentage` (migration `0110`), is dead code: written by exactly one admin route, read by nothing, scoped to AI-model traffic-splitting with **no user-key column at all** (so it cannot express "this user is in the cohort"), and governance-locked to admin/service-role. Per the mission's own explicit instruction, **it is not reused**.

### 7.2 What was built

`lib/services/rolloutCohort.ts` — a new, generic, reusable primitive:

| Required behaviour | Implementation |
|---|---|
| Global kill switch | `ROLLOUT_<KEY>_ENABLED` must be the exact string `'true'`; anything else fails closed |
| Stable authenticated subject allocation | SHA-256 hash of `key\|version\|subjectId`, first 4 bytes mod 100 — deterministic, no `Math.random()`, no session state |
| Configurable percentage | `ROLLOUT_<KEY>_PERCENTAGE`, validated integer 0-100 |
| Explicit configuration version | `ROLLOUT_<KEY>_VERSION`, required non-empty string; the bucket is a function of (key, version, subjectId) — **not** percentage — so raising the percentage with version fixed provably only ever adds subjects (proven by test: `at10 ⊆ at30 ⊆ at70`), never reshuffles. Changing the version is the only deliberate re-bucket (also proven by test). |
| Secure certification allowlist | `ROLLOUT_<KEY>_ALLOWLIST`, comma-separated subject ids, server-configured only |
| Explicit denylist precedence | `ROLLOUT_<KEY>_DENYLIST`, checked before allowlist and before the percentage bucket — proven to override even an allowlisted subject |
| Fail closed on malformed config | Missing/empty version, non-integer/out-of-range/empty-string percentage, or `ENABLED` not exactly `'true'` all resolve to excluded — never a thrown error, never a silent 100% |
| No client-controlled identity/percentage/inclusion | The public API (`resolveRolloutDecision`/`isRolloutPermitted`) takes exactly 2 parameters, `(key, subjectId)` — no request/header/cookie is ever read internally; the caller must pass a server-resolved id |
| Stable across requests/devices/sessions | Pure function of its 3 real inputs, no per-request state |
| Country eligibility independent / no currency-derived jurisdiction | No country or currency parameter exists in the module's surface at all — verified directly by a unit test asserting the function arity |
| Server-side enforcement | Plain server-only TypeScript; a caller enforces it the same way it already enforces `requireModuleCapability()` |

**17/17 unit tests pass** (`tests/unit/rolloutCohort.test.ts`), including a distribution-uniformity check (a 2,000-subject sample at 50% lands within 40-60%) and the monotonic-expansion property across a 300-subject sample at 10%/30%/70%.

### 7.3 Scope inventory — exactly which behaviours this rollout controls today

**Nothing.** This primitive is deliberately **not wired into any existing route** by this closure work. Explicitly, by category (mission's own required breakdown):

| Category | Controlled by this new primitive? |
|---|---|
| Existing production features | No |
| New G6/G7 behaviour | No |
| G5B GENERIC write access | No — still governed entirely by `G5B_GENERIC_WRITE_ENABLED`/`G4_APP_CAPABILITY_LAYER_ENABLED`, unchanged |
| G4 capabilities | No — unchanged |
| Anonymous landing presentation | No — unchanged, still governed by `G2_LANDING_LOCALISATION_ENABLED` |

This is a deliberate choice, not an oversight: the mission explicitly warns against "accidentally turn[ing] off existing production functionality merely because a new rollout defaults to zero." Since every existing feature is currently gated only by its own pre-existing boolean flag, wiring this primitive into any of them today — with no `ROLLOUT_<KEY>_*` variables configured anywhere — would immediately gate that feature behind an unconfigured (fail-closed) 0% cohort the moment this code shipped, which would be exactly the regression the mission warns against. **Wiring this primitive into a specific real feature, and choosing that feature's actual rollout percentage, version, and allowlist, is an explicit, separate Product Owner decision this closure work does not make unilaterally.**

### 7.4 Composition rule (for whenever a future change does wire it in)

```
Authenticated and country-confirmed
AND jurisdiction/module/operation eligible
AND rollout permits exposure
AND kill switch is not active
```
i.e. `isRolloutPermitted()`/`resolveRolloutDecision()` is called strictly **after** a route's existing auth + MCC + capability gates (exactly where `isG5BGenericWriteEnabled()` is consulted today, as the final narrowing check inside `appCapability.ts`'s decision chain) — never before, and never able to grant access those gates deny. It has no code path that could override RLS, MCC, capability rules, or entitlement, since it touches no table, policy, or gate of its own.

---

## 8. App/API/database rollout and rollback matrix

Per the mission's own instruction not to claim an application kill switch stops direct PostgREST writes unless proven — this table states the true, proven state for the three GENERIC-write tables, unchanged by this session except where marked:

| Path | App gate | DB gate | Kill-switch (`G5B_GENERIC_WRITE_ENABLED=false`) effect | Residual exposure |
|---|---|---|---|---|
| Browser → Next.js API route (INSERT/UPDATE, non-archive) | `requireModuleCapability` → `G4`/`G5B` flags | `is_write_permitted()` (`0129`) | **Fully effective** — the app-layer route itself refuses the request before any DB call | None |
| Browser → Next.js API route (DELETE) | Hard-blocked for GENERIC (`UNAVAILABLE_FOR_GENERIC_WRITE`), independent of `G5B` flag | `is_write_permitted()` returns `false` for GENERIC DELETE regardless | N/A — already denied at both layers | None |
| Direct authenticated PostgREST (INSERT/UPDATE, non-archive) | **Not reachable — no app gate exists for a non-app client** | `is_write_permitted()` — **unconditionally permits GENERIC UPDATE once migration `0129` is applied, independent of the app flag's state** | **No effect** — flipping the env var only stops the Next.js app's own routes from constructing a request; it does not revoke the DB grant | A GENERIC user can always write ordinary fields directly, by design (this is the intended universal-write capability) |
| **Direct authenticated PostgREST (UPDATE flipping `is_active`, i.e. archive)** | Not reachable | **Pre-`0147`: unconditionally permitted (bug). Post-`0147` (not yet applied): reclassified as DELETE, denied.** | No effect either way (DB-layer only) | **Pre-`0147`, live today: a GENERIC user can silently archive/bulk-archive their own rows, bypassing "Delete unavailable" entirely** — closed by migration `0147`, not yet applied |
| Direct authenticated PostgREST (literal DELETE) | Not reachable | MCC-14-exempt only for account-deletion cascade; otherwise denied | No effect (DB-layer only) | None — already correctly denied |
| Genuine account-deletion cascade | N/A (platform-level `admin.deleteUser`) | `_mcc_auth_user_exists()` exemption, unconditional | N/A | None — proven unaffected by `0147`, both live-DEV (pre-fix state) and PGlite (post-fix state) |
| `service_role` (any operation) | N/A | Bypasses `is_write_permitted()` entirely (first line of the function) | N/A | Unchanged, by design — trusted server-side operations only |

### 8.1 Rollback, defined separately per layer (mission's own required breakdown)

- **UI exposure**: fully reversible by `G4_APP_CAPABILITY_LAYER_ENABLED=false` (falls back to legacy `requireCountryConfirmedUser()` byte-for-byte) or `G5B_GENERIC_WRITE_ENABLED=false` alone (once G4 is on) — zero one-way side effects, confirmed by the existing unit-test suite (`appCapability.test.ts`, `g5bWriteFlag.test.ts`).
- **API access**: identical to UI exposure — the same flags gate the same Next.js routes a browser calls.
- **Direct database writes**: **not controlled by either flag at all**. The only real rollback is migration `0129`'s own documented rollback SQL block (drop the trigger / revert `is_write_permitted()`), a manual, reviewed DB operation — this asymmetry is disclosed in both `g5bWriteFlag.ts`'s header and (now, after the G8.056 fix already applied on this branch) migration `0129`'s own header, per the earlier session's cross-reference fix.
- **Derived outputs** (e.g. a dashboard total computed from a GENERIC-written row): unaffected by any of the above flags once the underlying row exists — reversing exposure does not retroactively alter or delete data already written, by design (never delete records created during rollout, per the mission's own instruction).
- **Schema**: rollback is migration `0129`'s own documented block; migration `0147` (once applied) has its own symmetric rollback documented in its own file header (revert `enforce_write_permitted_g5b()` to the `0130` body).
- **Historical snapshots**: not affected by any of this session's changes; G6 Contract 3's FX-lineage snapshots were separately proven unchanged by "current FX/country changes" in the 2026-09-12 report and nothing this session did touches `financial_snapshots`.

### 8.2 Presentation vs. write-access cohort labelling

Since the new rollout primitive is not wired to anything (§7.3), there is currently no "cohort" of any kind active in this codebase — so the mission's "label it presentation cohort, not write-access cohort" instruction has no live case to apply to yet. This will need to be revisited precisely, by category, the moment any future change actually wires `rolloutCohort.ts` into a route.

---

## 9. G4/G5B and other effective production flag values

**Not independently reconfirmed against live production this session** (no Amplify console/database-settings access from this sandbox — consistent with the 2026-09-12 report's own disclosed gap for G4). What this session *can* state, from source inspection alone:

| Flag | Default (unset) | Fails closed on misconfiguration? | Evaluated at build time or runtime? | This session's own new finding |
|---|---|---|---|---|
| `G2_LANDING_LOCALISATION_ENABLED` | OFF | Yes | Runtime (`process.env` read fresh per call, never `NEXT_PUBLIC_*`) | **Possibly never reaches production `process.env` at all — see §10** |
| `G4_APP_CAPABILITY_LAYER_ENABLED` | OFF | Yes | Runtime | Same risk |
| `G5B_GENERIC_WRITE_ENABLED` | OFF | Yes | Runtime | Same risk |
| `G2_ALLOW_TEST_DETECTION_HEADER` | OFF | Yes | Runtime | Same risk |
| `FDH_DOCUMENT_UPLOAD_ENABLED` | **ON** (inverted default — only `'false'` disables it) | Yes | Runtime | Same risk in principle, but the ON default and the separate hard `isKnownNonProductionSupabaseProject()` code-level check make this much lower-consequence |

All five are plain boolean flags — none has any percentage/cohort logic (confirmed by the same investigation that fed §7.1).

---

## 10. CloudFront, caching, and SEO evidence

### 10.1 CloudFront-Viewer-Country — cannot be verified from this environment

This sandbox has no AWS/Amplify console access, no CLI credentials scoped to the CloudFront distribution, and no way to inspect live origin-request policies, cache-key configuration, or actual header forwarding on the deployed distribution. Per the mission's own instruction ("If infrastructure access is unavailable, return exact operator checks and remain conditional for that evidence. Do not invent proof"), here is the exact operator checklist instead:

1. In the AWS CloudFront console, open the distribution serving `app.financialhealthplatform.com` → **Behaviors** → the default (or app) behavior → confirm its **Origin request policy** (or legacy "Cache and origin request settings") explicitly whitelists the `CloudFront-Viewer-Country` header for forwarding to the origin. (By default, CloudFront does **not** forward this header unless a policy explicitly includes it under "Origin request headers" or the managed `AllViewer`-family policy is in use.)
2. Confirm the **Cache policy** either includes this header in its cache key (if per-country caching is intended) or explicitly does not (if a single cached response should serve all countries and country-specific personalisation happens entirely server-side, post-cache) — the two choices have very different cache-poisoning implications and only one can be correct for this app's actual design.
3. With a real browser (or `curl`) hitting the production URL, confirm the header is genuinely present server-side (e.g. via a temporary debug log in `landingCountryContext.ts`, removed afterward) — a forwarded header from the console configuration is not proof it survives to the Next.js server's actual request object under Amplify's specific hosting compute model.
4. Confirm the **precedence rules already implemented in code** hold true against a forged header: `landingCountryContext.ts`'s own waterfall (manual selection > confirmed account > CloudFront header > default) needs the manual/confirmed-account precedence tested against a *deliberately wrong* `CloudFront-Viewer-Country` value sent by an ordinary browser dev-tools header override — this is a client-side test any operator can run without special access, and this session recommends it as a next concrete step but did not run it (it requires the real deployed app, not local DEV, to prove the actual precedence order survives real infrastructure, not just unit-tested logic).
5. Confirm no code path ever writes the literal string `'GLOBAL'` into `user_profiles.country_of_residence` (grep confirms `landingCountryContext.ts` only ever uses a `'GLOBAL'`-shaped bucket for the anonymous *presentation* layer, never for account storage — this part **was** confirmed via source inspection, unchanged from the consolidated report).

### 10.2 Amplify env-var forwarding — a new, real, source-confirmed risk

`amplify.yml`'s `build` phase forwards server-only environment variables into `.env.production` via a **fixed, hand-maintained grep list**:
```
env | grep -e SUPABASE_SERVICE_ROLE_KEY -e CRON_SECRET -e APP_BASE_URL -e RESEND_API_KEY -e CONTACT_FROM_EMAIL >> .env.production
env | grep -e NEXT_PUBLIC_ >> .env.production
```
Confirmed by full git history (`git log -p -- amplify.yml`) that this file has been touched exactly once, at its creation — **the grep list has never been updated** to add `G4_APP_CAPABILITY_LAYER_ENABLED`, `G5B_GENERIC_WRITE_ENABLED`, `G2_LANDING_LOCALISATION_ENABLED`, or `G2_ALLOW_TEST_DETECTION_HEADER`, on this branch **or on `origin/main`**. Per the build script's own header comment (written by an earlier session after diagnosing exactly this class of bug for `SUPABASE_SERVICE_ROLE_KEY`/`CRON_SECRET`/`APP_BASE_URL`/`RESEND_API_KEY`/`CONTACT_FROM_EMAIL`), a Next.js server route on Amplify has **no access to console-configured environment variables unless they are `NEXT_PUBLIC_*` or explicitly written into `.env.production` by this build script** — meaning setting any of these four flags in the Amplify console alone may have **zero effect at runtime**, regardless of what the console shows.

**This has not been confirmed as an active production incident** — this session has no access to the real Amplify build logs or a live production `process.env` dump. It is reported as a precise, checkable, previously-undocumented risk (documented now in `ENVIRONMENT_VARIABLES.md`), with two possible resolutions an operator needs to choose between: (a) the grep list genuinely needs updating before any of these flags can ever take effect in production, or (b) Amplify's specific Next.js hosting compute forwards console env vars through some other mechanism this repo's own build-script comment does not describe (in which case the comment itself is stale and should be corrected).

**This also reframes part of the 2026-09-12 report's own G5 evidence**: if (a) is true, then the "G5B ON in production, 19/19 GENERIC writes succeeded" certification must have exercised the **database layer** directly (a real authenticated session calling PostgREST, independent of whether the Next.js server ever read `G4`/`G5B` as `true`) rather than proving the flags themselves are live in the deployed Next.js process — which is fully consistent with that report's own "SCOPED PASS... DB-LAYER... not a full end-to-end GENERIC user journey" framing, and is a reason this session takes that framing at face value rather than reopening it.

### 10.3 SEO

Unchanged from the consolidated report and `g8-ownership-decisions.md`'s G8.054: the AU/IN/Global landing variants remain invisible to search engines by design (no hreflang, single crawlable URL, cookie/header-gated content). This is an unresolved, named Product Owner scope decision (visitor-experience-only vs. real crawlable per-country paths), not something this session decides or re-derives.

---

## 11. G6/G7 regression and historical preservation

No G6 or G7 code was touched this session. The full unit suite run (§12) included every G6/G7-related test file with **zero new failures attributable to this session's changes** (the one new test file this session added, `rolloutCohort.test.ts`, is fully independent of G6/G7 code; the migration-collision guard failure in §12.3 concerns migration `0129`, pre-dating this session). Historical FX-lineage snapshots, cross-border relationship lifecycle, country-change workflow, and recommendation-country negative controls are therefore unaffected and their existing 2026-09-12 certification stands without a fresh live-DEV rerun, per the mission's own "historical evidence remains valid for unchanged components" rule.

---

## 12. Verification commands, exit codes, and failed-file accounting

All commands run from this worktree, sequentially (per the mission's own instruction, to avoid this machine's previously-observed contention).

### 12.1 TypeScript / ESLint

```
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
```
Exit code: **0**. Zero errors. (One false alarm along the way: a stale, mid-write `.next/dev/types/routes.d.ts` from a dev server killed mid-generation produced 51 syntax errors; deleting `.next` and rerunning resolved it cleanly — not a real code defect.)

```
node node_modules/eslint/bin/eslint.js <every file this session touched>
```
Exit code: **0** on all `.ts`/`.mjs` files touched this session (`lib/services/rolloutCohort.ts`, `tests/unit/rolloutCohort.test.ts`, `tests/live-dev/g8LiveDevGenericArchiveBypassCertification.test.ts`, `scripts/g8_generic_currency_journey_live_dev.ts`, `scripts/g8_0147_archive_bypass_pglite_certification.mjs`). `ENVIRONMENT_VARIABLES.md` produced only the expected "no matching configuration" warning for a Markdown file (harmless).

### 12.2 Full unit suite

```
node node_modules/vitest/dist/cli.js run
```
Result: **6418 passed / 5 failed (test cases) / 23 skipped, out of 6446 total; 290 files passed / 14 files failed / 2 skipped, out of 306 total.**

Failed-file accounting, individually investigated (not lumped together):

| File | Failure | Pre-existing (per 2026-09-12 baseline) or new? | Disposition |
|---|---|---|---|
| `tests/unit/aiResidualClosureFailClosed.test.ts` (A4) | Named negative-control test | **Pre-existing**, named explicitly in the 2026-09-12 report | Unrelated to this session |
| `tests/unit/countryGateAccessMatrix.test.ts` (MC-15) | Account-deletion route doesn't exist yet | **Pre-existing**, named explicitly in the 2026-09-12 report | Unrelated to this session |
| 9 `tests/unit/resources*LiveDev.test.ts` / `resources*.test.ts` files | Whole-file failures | **Pre-existing**, named explicitly in the 2026-09-12 report as the standing `.env.local` BOM-corruption limitation on this machine | Unrelated to this session |
| `tests/unit/paymentWebhookRoutes.test.ts` | 1 test timed out (5000ms) | **New in the full-suite run, but re-run in isolation immediately: 16/16 PASS** | Confirmed flaky under this machine's load at the time (a dev server, a live-DEV certification script, and the full suite were briefly overlapping) — not a real regression |
| `tests/unit/paymentsCheckoutRoute.test.ts` (NEG-01) | 1 test failed | Same as above — **re-run in isolation: 16/16 PASS (both payment files together)** | Confirmed flaky under load, not a real regression |
| `tests/unit/migrationVersionsCrossBranch.test.ts` | Cross-branch collision guard: `origin/main`'s `0129` has different byte content than this branch's `0129` | **Pre-existing** (present in the branch before this session's first commit — confirmed by diffing before vs. after; the divergence is a comment-only addition from the earlier session's G8.056 fix, see §12.3) | Flagged precisely for the merge gate — not fixed this session (touching `0129` is outside this session's authority) |

**Established pre-existing baseline vs. this session**: the 2026-09-12 report's own baseline was "6404 passed / 2 failed / 23 skipped... a further 9 file-level failures" = 11 named failing signatures. This session's full run reproduces exactly those 11, plus the newly-investigated `migrationVersionsCrossBranch` failure (pre-existing but not previously named as a "failure" in the consolidated report's own count — it may not have been run in that exact form before, or `origin/main` genuinely had not diverged from this branch's `0129` copy until whatever commit introduced the difference), plus 2 transient flaky failures confirmed non-reproducing in isolation. **This session introduced zero new genuine test failures.**

### 12.3 Migration replay and the `0140`→`0147` rename

```
node scripts/g8_0147_archive_bypass_pglite_certification.mjs
```
Fresh PGlite replay of **every** migration `0001` → `0147` (135 files): **135/135 apply cleanly**, then 11/11 targeted checks pass (§6.3).

**Why the new migration is numbered `0147`, not `0140`**: this session initially wrote it as `0140`. A repo-wide history search (`git log --all --diff-filter=A -- supabase/migrations/014*`) found that the in-flight `feature/aie-1-*` programme (referenced in the user's own memory index — AIE-1.1/1.2/1.3, not merged) already claims migration numbers `0140` through `0146` across its branches. This is a real, confirmed cross-branch collision risk, of exactly the kind this repo's own collision-guard tooling exists to catch. The file (and its accompanying PGlite certification script) was renamed to `0147` — confirmed clear via the same history search — and the full PGlite replay + targeted checks were re-run afterward with identical 11/11 PASS results.

**The one genuinely pre-existing collision** (unrelated to this session's own new migration, and not fixable by this session): `origin/main`'s copy of migration `0129_g5b_generic_universal_module_write_enablement.sql` has **different byte content** than this branch's copy. Diffed precisely:
```
diff origin/main:0129 HEAD:0129
348a349,358
> [10 lines, all SQL comments — the G8.056 "OPERATIONAL WARNING" cross-reference
>  to the rollback asymmetry, described in the 2026-09-12 report's own G8.056
>  section as already implemented]
```
This is a **single, clean, additive, comment-only** divergence — no executable SQL differs at all. It was introduced by an earlier session's already-completed G8.056 work (not this session), and this session did not touch migration `0129` in any way. Since `0129` is already applied to DEV/production with the **original** (comment-less) content, this divergence does not represent any behavioural drift between what is deployed and what either branch's file says — but it does mean `tests/unit/migrationVersionsCrossBranch.test.ts`'s strict byte-identity guard (deliberately, by design, treating "same filename, different content" as an unconditional failure, per that test's own `(b2)` case) will fail until this is explicitly reconciled at the merge gate — either by accepting the comment-only update into `main` (safe, since no re-application is needed for a comment change) or by some other explicit Product Owner call. **Not resolved by this session, since resolving it means touching an already-applied migration file, which is outside this session's authority without explicit sign-off on the specific resolution.**

### 12.4 Flag-off / enabled-cohort builds, live rollout/kill-switch tests

- Flag-off unit coverage: `appCapabilityFlag.ts`/`g5bWriteFlag.ts`/`landingLocalisationFlag.ts`'s own existing unit suites (`appCapability.test.ts`, `g5bWriteFlag.test.ts`, `g2LandingLocalisationFlag.test.ts`) all pass unchanged (part of the full-suite run, §12.2).
- Enabled-cohort build: this session's own local dev-server run, with `G4_APP_CAPABILITY_LAYER_ENABLED=true`/`G5B_GENERIC_WRITE_ENABLED=true` set only in this worktree's `.env.local` for the duration of the currency-journey certification (§5), reverted afterward — confirmed the app builds and serves correctly with both flags on.
- Live rollout allocation / kill-switch tests: `tests/unit/rolloutCohort.test.ts`, 17/17 PASS (§7.2) — this is unit-level (deterministic hash function), not live-DEV, since the primitive is not wired to any live route yet (§7.3) and there is therefore no live endpoint to certify it against.
- Live app/API/database agreement tests: this session's own `g8LiveDevGenericArchiveBypassCertification.test.ts` is exactly this — proving the app-layer intent ("Delete unavailable") and the database-layer reality (pre-fix: permitted; post-fix: denied) actually agree, at the DB layer, live.

### 12.5 Responsive / accessibility / keyboard checks

**Not run this session.** No UI, component, or CSS file was touched by this session's work (the currency and archive-bypass fixes are entirely server-side/database; the rollout primitive has no UI surface at all). G8.053's 3 accessibility fixes (from the 2026-09-12 report) were not re-touched or re-verified, per "refresh evidence only where affected by reconciliation or closure changes" — nothing this session did affects them.

### 12.6 Secret/conflict/diff scans

`git status --short` confirmed a clean working tree at session start and end (all changes committed); no merge conflict markers introduced (no merge was performed); no credential values from `.env.local` appear in any committed file (`git diff`/`git show` reviewed for every commit before it was made — the values themselves were never echoed to the terminal by this session either, only used in-memory by test/certification scripts that read the file directly).

---

## 13. Migration status, checksums, and the new forward migration

| Migration | Status | Applied where | This session's relation to it |
|---|---|---|---|
| `0129`, `0130`, `0138`, `0139` | Already live in DEV and production (per baseline) | DEV + production | Read-only. One pre-existing, comment-only divergence in `0129` discovered (not created) — see §12.3. |
| **`0147`** | **Prepared, PGlite-tested (135/135 replay clean, 11/11 targeted checks pass), NOT applied anywhere** | Nowhere | **New this session.** Renumbered from an initially-chosen `0140` after discovering a real cross-branch collision with the in-flight AIE-1 programme (§12.3). Stops for Product Owner review before any application, per this session's explicit authority boundary. |

No other migration was modified, reverted, or renumbered by this session.

---

## 14. Synthetic cleanup and genuine-data preservation

Every live-DEV script/test this session ran (`g8_generic_currency_journey_live_dev.ts`, `g8LiveDevGenericArchiveBypassCertification.test.ts`) used exclusively real, disposable, timestamp-tagged synthetic users (`g8cur-*`, `g8arch-*` email prefixes) and independently re-verified zero residue after cleanup in every run — reported explicitly in each run's own console output (`"Zero residue confirmed"` in every case this session executed). No genuine user, account, or financial record was read, modified, or touched at any point (every operation this session performed against real DEV Supabase was scoped to a `user_id` created and owned by that same run). No production database was touched by any operation this session performed — confirmed by the hard DEV-project-ref guard (`vqycarelcoijzwlpkpcz`) present in every script/test this session wrote, which throws immediately if pointed at any other project.

---

## 15. Remaining issues, accepted exclusions, and owners

| Item | Status | Owner / next action |
|---|---|---|
| Migration `0147` (archive-bypass fix) | Prepared, locally tested, not applied | **Product Owner**: review and authorise DEV application via the established manual process |
| Pre-existing `0129` comment-only divergence vs. `origin/main` | Diagnosed, not fixed | **Product Owner / merge-gate reviewer**: decide how to reconcile (accept the comment update into `main`, or another explicit resolution) before merge |
| CloudFront-Viewer-Country forwarding | Cannot verify from this sandbox | **Operator with AWS/Amplify console access**: run the 5-step checklist in §10.1 |
| Amplify env-var forwarding for `G2`/`G4`/`G5B` flags | Real risk found by source inspection, not confirmed live | **Operator with Amplify console/build-log access**: confirm whether `amplify.yml`'s grep list needs updating, per §10.2 |
| G4's live production value | Not independently reconfirmed | Same operator access needed as above |
| G8.054 (SEO scope: visitor-experience-only vs. real crawlable per-country paths) | Unchanged open PO decision from the 2026-09-12 report | **Product Owner** |
| GB/US/SG/AE native-currency support (GBP/USD/SGD/AED) | **Explicitly out of scope, by design** — not a defect. The fixed product policy is AUD/INR-only for every account country. | No action — named here only so this accepted exclusion is never later mistaken for a silent gap |
| `income_sources`/`expense_items`/`insurance_policies`.`currency_code` DB CHECK constraint gap (§5.1) | Disclosed, not fixed (no live client can exploit it; only a direct forged PostgREST write could) | **Product Owner**: decide whether this residual DB-layer gap warrants its own forward migration (mirroring `0127`'s `user_profiles` fix), given it was not explicitly authorised in this closure's scope |
| Wiring `rolloutCohort.ts` into any real feature | Not done, deliberately | **Product Owner**: choose which feature(s), at what percentage, version, and allowlist — a separate decision from building the primitive itself |
| Responsive/accessibility/keyboard checks at the mission's specified breakpoints | Not run this session (no UI touched) | None needed unless a future change touches UI |

---

## 16. Merge/deployment/production authorization history

- No merge has been performed. No push has been performed. No production deployment or configuration change has been made.
- This closure branch (`feature/g6-g8-closure-continued`) remains local-only in this worktree, 37 commits ahead of `origin/main`, 0 commits behind.
- **If `main` is ever pushed to** (after explicit merge authorization), this repository's Amplify hosting **auto-deploys on push to `main`** (per the user's own standing deployment-plan memory) — any merge approval must account for this: merging is not a passive, deploy-later action here.
- Per this session's explicit authority boundary, this report **stops here** rather than requesting or performing that merge.

---

## 17. Exact next Product Owner action

This session is stopping at the mission's own explicit merge-gate boundary (§13 of the mission text: "Stop and request merge/push authorization"). The precise handoff to resume from:

1. **Decide on migration `0147`**: review `supabase/migrations/0147_g8_generic_archive_bypass_fix.sql` and its PGlite certification (`scripts/g8_0147_archive_bypass_pglite_certification.mjs`, 11/11 PASS) and either authorise its manual application to DEV (then production, per the established process) or direct a different remediation.
2. **Decide on the pre-existing `0129` divergence**: §12.3's byte-level comment-only difference from `origin/main` needs an explicit reconciliation decision before `tests/unit/migrationVersionsCrossBranch.test.ts` can pass cleanly at merge time.
3. **Assign an operator** with AWS/Amplify console access to run the CloudFront checklist (§10.1) and confirm the env-var-forwarding risk (§10.2) — neither this session nor any prior session in this programme has had that access.
4. **Decide on `rolloutCohort.ts`'s first real consumer**: which feature, at what initial percentage/version/allowlist — this closure work only delivers the certified, unwired primitive.
5. Once 1-4 are resolved: **re-run the full DEV certification gates** (§12) on the final candidate SHA, then this session's own successor can proceed to the merge gate (fetch `origin/main`, reconcile, re-audit the diff, confirm applied migrations unchanged, report the exact certified SHA) and request merge/push authorization explicitly — not performed here.

---

## Summary tallies (mission's own required closing list)

- Supported-country currency journeys passed/total: **24/24**
- Supported currencies tested: **AUD, INR** (the only two authorised)
- Unsupported-currency rejections: **24/24** (each GENERIC country's own real native currency — GBP/USD/SGD/AED — tested against both its AUD-profile and INR-profile account, across all 3 modules)
- DELETE/archive attacks blocked/total: **6/8 blocked pre-fix (2 real gaps found: single + bulk archive-via-UPDATE); 8/8 blocked post-fix (migration `0147`, not yet applied)**
- Cohort and kill-switch tests passed/total: **17/17** (unit-level; no live endpoint exists yet to certify against, since the primitive is unwired by design)
- App/database drift count: **1 confirmed** (the pre-`0147` archive-bypass gap — app said "Delete unavailable," database allowed it)
- AU/IN unexplained variance: **0** (no AU/IN code touched this session)
- Cross-border reconciliation variance: **0** (no G6/G7 code touched this session; existing certification stands)
- Historical records altered: **0**
- Synthetic residue: **0** (independently re-verified after every live-DEV run this session performed)
- Migrations newly applied (to any environment): **0** — `0147` is prepared and locally tested only
- Current production rollout scope: **Unchanged by this session** — `G5B_GENERIC_WRITE_ENABLED` reported ON per the 2026-09-12 baseline, not independently reconfirmed; the new `rolloutCohort.ts` primitive controls nothing in production (§7.3)
- Remaining blockers: migration `0147` PO review, the pre-existing `0129` divergence reconciliation, CloudFront/Amplify-env-var operator verification (§17)
- Push/merge/deployment status: **None performed. None authorized. None requested beyond this report's own §17 handoff.**
- Whether the programme is terminally complete: **No** — verdict is **G6-G8 CONDITIONAL PASS — SPECIFIC CLOSURE ITEMS REMAIN**, per §1.

# FHIP Country Programme — Complete Remaining Work and Activate Production: Progress Report

**Date:** 2026-09-14
**Mission status:** In progress. All DEV-side work achievable without operator/Amplify access is complete. **Merge, push, deploy, and production G2 activation are paused at a genuine access barrier** — per this mission's own explicit pause condition ("Pause only for a genuine access barrier...").

---

## 1. What this pass closed for real

### 1.1 The two-visitor DEV test (mission §6) — the report's own previously-named gap

The prior G8 report explicitly disclosed this as unproven ("structural inference only, not a live multi-session proof"). **Closed for real**: `scripts/g2_two_visitor_isolation_live_dev_check.ts`, **19/19 PASS**, real Playwright browser contexts (separate cookie jars), real interaction with the actual `<select>` `CountrySelector` component:

- Visitor A (AU) and Visitor B (India) never cross-contaminate each other's selection.
- Both persist across a real page reload.
- A changing to Global does not affect B.
- A brand-new third visitor inherits neither prior selection.
- A malformed selection cookie fails safe (falls through to neutral; page still loads 200).
- **A confirmed-AU authenticated account overrides a prior anonymous India selection** on the same landing page (tier-1 precedence, proven live).
- **After a real two-step sign-out** (AppShell's own `ConfirmDialog` flow, traced directly — the sidebar "Sign out" only opens a dialog whose own confirm button is *also* labelled "Sign out"), the landing page genuinely reverts to the earlier anonymous India selection — not a leaked authenticated state.

**Two real environment-configuration issues were found and fixed in the course of building this test (not application defects)**:
1. `/api/landing/country`'s origin check compares the request's `Origin` header against `APP_BASE_URL`, which defaults to `localhost:3000` — the isolated test server needed `APP_BASE_URL` set to match its actual port. This is a **test-harness artifact**, not a bug: in real DEV/production, `APP_BASE_URL` is already configured to match the real serving origin.
2. The pricing card renders the currency **symbol** (`A$`, `₹`), never the literal 3-letter code — an incorrect test assumption, fixed to check real rendered content.

### 1.2 Mobile/desktop layout, including the previously-sensitive 320px width (mission §6)

`scripts/g2_mobile_320px_layout_live_dev_check.ts`, **8/8 PASS**: no horizontal overflow at 320px/375px/768px/1440px, selector visible and usable at every width.

### 1.3 Regression baseline

- `npx tsc --noEmit`: clean throughout.
- `npx eslint` on every touched file: clean throughout.
- `tests/unit/g2*.test.ts`: 66/66 PASS (unchanged, re-confirmed).
- Secret scan, conflict-marker scan, migration-unchanged check across all 6 new commits this pass: clean — zero secrets, zero conflict markers, **zero migration files touched, zero application source files touched** (scripts/docs only, matching the 3 commits from the prior pass).

---

## 2. Requirement-to-evidence matrix (G0–G8, this mission's own scope)

| Requirement | Current implementation | Evidence and environment | Remaining work | Status |
|---|---|---|---|---|
| G6 — 10 contracts, live-DEV calculation certification | Unchanged | Prior session's live-DEV certification | None | **Retained, unchanged** |
| G7 — 6 contracts, report certification | Unchanged | Prior session's live-DEV certification | None | **Retained, unchanged** |
| G4/G5B production activation | 16/16 real authenticated HTTP checks | Production, prior session | None | **Retained, unchanged** |
| Migration `0147` (archive-via-UPDATE protection) | Applied to production | Prior session | None (not reapplied this pass) | **Retained** |
| Migration `0129` (byte-identical reconciliation) | Byte-identical hashes across branch/`origin/main`/base, zero diff | This session, re-confirmed | None | **Retained, closed** |
| Live-DEV cohort/kill-switch certification | 24/24 | Prior session, DEV | None (not repeated this pass) | **Retained, unchanged** |
| Application/API vs. direct-DB rollback boundary | Documented: app-layer rollout switch does not revoke direct DB INSERT/UPDATE; DELETE/archive independently blocked by `0147` | Prior session, live-verified | None — this is the honest operating boundary, not a gap | **Retained, documented** |
| MCC / MCC-14 / cross-tenant protection | Unchanged | Prior sessions | None | **Retained, unchanged** |
| **Two-visitor cache isolation (G2)** | **NOW PROVEN LIVE** — real browser contexts, real selector interaction | This pass, isolated DEV instance | None | **CLOSED THIS PASS** |
| **Mobile/320px layout** | **NOW PROVEN LIVE** | This pass, isolated DEV instance | None | **CLOSED THIS PASS** |
| Exact production deployment identity | Not established — no Amplify API/console access | N/A | Operator evidence package (§3) | **BLOCKED — genuine access barrier** |
| G2 production activation | **OFF** — never activated in production; every behavioral proof to date (including this pass's) is DEV-fixture-only | This pass + prior pass | Operator sets 2 Amplify console values, then a deploy (§4) | **BLOCKED — genuine access barrier** |
| CloudFront edge cache-policy / viewer-country injection confirmation | Not established — needs operator console evidence | N/A | Same operator package | **BLOCKED — genuine access barrier** |

**No genuinely missing original requirement was found beyond the two named operator-access items.** The eight deferred label-variant items, the no-Superannuation-aliasing rule, the no-new-URL-architecture rule, and the Resources/Admin exclusion all remain explicitly out of scope, unchanged, not reopened.

---

## 3. Deployment identity — still blocked, not retried

Per this mission's own §7 instruction ("If API access is denied, do not retry repeatedly"), this session's known-denied AWS identity (`arn:aws:iam::879807128139:user/Amar` — `amplify:*`/`cloudfront:*` all previously `AccessDenied`) was **not re-probed this pass**. `origin/main` is unchanged at `00a3d88` since the last check (re-confirmed via `git fetch`).

**The one consolidated evidence package still needed** (unchanged ask from the prior report): Amplify application ID, production branch, domain association for `app.financialhealthplatform.com`, latest successful deployment's job ID + full commit SHA + completion timestamp, and any later deployment's status.

---

## 4. G2 activation package — refined, ready, NOT applied

Same structure as the prior report's readiness package, now backed by real two-visitor and mobile proof rather than single-visitor DEV simulation alone.

| Field | Value |
|---|---|
| Target variables | `G2_LANDING_LOCALISATION_ENABLED=true`, `G2_ALLOW_TEST_DETECTION_HEADER=false` |
| Current values | Both unset (default `false`) |
| Runtime-forwarding requirement | **Already satisfied** — both names are already in `amplify.yml`'s forwarding list (added in `9feba13`, the same commit that fixed G4/G5B's forwarding gap) |
| Sequencing | Configuration change → build → successful deployment → runtime verification (same discipline as the G4/G5B activation — **saving a console variable alone does not change the running server**; a fresh build is required) |
| Confirm before activation | (1) both variables reach the server runtime through the actual build mechanism — already true by construction; (2) no secret values are exposed — neither variable is a secret; (3) G4/G5B/rollout values are preserved — this change touches a structurally separate module, zero code path overlap confirmed by direct source read; (4) G2-off and G2-on behavior both verified — done, this pass and the prior one |
| Real evidence this activation is safe | 19/19 two-visitor isolation, 8/8 mobile/desktop layout, plus the prior pass's tier-precedence/malformed-cookie/forged-header structural proofs |
| Rollback | Set `G2_LANDING_LOCALISATION_ENABLED` back to unset/`false`, rebuild — reverts to today's exact behavior (identical static content for every visitor). No migration, no data change |
| Financial/billing confirmation | Structurally guaranteed unaffected — `isAuthoritative: false` hardcoded on every result; no write path exists into any billing/country field |

**Not applied.** No PO approval was given during this pass for the actual Amplify console change.

---

## 5. What was NOT done this pass, and why

- **No merge, no push, no deploy.** Per this mission's own configuration-before-deployment sequencing (the same discipline the G4/G5B activation established), the G2 environment variables must be set in the Amplify console *before* any push that depends on them — that console access is the genuine barrier named in §3/§4.
- **No AWS API call was retried** after the prior session's explicit denials.
- **No bounded implementation fix was needed** — every check this pass passed on the first genuinely-correct attempt (after fixing 2 test-harness-only issues, not application defects, disclosed in §1.1).
- **Production rollout was not touched** — remains at 100%, unchanged, not re-tested this pass (already 24/24 from the prior session).

---

## 6. Exact next action

1. **Operator supplies the Amplify deployment-evidence package** (§3) — read-only, no secrets.
2. **Operator (or this session, once granted the drafted least-privilege IAM policy) sets the two G2 environment variables** in the Amplify console at the app level, matching G4/G5B's own precedent.
3. **Once both land**: this session merges the reviewed branch to `main`, pushes, tracks the resulting deploy to success, and runs the bounded production acceptance matrix from mission §13 (real visitor scenarios, account-preservation regression reusing the existing 16/16 evidence, cache-behavior checks) using disposable synthetic identities where necessary — then issues the terminal verdict.

**No further engineering work is blocked.** This pass is stopped at the exact two access-barrier items named above, per the mission's own explicit pause condition — not because more could not be done, but because what remains genuinely requires operator action.

# G1 Country Foundation — G0 Delta Report

Scope: refresh of G0-D1 through G0-D7 only (spec section 3). All prior G0/G0-JA-1 deliverables in `docs/jurisdiction-applicability/00-README.md` through `09-cross-border-model.md`, Wave 1 fixes, and Mandatory Country Confirmation are treated as established per spec section 2 and were spot-verified fresh against current `origin/main` (`6fdcf7e`) below rather than re-derived.

## Independently re-verified prior findings (UNCHANGED)

| Finding | Current evidence | Prior status | Current status |
|---|---|---|---|
| `households.primary_country` is a passive one-way copy, never read for logic | `lib/services/jurisdiction.ts` header comment + grep confirms only write site is `OnboardingWizard.tsx:155`; only other reader is `twinData.ts` display context | Established (01-canonical-architecture.md) | UNCHANGED |
| Wave 1 fixes (JA-D1 Twin AU-default, JA-D2 Resilience currency-derived-country) merged and live | `lib/services/twinData.ts`/`lib/engines/resilienceStress.ts` re-read fresh; no `?? 'AU'` or `currency === 'AUD' ? 'AU' : 'IN'` pattern found; commits `aaedd15`/`3d8c4f9` confirmed ancestors of HEAD via `git merge-base --is-ancestor` | Fixed | UNCHANGED, confirmed still fixed |
| `secondary_country` dormant (no write path) | Grep of `app/api` finds zero routes writing it; `profile/page.tsx` only reads it into a display type | Established | UNCHANGED |
| `preferred_currency` is the base/reporting currency owner | 01-canonical-architecture.md §8 + confirmed live by ~17 read-site grep (dashboard/reports/twin/forecast/goals/score/resilience) | Established | UNCHANGED |
| Five canonical applicability classes, `isItemAvailableForCountry()`/`assertItemCreationAllowedForUser()` as sole applicability engine | Re-read `lib/services/jurisdiction.ts` in full; unchanged since discovery fork | Established | UNCHANGED |
| MCC 85-table backstop, MCC-14 cascade fix | Migrations `0104/0105/0108/0111` present and are ancestors of HEAD | Established | UNCHANGED (not reopened) |

## NEW findings (post-discovery-baseline, this pass)

| Finding | Current evidence | Owner phase | Blocks G1 |
|---|---|---|---|
| G0-D7-1: `lib/services/retirementMemberData.ts:62` silently defaults an unresolved/non-IN country to `'AU'` (`profile?.country_of_residence === 'IN' ? 'IN' : 'AU'`) — a third instance of the JA-D1/JA-D2 defect class, not covered by Wave 1's Twin/Resilience-only scope | Direct read of `retirementMemberData.ts:62` | G5 (Existing-module realignment) | No — read-path display defect, not a country-ownership/foundation gap |
| G0-D7-2: `app/api/financial-data-hub/investment-statement/[documentId]/account-match/route.ts:47` hardcodes `countryCode: 'AU'` for account-matching regardless of the actual uploading user's country | Direct read of the route | G5 / FDH continuation | No |
| G0-D3-1: **No payment/checkout/subscription backend exists anywhere in this codebase** — confirmed by repo-wide search (no Stripe/Razorpay/PayPal, no checkout/subscription/billing API route, no price-ID field, no `subscriptions` table in any of 115 migrations). `supabase/migrations/0115_module11_1_ai_entitlements_quotas_cost_controls.sql` states this in its own comment: "this codebase has NO subscription/billing system." | `find app/api -iname "*checkout*" ...` → zero results; grep `stripe\|razorpay\|paypal` → zero real hits | G5 (checkout build-out) | **BLOCKS_G1 assumption, not G1 itself** — see resolution below |
| G0-D3-2: The landing page (`components/marketing/LandingPage.tsx`) shows exactly one static price, in **AUD** (`A$9.99/mo` / `A$99/yr`), unconditionally to every visitor. There is **no India price shown anywhere**, no country/currency branching in the pricing component, and the onboarding wizard's own default is `country_of_residence: 'AU'`/`preferred_currency: 'AUD'` (the opposite bias to the spec's own worked concern) | `LandingPage.tsx` lines 189-250; `OnboardingWizard.tsx:80-81` | G2 (landing-page localisation) | No |
| G0-D3-3: The systemic hardcoded-currency-default bias found across ~17 call sites (`?? 'AUD'`) skews toward **AU**, not India, whenever `preferred_currency` is unset | See billing/pricing audit below | G5 | No — pre-existing, orthogonal to G1's billing-authority scaffolding |
| G0-D5-1: `user_profiles.secondary_country` is the closest existing cross-border-declaration field but is single-valued, untyped-relationship, unconfirmed, and has no write path — confirmed structurally unable to serve as spec section 13's relationship store | `lib/validation/profile.ts:12`, grep of `app/api` finds zero writers | G1 (addressed by new `cross_border_relationships` table; `secondary_country` itself is left untouched, not migrated) | Addressed in this phase (new table), not a blocker |
| G0-D6-1: local migration head at task start was `0120`; `feature/module-11-3-insight-pack` (one of the explicitly-flagged parallel worktrees) has already filled gap `0117` and additionally claimed `0121` on its own branch | `node scripts/check-migration-versions-against-branch.mjs --against=feature/module-11-3-insight-pack` → 117 files vs local 115, no collision (different numbers) | G1 (this task) | Resolved by allocating `0122`, verified colliding-free against `origin/main`, `cert/fdh16-full-integration-certification`, `fix/admin-a02-wave3-disconnected-content-dead-routes`, and `feature/module-11-3-insight-pack` |

### G0-D3-1 resolution (why it does not block G1)

The spec's own worked question — "can a generic user receive India pricing merely because the landing page defaults to India?" — presupposes a checkout that does not exist. The correct G0 conclusion is: **there is currently no live defect to fix, because there is no live price-selection code path of any kind.** G1 therefore builds the billing-authority *foundation* (schema, confirmation contract, fail-closed server-side validator, tests proving the generic-user/India-pricing question) as forward-looking scaffolding for G5's future checkout, per spec section 17's own closing instruction ("G2/G5 will implement final landing and checkout presentation"). This is recorded here as NEW evidence changing the *nature* of the G1 billing deliverable (build the boundary vs. patch a live hole) without changing G1's required scope.

## Field ownership map (G0-D2)

See report section D (Ownership matrix) in the final closure report for the complete table. Summary of what changed in this pass: `primary_country`, `billing_country` (both new, `user_profiles`), `cross_border_relationships` (new table) are the only new authorities created. `country_of_residence`/`country_confirmed_at`/`country_source` (MCC), `preferred_currency` (base currency), and `households.primary_country` (confirmed non-authority) are unchanged.

## Migration risk refresh (G0-D6)

- Local chain: 115 files, `0001`-`0120` with gaps `0079-0081, 0103, 0117` (0103 is the rejected, never-applied `2fa2090` hotfix number — deliberately never reused, per its own migration's header convention).
- Collision guard (`scripts/check-migration-versions-against-branch.mjs`) run against: `origin/main` (clean), `cert/fdh16-full-integration-certification` (clean), `fix/admin-a02-wave3-disconnected-content-dead-routes` (clean), `feature/module-11-3-insight-pack` (117 files — fills `0117`, adds `0121`; no collision, different number space). G1 allocated **`0122`**.
- DEV/production schema difference: out of scope to verify directly (no DEV/production credentials available in this worktree — see final report section N). This migration has not been applied to DEV or production by this task.

## Findings explicitly allocated to later phases (not fixed here)

| Finding | Owner phase |
|---|---|
| Anonymous country selector, Cloudflare detection | G2 |
| Registration/onboarding redesign to support GENERIC countries | G3 |
| Application-wide module/nav filtering by capability | G4 |
| `retirementMemberData.ts` AU-default defect, FDH investment-statement hardcoded `'AU'` | G5 |
| EPF/PPF/NPS, India domestic retirement calculation engine | Explicitly excluded, no phase assigned by this task |
| Cross-border calculations reading `cross_border_relationships` | G6 |
| Report/Resources localisation using the new registry's locale/localisation flags | G7 |

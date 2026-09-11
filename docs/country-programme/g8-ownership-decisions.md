# G8 Canonical Ownership Decisions (G8.029–G8.056)

Synthesized directly from the G8 discovery pass (`docs/country-programme/g8-discovery-batch1..6*.md`). These are **decisions, not implementation** — no code is written here. Each decision states the canonical owner going forward, why (grounded in discovery), and whether it requires new schema/code or is already correctly owned.

Guiding rule carried through from G6/G7: **country is never derived from currency, locale, or a client-supplied value.** Discovery confirmed zero violations of this rule anywhere across all 28 G8 topics — every decision below inherits that clean baseline; where a decision references a real defect, it is a different class of gap (coverage, reversibility, accessibility, SEO structure), never a country-inference violation.

## G8.029 — Release baseline and lineage
**New owner required, process-level.** No version identifier, tag, or build-ID is ever surfaced anywhere in this codebase, and the dual-SHA cherry-pick-to-`main` pattern this whole closure sprint uses means there is no single canonical commit ID for any hotfix — only a verified-identical pair. **Decision: no code change.** This is named as a process gap for the Product Owner's own operational awareness, not something G8 builds a tool for — the existing discipline (verify each hotfix pair byte-identical before treating it as "the same fix," confirmed practice throughout LR-12R) is the correct mitigation until/unless a dedicated release-tracking mechanism is separately authorised.

## G8.030 — Feature-flag inventory
**Owner: the four existing flag modules (`appCapabilityFlag.ts`, `g5bWriteFlag.ts`, `landingLocalisationFlag.ts`, `featureFlags.ts`) stay canonical — all confirmed correctly fail-closed.** **Decision: `ENVIRONMENT_VARIABLES.md` is corrected to list all four flags plus `G2_ALLOW_TEST_DETECTION_HEADER`**, closing a real, repeated documentation-process gap discovery found (none of the five are currently documented there). No behavioural change.

## G8.031 — Migration inventory
**Owner: `docs/architecture/MIGRATION_REGISTRY.md` stays the canonical ledger, reaffirmed with a disclosed staleness gap.** **Decision: no automated fix in this phase** — the registry's own staleness (17+ migrations behind) and the collision-guard tool's blind spot (cannot detect a migration silently missing from a target branch, exactly the class of gap that let `0136` go unmerged) are named here as a process risk for a future tooling investment, not solved by this ownership decision. The `0136` instance of this exact gap was found and fixed the same day via LR-12R — this decision is about preventing a recurrence, which is out of this phase's implementation boundary.

## G8.032 — AU visitor
**Owner: unchanged — `landingCountryContext.ts`'s 5-tier waterfall stays canonical.** **Decision: the CloudFront-Viewer-Country header injection prerequisite (already named a "mandatory G8 activation prerequisite" at G2's own merge time) is escalated here to a formal G8 rollout blocker, not a documentation nicety** — confirming it is live on the real Amplify distribution is a prerequisite for claiming any AU/IN visitor detection actually functions in production, and no evidence exists that this has been checked since it was first flagged.

## G8.033 — India visitor
**Same decision as G8.032** — the mechanism is identical and symmetric; tracked once, not duplicated. **Decision, additionally**: the one genuine asymmetry found (AU has `DOMESTIC_RETIREMENT=true`, India `false`, by explicit registry design) is reaffirmed as correct and unrelated to the anonymous-visitor layer — no action.

## G8.034 — Global visitor
**Owner: unchanged, reaffirmed — the GLOBAL bucket's non-authoritative isolation is structurally guaranteed (type-disjoint, hardcoded `isAuthoritative:false`, no `countries` row exists for it).** **Decision: no change.** This is the single most robustly-defended topic in the entire G8 pass — no residual risk found.

## G8.035 — AU account
**Owner: unchanged — the FULL-experience AU registry row and SMSF's DB-trigger-level AU gate stay canonical.** **Decision on the one real gap found**: `components/grid/FinancialDataGrid.tsx`'s currency-mismatch warning (`country_code === 'IN' ? "India's" : "Australia's"`) is the same "not IN becomes Australia" defect class already fixed elsewhere (G5-D1) but never swept into that remediation. **This copy string should be corrected to use the same canonical country-label resolution the fixed call sites use**, closing the one instance this defect class left behind. Low severity (display-only), but a real, nameable, fixable item.

## G8.036 — India account
**Owner: unchanged — India's `DOMESTIC_TAX_OUTPUTS=true`/`DOMESTIC_RETIREMENT=false` registry profile stays correct.** **Decision on the sharpened finding**: Investment Intelligence's India-only scoping is confirmed correct *by data-shape coincidence*, not an explicit gate, at the module's own entry point (`source-documents` route) — this is the same residual risk G7 already disclosed one layer up (the tax-calculation layer) and declined to harden without separate authorisation. **G8 does not authorise hardening this either** — it is named again here as the same accepted, disclosed risk, now confirmed to extend one layer deeper than G7 knew.

## G8.037 — GB generic account
**Owner: unchanged — the middleware allowlist + `requireCountryConfirmedUser()`'s `GENERIC_EXPERIENCE_RESTRICTED` + DB `is_supported=false` triple-layer defense stays canonical, confirmed still correctly enforced with both G4 and G5B off in production.** **Decision on the one real gap**: the forced AUD/INR-only reporting currency for a GBP household is reaffirmed as a genuine, disclosed, **not-yet-authorised-for-fix** UX/data-fidelity gap — extending currency support is a separate, larger G5-adjacent decision outside this phase's boundary, named here for the record, not solved.

## G8.038 — US generic account
**Owner: unchanged, reaffirmed — byte-identical treatment to GB confirmed at every layer, zero US-specific branches found anywhere.** **Decision: no change.** The cleanest topic in the batch.

## G8.039 — SG generic account
**Owner: unchanged, reaffirmed.** **Decision on the one real finding**: the `AI_INSIGHTS` manifest note at `appCapability.ts:522` is factually stale (claims an unfixed gap that was already fixed by an earlier commit) — **corrected here as a documentation-accuracy fix**, since a manifest cited as authoritative evidence in future certification passes must not misstate its own history. No functional change.

## G8.040 — AE generic account
**Owner: unchanged, reaffirmed — no AE-specific special-casing found, including no hardcoded "no personal income tax" claim.** **Decision: no change.**

## G8.041 — Manual selector overrides
**Owner: unchanged — the anonymous-cookie/authenticated-confirmation separation is structurally guaranteed, with an explicit adversarial test scenario ("G3-14") already named in the code.** **Decision on the one real, narrow finding**: `confirm_country_of_residence()`'s lack of re-confirmation friction for an already-confirmed user submitting a genuinely different country via direct API call is **named as a hardening candidate, not authorised for a fix in this phase** — no live exploit path exists today (the UI never re-presents the form to a confirmed user), so this is disclosed forward, not fixed now.

## G8.042 — VPN and travel scenarios
**Owner: N/A — confirmed, by exhaustive search, that no IP-based geolocation mechanism exists anywhere in this codebase.** **Decision: no change, and no mechanism is built.** This is the correct, by-construction answer to what a "VPN/travel" topic would otherwise need to defend against — there is nothing to defend, since nothing infers location from IP at all.

## G8.043 — Missing-location behavior
**Owner: unchanged — `assertCountryConfirmedForUser()`'s `COUNTRY_MISSING` fail-closed classification stays canonical, confirmed to leave no silent default anywhere in the path.** **Decision on the one real gap**: `POST /api/onboarding/complete` has no server-side check that a country was ever actually set before flipping `onboarding_completed=true`. **This is a real, if currently non-exploitable, completeness gap — the same defensive check `assertCountryConfirmedForUser()` already provides should be called at this endpoint too**, so the invariant is enforced at the point of writing rather than relying entirely on a different module's downstream correctness.

## G8.044 — Confirmed-account precedence
**Owner: unchanged, reaffirmed — the strongest-defended topic alongside G8.034, with a structural (not conventional) guarantee and an explicit named adversarial scenario.** **Decision: no change.**

## G8.045 — Existing missing-country users
**Owner: unchanged — the MCC gate and its 8-table DB backstop stay canonical.** **Decision on two real findings**: (1) the DB backstop's scope is explicitly limited to 8 foundational tables, not independently re-verified against every table added since — **named as a "cannot verify" item for a future audit, not solved here**; (2) 4 of 5 AI Insights routes reach an authenticated-but-country-unconfirmed user via a helper that imports plain `requireUser()` instead of `requireCountryConfirmedUser()` — **this is a real, disclosed, unremediated gap; G8 authorises closing it** (swap the import at those 4 call sites) as a small, low-risk, high-value fix consistent with the MCC gate's own universal-coverage intent.

## G8.046 — Country-change workflow
**Owner: `confirm_country_of_residence()` stays canonical for `country_of_residence` writes; `primary_country`'s own preview/confirm RPC pair (migration 0122) stays canonical for `primary_country` writes — these are correctly two separate mechanisms by original design.** **Decision on the real gap**: a residence-country change silently leaves `primary_country` stale, since nothing wires the two together, and **no UI surface exists at all** for the compensating `primary_country` reconciliation action. **G8 authorises the smallest fix consistent with "reuse, don't invent"**: when `PUT /api/user/profile`'s residence-change path resets `country_confirmed_at`, it should also flag the account for a `primary_country` review (e.g., surface the already-built preview/confirm flow to the user at the same point they re-confirm residence) rather than leaving the divergence to accumulate silently. The exact UI/UX shape of that surfacing is implementation detail, not decided here.

## G8.047 — Cross-border reconciliation
**Owner: `cross_border_relationships` and `resolveCountryContext()` stay canonical, reaffirmed as declaration-only — no reconciliation logic exists and none is authorised here.** **Decision: no change**, consistent with G6/G7's own repeated deferral of this exact question — building real reconciliation logic is a materially larger phase than G8's own certification boundary permits.

## G8.048 — Multi-currency integrity
**Owner: unchanged — the FK-based `currencies` table and the application-layer Zod `z.enum(['AUD','INR'])` gates stay canonical.** **Decision on the sharpened, now-demonstrated risk**: `fx.ts`'s silent-treat-as-AUD branch for any non-AUD/INR currency is a real, live miscalculation path once any code writes a currency_code outside `{AUD,INR}` to a register table — which the FK alone no longer prevents (6 legitimate currency rows exist since G1). **G8 authorises the minimal fix**: `convertToReportingCurrency()` should fail closed (throw or return a clearly-flagged "unsupported currency" result) for any input outside `{AUD,INR}`, rather than silently mis-converting it — a defensive correctness fix, not a currency-support expansion. The DB-level CHECK-constraint gap itself (G6's own disclosed item) remains explicitly out of scope, as G6 already decided.

## G8.049 — Pricing and checkout protection
**Owner: unchanged — `validatePriceForBilling()`'s pure-function design stays canonical, confirmed structurally (not just conventionally) incapable of accepting currency/IP as a substitute for confirmed billing country.** **Decision: no change** — this is the best-defended topic in the entire G8 pass at the code-inspection level. The two live-round-trip gaps LR-10 already disclosed (real Razorpay human authorization, real internet-delivered webhooks) are reaffirmed as process gaps for a pre-launch checklist, not pricing-forgery gaps, and remain LR-10's own open items, not re-owned here.

## G8.050 — Authentication regression
**Owner: unchanged — `app/(auth)/**`'s complete independence from any country/capability gate is confirmed correct and untouched by this entire programme.** **Decision on the one real test-coverage gap**: `countryGateAccessMatrix.test.ts` asserts every `app/(app)/` route *is* gated but has no negative assertion that `(auth)`/`(onboarding)` routes are specifically excluded. **G8 authorises adding that negative assertion** — a small, direct regression guard against a future accidental widening of `proxy.ts`'s allowlist regex, reusing the existing test file rather than creating a new mechanism.

## G8.051 — RLS and API attacks
**Owner: unchanged — the existing, extensive per-table RLS certification corpus stays canonical.** **Decision on the three real coverage gaps found** (`business_entity_liabilities`, `report_access_events`, `user_entitlements.plan_tier`'s direct-write boundary): **G8 authorises extending the existing certification scripts to cover all three**, reusing each one's own established attack pattern (the LR-11B script for the first, the R10 script for the second, a new minimal RLS-only check for the third) rather than inventing a new methodology. This closes real, evidenced gaps on tables that directly affect reported net worth and billing correctness — genuinely warranted, not speculative hardening.

## G8.052 — Mobile and responsive UX
**Owner: unchanged — the existing per-phase mobile-sweep methodology (375×812, Android Chrome UA) stays canonical.** **Decision on the most significant finding in this whole G8 pass**: `/dashboard` — the app's primary post-login landing page — has never been mobile-tested in this programme's history. **G8 authorises this as the top-priority target for the next mobile pass**, followed by the three GENERIC-opened modules with zero page-level coverage (`/score`, `/dna`, `/resilience`) and the entire pre-authentication/forced-onboarding surface (`/login`, `/signup`, `/forgot-password`, `/reset-password`, `/onboarding`, `/confirm-country`, `/global-setup`) — the latter reached by 100% of new users, disproportionately likely via a phone (an email link). The full remaining gap list (forecast's 11 sub-pages, Investment Intelligence's 6, etc.) is named in discovery for a future pass, not all authorised for immediate action — the dashboard and the pre-auth surface are the two decided priorities.

## G8.053 — Accessibility
**Owner: unchanged — `ConfirmCountryForm.tsx`'s own a11y pattern (real ARIA wiring, live-region disclosure, properly-validated acknowledgement) is reaffirmed as the reference implementation for this programme's country-specific UI.** **Decision on three real gaps, all authorised for a fix reusing that same reference pattern**: (1) the G2 selector's mobile-hidden hint should use a visually-hidden (not `display:none`) technique so `aria-describedby` keeps a real target on phones; (2) `BillingPanel.tsx`'s country-confirm error should adopt the same `role="alert"` + `aria-describedby` pattern `ConfirmCountryForm.tsx` already uses; (3) `OnboardingWizard.tsx`'s country select should get the same `aria-required`/`aria-invalid`/`aria-describedby` wiring its own sibling currency field already has, in the same file, same step. All three are small, additive, reuse-an-existing-pattern fixes — no new accessibility infrastructure is proposed.

## G8.054 — SEO and canonical identity
**New owner required.** No prior phase has owned country-programme SEO at all — `lib/seo/entity.ts` owns the non-country-specific JSON-LD/sitemap/robots layer and is reaffirmed correct for what it does. **Decision on the real structural finding**: the AU/IN/Global landing variants are **completely invisible to search engines by design** (single static metadata, no hreflang, single crawlable URL, cookie/header-gated content a crawler never carries) — not a bug to fix silently, but a **genuine scope question for the Product Owner**: either (a) explicitly accept that G2's localisation is a post-click-through visitor-experience feature only, never an SEO feature, and document that boundary so a future phase doesn't assume otherwise, or (b) authorise building real per-country crawlable paths (e.g. `/au`, `/in`) with proper hreflang — a materially larger change than this phase's own boundary permits to decide unilaterally. **G8 makes no unilateral call on (a) vs (b)** — it names the gap precisely and flags it for explicit Product Owner decision, consistent with this whole programme's discipline against inventing scope.

## G8.055 — Controlled production cohort
**New owner required — none exists today.** **Decision, matching the discovery's own framing precisely**: no per-user rollout/cohort/canary mechanism exists anywhere in this codebase; `ai_model_registry.rollout_percentage` is a real but entirely unconsumed near-miss. **This is a genuine Product Owner scope decision, not an engineering call this ownership pass makes unilaterally**: either (a) formally accept that "controlled rollout" in this programme's actual operating model means "apply to DEV → verify → flip one global env var to 100% of production," and update G8's own name/scope documentation to match reality, or (b) authorise building a real per-user targeting primitive (a `feature_flag_overrides(user_id, flag_key)` table, or wiring the existing unconsumed `rollout_percentage` column to a real selection function) before G8 can be said to have delivered what its own name promises. **G8 does not choose between (a) and (b)** — this is named as the single most consequential open decision this entire G8 pass surfaced, for explicit Product Owner ruling.

## G8.056 — Full rollout and rollback
**Owner: unchanged for G2/G4 — both confirmed genuinely, completely reversible kill switches with zero one-way side effects.** **Decision on the real, significant asymmetry found in G5B**: the database-layer grant (migration `0129`) is **not** actually controlled by the `G5B_GENERIC_WRITE_ENABLED` environment variable at all — Postgres cannot read it — so flipping the flag off does not revoke the underlying write permission once the migration is applied; only the migration's own manual rollback SQL block does that. **G8 authorises a documentation-only fix as the minimum bar**: `g5bWriteFlag.ts`'s own doc comment and the migration's header should each cross-reference this asymmetry explicitly, so a future operator's rollback runbook cannot reasonably assume "flip the env var" is sufficient. **Whether to additionally build a true single-switch rollback (e.g., have the app-layer flag's OFF state also revoke the DB grant, or wire the DB function itself to read a settings row instead of being unconditionally on) is a larger design decision, not authorised here** — named for a future hardening phase, consistent with this decision's own "reuse, minimal, disclosed" discipline. Separately, the `income-proposals/apply` route's stale `requireCountryConfirmedUser` import (meaning G5B doesn't actually enable the FDH-derived income-proposal path it implicitly claims to) **is authorised for a fix** — swap to `requireModuleCapability`, the same call-site-level change already applied to the sibling manual-entry route.

---

## Summary of items this phase authorises for direct implementation (small, reuse-pattern fixes)

- G8.035: correct `FinancialDataGrid.tsx`'s "not IN becomes Australia" currency-mismatch copy.
- G8.039: correct the stale `AI_INSIGHTS` manifest note.
- G8.043: add a server-side country-set check to `POST /api/onboarding/complete`.
- G8.045: swap the 4 AI Insights routes' auth helper to `requireCountryConfirmedUser`.
- G8.046: surface the existing `primary_country` reconciliation flow at the point of residence-country reconfirmation.
- G8.048: make `fx.ts`'s currency conversion fail closed for any non-AUD/INR value.
- G8.050: add a negative assertion excluding `(auth)`/`(onboarding)` from `countryGateAccessMatrix.test.ts`.
- G8.051: extend RLS certification to `business_entity_liabilities`, `report_access_events`, and `user_entitlements.plan_tier`'s direct-write boundary.
- G8.053: three small ARIA/accessibility fixes (G2 mobile hint, BillingPanel error, OnboardingWizard country field).
- G8.056: cross-reference the G5B flag/migration rollback asymmetry in both files' own doc comments; fix the stale `income-proposals/apply` auth import.

## Summary of items requiring an explicit Product Owner decision before any further work (not authorised here)

- **G8.032/033**: confirm whether CloudFront-Viewer-Country header injection is actually live on the production Amplify distribution — a named rollout blocker, not something this codebase can self-verify.
- **G8.054**: whether G2 landing localisation is scoped as visitor-experience-only (accept the SEO invisibility) or should be extended to real crawlable per-country paths.
- **G8.055**: whether "controlled rollout" in this programme means the current global-flag operating model (rename/rescope G8 to match), or whether a real per-user targeting mechanism should be built before G8 is considered complete.

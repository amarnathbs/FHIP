# G8 Discovery — Batch 5: Pricing Forgery, Authentication Regression, RLS Coverage, Mobile UX (G8.021–G8.024)

Repo: `D:\FHIP\.claude\worktrees\agent-a9fdb5d253f9b5fff` at capture time.

## 1. Pricing and checkout protection

**Client-controlled inputs traced end to end**: `POST /api/payments/checkout` accepts exactly one field, `{priceId}` — no amount, currency, or provider price ID is ever accepted from the client. `billingCountry`/`billingConfirmed` are resolved server-side from `user_profiles`, never the request body. A repo-wide grep for any IP/geo/`Accept-Language`-style country inference across `app/`/`lib/` returns **zero hits**.

`validatePriceForBilling()` (`billingAuthority.ts`) is a pure function of `(billingCountry, billingConfirmed, requestedPriceId)` only — it structurally cannot accept currency or IP as inputs (no such parameter exists). `paymentPlanCatalogue.ts` hard-codes exactly 4 entries, each with a server-only `region` and an env-var-sourced `providerPriceId`; a price whose region doesn't exactly match the caller's confirmed billing country is rejected (`PRICE_REGION_MISMATCH`) — no currency-based approximation exists anywhere.

**Cross-referenced against this session's own live round trip** (`LR10_LIVE_PAYMENT_ROUND_TRIP.md`): NEG-03 (checkout alone never grants Premium) proven live twice; webhook signature verification, idempotency, and WP-10 all proven live, both providers. What that report itself already discloses as NOT live-proven: a real human-completed Razorpay hosted-page authorization, and real internet-delivered webhooks from either provider's own servers — both process gaps, not pricing-forgery gaps.

**Findings**: pricing/region forgery is confirmed structurally absent, not just policy-absent — `validatePriceForBilling`'s signature has no slot for currency/IP to occupy. The one open item (Razorpay real-authorization / real webhook delivery) is orthogonal to this topic and already tracked in LR-10's own report.

## 2. Authentication regression

**No country/capability gate sits in front of auth, confirmed structurally.** `app/(auth)/{login,signup,forgot-password,reset-password}/page.tsx` and `app/auth/callback/route.ts` call Supabase's client SDK directly — zero imports of `requireUser`/`requireCountryConfirmedUser`/`countryGate`/`appCapability` anywhere in `app/(auth)/**`. `proxy.ts`'s one routing-layer allowlist regex does not match `/login`, `/signup`, `/forgot-password`, or `/reset-password` at all — none of the redirect logic ever runs for them. `app/(app)/layout.tsx` (the one place MCC is enforced for the whole authenticated app) explicitly excludes onboarding by route-group design.

`git log` on `app/(auth)/**` shows only pre-programme commits — **no commit under the entire G0-G8 country programme has ever touched the auth surface.**

**Findings**: auth is confirmed genuinely country-agnostic by construction. One real, narrow test-coverage gap: `tests/unit/countryGateAccessMatrix.test.ts` asserts every `app/(app)/` directory *is* gated, but has no equivalent negative assertion that `(auth)`/`(onboarding)` routes are specifically excluded — nothing today prevents a future engineer from accidentally widening `proxy.ts`'s allowlist regex to catch `/login`, except code review.

## 3. RLS and API attacks — consolidated inventory, and a genuine coverage gap

This programme (G0-G8 plus its LR-1..LR-12R and MCC/G0-G5 predecessors) has built a genuinely deep, table-named, both-DB-level-and-client-level RLS certification corpus: country foundation, G3, MCC (incl. MCC-14 delete-cascade), Reports (5 named attacks), Retirement, Professional Access, Companies & Trusts, ~18 Financial-Data-Hub scripts, Investment Intelligence, SMSF, and Admin/Resources RBAC — see the full per-area table with script citations in the source discovery transcript.

**Three genuine, evidenced coverage gaps found — sibling tables never tested despite an identical schema/RLS shape to a table that was:**

1. **`business_entity_liabilities` has never had a cross-tenant forgery test, though its sibling `business_entity_assets` has** (both created in the same migration, `0134`, identical RLS policy shape) — the one certification script for this migration (`lr11b_family_trust_cross_tenant_live_dev.mjs`) attacks `business_entities`/`business_entity_assets` but never once references `business_entity_liabilities`, despite it directly affecting a user's reported net worth.
2. **`report_access_events` has never had a cross-tenant forgery test, though every one of its `report_*` siblings has** — the R10 certification script explicitly names and attacks `report_sections`/`report_snapshots`/`report_exports`/`report_generation_runs`, but this per-user audit table appears in zero scripts anywhere.
3. **`user_entitlements.plan_tier`'s direct-write RLS boundary has never been live-attacked, only inferred from schema** — the table has a SELECT-own policy and (by omission) no INSERT/UPDATE policy for `authenticated`, meaning a raw client self-upgrade write should fail closed by default-deny, but LR-10's own NEG-01..NEG-05 matrix only proves the *application routes* never write `plan_tier` outside the webhook — a raw client-side write against the table's RLS directly has never been attempted, for the exact table that gates billing correctness.

`payment_webhook_events` was checked and correctly excluded — RLS enabled with deliberately zero policies and no `user_id` column, so there is no tenant dimension to forge.

**Findings**: none of the RLS policies inspected key off currency/locale/IP as an authorization signal — every one is `auth.uid() = user_id`. The three gaps above are real, but represent an *inferred*, not yet *demonstrated*, guarantee for tables that directly affect reported net worth and billing.

## 4. Mobile and responsive UX — full-app coverage inventory

Built from a full 96-route `page.tsx` glob cross-referenced against every doc under `docs/` mentioning a viewport width or "mobile" (this session's own consolidated sweep, `LR_CONSOLIDATED_ACCESSIBILITY_MOBILE_SWEEP.md`, is prior art, not repeated).

**The single biggest, most consequential gap found**: **`/dashboard` — the app's primary post-login landing page — has never been mobile-viewport-tested anywhere in this programme's history.**

**Other real, notable gaps**: the three modules G4 specifically opened to GENERIC-experience international users (`/score`, `/dna`, `/resilience`) have zero mobile evidence at all; their siblings (`/income`, `/expenses`, `/insurance`) only have FDH-upload-widget-level partial coverage, never the full page/register grid. Every pre-authentication and forced-onboarding page (`/login`, `/signup`, `/forgot-password`, `/reset-password`, `/onboarding`, `/confirm-country`, `/global-setup`) — 100% of a new user's first real interaction with the product — has zero mobile evidence, despite being exactly the surfaces most likely reached via a phone (e.g. an email link). Also uncovered: all of `/forecast` (11 sub-pages), all of `/investment-intelligence` (6 sub-pages), `/financial-twin` (3 pages), `/assets`, `/insurance`, `/reports/[id]` (detail, as opposed to the covered list page), all marketing static pages, and both print/export rendering surfaces (`(print)/forecast/report/print`, `(print)/reports/[id]/print`).

**Findings**: coverage gaps are purely a function of which phase happened to touch which file — no country/currency/locale/IP signal plays any role in what got mobile-tested. `/dashboard` and the pre-authentication surface are the two highest-priority gaps for any future mobile pass.

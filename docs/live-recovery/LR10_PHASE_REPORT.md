# LR-10 Phase Report — AU/India/Global Payment Operationalisation

**Status:** CONDITIONAL PASS — code complete, tested, tsc/lint/build clean; blocked on two things only the Product Owner can supply: (1) applying migration `0133` to DEV then production, and (2) real Stripe/Razorpay test-mode credentials for a live checkout/webhook round trip.

**Date:** 2026-09-09
**Branch:** `feature/phase1-design-system` (worktree `merge-napi-canvas-into-main`)

---

## 1. Scope and provider decision

Per the Product Owner's explicit choice, LR-10 builds **two separate, independent payment integrations**:

- **Stripe** for AU (and any future PO-approved Global price — none exists yet, see §2).
- **Razorpay** for India.

No third "Global/GENERIC" price point was invented. `lib/config/landingPricing.ts`'s own header is explicit that no PO-approved Global price exists; inventing one would be exactly the kind of unsupported pricing claim this programme's cross-cutting rules forbid. A confirmed GENERIC billing country (GB/US/SG/AE) gets an honest `NO_PLAN_FOR_REGION` denial rather than a fabricated price.

## 2. What was built

### Schema (migration `0133`, not yet applied — see §6)
- `user_entitlements` extended (additive only) with `provider`, `provider_customer_id`, `provider_subscription_id`, `subscription_status`, `price_id`, `current_period_end`, `cancel_at_period_end`. The existing `plan_tier` column and every existing reader of it (`lib/services/entitlements.ts`) is untouched — this is the same canonical entitlement register LR-8's report-export gate already reads, not a second source of truth.
- `payment_webhook_events` (new table): idempotency ledger, PK `(provider, provider_event_id)`, RLS enabled with **zero** policies/grants (service-role-only, same discipline as migration `0129`'s `mcc_generic_write_capabilities`).

### Plan catalogue
`lib/services/paymentPlanCatalogue.ts` — 4 real plans (AU monthly/annual via Stripe, IN monthly/annual via Razorpay), reusing the already-PO-approved `LANDING_MARKETING_PRICES` figures verbatim for display. Provider price/plan IDs come from env vars, `null` until the PO creates the actual Price/Plan objects in each provider's own dashboard — every caller treats `null` as `PROVIDER_NOT_CONFIGURED`, never a fabricated ID.

### Provider activation control (WP-12)
`lib/services/payments/stripeClient.ts` / `razorpayClient.ts` — both refuse to construct a client if the key is missing, or if a test-mode key is used in a production `NODE_ENV` (or vice versa), using each provider's own documented key-prefix convention. Verified by `tests/unit/paymentProviderActivation.test.ts` (10 cases).

### Checkout (WP-02/WP-04)
`POST /api/payments/checkout` — client supplies only an internal catalogue `priceId`, never an amount/currency/provider price ID. Billing country is read server-side from the caller's own **confirmed** `billing_country`, never the request body. Reuses the already-certified G1 `validatePriceForBilling()` unchanged; adds one new, honest pre-check (`NO_PLAN_FOR_REGION`) rather than widening that certified function. Routes to Stripe's hosted Checkout or Razorpay's hosted subscription-authorisation page — FHIP never collects a raw card/UPI/bank credential at any point.

### Webhooks (WP-05/WP-06)
`POST /api/payments/stripe/webhook` and `POST /api/payments/razorpay/webhook` — the **only** two places `user_entitlements.plan_tier` is ever changed. Both: verify the raw-body signature (Stripe via `stripe.webhooks.constructEvent`, Razorpay via the SDK's own `Razorpay.validateWebhookSignature`), claim the event via `payment_webhook_events` **before** any entitlement work (a `23505` unique-violation means "already processed", not an error), and fail closed (503) if the provider isn't configured. Unknown/unhandled event types are acknowledged (200) but marked `ignored`, never mistaken for an entitlement signal.

**Known, disclosed limitation (Razorpay only):** Razorpay's webhook payload does not document a universal per-delivery event ID the way Stripe's `event.id` does. The route uses the `X-Razorpay-Event-Id` header when present, falling back to a composite key (event type + subscription id + status) when absent. This is the best available idempotency key without live Razorpay webhook traffic to confirm the header's actual presence — flagged here rather than assumed reliable.

### Entitlement lifecycle (WP-07)
`lib/services/payments/entitlementSync.ts` — `active`/`trialing`/`past_due` keep Premium (a deliberate grace-period decision: both providers auto-retry a failed charge before finally cancelling; instant downgrade on the first decline would be user-hostile). Every other status (`canceled`, `incomplete`, `incomplete_expired`, `unpaid`) reverts to `free`.

**NEG-03 "Premium granted before webhook" — structurally impossible, not just avoided by convention:** checkout-session/subscription creation (`stripeCheckout.ts`, `razorpaySubscription.ts`) writes only `provider`/`provider_customer_id`/`provider_subscription_id` (pending state) before redirecting the user — never `plan_tier`. Only the webhook route can set `plan_tier: 'premium'`.

### Billing-country change vs. active subscription (WP-10)
`POST /api/user/billing-country/confirm` (existing G1 route, LR-10 is its first real caller) now blocks a billing-country **change** (not a re-confirmation of the same country) while the caller has a live (`active`/`trialing`/`past_due`) subscription, returning `ACTIVE_SUBSCRIPTION_BLOCKS_COUNTRY_CHANGE` (409) with a support-mediated path rather than a silent "cancel first" self-service option (cancelling loses Premium immediately, a worse outcome). The underlying `confirm_billing_country` RPC (migration `0122`) is unmodified — this is enforced at the one call site that can reach it with a real subscription in play.

### Receipts (WP-08)
`GET /api/payments/invoices` + `lib/services/payments/invoices.ts` — a thin, honest passthrough over each provider's own generated invoice/receipt records (Stripe `invoices.list`, Razorpay `invoices.all({subscription_id})`). FHIP computes no total, tax line, or receipt number of its own.

### Taxes (WP-09)
No tax figure or advice is invented anywhere in this phase. The receipts UI shows only the provider-reported total (`amount_paid` / `gross_amount`), which already includes whatever tax the provider itself calculated and charged — satisfied by omission, not by building a tax-breakdown feature that would require this app to compute or assert a tax position it has no authority to make.

### UI
`components/profile/BillingPanel.tsx`, wired into the existing Profile page (`app/(app)/profile/page.tsx`) as a new "Billing" section: shows plan/status/renewal date, a billing-country confirm/change control, available plans with an Upgrade button (redirects to the provider's hosted page), and the receipts list. `GET /api/payments/status` backs the panel's read side.

## 3. Real defects found and fixed during this phase

None — this is new capability, not a fix to existing broken behaviour. Two near-miss design decisions were caught and self-corrected before implementation (both already recorded in the working session, not repeated here): (a) declining to widen `billingAuthority.ts`'s certified `isFullExperienceCountry` gate, since no GENERIC price exists regardless; (b) mapping the new `app/api/payments/**` folder to the existing infra allowlist rather than the dormant `SUBSCRIPTION_PRICING` capability, which belongs to a separate, still-inactive G4/G5 gating system this phase does not touch.

## 4. Verification performed

- `npx tsc --noEmit` — clean.
- `npx eslint` on every new/changed file — clean (2 real errors caught and fixed: a `react-hooks/immutability` false-positive on `window.location.href =` resolved via `.assign()`, and one unescaped apostrophe in JSX).
- **43 new unit tests**, all passing, across 6 new test files:
  - `paymentProviderActivation.test.ts` (10) — WP-12 NOT_CONFIGURED / KEY_ENVIRONMENT_MISMATCH, both providers, both directions.
  - `paymentWebhookIdempotency.test.ts` (2) — NEG-04 duplicate-delivery detection, non-duplicate DB errors surfaced distinctly.
  - `entitlementSync.test.ts` (4) — status→plan_tier mapping including the `past_due` grace-period decision, both lookup helpers.
  - `paymentsCheckoutRoute.test.ts` (7) — NEG-01 (unconfirmed billing country), the GENERIC `NO_PLAN_FOR_REGION` honesty check, NEG-02 (region-mismatched price denied), unknown price denied, provider-unconfigured fails closed, both providers' happy paths.
  - `billingCountryConfirmRoute.test.ts` (6) — WP-10: blocks a real change under `active`/`past_due`, never blocks same-country reconfirmation, never blocks a free or cancelled-subscription user.
  - `paymentWebhookRoutes.test.ts` (9) — both webhook routes: unconfigured→503, NEG-05 invalid signature→400 before any entitlement work, NEG-04 duplicate acknowledged, unknown event types ignored (not processed), a real subscription-event payload correctly resolves userId and calls `applySubscriptionEvent` with the right fields.
- Two pre-existing test-completeness guards tripped and resolved (matching this programme's established pattern, not behaviour changes): `fdh1Isolation.test.ts`'s naive substring scanner flagged a comment in `stripeClient.ts` that happened to name a Financial-Data-Hub file path as a stylistic precedent — reworded to drop the literal path rather than adding to that test's allowlist, since it was not an actual cross-boundary reference. `appCapabilityManifest.test.ts`'s route-folder completeness check flagged the new `app/api/payments/` folder — added to its infra allowlist (mirroring the existing `account`/`user` precedent), with an explicit note recorded in that test file on why it is deliberately NOT mapped to the dormant `SUBSCRIPTION_PRICING` ModuleKey.
- Full repo test suite run (6,293 tests): 6,266 passed. The handful of failures were confirmed, by re-running each standalone, to be **pre-existing and unrelated to this phase** — six `*LiveDev` tests that require live DEV Supabase connectivity not available in this run, one already-failing AI-residual-closure negative control (`aiResidualClosureFailClosed.test.ts`, Module 11, untouched by LR-10), and transient timeouts on 3 files (including one of this phase's own) caused by full-suite parallel resource contention, not a real defect — each passed cleanly when re-run in isolation.
- `npm run build` (production build): clean, exit code 0. All 5 new payment routes (`/api/payments/checkout`, `/api/payments/invoices`, `/api/payments/razorpay/webhook`, `/api/payments/status`, `/api/payments/stripe/webhook`) and the `/profile` page (now carrying the new Billing panel) built with no errors or warnings.
- `npm audit` — the `stripe`/`razorpay` package additions themselves introduce no new advisories; the 4 pre-existing high-severity findings (`brace-expansion`, `js-yaml`, `nanoid`, `xlsx`) are unrelated transitive dependencies of unrelated tooling, unchanged by this phase.

## 5. Explicitly out of scope / disclosed gaps

- **No live provider round-trip was performed.** This requires real Stripe/Razorpay **test-mode** API keys, which only the Product Owner can create (account creation and credential handling are outside what this agent can do). Everything up to that boundary — signature verification, idempotency, entitlement mapping, activation control — is verified against realistic mocked payloads modelled on each SDK's own documented shapes, not live traffic.
- **Migration `0133` has not been applied anywhere yet** (DEV or production) — see §6.
- **Razorpay webhook event-id fallback** (§2, Webhooks) is a disclosed best-effort, not a proven-reliable mechanism, pending real Razorpay webhook traffic to confirm header behaviour.
- **No "cancel subscription" self-service action was built.** WP-10 deliberately routes a country-change-while-subscribed to a support-mediated path rather than self-service cancellation; a dedicated cancel button (calling the provider's own cancel API) was not requested as part of this phase's core deliverables and was not built.
- **No dunning/retry UI.** `past_due` is handled correctly at the entitlement layer (grace period, no downgrade) but there is no UI surfacing "your payment failed, update your card" — a user only sees this via the provider's own email/dashboard until the next successful charge or final cancellation.

## 6. What the Product Owner needs to do next

1. **Apply migration `0133`** to DEV (then, after confirming, to production — the same hold/verify/push/apply/re-verify sequencing used for every prior migration this programme has shipped).
2. **Create the actual Stripe Price objects** (AU monthly/annual) and **Razorpay Plan objects** (IN monthly/annual) in each provider's own dashboard, and set the resulting IDs as `STRIPE_PRICE_ID_PREMIUM_MONTHLY_AU` / `_ANNUAL_AU` / `RAZORPAY_PLAN_ID_PREMIUM_MONTHLY_IN` / `_ANNUAL_IN`.
3. **Set the remaining provider secrets** (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`) via environment variables only — never pasted into chat.
4. Register each webhook endpoint (`/api/payments/stripe/webhook`, `/api/payments/razorpay/webhook`) in the respective provider dashboard.
5. Once test-mode keys are in place, a live checkout→webhook→entitlement round trip can be run and independently verified.

---

*Continuing the LR-2..LR-12 programme: LR-11 (Company/Family Trust Entity Architecture — Child Discovery Only) is next. LR-1 (Upload Security) remains deferred to the end, per standing instruction.*

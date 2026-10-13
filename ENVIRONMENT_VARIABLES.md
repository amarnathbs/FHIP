# Environment Variables

No real values are recorded in this file. Copy `.env.example` to `.env.local` for local development; configure the same names as environment variables in AWS Amplify for deployed environments.

| Variable | Secret? | Where used | Purpose |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | No — public | Browser + server | Supabase project URL. `NEXT_PUBLIC_*` variables are inlined into the client JS bundle at build time; treat as public. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | No — public | Browser + server | Supabase anonymous/public API key. Safe to expose — access is governed by Postgres Row Level Security, not by keeping this key secret. |
| `SUPABASE_SERVICE_ROLE_KEY` | **Yes** | Server only (`lib/supabase/admin.ts` and code that imports it) | Bypasses Row Level Security entirely. Must never reach the client bundle, never be logged, never be committed. Only used for trusted server-side operations (e.g. the report-export signed-URL flow, admin operations). |
| `APP_BASE_URL` | No | Server only | Base URL the app uses to build absolute links when it can't infer one from an incoming request (notably the headless PDF-export renderer, which needs an absolute URL to navigate to). Set to `http://localhost:3000` locally; set to `https://app.financialhealthplatform.com` in production. |
| `CRON_SECRET` | **Yes** | Server only (`app/api/reports/cron/monthly-generate`) | Shared-secret bearer token the monthly report-generation cron endpoint requires in its `Authorization` header. Generate a long random value; configure the identical value on whatever scheduler calls this endpoint. |
| `G4_APP_CAPABILITY_LAYER_ENABLED` | No | Server only (`lib/services/appCapabilityFlag.ts`) | Whether the manifest-driven module-capability resolver (`requireModuleCapability()`) is active at all. Default OFF; unset/empty/any value other than the exact string `'true'` falls back to the legacy `requireCountryConfirmedUser()` behaviour. |
| `G5B_GENERIC_WRITE_ENABLED` | No | Server only (`lib/services/g5bWriteFlag.ts`) | Only has any effect once `G4_APP_CAPABILITY_LAYER_ENABLED` is already `'true'`. Governs whether GENERIC-experience users may CREATE/UPDATE Income/Expenses/Insurance. Default OFF. **Does not control the underlying database-layer grant** (migration `0129`'s `is_write_permitted()`) — see that migration's own header and `g5bWriteFlag.ts`'s header for the rollback-asymmetry this creates. |
| `G2_LANDING_LOCALISATION_ENABLED` | No | Server only (`lib/services/landingLocalisationFlag.ts`) | Whether the G2 landing-page country-detection/localisation experience is active. Default OFF, fails closed to the single global landing variant on any misconfiguration. |
| `G2_ALLOW_TEST_DETECTION_HEADER` | No | Server only (`lib/services/landingCountryContext.ts`) | Test-only escape hatch letting an incoming request override the detected visitor country via a header, for automated testing of the G2 country-detection waterfall. Must never be `'true'` in production. |
| `FDH_DOCUMENT_UPLOAD_ENABLED` | No | Server only (`lib/financial-data-hub/constants/featureFlags.ts`) | Ordinary env-var convenience flag for FDH-3 document uploads — defaults ON (only an explicit `'false'` disables it). This is NOT the real production gate: `isKnownNonProductionSupabaseProject()` in the same file is a hard, code-level check this flag cannot override, refusing real uploads unless the configured Supabase project is the one DEV project FDH-3 was certified against. |
| `ROLLOUT_<KEY>_ENABLED` / `_VERSION` / `_PERCENTAGE` / `_ALLOWLIST` / `_DENYLIST` | No | Server only (`lib/services/rolloutCohort.ts`) | G8 closure's canonical controlled-rollout primitive. `<KEY>` is a per-feature name a future caller chooses (e.g. `ROLLOUT_G8_EXAMPLE_ENABLED`); **no `<KEY>` is currently wired into any route**, so these variables have zero effect on anything in production today. See `rolloutCohort.ts`'s own header for the full design and `docs/country-programme/` for the G8.055 closure writeup. |

## Promo codes, Premium grants and reminder e-mails (hardening 2026-10-05)

Names only, no value anywhere in this file. **There are no fallbacks between these secrets.** Each has one purpose and one variable. A feature whose secret is missing, shorter than 32 characters, or equal to another dedicated secret **refuses with an explicit 503** (or stays disabled). It never uses another secret instead. All four secrets must be different values. Generate each one separately (for example 32 random bytes written as 64 hex characters) and never reuse an old value.

| Variable | Secret? | Where used | Purpose |
|---|---|---|---|
| `PROMO_CODE_DIGEST_SECRET` | **Yes** (new, mandatory) | Server only (`lib/services/promoSecrets.ts`, `promoCodeDigest.ts`) | Key of the HMAC digest that identifies a promo code. The database stores only the digest and a masked hint, never the plain code. Needed to create and to redeem a code. Rotation: see `docs/admin/PROMO_CODE_DIGEST_KEY_ROTATION_RUNBOOK.md`. |
| `PROMO_CODE_DIGEST_VERSION` | No (optional) | Server only | Integer 1 or more, default 1. The key version stamped on newly created codes. Raise it (and keep the old key in `PROMO_CODE_DIGEST_SECRET_PREVIOUS`) when rotating. |
| `PROMO_CODE_DIGEST_SECRET_PREVIOUS` | **Yes** (optional, rotation window only) | Server only | The previous digest key (version = current minus 1). Accepted for LOOKUP only, while codes made under it are still valid. Remove it when none remain. |
| `PREMIUM_PROMO_EMAIL_BIND_SECRET` | **Yes** (mandatory for e-mailed or address-bound codes, and for redemption) | Server only | Key of the keyed hash of an e-mail address: the address binding of a code and the dispatch ledger. **No longer falls back to `PROMO_IP_HASH_SECRET` or `CRON_SECRET`.** Changing it makes already bound codes unusable. |
| `PROMO_IP_HASH_SECRET` | **Yes** (mandatory for redemption) | Server only (`lib/services/promoCodeIp.ts`) | Key of the keyed hash of the client network address used for the redemption rate limit. **No longer falls back to `CRON_SECRET`.** |
| `CRON_SECRET` | **Yes** (mandatory for the scheduled routes) | Server only (`app/api/premium/cron/expiry-reminders`, `lib/services/premiumCronAuth.ts`) | Shared secret in the `x-cron-secret` header. Compared in constant time. Must equal the Vault secret `premium_reminder_cron_secret` that the database job sends (check with `premium_cron_verify`, migration 0268). |
| `PROMO_TRUSTED_PROXY_HOPS` | No (optional) | Server only | How many trusted proxy hops append to X-Forwarded-For. Default 1 (CloudFront). The client address is taken from the right end of the list. **UNVERIFIED for Amplify** (see the report, item 6). An invalid value means no network address is trusted, so only the per-user limit applies. **The Promo Codes page has a "Check my network address" button that shows which entry would be used, so the value can be settled on the deployed site.** |
| `PREMIUM_PROMO_EMAIL_ENABLED` | No | Server only | Kill switch for e-mailing a promo code. Only the exact text `true` enables sending. Default: unset (OFF). **Production decision 07-10-2026: kept ON.** Read at BUILD time (a change needs a redeploy); the instant stop is `docs/admin/po_apply_promo_hardening_release/emergency/STOP_promo_emails.sql`. |
| `PREMIUM_PROMO_EMAIL_FROM_NAME`, `PREMIUM_REMINDER_FROM_EMAIL` | No | Server only | Sender display name (default FHIP) and sender address for the promo and reminder e-mails. |
| `PREMIUM_REMINDER_SEVEN_DAY_ENABLED` | No | Server only | Optional seven day expiry reminder. Only the exact text `true` enables it. **Default: unset (OFF).** Do not enable before the deduplication proof in `tests/unit/premiumExpiryReminderSevenDayPglite.test.ts` is reviewed and the PO approves. |

The thirty day expiry reminder job itself is controlled by a database row (`premium_reminder_job_control`, key `expiry_email`), which ships and stays disabled. The retention job is controlled by the row `promo_retention`, which also ships disabled.

## AI Extraction Engine (AIE-1)

Added by M12C §13 (`M2-OPEN-4`). Until then not one `AIE_*` variable was documented anywhere in this repository, even though two of them are genuine secrets. **Names only — no value for any of these appears in this file, in `.env.example`, or in any committed file.**

The two that are secrets:

| Variable | Secret? | Where used | Purpose |
|---|---|---|---|
| `AIE_OPENAI_API_KEY` | **Yes** | Server only (`lib/aie/provider/openaiAieProvider.ts`, presence-checked in `lib/aie/provider/providerFactory.ts`) | The AIE gateway's own OpenAI API credential. Distinct from any Module 11 key. The factory throws rather than silently falling back to the mock provider when it is absent, so a misconfiguration fails loudly instead of quietly degrading. |
| `AIE_MASK_TOKEN_ENCRYPTION_KEY` | **Yes** | Server only (`lib/aie/masking/identifierToken.ts`) | 32-byte (64 hex characters) master secret for the one-way HMAC that produces `[MASKED:…]` identifier tokens. **There is no reversible token map anywhere in the product** — this key derives tokens, it never decrypts them. Masking fails CLOSED if it is unset: `maskText` throws, and `lib/aie/orchestrator.ts` degrades the run to reconciliation rather than crashing the request. Rotating it changes every future token; it does not expose any past one. |

The remaining `AIE_*` variables are not secrets — feature flags, pilot-cohort gating and tuning values, all server-only, declared across `lib/aie/featureFlags.ts`, `lib/aie/config.ts`, `lib/aie/review/featureFlags.ts` and the three adapter `featureFlags.ts` files. The exhaustive list of names lives in `.env.example`, and `tests/unit/m12cServerOnlySecretBoundary.test.ts` fails if the code ever reads an `AIE_*` name that file does not declare — so there is exactly one place to keep current, and forgetting it is a test failure rather than a silent gap. Each flag's own default and fail-closed behaviour is deliberately not restated in either place, because a restatement drifts.

**There is no `NEXT_PUBLIC_AIE_*` variable and there must never be one.** `tests/unit/m12cServerOnlySecretBoundary.test.ts` asserts this, asserts that no secret name has a `NEXT_PUBLIC_` twin, and asserts that no `'use client'` component can reach a secret-reading module even transitively.

## ⚠ Known gap: server-only flags and the Amplify build script

`amplify.yml`'s `build` phase only forwards a **fixed, explicitly hand-maintained list** of server-only environment variable names into `.env.production` (the only way a non-`NEXT_PUBLIC_*` variable reaches this app's runtime on Amplify — see that file's own header comment for why):

```
env | grep -e SUPABASE_SERVICE_ROLE_KEY -e CRON_SECRET -e APP_BASE_URL -e RESEND_API_KEY -e CONTACT_FROM_EMAIL -e G4_APP_CAPABILITY_LAYER_ENABLED -e G5B_GENERIC_WRITE_ENABLED -e G2_LANDING_LOCALISATION_ENABLED -e G2_ALLOW_TEST_DETECTION_HEADER -e ROLLOUT_ -e AIE_ -e STRIPE_ -e RAZORPAY_ -e II_AI_FALLBACK_ >> .env.production
```

**Corrected by M12C §13:** the block above is now quoted verbatim from `amplify.yml`'s current `build` phase. The version previously printed here omitted the four G-flags, `-e ROLLOUT_` and `-e AIE_`, all of which the real script has since gained — so this document was itself the source of a misleading "known gap". `-e AIE_` is a prefix match, so every `AIE_*` variable, including both secrets, is forwarded. **A reader who relied on the old quotation would have concluded that AIE configuration could not reach the runtime at all.** The paragraph that follows is retained because its underlying warning — that this list is hand-maintained and silently forgetting a new name has no failure mode — is still true; its specific four-flag claim is not.

**2026-09-21 fix (M13A finding):** `-e II_AI_FALLBACK_` was added for the OLD, pre-AIE Investment Intelligence AI-fallback path (`lib/services/investment-intelligence/aiFallbackFeatureFlag.ts`) — its own kill switch `II_AI_FALLBACK_ENABLED` and this same fix's new pilot-cohort gate (`II_AI_FALLBACK_PILOT_COHORT_ENFORCED`/`_USER_IDS`/`_EMAILS`) do not contain the substring `AIE_` (they are spelled `II_`, for "Investment Intelligence", not the AIE-1 gateway's own prefix), so the existing `-e AIE_` term never matched any of them — the same defect class as every entry above. A prefix, not each variable by exact name, is used here for the identical reason `-e AIE_` is a prefix above: it keeps the kill switch and its cohort allowlist inseparable, so a future operator cannot enable the switch alone while its paired safety gate stays silently unforwardable.

Historically, on `origin/main` and every branch checked at the time of the G6-G8 closure programme, **that list had not been updated to include `G4_APP_CAPABILITY_LAYER_ENABLED`, `G5B_GENERIC_WRITE_ENABLED`, `G2_LANDING_LOCALISATION_ENABLED`, or `G2_ALLOW_TEST_DETECTION_HEADER`** (the same is true for `FDH_DOCUMENT_UPLOAD_ENABLED`, though it defaults ON so this happens to be less consequential for it, and for any future `ROLLOUT_<KEY>_*` variable). Per the build script's own stated mechanism, setting one of these four flags in the Amplify console alone may have **zero effect at runtime** — `process.env.G4_APP_CAPABILITY_LAYER_ENABLED` (etc.) could read `undefined` in the actual deployed server process regardless of console configuration, because the value is never copied into `.env.production` at build time. This was found by source inspection during the G6-G8 closure programme and has **not** been confirmed against the live Amplify build logs or a live production `process.env` dump (this session has no such access) — it is reported here as a precise, checkable risk, not a confirmed production incident. An operator with Amplify console/build-log access should confirm one of: (a) this grep list needs updating before any of these four flags can ever take effect in production, or (b) Amplify's Next.js hosting compute forwards console-configured environment variables to the server runtime through some other mechanism this repository's own build script comment does not describe.

## Classification key

- **Secret**: must be stored only in Amplify's environment-variable store (or another secret manager), never committed, never printed in logs or error messages.
- **Public**: intentionally shipped to the browser; not a secret, but should still only ever point at the correct environment's Supabase project (don't let a preview build accidentally point at production).

## Supabase Auth / Resend configuration

The Resend API key used for outbound auth email (signup confirmation, password reset) is configured directly in the Supabase project's **Auth → SMTP settings**, not as a Next.js application environment variable — this app has no direct Resend integration in its own code. See [DEPLOYMENT.md](DEPLOYMENT.md) section 3.

## Adding a new environment variable

1. Add it to `.env.example` with a comment (no real value).
2. Add a row to the table above.
3. Add it to Amplify's environment variables for every environment that needs it.
4. If it must be readable in the browser, prefix it `NEXT_PUBLIC_` and treat it as non-secret — anything without that prefix is server-only by Next.js convention, which is what keeps `SUPABASE_SERVICE_ROLE_KEY` and `CRON_SECRET` out of the client bundle.

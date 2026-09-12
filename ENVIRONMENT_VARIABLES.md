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

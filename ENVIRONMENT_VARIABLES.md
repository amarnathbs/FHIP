# Environment Variables

No real values are recorded in this file. Copy `.env.example` to `.env.local` for local development; configure the same names as environment variables in AWS Amplify for deployed environments.

| Variable | Secret? | Where used | Purpose |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | No — public | Browser + server | Supabase project URL. `NEXT_PUBLIC_*` variables are inlined into the client JS bundle at build time; treat as public. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | No — public | Browser + server | Supabase anonymous/public API key. Safe to expose — access is governed by Postgres Row Level Security, not by keeping this key secret. |
| `SUPABASE_SERVICE_ROLE_KEY` | **Yes** | Server only (`lib/supabase/admin.ts` and code that imports it) | Bypasses Row Level Security entirely. Must never reach the client bundle, never be logged, never be committed. Only used for trusted server-side operations (e.g. the report-export signed-URL flow, admin operations). |
| `APP_BASE_URL` | No | Server only | Base URL the app uses to build absolute links when it can't infer one from an incoming request (notably the headless PDF-export renderer, which needs an absolute URL to navigate to). Set to `http://localhost:3000` locally; set to `https://app.financialhealthplatform.com` in production. |
| `CRON_SECRET` | **Yes** | Server only (`app/api/reports/cron/monthly-generate`) | Shared-secret bearer token the monthly report-generation cron endpoint requires in its `Authorization` header. Generate a long random value; configure the identical value on whatever scheduler calls this endpoint. |

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

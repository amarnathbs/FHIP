# Security Model

## Data isolation: Row Level Security

Every user-data table is protected by Postgres Row Level Security (RLS) policies defined in `supabase/migrations/`, scoped to `auth.uid()`. The Next.js app's normal server/browser Supabase clients (`lib/supabase/client.ts`, `lib/supabase/server.ts`) authenticate as the signed-in user and are subject to these policies — a user cannot read or write another user's household data through the normal app code path, even if application logic had a bug, because the database itself enforces the boundary.

`lib/supabase/admin.ts` creates a **service-role** client that bypasses RLS entirely. It exists only for the specific trusted server-side operations that genuinely need cross-user or elevated access (e.g. resolving a signed URL for a user's own exported report from storage, admin benchmark-governance endpoints, the cron report-generation job). Any new code that reaches for the admin client should be scrutinized: prefer the normal per-request client and let RLS do its job unless there's a specific, documented reason RLS can't apply.

## Secrets

- `SUPABASE_SERVICE_ROLE_KEY` and `CRON_SECRET` are server-only secrets — see [ENVIRONMENT_VARIABLES.md](ENVIRONMENT_VARIABLES.md). They must live only in `.env.local` (gitignored) locally and in Amplify's environment variable store in deployed environments. Never commit them, never log them, never put them in a URL query string.
- `NEXT_PUBLIC_*` variables are intentionally public (inlined into the client bundle) — access control comes from RLS and Supabase Auth, not from keeping these values secret.
- Before every commit that touches configuration, confirm no real secret value is hardcoded anywhere in source (a plain `.env.local` in the repo root is the most common accidental leak — confirm it stays gitignored).

## Authentication

Supabase Auth handles sign-up, login, session management, and password reset. `middleware.ts` redirects unauthenticated requests away from protected `(app)` routes. There is no separate application-level session store — the Supabase session cookie is the source of truth.

## Admin access

Admin-only API routes and UI (`app/(app)/admin/**`, `app/api/admin/**`) gate on the signed-in user's role via `/api/admin/me` and equivalent server-side checks — a non-admin user hitting an admin route should be rejected server-side, not merely hidden in the UI. Treat any admin route that only checks role in a client component (without a matching server-side check) as a bug to fix, not an accepted pattern.

Admin navigation visibility is a UX control only, not authorisation. Any change to Admin functionality — navigation, pages, roles, capabilities, APIs, privileged database access, or analytics/reporting — must follow the canonical **[FHIP Admin Architecture Standard](docs/admin/FHIP_ADMIN_ARCHITECTURE_STANDARD.md)**.

## Advice boundary

`lib/advice-boundary/check.ts` is a deliberate guardrail: FHIP surfaces financial *information and calculated scenarios*, not licensed personal financial advice. Any new user-facing copy or recommendation text should be checked against this boundary rather than assumed safe — this is a product/compliance requirement, not just a code-style preference.

## Dependency hygiene

- `npm audit --omit=dev` should show zero production-dependency vulnerabilities before each deploy; re-run it after any dependency bump.
- Dev-only vulnerabilities (e.g. transitive issues in lint tooling) don't block deployment but shouldn't be ignored indefinitely — track them for cleanup.

## Report exports

Exported report PDFs are stored in Supabase Storage and served via short-lived signed URLs generated server-side with the service-role client — never via a public bucket. If report storage requirements change, keep signed-URL-with-expiry as the default; don't switch to a public bucket without a specific reason and a fresh review.

## Pre-launch checklist

Before pointing real users at the production domain:
- [ ] `npm audit --omit=dev` clean.
- [ ] Repo-wide scan for hardcoded secrets (service-role key, Resend key, AWS keys, PEM headers, Postgres connection strings, bearer tokens) returns nothing.
- [ ] RLS spot-checked against the production Supabase project: sign in as two different test users, confirm neither can read the other's data via the app or a direct Supabase REST call with their own session token.
- [ ] Service-role key confirmed present only in Amplify's environment variables, not in any client-reachable code path.
- [ ] Auth redirect URLs in Supabase locked to the real production domain (not `localhost` or a preview URL).
- [ ] `CRON_SECRET` set to a freshly generated random value, not a placeholder.

## Reporting a concern

There is no external bug-bounty program. If a security issue is found in this codebase, raise it directly with the project owner rather than filing it as a public GitHub issue.

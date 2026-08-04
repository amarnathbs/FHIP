# Deployment Guide

Target stack: **GitHub** (source) → **AWS Amplify** (build + hosting) → **Cloudflare** (DNS) → **Supabase** (database/auth/storage, production project) → **Resend** (transactional email, via Supabase Auth SMTP).

Canonical production domain: `app.financialhealthplatform.com`.
AWS region: `ap-southeast-2` (Sydney).

This is a from-scratch deployment (no existing production environment). Treat every step below as one-time setup unless noted as repeatable.

## 1. Prerequisites

- GitHub repository: `https://github.com/amarnathbs/FHIP.git` (public, empty at time of writing).
- An AWS account with permission to create Amplify apps in `ap-southeast-2`. AWS CLI must be configured locally (`aws configure`) with credentials that have Amplify permissions — **do this yourself**; credentials are never entered by an AI assistant.
- A **new** Supabase project dedicated to production. Do not reuse any existing development/test Supabase project — those contain synthetic test data and test users.
- A Cloudflare account with the `financialhealthplatform.com` zone already added.
- A Resend account with the sending domain verified.

## 2. GitHub

```bash
git init
git branch -M main
git add <files>          # stage in logical groups, review with `git status`/`git diff` first
git commit -m "..."
git remote add origin https://github.com/amarnathbs/FHIP.git
git push -u origin main
```

Do not commit `.env.local`, `node_modules/`, `.next/`, or any file containing real secrets — see [SECURITY.md](SECURITY.md). Personal working documents (`.docx` files, temporary Word lock files like `~$*.docx`) at the repo root should not be pushed either; add them to `.gitignore` or move them out of the repo before the initial commit.

## 3. Supabase (production project)

1. Create a new Supabase project (do not reuse a dev project).
2. Apply every file under `supabase/migrations/` in filename order (Supabase CLI `supabase db push`, or paste each file into the SQL editor in order).
3. Run `supabase/seed.sql` to load baseline reference data (master financial item catalogue, benchmark cohort library, DNA archetypes). This is reference data required for the app to function, not test data.
4. **Auth → URL Configuration**: set Site URL to `https://app.financialhealthplatform.com` and add it to the redirect allow-list.
5. **Auth → SMTP settings**: configure custom SMTP with Resend:
   - Host: `smtp.resend.com`, port `587` (or `465`), username `resend`, password = your Resend API key.
   - Sender: `no-reply@auth.financialhealthplatform.com`, display name "Financial Health Intelligence Platform".
6. Note the project's URL and anon key (Settings → API) and the service-role key (Settings → API → service_role, secret) — these become Amplify environment variables in step 5.

## 4. Cloudflare DNS (manual)

No API token is configured for this — DNS changes are made by hand in the Cloudflare dashboard.

1. After creating the Amplify app and adding the custom domain (step 5 below), Amplify will show a CNAME target (e.g. `xxxxx.cloudfront.net` or an Amplify-specific verification record).
2. In Cloudflare DNS for `financialhealthplatform.com`, add a CNAME record: `app` → the target Amplify provides. Set proxy status per Amplify's instructions (Amplify's own SSL cert issuance typically requires **DNS-only** / grey-cloud until validated, then it can be proxied).
3. Add the sending-domain DNS records Resend provides (SPF/DKIM/DMARC, and a CNAME/MX for `auth.financialhealthplatform.com` if using a subdomain) to verify the sending domain.
4. Wait for propagation and confirm both the app domain and the mail domain show as verified in their respective dashboards before proceeding.

## 5. AWS Amplify

1. Amplify Console → New app → Host web app → connect the GitHub repo/branch (`main`).
2. Region: `ap-southeast-2`.
3. Build settings: Amplify will auto-detect `amplify.yml` at the repo root — verify it matches:
   ```yaml
   version: 1
   frontend:
     phases:
       preBuild:
         commands:
           - npm ci
           - npx playwright install --with-deps chromium
       build:
         commands:
           - npm run build
     artifacts:
       baseDirectory: .next
       files:
         - '**/*'
     cache:
       paths:
         - node_modules/**/*
         - .next/cache/**/*
   ```
   Note: `--with-deps` installs Chromium's OS-level dependencies via `apt`, which assumes a Debian/Ubuntu-based build image. Amplify's build image is Amazon Linux-based — **this has not yet been verified against a real Amplify build**. If the `preBuild` step fails on OS package installation, replace `--with-deps` with an explicit `apt`/`yum` dependency list appropriate to Amplify's actual image, or install Chromium's dependencies in a separate step.
4. Environment variables (Amplify Console → App settings → Environment variables) — see [ENVIRONMENT_VARIABLES.md](ENVIRONMENT_VARIABLES.md) for the full list and which are secret. At minimum: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `APP_BASE_URL=https://app.financialhealthplatform.com`, `CRON_SECRET`.
5. Trigger the first build. Watch build logs for the Playwright install step and the Next.js build step.
6. Domain management → add domain `app.financialhealthplatform.com`, follow Amplify's verification instructions (feeds back into step 4 above for the Cloudflare CNAME).
7. **Do not activate/promote this as the live production endpoint for real users until Phase 6 (end-to-end testing against the live domain) passes and the user gives an explicit go-ahead.** Every production activation requires a fresh explicit confirmation, even if staging looked fine earlier.

## 6. Scheduled jobs

The monthly report generation endpoint (`app/api/reports/cron/monthly-generate`) expects a `Bearer` token matching `CRON_SECRET` and is meant to be invoked by an external scheduler (e.g. Amazon EventBridge Scheduler → HTTPS target, or any cron-capable service that can send an `Authorization: Bearer <CRON_SECRET>` header). Set this up once the app is live and `CRON_SECRET` is configured in Amplify.

## 7. Post-deploy verification

Before telling real users the app is live:
- Sign up a fresh account against production Supabase, complete onboarding, confirm data entry, dashboard, health score, DNA, resilience, goals, twin, forecasting, and report generation (both tiers) all work against the production database.
- Confirm auth emails (signup confirmation, password reset) arrive and are sent from `no-reply@auth.financialhealthplatform.com`.
- Confirm the site is served over HTTPS at `app.financialhealthplatform.com` with a valid certificate.
- Run through [SECURITY.md](SECURITY.md)'s pre-launch checklist.

## Rollback

Amplify keeps prior build artifacts — use Amplify Console → App → the previous successful build → "Redeploy this version" to roll back the app tier quickly. Database migrations are not automatically reversible; do not apply a destructive migration to production without a tested down-migration or a verified backup first (see [OPERATIONS_RUNBOOK.md](OPERATIONS_RUNBOOK.md)).

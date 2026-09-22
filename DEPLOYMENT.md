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

The monthly report generation endpoint (`app/api/reports/cron/monthly-generate`) and every `cron/*` route under `app/api/financial-data-hub` and `app/api/aie` share the same shared-secret pattern: a `POST` request carrying header **`x-cron-secret: <CRON_SECRET>`** (confirmed against each route's own code, e.g. `req.headers.get('x-cron-secret')` — not an `Authorization: Bearer` header, which an earlier version of this doc incorrectly said). None of these routes self-schedule themselves; each one is meant to be invoked by an external scheduler (e.g. Amazon EventBridge Scheduler → HTTPS target, or any cron-capable service that can send a custom header). Set these up once the app is live and `CRON_SECRET` is configured in Amplify.

### Malware-scan sweep crons (real-malware-gate async fix, 2026-09-21)

When `AIE_REAL_MALWARE_SCAN_ENABLED=true`, every FDH-3 and AIE document upload is quarantined to S3 and scanned by GuardDuty Malware Protection (`lib/aie/malware/*`) before processing is allowed to proceed. A scan that does not finish inline (GuardDuty's own documented SLA: "the vast majority of scans complete within minutes") leaves the document sitting in `processing_status = 'validating'` until something calls one of the two sweep routes below to check GuardDuty's result and resume the document. **Nothing in the app itself does this on a schedule** — without an external scheduler hitting these routes, a document whose scan takes longer than the gate's own brief inline poll (a few hundred milliseconds) sits in `validating` until an operator manually invokes the sweep. (As of this fix, the frontend shows an honest "still scanning" state and times out gracefully after ~2 minutes instead of a raw error either way — but the document itself only actually finishes once one of these routes runs.)

**Operator action required before `AIE_REAL_MALWARE_SCAN_ENABLED` is turned back on in production**: set up a recurring EventBridge Scheduler invocation (every 1–2 minutes is reasonable, given the bounded ~2 minute frontend timeout above) for **both** of these routes:

1. `POST https://app.financialhealthplatform.com/api/financial-data-hub/documents/cron/malware-scan-sweep`
2. `POST https://app.financialhealthplatform.com/api/aie/cron/malware-scan-sweep`

Both require header `x-cron-secret: <CRON_SECRET>` (the exact same secret value already set in Amplify for the monthly-report cron) and no request body.

**Console steps** (repeat once per route above — two schedules total):
1. EventBridge console → **API destinations** → **Connections** → *Create connection*. Name it e.g. `fhip-cron-secret`, Authorization type **API key**, API key name `x-cron-secret`, API key value `<the real CRON_SECRET value>`.
2. **API destinations** → *Create API destination*. Name it e.g. `fdh3-malware-scan-sweep-dest`, API destination endpoint = the route URL above, HTTP method **POST**, Connection = the one just created.
3. EventBridge console → **Scheduler** → *Create schedule*. Name e.g. `fdh3-malware-scan-sweep`, **Recurring schedule**, rate expression `rate(1 minute)`, flexible time window **Off**.
4. Target: **EventBridge API destination** → select the API destination created in step 2. Leave the request payload empty (`{}`).
5. Execution role: let the console auto-create one (it only needs `events:InvokeApiDestination` scoped to this API destination) — do not reuse a broader existing role.
6. Save, then check **Scheduler → Schedules → (name) → Monitoring** after a few minutes to confirm invocations are succeeding (HTTP 200 with a JSON body like `{"data":{"scanned":0,...}}` when there is nothing to sweep — that is a healthy no-op, not a failure).
7. Repeat steps 1–6 for the second route (`.../aie/cron/malware-scan-sweep`) — a separate connection is not required, the same `fhip-cron-secret` connection can be reused for a second API destination pointed at the AIE URL.

**CLI sketch** (illustrative — the AWS CLI's exact JSON shape for `aws events create-connection` / `create-api-destination` / `aws scheduler create-schedule` has changed across CLI versions; verify each command's current parameters with `aws <command> help` before running against production):
```bash
aws events create-connection \
  --name fhip-cron-secret \
  --authorization-type API_KEY \
  --auth-parameters '{"ApiKeyAuthParameters":{"ApiKeyName":"x-cron-secret","ApiKeyValue":"<CRON_SECRET value>"}}'

aws events create-api-destination \
  --name fdh3-malware-scan-sweep-dest \
  --connection-arn <connection-arn-from-above> \
  --invocation-endpoint "https://app.financialhealthplatform.com/api/financial-data-hub/documents/cron/malware-scan-sweep" \
  --http-method POST

aws scheduler create-schedule \
  --name fdh3-malware-scan-sweep \
  --schedule-expression "rate(1 minute)" \
  --flexible-time-window '{"Mode":"OFF"}' \
  --target '{"Arn":"<api-destination-arn-from-above>","RoleArn":"<execution-role-arn>"}'
```
Repeat the last two commands (new destination + new schedule, same connection) with the AIE URL for the second sweep route.

Only turning `AIE_REAL_MALWARE_SCAN_ENABLED` back on in production without this scheduler in place will strand any upload whose scan takes longer than a few hundred milliseconds — this was the exact 2026-09-21 production incident this fix addresses. With the flag off (today's default), no document ever sits in `validating` for more than an instant, so these schedules are harmless no-ops until the flag is turned on.

**Alternative: this codebase's own `pg_cron` + `pg_net` mechanism (no AWS account needed).** This app's `purge-sweep` routes have used exactly this mechanism since migration `0135_lr1_document_purge_sweep_scheduler.sql` (FDH-3/LR-1) and `0149_aie1_closure_document_lifecycle_purge.sql` (AIE) — a job registered directly inside Supabase's own Postgres via `cron.schedule()`, firing `net.http_post()` on a fixed cadence, with the real `CRON_SECRET` value looked up from Supabase Vault at call time rather than ever written into a migration file. Migration `0174_aie1_malware_scan_sweep_scheduler.sql` registers the SAME kind of job for both malware-scan-sweep routes (`fdh3-malware-scan-sweep`, `aie1-malware-scan-sweep`, every 1 minute). This is the genuinely DEV-reachable option (no AWS console/IAM access required) — apply the migration, then run, once, directly in the target project's SQL Editor:
```sql
select vault.create_secret('<the real CRON_SECRET value>', 'aie1_malware_scan_sweep_cron_secret');
```
and replace the migration's `<REPLACE_WITH_REACHABLE_APP_ORIGIN>` placeholder with a real, publicly reachable origin for that environment before applying (Supabase's hosted Postgres cannot reach `localhost` — see the migration's own header for the full disclosure, including the same "no standing publicly-reachable DEV deployment exists yet" limitation this project's `0135` migration already discloses). The two mechanisms (this one and the AWS EventBridge one described above) are not mutually exclusive but should not both be pointed at the same route in the same environment — pick one per environment to avoid double-sweeping (harmless but wasteful, since the sweep is already idempotent).

## 7. Post-deploy verification

Before telling real users the app is live:
- Sign up a fresh account against production Supabase, complete onboarding, confirm data entry, dashboard, health score, DNA, resilience, goals, twin, forecasting, and report generation (both tiers) all work against the production database.
- Confirm auth emails (signup confirmation, password reset) arrive and are sent from `no-reply@auth.financialhealthplatform.com`.
- Confirm the site is served over HTTPS at `app.financialhealthplatform.com` with a valid certificate.
- Run through [SECURITY.md](SECURITY.md)'s pre-launch checklist.

## Rollback

Amplify keeps prior build artifacts — use Amplify Console → App → the previous successful build → "Redeploy this version" to roll back the app tier quickly. Database migrations are not automatically reversible; do not apply a destructive migration to production without a tested down-migration or a verified backup first (see [OPERATIONS_RUNBOOK.md](OPERATIONS_RUNBOOK.md)).

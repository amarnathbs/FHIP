# Operations Runbook

Day-2 operational procedures for the deployed FHIP app (AWS Amplify + Supabase + Cloudflare + Resend). For initial setup see [DEPLOYMENT.md](DEPLOYMENT.md).

## Routine operations

### Deploying a change
Push/merge to `main` on GitHub. Amplify is connected to the branch and builds automatically. Watch the build in Amplify Console — the `preBuild` phase installs Playwright/Chromium (needed for PDF export), then `npm run build` runs the Next.js production build. A failed build does not affect the currently-live deployment.

### Applying a new database migration
1. Add a new numbered file under `supabase/migrations/` (never edit an already-applied migration file — add a new one).
2. Test it against a non-production Supabase project first.
3. Apply to production via `supabase db push` or the SQL editor.
4. Confirm the app still builds/runs against the new schema before considering the migration "done" — Supabase has no automatic app-compatible rollback, so sequence schema changes so the deployed app tolerates both the old and new shape during rollout (additive changes first; remove old columns/tables in a later, separate migration once the app no longer references them).

### Monthly report generation cron
`POST app/api/reports/cron/monthly-generate` with header `Authorization: Bearer <CRON_SECRET>`. This must be invoked by an external scheduler (e.g. EventBridge Scheduler) — the app itself does not self-schedule anything. If monthly reports stop appearing for users, check: (a) the scheduler actually fired, (b) the request reached Amplify (check access logs), (c) the response status/body for errors.

### PDF report export
Report PDF export runs Playwright/headless Chromium **inside the Amplify build/runtime environment** (`lib/services/reportPdfRenderer.ts`). If PDF exports start failing in production but the rest of the app works:
- Confirm the `preBuild` Playwright install step succeeded in the latest build log.
- Confirm Amplify's runtime environment allows spawning a headless browser process (some serverless/edge runtimes don't — if Amplify's compute model changes, this is the first thing to re-verify).
- Chart rendering in the PDF depends on a readiness wait (`page.waitForFunction` on `.recharts-wrapper svg` non-zero width) before printing; if charts render blank in production PDFs but not locally, suspect a slower cold-start render time than the wait's timeout allows.

## Monitoring

- **Build/deploy health**: Amplify Console build history.
- **Application errors**: Amplify Console → Monitoring (CloudWatch-backed) for server-side (Route Handler) errors; browser console/network tab for client-side issues during manual checks.
- **Database health**: Supabase Console → Database → reports, and Auth → Logs for sign-in/email delivery issues.
- **Email delivery**: Resend dashboard for send/bounce/complaint status on auth emails.

No dedicated alerting/paging integration exists yet — monitoring today is dashboard-based, not push-based. If this becomes a real operational gap, add it as a follow-up rather than assuming it's covered.

## Incident playbooks

### Site is down / 5xx on every page
1. Check Amplify Console — is the latest build green? If a bad deploy just went out, redeploy the previous successful build ("Redeploy this version").
2. Check Supabase status — if Supabase itself is down, the app has no local fallback (it's fully dependent on Supabase for data and auth).
3. Check Cloudflare — confirm DNS still resolves `app.financialhealthplatform.com` to the correct Amplify target and the zone isn't in an unexpected state (e.g. "Under Attack Mode" blocking legitimate traffic).

### Users not receiving auth emails
1. Supabase Console → Auth → Logs — confirm Supabase attempted to send.
2. Resend dashboard — confirm the send was accepted and check bounce/spam-complaint status.
3. Confirm the sending domain's SPF/DKIM/DMARC records are still valid in Cloudflare (a DNS change elsewhere in the zone can silently break these).

### A migration broke production
1. Do not attempt an automatic rollback of the migration itself — write and apply a new, forward-only corrective migration.
2. If data was corrupted, restore from a Supabase backup (Supabase Console → Database → Backups) to a separate project first to assess the damage before deciding whether to restore production directly (a direct restore loses everything written since the backup).

## Backups

Rely on Supabase's built-in automated backups for the production project (confirm the plan tier includes the retention window your organization needs — the default enabled tier and window should be verified in the Supabase project settings at setup time, not assumed). There is no separate application-level backup mechanism in this codebase.

## Support data access

`SUPABASE_SERVICE_ROLE_KEY` bypasses Row Level Security and should only ever be used server-side, and only for the specific trusted operations already coded in `lib/supabase/admin.ts` and its callers. Do not use it ad hoc to query/modify user data for support purposes without going through the app's own service layer — see [SECURITY.md](SECURITY.md).

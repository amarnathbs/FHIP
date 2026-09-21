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
`POST app/api/reports/cron/monthly-generate` with header `x-cron-secret: <CRON_SECRET>` (corrected 2026-09-21 — this doc previously said `Authorization: Bearer <CRON_SECRET>`, which does not match the route's actual `req.headers.get('x-cron-secret')` check). This must be invoked by an external scheduler (e.g. EventBridge Scheduler) — the app itself does not self-schedule anything. If monthly reports stop appearing for users, check: (a) the scheduler actually fired, (b) the request reached Amplify (check access logs), (c) the response status/body for errors.

### Malware-scan sweep crons (FDH-3 + AIE)
`POST app/api/financial-data-hub/documents/cron/malware-scan-sweep` and `POST app/api/aie/cron/malware-scan-sweep`, each with header `x-cron-secret: <CRON_SECRET>` and no body. Both must be invoked by an external scheduler every 1–2 minutes — see [DEPLOYMENT.md](DEPLOYMENT.md)'s "Scheduled jobs" section for the exact EventBridge Scheduler setup (console steps + CLI sketch). **This is required infrastructure, not optional polish, whenever `AIE_REAL_MALWARE_SCAN_ENABLED=true` in production** — with no scheduler hitting these routes, any upload whose real S3+GuardDuty malware scan takes longer than the gate's own brief inline poll gets stuck in `processing_status = 'validating'` forever (the 2026-09-21 production incident this section documents). Both routes are safe, cheap no-ops when there is nothing pending, so running them on a schedule even while the flag is off costs nothing.

If a user reports an upload stuck "Validating" for more than a few minutes: (a) confirm the scheduler is actually invoking both sweep routes (check its own invocation history/logs — see DEPLOYMENT.md step 6 above), (b) manually invoke each route once with `curl -X POST -H "x-cron-secret: $CRON_SECRET" https://app.financialhealthplatform.com/api/financial-data-hub/documents/cron/malware-scan-sweep` (and the `/api/aie/...` sibling) and read the JSON response — the FDH-3 route reports `scanned`/`resolved_clean`/`resolved_blocked`/`still_pending`/`resumed_to_queued`; the AIE route reports the same first four fields but no `resumed_to_queued` (see the next paragraph) — to see whether GuardDuty has actually resolved the scan yet, (c) if `still_pending` stays nonzero for an unreasonable time, check the GuardDuty Malware Protection console / CloudWatch for that scan's own status — the sweep can only resume what GuardDuty has actually finished.

**Pre-existing, separately-disclosed gap on the AIE side** (`app/api/aie/cron/malware-scan-sweep/route.ts`'s own header comment, dated the same day the real-scan gate was wired in): the AIE sweep only updates `aie_document_intake.malware_scan_status` — unlike its FDH-3 sibling, it does **not** resume AIE's own extraction pipeline once a scan resolves `clean`. This is outside this section's fix (FDH-3's five processing services and their frontend panels); an AIE document stuck at `pending_scan` needs its own dedicated resume path built before `AIE_REAL_MALWARE_SCAN_ENABLED` is relied on for the AIE intake surface specifically.

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

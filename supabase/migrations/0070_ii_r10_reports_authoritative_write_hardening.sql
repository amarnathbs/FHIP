-- Investment Intelligence R10 -- Reports & Premium Packaging.
--
-- FINDING (2026-08-24, R10 discovery phase, live-DEV reproduction via
-- scripts/r10_repro_reports_forgery.mjs and
-- scripts/r10_repro_status_only.mjs): SAME-USER AUTHORITATIVE-WRITE FORGERY
-- -- CONFIRMED LIVE ON DEV, NOT HYPOTHETICAL.
--
-- The `reports` table family (created in migration 0010_module9_reports.sql,
-- predates Investment Intelligence entirely, never hardened since) grants
-- every policy as a single
--   for all using (auth.uid() = user_id) with check (auth.uid() = user_id)
-- -- the exact defect class this project has already found and fixed
-- repeatedly elsewhere (ii_review_items 0069, ii_tax_lots/capital_gains
-- 0062, fdh_statement_uploads.reconciliation_status 0065): row-level
-- OWNERSHIP is enforced, but every COLUMN on an owned row -- including the
-- displayed financial figures and the report's own provenance -- is freely
-- writable by the owning user via a raw REST call, never mind the app UI.
--
-- LIVE, REPRODUCED, CONFIRMED against real DEV this session (one disposable
-- test user, real JWT via anon key + password sign-in, real owned rows,
-- valid FKs throughout -- cleaned up immediately after, see
-- scripts/r10-repro-reports-forgery-results.json):
--   ATTACK-1 (status-only variant): PATCH reports SET status='published'
--     directly, bypassing publishReport()'s '.eq(status, ready)' guard
--     entirely -- SUCCEEDED (an unpublished/never-generated report can be
--     stamped "published" by its own owner with zero server validation).
--   ATTACK-2: PATCH report_sections SET section_data_json={netWorth:
--     99999999,...}, narrative_text='FORGED...' on an owned section --
--     SUCCEEDED. This is section_data_json/narrative_text -- the literal
--     displayed financial numbers and narrative of the report.
--   ATTACK-3: INSERT a fabricated report_snapshots row with
--     source_version='forged-engine-9.9.9' -- SUCCEEDED. Report provenance
--     is user-forgeable.
--   ATTACK-4: INSERT a report_exports row with status='ready' and an
--     arbitrary storage_path, with no PDF ever rendered -- SUCCEEDED. Chained
--     with the download route (which trusts storage_path straight off this
--     row), this is a path to signing a URL for ANY storage_path string the
--     forger chooses, including another user's real object path if it is
--     ever discovered.
--   ATTACK-5: PATCH report_generation_runs SET output_status='succeeded' on
--     an owned audit row -- SUCCEEDED. The generation audit trail itself is
--     forgeable by the same user it is meant to audit.
-- 4 of 5 attacks succeeded on first pass; the 5th (bundled with a
-- deliberately invalid financial_snapshot_id FK) was blocked only by an
-- incidental FK constraint, not by RLS -- the isolated re-run without that
-- FK (ATTACK-1 above) also succeeded, so the true count is 5/5.
--
-- FIX: none of these six tables are ever legitimately written to from the
-- browser -- grep of components/reports and app/(app)/reports/** confirms
-- every mutating call already happens inside server-only API routes/
-- services. This migration removes ALL insert/update/delete privileges for
-- the `authenticated` role on every table in the reports family, leaving
-- only SELECT-own. Every legitimate write moves to the service-role admin
-- client in the same commit (lib/services/reportsData.ts,
-- app/api/reports/[id]/exports/route.ts,
-- app/api/report-exports/[exportId]/download/route.ts) -- authorization is
-- still enforced by requireUser() + an explicit .eq('user_id', userId) (or
-- equivalent) check in that server code, exactly the same pattern already
-- used for report_exports' render_token handling and the cron job's report
-- generation path. This is a full lockdown, not a narrow trigger like
-- ii_review_items' 0069, because -- unlike acknowledge/dismiss -- there is
-- no legitimate end-user-initiated column-level write left on any of these
-- six tables once generation, publish, archive, retry and export are all
-- moved server-side.

drop policy if exists "own reports" on reports;
create policy "read own reports" on reports for select using (auth.uid() = user_id);

drop policy if exists "own report sections" on report_sections;
create policy "read own report sections" on report_sections for select using (auth.uid() = user_id);

drop policy if exists "own report snapshots" on report_snapshots;
create policy "read own report snapshots" on report_snapshots for select using (auth.uid() = user_id);

drop policy if exists "own report exports" on report_exports;
create policy "read own report exports" on report_exports for select using (auth.uid() = requested_by_user_id);

drop policy if exists "own report generation runs" on report_generation_runs;
create policy "read own report generation runs" on report_generation_runs for select using (auth.uid() = user_id);

drop policy if exists "own report access events" on report_access_events;
create policy "read own report access events" on report_access_events for select using (auth.uid() = user_id);

-- No insert/update/delete policy is created for any of the six tables for
-- the authenticated role -- PostgreSQL RLS defaults to deny for any
-- operation with no matching policy, so authenticated writes are now
-- unconditionally blocked. The service_role key (used exclusively by
-- server-side code from this point on for every write in this table
-- family) bypasses RLS entirely, as it always has.

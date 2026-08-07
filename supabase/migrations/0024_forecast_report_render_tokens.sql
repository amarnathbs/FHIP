-- Real PDF export pipeline for the Consolidated Forecasting Report
-- (Phase 2 universal formatting fixes — this report previously had no
-- server-rendered PDF at all, only a plain browser window.print() button
-- with no controllable page numbers). Mirrors report_exports'
-- render_token/render_token_expires_at pattern (0022_report_pdf_export.sql)
-- so the headless-Chromium renderer (lib/services/forecastReportPdfRenderer.ts)
-- can open the bare print route (app/(app)/forecast/report/print) without a
-- real user session. A dedicated table, not a reuse of report_exports,
-- because this report isn't a saved/versioned `reports` row — it's always
-- rendered live from the current forecast data, so there's no report_id to
-- attach a token to and no PDF file to persist in storage; the API route
-- streams the rendered PDF straight back to the caller.
create table forecast_report_render_tokens (
  token text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  scenario_id uuid,
  expires_at timestamptz not null,
  created_at timestamptz default now()
);
create index idx_forecast_report_render_tokens_expires on forecast_report_render_tokens(expires_at);

alter table forecast_report_render_tokens enable row level security;
-- No policies for authenticated/anon roles — this table is only ever
-- accessed via the service-role client (minted by the export API route,
-- redeemed and immediately deleted by the print route), the same
-- server-only usage pattern as report_exports.render_token.

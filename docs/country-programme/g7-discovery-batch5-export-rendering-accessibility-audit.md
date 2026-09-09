# G7 Discovery Batch 5 — Export/Rendering/Accessibility/Audit (G7.019–G7.023)

Repo: `D:\FHIP\.claude\worktrees\agent-a9fdb5d253f9b5fff` @ `cd7b201`.

## G7.019 — Report export formats

**Current repository owner:** `lib/engines/reportExport.ts` (pure decision logic: `isExportFormatImplemented`, `requiresPremiumEntitlement`), consumed by `app/api/reports/[id]/exports/route.ts` (POST creates an export, GET lists them) and `app/api/report-exports/[exportId]/download/route.ts` (signed-URL download). Schema owner: `report_exports` table, first defined in `supabase/migrations/0010_module9_reports.sql` (lines 136-153, `export_format text not null check (export_format in ('pdf', 'print', 'csv'))`), extended by `0022_report_pdf_export.sql` (adds `render_token`/`render_token_expires_at`) and locked down (RLS SELECT-own only) by `0070_ii_r10_reports_authoritative_write_hardening.sql`. Tests: `tests/unit/reports.test.ts` line 77 ("Persona H / I") asserts the exact matrix below as a pure unit test; `tests/unit/forecastReportExportEntitlement.test.ts` and `tests/unit/reportExportDownloadCacheHeader.test.ts` cover the sibling forecast-report export route and the download route's cache header, respectively.

**Formats that exist today — classification: live and connected (print, pdf) / backend-only-honest-stub (csv):**
- `print` — not premium-gated, "implemented" (it's just the on-screen `app/(print)/reports/[id]/print` route, browser print-to-PDF).
- `pdf` — premium-gated, genuinely implemented via a real headless-Chromium render (`lib/services/reportPdfRenderer.ts`).
- `csv` — accepted as a valid enum value at both the DB constraint and the `ExportFormat` type level, premium-gated, but `isExportFormatImplemented('csv')` returns `false`. The POST route (`app/api/reports/[id]/exports/route.ts` lines 43-63) inserts the `report_exports` row with `status: 'failed', error_code: 'not_implemented'` immediately, with no renderer ever invoked. This is deliberately honest bookkeeping, not a bug — comment at lines 17-21 states this explicitly. **Classification: backend-only / stale-by-design (recorded-as-failed, never live).**

**Country-specific formatting in the export format itself:** None exists in `reportExport.ts` or the export route — format selection (`pdf`/`print`/`csv`) carries zero country/locale logic. Number/date/currency formatting is not part of the *export format* decision layer at all; it lives one level down in the rendered content (see G7.020's currency-locale finding). **Verdict: no export-format-level country conditionality exists — new requirement if wanted.**

## G7.020 — PDF rendering

**Owner:** `lib/services/reportPdfRenderer.ts` (`renderReportToPdf`), invoked only from `app/api/reports/[id]/exports/route.ts` line 66. No tests directly exercise it (no mock/failure-injection test for `renderReportToPdf` itself exists anywhere in `tests/`).

**Mechanism:** Not a template/HTML-to-PDF library — it drives real Playwright headless Chromium (`chromium.launch()`) against the app's own `/reports/[id]/print` route (short-lived `render_token`, 5-min TTL, single-use, minted/cleared per export — lines 18-26, 110-113) and calls `page.pdf()`. Page format is **hardcoded `format: 'A4'`** (line 100) — no AU/US Letter branching, no country-conditional page size logic anywhere in this file. Margins/header/footer are also hardcoded, format-agnostic. **Classification: live and connected, no country-conditional logic present (none was ever added — not a removed feature).**

**Currency/locale in the rendered content:** The PDF renders the exact same React print page as the on-screen view, which pulls `reporting_currency` (`'AUD'|'INR'`) from the `reports` row and formats amounts via `lib/engines/money.ts`'s `formatMoney`/`formatMoneyWhole`:
```
const locale = currency === 'INR' ? 'en-IN' : 'en-AU';
new Intl.NumberFormat(locale, { style: 'currency', currency }).format(amount)
```
This *is* real currency-conditional number formatting (Indian digit grouping for INR, Western grouping for AUD, correct symbol placement via `Intl`) — but it is keyed off `reporting_currency` (itself sourced from `user_profiles.preferred_currency`, `lib/services/reportSnapshotResolver.ts` line 228), never off country directly and never off any client-supplied value. **Date formatting, however, is hardcoded to `'en-AU'` unconditionally** regardless of currency/country — found in `lib/services/reportsData.ts` line 39, `components/reports/ReportHistoryTable.tsx` line 42, and `components/reports/ReportPreview.tsx` lines 109/112/785. All of these use spelled-out month names (`{ day: 'numeric', month: 'long', year: 'numeric' }`), so there is no DD/MM-vs-MM/DD numeric ambiguity bug — but an INR/India report still gets an AU-locale-formatted date string. **Classification: partially wired / inconsistent — currency formatting is properly locale-aware and data-driven, date formatting is not locale-aware at all (hardcoded en-AU everywhere, including for INR reports).**

**napi-canvas/pdfjs-dist production-bundling issue:** Confirmed **unrelated to Reports PDF generation.** That issue (`next.config.mjs` `serverExternalPackages: ['pdf-parse', '@napi-rs/canvas']` plus `outputFileTracingIncludes` scoped to exactly `/api/investment-intelligence/source-documents/[id]/process` and `/api/financial-data-hub/bank-pdf/[documentId]/process`) is about the **Investment Intelligence/Financial Data Hub document-*extraction*** pipeline (`pdf-parse` reading uploaded bank/CAS PDFs), a completely different code path from `reportPdfRenderer.ts` (which uses Playwright's own bundled Chromium, not pdfjs-dist/@napi-rs/canvas at all). **Report PDF rendering is currently healthy/live and not implicated by that known issue.**

## G7.021 — Accessibility and plain language

**No accessibility audit or pass exists specifically for the Reports module.** Evidence:
- `grep -c "aria-|role="` across `components/reports/ReportPreview.tsx`, `app/(app)/reports/[id]/page.tsx`, `app/(print)/reports/[id]/print/page.tsx` returns **0** in all three files — no ARIA labels, no roles, anywhere in the Reports rendering stack (charts are bare Recharts SVGs, tables have no `scope`/caption structure).
- The only accessibility-specific test/doc pair in the repo is FDH-14 (`docs/financial-data-hub/FDH14_UI_ACCESSIBILITY_SMOKE.md`, `docs/financial-data-hub/FDH8_ACCESSIBILITY_CERTIFICATION.md`, `tests/e2e/fdh14-ui-accessibility-smoke.spec.ts`), and it is explicitly scoped to the **Financial Data Hub** module (CSV upload flows), not Reports.
- `app/(marketing)/accessibility/page.tsx` is a public marketing statement page ("Our commitment", general practices) added under LR-9 WP-05 — a policy statement, not a technical audit, and not module-specific.
- No `jsx-a11y`-specific lint config beyond whatever ships inside `eslint-config-next/core-web-vitals` (`eslint.config.mjs`) — no dedicated a11y linting layer for this repo.
- No plain-language/readability check of any kind exists for report narrative text (`narrative_text` column, `report_sections`).

**Classification: cannot verify a pass ever happened because none exists — this is a genuine new requirement for Reports specifically**, distinct from and not covered by FDH-14's scope.

## G7.022 — Content versioning

**Canonical ownership already exists and is live** — this is not a new requirement, contrary to the prompt's suggestion that `resource_posts` itself might lack a version column.

- `resource_posts` itself (schema: `supabase/migrations/0049_reconcile_phase0c_resources_lineage.sql` lines 474-545) has **no version column** on the row itself — only `updated_at`/`updated_by` (last-editor tracking, no history).
- However, a **separate revision-history table**, `resource_post_versions`, exists (migration 0049 lines 706-725, originally `migration_archive/0033_resources_foundation.sql` line 532): `id, post_id, version_number, snapshot jsonb, change_summary, created_by, created_at`, unique on `(post_id, version_number)`, RLS restricted to resource staff (`"staff read post versions"` / `"staff insert post versions"`, lines 1034-1039).
- The migration's own comment (lines 720-725) says "the table exists as the foundation; write path is deferred" — **but that comment is now stale**: a real write path exists and is wired end-to-end:
  - `lib/resources/editor/mutations.ts`, `createResourceVersion()` (lines 201-211) — computes `version_number` via SELECT-max-then-insert, retries once on collision, called from the PATCH save route (comment: "the caller... decides `createVersion` based on the save's origin — first save, manual Save, workflow submission, pre-publish save — never bare autosave").
  - Read side: `lib/resources/editor/queries.ts` → `getResourcePostVersions()`, exposed via `app/api/admin/resources/content/[id]/versions/route.ts` (also mirrored for videos: `app/api/admin/resources/videos/[id]/versions/route.ts`), with double-enforced staff-only authorization (RLS + explicit `isResourceStaff()` check at the API layer, added per an Admin A0.2 Wave 4 defence-in-depth fix documented inline at lines 20-27 of that route).
  - UI: `components/resources/editor/RevisionHistoryPanel.tsx` consumes this.
- A separate `resource_workflow_history` table (migration 0049 lines 727+) tracks status-transition audit trail (from_status/to_status/actor/reason), distinct from content-snapshot versioning.

**Classification: live and connected.** Canonical ownership of "content versioning for Resources" already exists (`resource_post_versions` + `lib/resources/editor/mutations.ts`/`queries.ts` + the versions API routes + `RevisionHistoryPanel.tsx`). No such mechanism exists for Reports (reports are immutable-with-`revises_report_id` lineage instead — see G7.023 — which is a different, already-answered concept for that module).

## G7.023 — Audit and provenance

**Owner and mechanism are extensive and already largely built,** centred on `reports`, `report_generation_runs`, `report_snapshots`, and `report_access_events` (all defined in `supabase/migrations/0010_module9_reports.sql`).

**Reports' own audit columns (schema, `reports` table, lines 48-82):** `version_number`, `revises_report_id` (self-FK forming an explicit lineage chain), `revision_reason`, `generated_at`, `published_at`, `failure_code`, `failure_message`, `template_version`, `disclaimer_version`, `data_completeness_pct`, `financial_snapshot_id`/`health_score_snapshot_id`/`resilience_snapshot_id`/`dna_snapshot_id`/`financial_twin_id` (explicit FKs to the exact source records used). Corrections never mutate a published report in place — `generateReport()`'s revision path (`lib/services/reportsData.ts` lines 183-190, 302-304) inserts a new row and marks the original `superseded`.

**Generation-run audit trail:** `report_generation_runs` (0010 lines 159-173): one row per attempt (manual or scheduled), `trigger_type`, `started_at`/`completed_at`, `output_status`, `retry_count`, `failure_details`, `worker_version`. Written at both start and finish of every `generateReport()` call (`reportsData.ts` lines 104-108, `finishRun()` lines 314-326), for every branch — already-exists, not-eligible, success, and thrown-exception.

**Data-snapshot lineage:** `report_snapshots` (0010 lines 115-127) records `snapshot_type`, `source_version` (the *engine's own* version string, e.g. `source.healthScore.modelVersion`, never a value the report module invents — explicit comment at `reportsData.ts` lines 281-284), `source_as_of_date` — one row per contributing data source (financial/score/resilience/dna/Investment-Intelligence chapters), inserted at generation time (lines 239-300).

**Access/download audit:** `report_access_events` (0010 lines 178-186) records `viewed|printed|exported|downloaded` events with `user_id`/`report_id`/timestamp; written from `recordAccessEvent()` (`reportsData.ts` lines 413-416) and from the download route (`app/api/report-exports/[exportId]/download/route.ts` line 39).

**Ownership/tenant-isolation hardening — already a documented, fixed, and *re-tested* incident, not merely designed:** `supabase/migrations/0070_ii_r10_reports_authoritative_write_hardening.sql` documents a **live, reproduced, confirmed** same-user forgery vulnerability (2026-08-24) across all six reports-family tables — an owning user could, via raw REST, forge `status='published'`, rewrite `section_data_json`/`narrative_text`, fabricate `report_snapshots` provenance rows, fabricate a `report_exports` `status='ready'` row with an arbitrary `storage_path`, and forge `report_generation_runs.output_status='succeeded'` — 5 of 5 attacks succeeded pre-fix. The fix (same migration) strips all authenticated insert/update/delete grants down to SELECT-own only, moving every legitimate write to the service-role admin client with authorization enforced by `requireUser()` + explicit `.eq('user_id', ...)` checks in the API/service layer.

**Positive/negative/cross-tenant controls that already exist (inventory):**
- `scripts/r10_repro_reports_forgery.mjs` — the original live-DEV attack reproduction (positive proof the vuln existed).
- `scripts/r10_repro_cross_user.mjs` — a genuine cross-tenant attack script: two real disposable users (A victim, B attacker) with real JWTs; B attempts direct-by-real-id reads of A's `reports`/`report_sections`/`report_exports` rows and a signed-URL-style read of A's real storage object; asserts `0` rows returned to B.
- `scripts/r10_reports_rls_certification.mjs` — a PGlite (real Postgres 18 wasm) harness that (1) proves the owning user can still SELECT their own rows post-fix (no read regression), (2) proves all 5 forgery attempts now fail, (3) proves cross-tenant read/write denial holds, (4) proves the service-role client can still perform every legitimate write, and (5) is a genuine **negative control**: it re-applies the *old* permissive policy on a scratch copy of `reports` and proves the exact same forgery attempt succeeds again — demonstrating the test suite isn't vacuous.
- `tests/unit/reportExportDownloadCacheHeader.test.ts` — covers a related but distinct LR-8 finding (private report data must not be cached by intermediaries), exercises the real download route handler with mocks.
- No comparable failure-injection test exists for the *renderer* itself (`renderReportToPdf` failure path, i.e. `status: 'failed', error_code: 'render_failed'` at `app/api/reports/[id]/exports/route.ts` lines 90-96, is untested).

**Classification: live and connected, with substantial pre-existing security certification (positive, negative, and cross-tenant controls all present and passing) for the ownership/forgery dimension of audit integrity.** The audit *data model* itself (who/when/from-what-snapshot) is complete and already wired for every report generation, revision, export, and access event — this is not a new requirement; any G7 work here would be extending/formalizing existing coverage (e.g., renderer failure-injection tests), not building the mechanism from scratch.

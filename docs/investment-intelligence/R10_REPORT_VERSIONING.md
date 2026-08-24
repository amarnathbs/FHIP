# II-R10 — Report Versioning & Historical Snapshots

Status: REUSED, unmodified versioning model; SECURED further this session.

## Model (pre-existing, migration 0010)

`reports.version_number` + `revises_report_id` chain; `status` enum
(`draft/queued/generating/ready/published/failed/revised/superseded/archived`);
`template_version`/`disclaimer_version` columns. A revision creates a new
row (`version_number + 1`) and marks the original `superseded` —
`generateReport({ reviseReportId, revisionReason })`.

## Immutability (spec section 69, 12)

Before this session: a historical report's rows were only as immutable as
the RLS on `reports`/`report_sections`/`report_snapshots` allowed — and (as
`R10_REPORT_SECURITY_MODEL.md` documents in full) that RLS allowed the
owning user to directly rewrite them. **This was therefore not genuinely
guaranteed immutability, despite the schema's own design intent.**

After migration `0070` (live on DEV, independently re-verified this
continuation): `reports`/`report_sections`/`report_snapshots` grant
SELECT-own only to the authenticated role — no UPDATE/INSERT/DELETE path
exists for anyone except the service-role report-generation code. A
historical report's snapshot and sections are now genuinely immutable from
the outside, not just by application-layer convention.

## This session's II chapters and versioning

The five new chapters do not introduce a separate report-schema version —
they are additional `report_sections` rows on the same `reports` row,
carrying the same `template_version`/`report.version_number` as every other
section in that report. Each chapter's own engine version
(`ii_performance`/`ii_sip`/`ii_xray`/`ii_tax` snapshot rows'
`source_version`) is the finer-grained, per-chapter version signal — see
`R10_REPORT_PROVENANCE.md`.

## Not verified this session

- Staleness detection/display (spec section 53) for the 5 new chapters
  specifically — e.g. "your II analytics were last refreshed on X, this
  report is from Y" — was not implemented or tested. The report as a whole
  already carries `as_of_date`/`generated_at`; per-chapter staleness
  relative to the underlying II engine's own last-run date is a genuine
  gap.
- A live regenerate-after-data-change test (LIVE-R10-019/020 in spirit)
  confirming an old report's II chapter content survives unchanged after a
  user's II data changes, while a new report reflects the change, was not
  run this session (no II data existed for the live test users to change).

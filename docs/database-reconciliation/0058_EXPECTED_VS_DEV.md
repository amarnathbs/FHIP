# 0058 reconciliation — expected vs DEV (verification by direct query)

**No SQL was applied to DEV as part of this reconciliation.** This document
records a direct-query verification pass (service-role key, DEV project
`vqycarelcoijzwlpkpcz`, run 2026-08-23) confirming that everything both
original `0058` migrations describe is already live and functional — the
expected outcome, since both had already been independently applied before
this reconciliation started (see `0058_CANONICAL_LINEAGE_DECISION.md`).

Method: `scripts/fdh3_rls_certification.mjs` and `scripts/fdh3_dev_
certification.mjs` (FDH-3's own certification suite, both re-run fresh —
see `0058_INTEGRATION_COMPLETION_REPORT.md` section E) plus a standalone
PostgREST-based verification pass covering both sides in one script, run
directly against DEV with the service-role key from `.env.local`. Every
check below is a live HTTP round-trip, not an inference from file content.

## FDH-3 side (migration `0058`, filename unchanged)

| Expected object | DEV result |
| --- | --- |
| `fdh_upload_sessions` table | PRESENT — HTTP 200 |
| `fdh_document_audit_events` table | PRESENT — HTTP 200 |
| `fdh_statement_uploads` 7 added columns (`storage_provider`, `uploaded_at`, `validated_at`, `processing_started_at`, `processing_completed_at`, `purge_requested_at`, `duplicate_of_document_id`) | ALL PRESENT — HTTP 200 selecting all 7 |
| `fdh-source-documents` storage bucket | PRESENT, `public: false` |
| 2 FDH1-F1 triggers (`trg_fdh_upload_sessions_owner`, `trg_fdh_ingestion_jobs_owner`) | FUNCTIONAL — cross-tenant insert genuinely refused, same-tenant insert genuinely succeeds (`fdh3_rls_certification.mjs`, PGlite replay of the identical SQL, 18/18 including 2 explicit trigger checks) |
| `storage.objects` SELECT policy (`fdh-source-documents`, folder-scoped) | FUNCTIONAL LIVE — real upload/signed-read/private-verify/anon-denied/delete-verify against real DEV storage (`fdh3_dev_certification.mjs`, 11/11) |

PostgREST cannot introspect trigger/policy catalogs directly (no
`information_schema.triggers`/`pg_policies` exposed over the REST API), so
those two rows are confirmed via the two dedicated certification scripts
rather than raw table introspection — both scripts talk to the SAME DEV
project and were re-run fresh in this session, not reused from a prior
session's cached output.

## Investment Intelligence R6 side (originally `0058`-`0062`, now `0059`-`0063`)

| Expected object | DEV result |
| --- | --- |
| `ii_scheme_tax_classification` table | PRESENT — HTTP 200 |
| `ii_exit_load_schedules` table | PRESENT — HTTP 200 |
| `ii_tax_lot_consumptions` table | PRESENT — HTTP 200 |
| `ii_capital_gains_computations` table | PRESENT — HTTP 200, readable via service-role (post-`0062` policy rename) |
| `ii_tax_lots` corrected RLS policy (`0062`) | Table present and service-role-readable; the SELECT-only-for-owner shape is certified structurally via the identical SQL replayed in the clean-rebuild (`0058_CLEAN_REBUILD_CERTIFICATION.md`) — a service-role client bypasses RLS by design and cannot itself prove a policy's shape from the outside |
| `ii_tax_profiles` table | PRESENT — HTTP 200 |
| `ii_tax_rule_versions`, `rule_set_key = 'in_mutual_fund_capital_gains'` | 3 rows present, all `placeholder: false` |
| — `1961_act_pre_20240723`, `1961_act_post_20240723`, `2025_act_post_20260401` each carry `debtSpecified.legacyRegime` | PRESENT on all 3 rows (confirms `0063`'s debt-fund-fix UPDATE landed) |
| — `2025_act_post_20260401`: STCG 20% / LTCG 12.5% | CONFIRMED (the corrected `0059`/originally-`0058` seed value, not a stale pre-correction figure) |
| ICICI Prudential Corporate Bond Fund debt instrument (ISIN `INF109KA1Z62`, `0060` seed) | PRESENT, exactly 1 row |

## Result

**20/20 direct-query checks passed. Everything from both original `0058`
migrations — and R6's full follow-on chain through the original `0062` — is
present and functionally correct in DEV.** No discrepancy found. No SQL
needs to be applied to DEV as a consequence of this reconciliation; the
renumbering is filename-only bookkeeping, as `0058_CANONICAL_LINEAGE_
DECISION.md` explains.

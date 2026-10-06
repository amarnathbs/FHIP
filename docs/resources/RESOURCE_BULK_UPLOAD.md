# Resources Bulk Upload: Articles + Money Updates

One reusable framework for two content types, not two upload systems. Manual creation (New Article, New Money Update, Create Money Update from Template, editing, autosave, preview, workflow, revision history) is unchanged and remains first-class. Bulk upload is additional.

**Invariants:** upload is not publish. Upload creates a **private draft**. Article upload goes to the existing Article editor; Money Update upload goes to the existing Money Update editor. Finished bodies become canonical `content_blocks`. Sources are `resource_sources`. Category, tag and CTA are the existing relationships. The spreadsheet cannot approve, schedule, publish or bypass the GREEN / AMBER / RED workflow. A failed apply creates nothing. The same file twice creates nothing the second time. An existing human-edited Resource is never overwritten (v1 is create-only).

## Where things are

| Concern | Location |
|---|---|
| Shared engine | `lib/resources/import/` (`types`, `common-schema`, `file-security`, `parser`, `markup`, `validation`, `staging`, `results-csv`, `template-generator`, `adapters`, `access`, `history`) |
| Article adapter | `lib/resources/import/article/` (`schema`, `validation`, `mapper`, `template`) |
| Money Update adapter | `lib/resources/import/money-update/` (`schema`, `validation`, `mapper`, `template`) |
| File readers (hostile-input safe) | `lib/services/investment-intelligence/benchmarkData/fileIngest/` (reused, not copied); XLSX is only ever WRITTEN with SheetJS (templates), never read with it |
| API | `app/api/admin/resources/import/**` |
| Admin pages | `app/(app)/admin/resources/import/**` (chooser, upload, preview/result, history) |
| Components | `components/resources/import/**` |
| Capability | `lib/resources/permissions.ts` `canBulkImportResources` (`resources.content.bulk_import`), `lib/admin/adminNav.ts` field `resourceContentBulkImport` |
| Database | `supabase/migrations/0272_resource_content_bulk_import.sql` |
| Template docs (generated) | `ARTICLE_UPLOAD_TEMPLATE_SPEC.md`, `MONEY_UPDATE_UPLOAD_TEMPLATE_SPEC.md` |

## The flow

1. `/admin/resources/import`: "What would you like to upload?" Articles or Money Updates (the same importer). Contextual buttons: **Upload Articles** on All Content; **Upload Updates** and **Download Template** on Money Updates.
2. Download a template (4 files: Article and Money Update, XLSX and CSV). Headers come from the same schema the parser reads.
3. Upload the file. The server (not the browser) checks the type, size, content and every value, then: parse, validate schema, normalise, resolve references in a constant number of queries, stage, preview.
4. Preview: type, file, template version, rows, ready, with notes, with errors, duplicates; a row table (Row, Title, Type, Jurisdiction, Compliance, Category, Status, Issues) with expandable detail; a downloadable validation results CSV (row, field, error_code, message).
5. Confirm "Create N Articles as private Drafts?". Apply sends only the run id. The database function creates every row in one transaction, or none.
6. Result "N created, 0 failed" with links: View imported drafts, Open first draft, View import history.

## Staging, retention and audit

- `resource_content_import_runs` (one row per file: actor, content type, file name, SHA-256, template version, counts, status, failure code, timestamps) and `resource_content_import_rows` (normalised rows between preview and apply).
- The raw file is never stored: only its SHA-256 and the normalised rows. No bucket is used.
- Unapplied runs: staged rows purged after 7 days (opportunistically on each upload; the run record stays as history). Applied runs: the full payload is cleared by the apply function itself; metadata stays.
- Import-level audit: the run row plus `resource_audit_log` rows `uploaded` / `rejected` / `applied` / `apply_failed`. Resource-level audit: one `resource_audit_log` row per created post with `created_via=bulk_import`, `import_run_id`, `import_row_number`, `external_id`. A revision-history version 1 ("Created by bulk upload") is also written.

## Create-only behaviour

An existing external id (stored as the Resource `content_id`), an existing post id, or an existing slug is `EXISTING_CONTENT_CONFLICT`. Duplicates inside the file are `DUPLICATE_SLUG_IN_FILE` / `DUPLICATE_EXTERNAL_ID_IN_FILE`. Nothing is matched by title. The same successful file (SHA-256, same type) again is `FILE_ALREADY_APPLIED`, guaranteed in the database by a partial unique index. A conflict created after the preview is `STALE_PREVIEW` and creates nothing.

## Admin Architecture Standard compliance

Capability affected: `resources.content.bulk_import` (new, Super Admin, Resource Admin, Editor only). Template download is allowed to anyone who can create Resources by hand (Author, Editor, Resource Admin, Super Admin); Apply is tighter.

| Standard clause | How it applies | Proof |
|---|---|---|
| 2 Capability-based access | its own named predicate, not derived from `isResourceStaff` or `canCreateSpecialistContent`; own nav field | `resourcesBulkImportRoutes.test.ts` (predicate, nav contract) |
| 3 Multi-role composition | union of roles: Analyst + Editor holds it through Editor; Analyst alone does not | route matrix |
| 4 Navigation is not authorisation | enforced at DB (RLS + apply RPC), API (`guardBulkImport`), page (redirect), nav (field); direct-URL, direct-API and database-bypass tests; denial is 401/403, never an empty 200 | route matrix, PGlite suite, live DEV matrix |
| 5 Separation of duties | Author, Compliance Reviewer, Publisher, Analyst denied; workflow gates untouched | PGlite workflow test, live DEV workflow |
| 6 Privileged RPC pattern | `SECURITY DEFINER`, `auth.uid()`, capability predicate inside, fixed empty `search_path`, no dynamic SQL, `EXECUTE` revoked from public and anon, caller cannot choose actor, status, visibility or content type. Note: Section 6 is written for analytics RPCs; the return is a fixed-key `jsonb` summary (ids and counts), documented here as an interpretation, not an exception | PGlite suite, migration test |
| 11 Safe exports | results CSV: server generated, fixed column allow-list, formula-injection neutralised, authorised again at download, non-identifying file name | security test NC-S6, live DEV |
| 13 Safe failure | any failure creates nothing and is an explicit error | atomicity tests |
| 14 No hidden scope expansion | adds one capability, one nav group, its own routes; the Article editor gains the existing SourcePicker because the spec requires imported sources to be manageable | see Article source picker below |

No exception to the Standard is requested.

## Article source picker (spec section C)

The Article / Guide / FHIP Explainer editor (`ResourceEditor`) now carries the existing reusable `SourcePicker` and loads the post's linked sources plus the first page of the shared library (so a linked source beyond the first 25 is still visible and removable; the Money Update editor page uses the same loader). The save route writes source links **only when the client sends `sourceIds`**, so any other caller can never clear an item's sources by omission.

## Known limits (v1)

- Create-only: no update of existing content.
- v1 types: article and money_update only (Guide and FHIP Explainer could be added by implementing the same four adapter files; none is built).
- Two sources per row (the contract defines `source_1_*` and `source_2_*`).
- 500 rows, 10 MB per file.
- The upload progress wording ("Uploading...", "Parsing...", "Validating...", "Preparing preview...") advances on a timer during one request; it is progress text, not a server measurement.
- Retention purge runs on upload, not on a schedule (no cron job is added); an idle system keeps expired staging rows until the next upload.

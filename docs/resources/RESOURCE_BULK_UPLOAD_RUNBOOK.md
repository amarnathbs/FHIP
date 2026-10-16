# Resources Bulk Upload: runbook

For the people who run Resources day to day and for whoever supports them.

> **PO decision 16-10-2026 (placement only): Bulk Upload lives inside Create Resource; no separate sidebar group.** The Admin sidebar no longer has a "Bulk Upload" group. The option is a separate "Bulk Upload" section on the Create Resource page (`/admin/resources/content/new`, below the Article / Guide / FHIP Explainer cards) and on the Money Update create screen (`/admin/resources/money-updates/new`), shown only when the server-side capability `resources.content.bulk_import` is held (Super Admin, Resource Admin, Editor). The routes `/admin/resources/import/**`, their capability guards, the API routes and the Upload buttons on All Content and Money Updates are unchanged, as are apply, staging, the database and the migrations (none added). The importer's parent is now Create Resource (back link and breadcrumb); upload, preview and history pages still return to the Bulk Upload chooser. Tests: `tests/unit/resourcesBulkUploadInsideCreateResource.test.ts`.

## Who can do what

| Action | Super Admin | Resource Admin | Editor | Author | Compliance Reviewer | Publisher | Analyst |
|---|---|---|---|---|---|---|---|
| Download a template | yes | yes | yes | yes | no | no | no |
| Upload, preview, apply, download results | yes | yes | yes | no | no | no | no |
| See other people's uploads in history | yes | yes | no | no | no | no | no |
| Apply someone else's upload | no | no | no | no | no | no | no |

## Uploading Articles or Money Updates

1. Resources, Create Resource, then the Bulk Upload section (or the Upload button on All Content or Money Updates).
2. Choose the type, download the template, paste finished rows into the upload sheet (`Article_Upload` or `Money_Update_Upload`).
3. Upload the file. Read the preview. Open a row to see exactly what will be stored.
4. If a row has an error, fix the file and upload it again. All rows must pass before anything is created.
5. Create the drafts. Open them from the result screen and use the normal editor and workflow.

## What every error means

| Code | Meaning | Fix |
|---|---|---|
| `INVALID_FILE_TYPE` | not a plain .csv or .xlsx (or a macro/old/encrypted/odd workbook) | save as .xlsx or .csv |
| `FILE_TOO_LARGE`, `TOO_MANY_ROWS`, `EMPTY_FILE` | over 10 MB, over 250 rows, or no data rows | split or fill the file |
| `UPLOAD_SHEET_MISSING` | no sheet was chosen, or the chosen sheet is not in the workbook | choose the sheet that holds your rows (the template keeps them on `Article_Upload` / `Money_Update_Upload`, preselected) |
| `TEMPLATE_VERSION_UNSUPPORTED` | `template_version` is not 1.0 | download the current template |
| `MISSING_REQUIRED_COLUMN`, `DUPLICATE_COLUMN`, `UNKNOWN_COLUMN` | header problem | use the template header |
| `FORBIDDEN_COLUMN` | the file has a status, visibility, type, approval or publish column | remove it: uploads are always private drafts |
| `FORMULA_NOT_ALLOWED` | a formula cell, or a value starting with `=` | paste values |
| `MISSING_REQUIRED_VALUE`, `INVALID_ENUM`, `INVALID_DATE`, `INVALID_BOOLEAN`, `INVALID_SLUG`, `FIELD_TOO_LONG` | a value is blank or not allowed | the message names the row and column and lists allowed values |
| `INVALID_URL`, `INSECURE_URL` | a source link is malformed or not https | use a full https link |
| `UNKNOWN_PRIMARY_CATEGORY`, `UNKNOWN_TAG`, `UNKNOWN_CTA`, `UNKNOWN_AUTHOR`, `AMBIGUOUS_AUTHOR` | the record does not exist (or two share a name) | use the exact name or slug from Lookup_Values; uploads never create them |
| `DUPLICATE_SLUG_IN_FILE`, `DUPLICATE_EXTERNAL_ID_IN_FILE`, `EXISTING_CONTENT_CONFLICT` | repeated in the file, or already exists | change the slug or external id; uploads never overwrite |
| `UNSUPPORTED_ARTICLE_MARKUP`, `UNSUPPORTED_MARKUP`, `ARTICLE_BODY_EMPTY` | body uses markup outside the allowed set, or is empty | see the template spec |
| `FUTURE_EVENT_DATE`, `MISSING_REVIEW_OR_EXPIRY`, `SOURCE_REQUIRED` | Money Update rules | fix the row |
| `FILE_ALREADY_APPLIED` | this exact file was already applied | nothing to do; if you changed the file, upload the changed one |
| `STALE_PREVIEW` | something changed after the preview (e.g. the slug is now taken) | upload again |
| `IMPORT_NOT_READY` | the import has errors, is already applied, or expired | upload again |
| `APPLY_FAILED` | the database refused the import; nothing was created | try again or upload again |

## Large files, the 8 second limit, and production

The API connects to the database through a login role that allows **8 seconds per call**, and that limit applies to the server's own calls too. Creating the drafts of a file is one database call, so a file that needs more than 8 seconds of database time cannot be applied (nothing is created; the whole call is cancelled).

- **DEV measurements (migration 0274, 500 rows, 5 runs each):** Article database time min 3.4 s, median 3.5 s, max 4.6 s; Money Update min 2.9 s, median 3.0 s, max 3.2 s. Two 500-row runs applied at the same moment: Article about 6.5 s each, Money Update about 5.9 s each (all applied). **Per-file limit: 250 rows** (chosen by the Product Owner on 07-10-2026 on the recommendation after these measurements; the single constant `IMPORT_LIMITS.maxRows`, `lib/resources/import/types.ts`; the parser, template notes, generated template documents and upload screen all read it). At 250 rows the DEV measurements are in the next bullet; 500 rows is marginal against the 8 second limit and is NOT the current limit.
- **DEV measurements at the chosen limit (migration 0274, 250 rows, 5 runs each, 07-10-2026):** Article database time min 1.6 s, median 1.8 s, max 2.1 s; Money Update min 1.5 s, median 1.6 s, max 1.7 s. Two 250-row runs applied at the same moment (different imports): Article 3.3 s and 3.3 s, Money Update 3.1 s and 3.0 s (all applied, all under 3.5 s; about half of the 6 second line). One Article run showed a 12.7 s response time with only 1.8 s of database time: a client or network stall, not the database. Evidence: `RESOURCE_BULK_UPLOAD_DEV_EVIDENCE_bulkcertmux5udmu.json`.
- **If an apply ever hits the limit** the person sees: "Nothing was created. This file is too large to apply in one go right now. Split it into smaller files or try again." The import stays "Ready, not applied" and can be applied again (the guards make a retry safe; a repeated apply can never create anything twice). The server log records `Resources import apply TIMED OUT after N ms`; a completed apply returns `dbMs` (database time) in its response.
- **PRODUCTION MUST BE PROVEN BEFORE REAL BULK FILES ARE USED.** Production has the same 8 second limit but a different data volume (more existing posts and indexes, different hardware). Before the first real file, the Product Owner runs the synthetic proof there (250-row Article and Money Update uploads of clearly synthetic content, apply, read `dbMs`, delete the synthetic drafts; add 500-row files only to test a raise) and keeps the numbers. The limit is already 250. **The Product Owner may later raise `IMPORT_LIMITS.maxRows` to 500 only if the production worst-case `dbMs` stays under about 6 seconds for 500-row files, single and two at once** (change the one constant, regenerate the two template documents with `npx tsx scripts/generate_resources_upload_template_docs.ts`, update the tests that assert 250, and re-prove). If production at 250 rows already exceeds about 6 seconds, lower it further.
- A chunked-but-atomic apply is not possible here: the application has no direct database connection (only the API), and one transaction cannot span several API calls, so chunking would give up all-or-none.

## Support procedures

- **A person says "my upload created nothing".** Open Import history. `Has errors` or `File rejected`: download the results CSV from the preview. `Ready, not applied`: they did not confirm. `Out of date`: re-upload.
- **A person says "it created the wrong thing".** Every created item is a private draft with an audit row (`created_via=bulk_import`, run id, row number). Delete or edit the drafts in the normal editor; nothing is published.
- **Re-running the same file** creates nothing (`FILE_ALREADY_APPLIED`). To import corrected content, change the file (the fingerprint changes) and give the changed rows new slugs and external ids, or edit the existing drafts by hand.
- **Disabling the feature.** In the database the immediate switch is `docs/resources/po_apply_bulk_upload_production/rollback/R2_disable_apply_only.sql` (nobody can then create drafts; uploads can still be previewed; `R3` switches it back on). It revokes **both** apply functions. Correction 15-10-2026: this runbook used to name only `apply_resource_content_import ... from authenticated`, which does NOT stop an apply, because the application calls the server-only twin `apply_resource_content_import_as_actor` first (migration 0273); a PGlite negative control (`resourcesBulkImportProductionPack.test.ts`, PACK-DB14) shows the single revoke leaves the twin working. Fully, remove the Bulk Upload section from Create Resource and the routes in code (there is no sidebar group since 16-10-2026). Existing drafts are ordinary Resources and are unaffected.
- **Retention.** Unapplied staged rows are removed after 7 days on the next upload. Applied runs keep their metadata, never their content.

## Rollback of the database change

See `docs/resources/po_apply_bulk_upload/README.md` ("If you need to undo it").

## Future review owner

Resources product owner. Review on: any change to the Resources block model (the mapper must follow it), any new content type (add an adapter), any change to the Resources roles (the capability predicate mirrors the SQL one).

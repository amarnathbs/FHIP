# Resources Bulk Upload: runbook

For the people who run Resources day to day and for whoever supports them.

## Who can do what

| Action | Super Admin | Resource Admin | Editor | Author | Compliance Reviewer | Publisher | Analyst |
|---|---|---|---|---|---|---|---|
| Download a template | yes | yes | yes | yes | no | no | no |
| Upload, preview, apply, download results | yes | yes | yes | no | no | no | no |
| See other people's uploads in history | yes | yes | no | no | no | no | no |
| Apply someone else's upload | no | no | no | no | no | no | no |

## Uploading Articles or Money Updates

1. Resources, Bulk Upload (or the Upload button on All Content or Money Updates).
2. Choose the type, download the template, paste finished rows into the upload sheet (`Article_Upload` or `Money_Update_Upload`).
3. Upload the file. Read the preview. Open a row to see exactly what will be stored.
4. If a row has an error, fix the file and upload it again. All rows must pass before anything is created.
5. Create the drafts. Open them from the result screen and use the normal editor and workflow.

## What every error means

| Code | Meaning | Fix |
|---|---|---|
| `INVALID_FILE_TYPE` | not a plain .csv or .xlsx (or a macro/old/encrypted/odd workbook) | save as .xlsx or .csv |
| `FILE_TOO_LARGE`, `TOO_MANY_ROWS`, `EMPTY_FILE` | over 10 MB, over 500 rows, or no data rows | split or fill the file |
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

## Support procedures

- **A person says "my upload created nothing".** Open Import history. `Has errors` or `File rejected`: download the results CSV from the preview. `Ready, not applied`: they did not confirm. `Out of date`: re-upload.
- **A person says "it created the wrong thing".** Every created item is a private draft with an audit row (`created_via=bulk_import`, run id, row number). Delete or edit the drafts in the normal editor; nothing is published.
- **Re-running the same file** creates nothing (`FILE_ALREADY_APPLIED`). To import corrected content, change the file (the fingerprint changes) and give the changed rows new slugs and external ids, or edit the existing drafts by hand.
- **Disabling the feature.** In the database the immediate switch is `revoke execute on function public.apply_resource_content_import(uuid) from authenticated` (nobody can then create drafts; uploads can still be previewed). Fully, remove the nav group and the routes in code. Existing drafts are ordinary Resources and are unaffected.
- **Retention.** Unapplied staged rows are removed after 7 days on the next upload. Applied runs keep their metadata, never their content.

## Rollback of the database change

See `docs/resources/po_apply_bulk_upload/README.md` ("If you need to undo it").

## Future review owner

Resources product owner. Review on: any change to the Resources block model (the mapper must follow it), any new content type (add an adapter), any change to the Resources roles (the capability predicate mirrors the SQL one).

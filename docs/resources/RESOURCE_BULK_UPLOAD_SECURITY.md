# Resources Bulk Upload: security model

Server-side and authoritative. Client validation is a convenience only. Nothing from the browser is trusted: file type, content type, extension, size, enum values, dates, slug, role, category, author, CTA and source are all re-checked on the server.

## File handling

| Control | Implementation |
|---|---|
| Only `.csv` and `.xlsx` | extension allow-list + content sniffing + declared MIME consistency (`file-security.ts` over the shared ingest inspector). `.xls`, `.xlsm`, `.xlsb`, `.ods`, zip, pdf, exe, gzip, png all `INVALID_FILE_TYPE` |
| 10 MB, 500 records | size checked from the declared length before the body is read (413) and again on the bytes; 500 non-empty data rows (`TOO_MANY_ROWS`) |
| Bounded decompression | own strict ZIP reader: central directory, per-entry and total size caps, compression-ratio cap, entry-count cap, zip64/encrypted/overlapping/duplicate/path-traversal rejected, declared size enforced AT inflate time (a lying header cannot expand) |
| XML | linear scanner, no DTD, no entity definitions (no XXE, no entity expansion), only the five predefined entities |
| No formulas | any formula cell (XLSX `<f>`) or a value starting with `=` is `FORMULA_NOT_ALLOWED`; the cached value is never used |
| No macros | macro projects and macro-enabled workbook parts refused (see note) |
| No raw HTML | raw HTML, comments and CDATA in any body field are `UNSUPPORTED_ARTICLE_MARKUP` / `UNSUPPORTED_MARKUP`; block text is never parsed as HTML anywhere |
| No stored raw file | only SHA-256 + normalised rows; no bucket |
| Hostile input never throws | every stage returns structured issues; randomised and mangled files tested |

**Note on the macro check.** The shared inspector refuses any workbook whose content-types file merely contains the text "macroEnabled". Libraries that write xlsx (including the one that writes our templates) carry a harmless `.bin` default with that text, so the shared check would reject our own template. `isWorkbookPartMacroEnabled()` re-decides only that final check precisely (workbook part declared macro-enabled, or a vbaProject part); every earlier archive defence has already run. The shared benchmark code was not changed.

## Source links

Must be `https://` and parse as a URL. `javascript:`, `data:`, `file:`, `ftp:`, `http:` are `INSECURE_URL`; unparseable is `INVALID_URL`. Exact source reuse only on an identical name, link and document title; no fuzzy merge. A missing valid source is created inside the apply transaction (no orphans).

## Authorisation

Capability `resources.content.bulk_import` = Super Admin, Resource Admin, Editor. Enforced at four layers and tested at each:

1. **Database**: `private.can_bulk_import_resource_content`; RLS on the staging tables (a person reads only their own runs; Resource Admin and Super Admin read all, for history); the apply function re-checks the capability and that the caller **uploaded the run**.
2. **API**: `guardBulkImport()` is the first statement of every handler (a structural test enforces this): 401 not signed in, country gate, 403 no capability.
3. **Page**: a caller without the capability is redirected, never shown an empty page.
4. **Navigation**: its own field and group; fails closed.

Staging writes use the service role **after** the capability check, and no API role holds a write grant on the staging tables, so a browser can never write or alter staged rows. The preview shown in the browser is not apply authority: Apply carries only a run id and the database reads the server-staged rows.

## What the apply function never takes from the data

Actor (always `auth.uid()`), content type (the run's), status (`draft`), visibility (`private`), `is_indexable` (`false`), `created_by`/`updated_by`, publish and approval columns. Negative controls prove each of these is what stops an injected value.

## Failure semantics

All or none in one transaction. Any failure (stale preview, a row the database refuses, a late unique violation) leaves zero posts, zero category or tag links, zero source links, zero **new** sources, zero versions and zero audit rows, and the run is not marked applied. Two simultaneous applies: the run row is locked, the second waits then reports "already applied" with no new rows.

## Evidence labels

| Claim | Label |
|---|---|
| Parsing, security, adapters, route matrix, migration lint | unit-tested |
| Staging/apply behaviour, RLS, capability, atomicity, stale preview, injection | PGlite-verified (full migration replay) |
| Real routes with real sessions, concurrency, scale, cleanup | DEV-verified (see `RESOURCE_BULK_UPLOAD_CERTIFICATION.md`) |
| Browser, responsive and accessibility | DEV-browser-verified (see certification) |

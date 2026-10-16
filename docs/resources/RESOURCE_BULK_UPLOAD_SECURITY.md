# Resources Bulk Upload: security model

Server-side and authoritative. Client validation is a convenience only. Nothing from the browser is trusted: file type, content type, extension, size, enum values, dates, slug, role, category, author, CTA and source are all re-checked on the server.

## File handling

| Control | Implementation |
|---|---|
| Only `.csv` and `.xlsx` | extension allow-list + content sniffing + declared MIME consistency (`file-security.ts` over the shared ingest inspector). `.xls`, `.xlsm`, `.xlsb`, `.ods`, zip, pdf, exe, gzip, png all `INVALID_FILE_TYPE` |
| 10 MB, 250 records | size checked from the declared length before the body is read (413) and again on the bytes; 250 non-empty data rows (`TOO_MANY_ROWS`; the single constant `IMPORT_LIMITS.maxRows`) |
| Bounded decompression | own strict ZIP reader: central directory, per-entry and total size caps, compression-ratio cap, entry-count cap, zip64/encrypted/overlapping/duplicate/path-traversal rejected, declared size enforced AT inflate time (a lying header cannot expand) |
| XML | linear scanner, no DTD, no entity definitions (no XXE, no entity expansion), only the five predefined entities |
| No formulas | any formula cell (XLSX `<f>`) or a value starting with `=` is `FORMULA_NOT_ALLOWED`; the cached value is never used |
| No macros | macro projects and macro-enabled workbook parts refused (see note) |
| No raw HTML | raw HTML, comments and CDATA in any body field are `UNSUPPORTED_ARTICLE_MARKUP` / `UNSUPPORTED_MARKUP`; block text is never parsed as HTML anywhere |
| No stored raw file | only SHA-256 + normalised rows; no bucket |
| Hostile input never throws | every stage returns structured issues; randomised and mangled files tested |

**Note on the macro check (no local override).** The shared inspector is used UNCHANGED. It refuses any workbook whose content-types file merely contains the text "macroEnabled". The library that WRITES our templates always emits an unused `.bin` default mapping with that text (the workbook has no `.bin` part and no macro), so a template straight from the writer would be refused by the shared inspector. The template generator therefore removes that one unused default (`lib/resources/import/xlsx-sanitize.ts`, only when the package has no `.bin` part) and the generated templates then pass the shared inspector as it is; a test shows the raw writer output is refused (control) and the sanitised output and both real templates are accepted. If a workbook saved by some other tool is ever refused as "macro-enabled" although it holds no macro, that is a limitation of the shared inspector's blunt text check, to be raised with its owner; nothing here weakens it.

## Source links

Must be `https://` and parse as a URL. `javascript:`, `data:`, `file:`, `ftp:`, `http:` are `INSECURE_URL`; unparseable is `INVALID_URL`. Exact source reuse only on an identical name, link and document title; no fuzzy merge. A missing valid source is created inside the apply transaction (no orphans).

## Authorisation

Capability `resources.content.bulk_import` = Super Admin, Resource Admin, Editor. Enforced at four layers and tested at each:

1. **Database**: `private.can_bulk_import_resource_content`; RLS on the staging tables (a person reads only their own runs; Resource Admin and Super Admin read all, for history); the apply function re-checks the capability and that the caller **uploaded the run**.
2. **API**: `guardBulkImport()` is the first statement of every handler (a structural test enforces this): 401 not signed in, country gate, 403 no capability.
3. **Page**: a caller without the capability is redirected, never shown an empty page.
4. **Navigation**: its own field and group; fails closed.

Staging writes use the service role **after** the capability check, and no API role holds a write grant on the staging tables, so a browser can never write or alter staged rows. The preview shown in the browser is not apply authority: Apply carries only a run id and the database reads the server-staged rows.

## Deliberate, bounded deviation from the Admin Standard's `auth.uid()` preference (migration 0273)

Standard section 6 prefers that a privileged RPC take its actor from `auth.uid()`. The apply of a very large file does not fit the 8 second statement limit of the signed-in API role (measured on DEV before the faster core of 0274: a 500-row apply needed 5 to 9 seconds of database time). A function-level setting cannot raise the limit of the call that is already running, so the apply is also offered as `public.apply_resource_content_import_as_actor(run id, actor id)`: callable by the **service role only**, naming the actor.

| | |
|---|---|
| What is different | for this one function, the database trusts the server (not `auth.uid()`) for WHO the actor is |
| Who can call it | `EXECUTE` is revoked for `public`, `anon` and `authenticated`: no browser and no signed-in session can call it or name an actor (proved in PGlite, with a negative control that GRANTs it and shows the impersonation the revoke prevents) |
| Where the actor comes from | the API route's verified session user (`guardBulkImport()` has already confirmed the capability); it is never read from the request, body, query or headers (structural test) |
| What the database re-checks anyway | inside the shared private core: the named actor must hold `resources.content.bulk_import` AND must be the person who uploaded that very run; unknown ids and null are refused. A wrong actor can only ever act as someone already entitled to apply that exact run |
| What cannot change | content type of the run, status `draft`, visibility `private`, not indexable, all-or-none, `STALE_PREVIEW`, `FILE_ALREADY_APPLIED` (unique index + advisory lock), idempotent second apply: one private core shared by both callers |
| Residual risk | compromise of the service-role key (which already writes the staging tables and is the platform's own root of trust for the server) |
| Rollback | the README of `po_apply_bulk_upload_0273`; the app falls back to the signed-in function if the twin is missing |

The signed-in function `apply_resource_content_import(run id)` is unchanged for callers: it still takes the actor from `auth.uid()`. Standard section 16 record: clause departed from = section 6 (actor from `auth.uid()`); reason = the 8 second limit above; effect and compensating controls = the table above; approval = **ACCEPTED by the Product Owner** as a bounded deviation from Admin Standard section 6: decision "A" of 06-10-2026, relayed through the orchestrating agent and reaffirmed by the Product Owner on 07-10-2026 ("go with your recommendations"). Status: accepted, no further exception requested. The Product Owner's own written record, if the Standard's record-keeping requires one, is held outside this repository.

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

# FDH-3 — RLS & Storage Policies

## 1. Table RLS

| Table | Policy | Notes |
| --- | --- | --- |
| `fdh_upload_sessions` | `for all using (auth.uid() = user_id) with check (auth.uid() = user_id)` | Standard FDH owner-only policy, identical text to all 15 pre-existing FDH user-owned tables |
| `fdh_document_audit_events` | `for select using (auth.uid() = user_id)` **only** | No insert/update/delete policy for `authenticated` at all — matches `ii_audit_events` exactly. Writes go through the service-role client (`services/auditLog.ts`) after the caller has already been authenticated and authorized upstream |
| `fdh_statement_uploads`, `fdh_ingestion_jobs` | unchanged (FDH-1) | FDH-3 adds two triggers to `fdh_ingestion_jobs` (see below) but does not touch its RLS policy |

## 2. FDH1-F1 focused hardening — the two new triggers

FDH1-F1 (open finding from FDH-0): a foreign key alone proves the referenced
row *exists*, not that it belongs to the *same tenant*. RLS's `with check`
stops a row being saved under someone else's identity but says nothing about
which *other* tenant's row it points at.

Migration 0058 adds two `before insert or update` triggers — narrow,
targeted at exactly the relationships FDH-3 introduces or newly exercises,
not a rewrite of all ~85 historical foreign keys:

```sql
create trigger trg_fdh_upload_sessions_owner
  before insert or update of user_id, document_id on fdh_upload_sessions
  for each row execute function fdh3_assert_upload_session_owner();

create trigger trg_fdh_ingestion_jobs_owner
  before insert or update of user_id, statement_upload_id on fdh_ingestion_jobs
  for each row execute function fdh3_assert_ingestion_job_owner();
```

Each function looks up the referenced parent row's `user_id` and raises an
exception if it does not match the referencing row's own `user_id` — a real,
independent-of-RLS check that fires even for a service-role write. Live
proof (`scripts/fdh3_rls_certification.mjs`):

```
PASS  cross-tenant fdh_upload_sessions.document_id reference is blocked by the FDH1-F1 trigger
PASS  cross-tenant fdh_ingestion_jobs.statement_upload_id reference is blocked by the FDH1-F1 trigger
PASS  control: same-tenant fdh_ingestion_jobs insert succeeds (trigger is not simply blocking all writes)
```

The negative control on the third line is what makes this a real proof
rather than "the trigger blocks everything" — the identical insert with the
correct owner succeeds.

**Global FDH1-F1 finding: still OPEN.** The remaining ~85 historical
foreign-key relationships across the platform are unaffected by this
migration and remain tracked for a dedicated future hardening phase, per the
spec's own instruction not to "casually refactor all 85 historical FKs."

## 3. Storage policy

```sql
create policy "own fdh source document objects" on storage.objects
  for select using (
    bucket_id = 'fdh-source-documents'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
```

One policy, SELECT only. No insert/update/delete policy for `authenticated` —
writes only via the service-role client (`services/storage.ts`). The bucket
itself is `public = false` (verified live, not merely configured — see
`FDH3_STORAGE_SECURITY.md`).

## 4. Live certification summary

`scripts/fdh3_rls_certification.mjs` (PGlite, full 58-migration clean
rebuild, real Tenant A/Tenant B rows, genuine negative controls):
**18/18 passed**, including:

- Tenant A creates/reads its own upload session; Tenant B cannot read it.
- Both FDH1-F1 triggers block cross-tenant references, with a same-tenant
  positive control proving the trigger isn't just blocking everything.
- Tenant A cannot directly `INSERT` into `fdh_document_audit_events` (service
  role only).
- Storage-object RLS: Tenant A reads its own object; Tenant B cannot; the
  bucket is not public.
- A negative control (RLS explicitly disabled, then re-enabled) proves the
  isolation assertions above are not vacuous.
- The document + purge state machine, exercised against real rows including
  a genuine DB-constraint rejection of "purged with a storage reference still
  present."

`scripts/fdh3_dev_certification.mjs` (real Supabase Storage on DEV,
project `vqycarelcoijzwlpkpcz`): **11/11 passed** — see `FDH3_STORAGE_SECURITY.md`.

## 5. What is not yet live-certified

Migration 0058 (the tables, the two triggers, and the storage.objects policy
itself) has **not yet been applied to DEV** — it requires the same manual
Supabase-Dashboard-SQL-editor application every prior FDH migration has
required (this agent has no DDL execution capability against any live
environment). The access-control *logic* above is certified against a full
clean rebuild (PGlite); the *deployment* of that logic to the real DEV
database is the one remaining CONDITIONAL-PASS gap — see
`FDH3_COMPLETION_REPORT.md`.

# 4. DEV pack: repeat the verification, then the production steps in order

Everything here uses the DEV project `vqycarelcoijzwlpkpcz` only. Check the project reference in the address bar of the Supabase SQL editor before running any SQL
(DEV `vqycarelcoijzwlpkpcz`; production `twwpnltizhtjxhamyoxt` is never touched by this pack until section C, and only by you).

**This branch needs no migration and no SQL.** The DEV checks below are read-only; section C lists the one production data step (none) and the Amplify settings.

## A. Prerequisites on DEV (read-only checks, run in the DEV SQL editor)

Run each as written. Words such as "into", "from" and "join" are deliberately absent from the comments.

```sql
-- A1. the draft table exists (migration 0197) and the per-user cap objects exist (migration 0284)
select to_regclass('public.fdh_ai_fallback_drafts') is not null as drafts_table_present,
       to_regclass('public.aie_ai_cost_attempt') is not null as cost_attempt_table_present,
       to_regclass('public.aie_ai_cost_ledger') is not null as cost_ledger_present;

-- A2. the global allowance and the per-user daily cap currently stored
select allowance_usd, user_daily_cap_usd, settled_usd, reserved_usd from aie_ai_cost_ledger where id = 'global';

-- A3. the CHECK constraint on upload error codes accepts the codes the PDF routes store
select pg_get_constraintdef(c.oid) like '%ocr_required%' and pg_get_constraintdef(c.oid) like '%extraction_timeout%'
       and pg_get_constraintdef(c.oid) like '%document_type_not_identified%' and pg_get_constraintdef(c.oid) like '%page_limit_exceeded%' as error_codes_ok
  from pg_constraint c
 where c.conrelid = 'public.fdh_statement_uploads'::regclass and c.conname like '%error_code%';
```

## B. The DEV run (what was done on 19/10/2026 and how to repeat it)

Terminal 1 (a local build of this branch against DEV, real GuardDuty scan through the DEV bucket, real `gpt-4o-mini`, the three PDF switches ON; it reads the shared `.env.local` and the AWS profile for the DEV scan bucket, prints nothing secret, strips every `PRODUCTION_*` value and refuses to start unless the host is the DEV project):

```
node scripts/pdf_routes_dev_server.mjs 3993
```

Terminal 2 (passwordless synthetic users, deleted at the end; residue re-counted):

```
npx tsx scripts/pdf_routes_dev_run.ts http://localhost:3993
npx tsx scripts/pdf_routes_dev_run.ts http://localhost:3993 liability      (or one class, or one document id such as LB-03)
```

It uploads the 25 corpus PDFs through the REAL upload routes as a Premium synthetic person, waits for the real scan, lets the routes decide (certified reader, refusal, or model draft), confirms
each model draft the way the screen does, and scores the stored statement against `EXPECTED_VALUES.md`. It also proves: a Free person is refused before anything exists; a byte-identical re-upload
makes no second model call; a second confirm is refused; another person can neither read nor confirm; every model call was `gpt-4o-mini` with a PDF-route key prefix; the original PDF is
deleted and verified absent for every document; the cleanup leaves no rows. The sanitised result is written to `evidence/dev_run_<dd-mm-yyyy>.json` and `_accuracy.txt`.

Read-only evidence queries for one document (replace the id):

```sql
-- B1. the document, its scan verdict and its deletion
select processing_status, error_code, malware_scan_status, raw_document_purge_status, raw_document_storage_reference is null as reference_cleared, purge_reason
  from fdh_statement_uploads where id = '<document id>';

-- B2. its audit trail (codes only)
select created_at, event_type, metadata from fdh_document_audit_events where document_id = '<document id>' order by created_at;

-- B3. its pending or confirmed model draft
select status, document_type, provider_idempotency_key, confirmed_at from fdh_ai_fallback_drafts where statement_upload_id = '<document id>';

-- B4. the metered model calls of one person (PDF route keys end in -pdf-ai-fallback)
select idempotency_key, admission_outcome, reserved_usd, settled_usd, model, input_tokens, output_tokens, call_outcome
  from aie_ai_cost_attempt where user_id = '<user id>' order by created_at;
```

## C. Production (you do these; nothing here has been done)

Order, each step only after the one before it. Production has no managed backups; none of these steps changes data, so no table backup is needed.

1. **Merge.** Fetch and test, then push yourself (two separate PowerShell 5.1 lines, no `&&`):
   ```
   git fetch origin
   git merge-base --is-ancestor origin/main <verified tip sha>
   ```
   An exit code of 0 means the tip contains `origin/main` and the push is a fast-forward. (The exact sha is in the report.)
2. **Deploy with the three switches UNSET.** `AIE_LIABILITY_PDF_ROUTE_ENABLED`, `AIE_RETIREMENT_PDF_ROUTE_ENABLED`, `AIE_AU_INVESTMENT_PDF_ROUTE_ENABLED` are off when unset. After the deploy a PDF sent to any of the three screens is refused with plain words before anything is stored; CSV behaves as before. Nothing else changes.
3. **Confirm the existing AI prerequisites** (they are the same ones the bank and payslip PDF readings need; see `../po_apply_premium_ai_production_proof/` on the Premium proof branch): migration 0284 on production, `AIE_AI_FALLBACK_ENABLED`, the per-class AI switches (`AIE_LIABILITY_AI_FALLBACK_ENABLED`, `AIE_RETIREMENT_STATEMENT_AI_FALLBACK_ENABLED`, `AIE_INVESTMENT_STATEMENT_AI_FALLBACK_ENABLED`), the real malware scan, the masking key and `AIE_AI_PROVIDER` / `AIE_AI_MODEL` unchanged. Without the AI switches a PDF route that is ON still reads the certified layouts and refuses the rest.
4. **Switch ONE class on in the Amplify console** (for example `AIE_LIABILITY_PDF_ROUTE_ENABLED` = `true`), redeploy, and run the PDF journey for that class with a synthetic Premium person using the corpus files (`corpus/`, checked against `MANIFEST.sha256` before upload). Then the next class.
5. **Rollback of one class** (no deploy of code needed): unset or change its switch to anything other than `true` and redeploy. That refuses new PDFs for that class only. It preserves the per-user daily cap, the global ledger, every saved statement, every pending draft and the CSV route.
   Stopping ALL new AI spend without a deploy is the Premium proof pack's `sql/ops/O02a`.
6. **Do not** drop any cap object as a rollback; there is none to drop (this branch adds no database object).

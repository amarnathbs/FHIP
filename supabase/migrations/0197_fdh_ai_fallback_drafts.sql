-- 0197 -- AIE-1 final production completion (2026-09-25): durable, versioned
-- AI-fallback drafts for FDH documents.
--
-- WHY. When a document's deterministic parser fails and the AI fallback reads
-- it instead, the validated AI result (the "draft") existed ONLY in the HTTP
-- response. Nothing durable held it:
--   * the confirm step trusted whatever the client posted back and never
--     checked that a draft had been issued at all;
--   * the document sat in `processing` holding the draft only in the browser,
--     and the 50-minute raw-file backstop then forced it to `rejected` and
--     deleted the PDF -- the draft was lost and the confirm route refused;
--   * acceptance therefore depended on the original PDF's lifetime.
--
-- WHAT THIS TABLE IS. The AI result, validated locally against the adapter's
-- schema and mapped to the native extraction shape, persisted BEFORE the user
-- sees it. One pending draft per document (partial unique index). The user's
-- review then confirms (optionally corrects) it through the existing certified
-- writer (`persistPayrollEvidence` for payslips); the draft row is moved
-- pending_review -> confirmed by a single conditional update, which is what
-- makes a replayed or concurrent confirmation write nothing a second time.
-- The PDF is not needed for any of this, so the backstop may delete it while
-- the draft waits.
--
-- PRIVACY. `payload` holds only the structured facts the user is shown (the
-- same values the confirm route already accepts). No document text, no masked
-- text, no token map, no page image, no file bytes. `provider_idempotency_key`
-- links the draft to its metered AI call (aie_ai_cost_attempt) for audit.
--
-- ACCESS. The owner may READ their drafts (the review UI). Only the server
-- (service_role) inserts or changes them: no insert/update/delete policy
-- exists for the authenticated role, and the table grants below say so
-- explicitly.
--
-- Additive only: one new table, its indexes and policies. No existing
-- constraint is touched. No per-environment data.

create table if not exists fdh_ai_fallback_drafts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  statement_upload_id uuid not null references fdh_statement_uploads(id) on delete cascade,
  document_type text not null,
  schema_name text not null,
  schema_version text not null,
  payload_version integer not null default 1 check (payload_version >= 1),
  payload jsonb not null,
  provider_idempotency_key text,
  status text not null default 'pending_review'
    check (status in ('pending_review', 'confirmed', 'superseded', 'discarded')),
  created_at timestamptz not null default now(),
  confirmed_at timestamptz,
  confirmed_payload jsonb,
  check (status <> 'confirmed' or confirmed_at is not null)
);

create unique index if not exists uq_fdh_ai_fallback_drafts_one_pending
  on fdh_ai_fallback_drafts (statement_upload_id)
  where status = 'pending_review';
create index if not exists idx_fdh_ai_fallback_drafts_user on fdh_ai_fallback_drafts (user_id, created_at desc);

alter table fdh_ai_fallback_drafts enable row level security;

drop policy if exists "owner reads own ai fallback drafts" on fdh_ai_fallback_drafts;
create policy "owner reads own ai fallback drafts" on fdh_ai_fallback_drafts
  for select using (auth.uid() = user_id);

revoke all on table fdh_ai_fallback_drafts from anon;
revoke insert, update, delete, truncate on table fdh_ai_fallback_drafts from authenticated;
grant select on table fdh_ai_fallback_drafts to authenticated;
grant all on table fdh_ai_fallback_drafts to service_role;

comment on table fdh_ai_fallback_drafts is
  '0197: validated AI-fallback results awaiting the owner''s review; written only by the server; confirmed exactly once.';

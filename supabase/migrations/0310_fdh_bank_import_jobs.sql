-- 0310 -- Bank statement import as a durable BACKGROUND JOB (Document2 (4) F15, Product Owner decision PO-D24-03).
--
-- WHY. Expenses > Import bank statement ran the whole extraction (CSV parse, certified PDF read, AI reading, thousands of row
-- inserts) inside ONE web request. The hosting platform ends a request after about 28 seconds and the handler never gets to run
-- its catch, so a long statement left the document stuck in `processing` and the user saw "We could not process this bank
-- statement" (docs/reviews/DOCUMENT2_4_TRUTH_WP-E.md). There is no long-running worker on this platform, so the work is cut
-- up as short, resumable SLICES (each well under the request limit) whose progress lives in this table.
--
-- WHAT THIS ADDS (additive only; no existing table, column, constraint or policy is changed).
--   * fdh_bank_import_jobs        -- ONE row per uploaded statement (unique on statement_upload_id): status, phase, checkpoint,
--                                    lease, attempt counters, the finished summary. The browser reads it (RLS: own rows, SELECT only).
--   * fdh_bank_import_job_chunks  -- temporary STAGING for one job (the staged transaction plan, the masked page groups an AI reading
--                                    works through, each part's result). Server-only: RLS on, no policy for any browser role. Deleted
--                                    when the job completes or fails for good, and by the sweep.
--   * fdh_bank_import_claim_job / fdh_bank_import_claim_next -- the ATOMIC lease claim (one winner; a lease that ran out is taken over).
--   * fdh_bank_import_heartbeat   -- extends a lease the caller still holds.
--
-- LEASE MODEL. A slice claims the job with a random owner token and a lease (default 90 s). Every write a slice makes to the job
-- row is conditional on `lease_owner = <its token>`, so a slice that was killed or stalled and later wakes up cannot overwrite
-- the slice that took over (fencing). A killed slice simply stops renewing: after the lease runs out the next poll (or the
-- scheduled backstop) claims the job again and carries on at the checkpoint. Every slice is idempotent: what remains to do is
-- recomputed using the database, never trusted using a counter.
--
-- NO NEW AUDIT EVENT TYPES. The document audit CHECK constraint is NOT widened here (drop-and-recreate trap): jobs use the existing
-- bank_csv_* / pdf_* event types and their own durable row.

create table if not exists fdh_bank_import_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  statement_upload_id uuid not null references fdh_statement_uploads(id) on delete cascade,
  source_kind text not null check (source_kind in ('csv', 'pdf')),
  -- Client-supplied (Idempotency-Key header) or derived using the document id. One key = one job.
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 200),
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'review_required', 'completed', 'failed')),
  phase text not null default 'read'
    check (phase in ('read', 'ai_read', 'ai_review', 'plan_confirmed', 'persist', 'finalize', 'done')),
  -- Why a review_required job waits for a person.
  review_reason text check (review_reason is null or review_reason in ('ai_draft', 'password')),
  checkpoint jsonb not null default '{}'::jsonb,
  progress_done integer not null default 0 check (progress_done >= 0),
  progress_total integer check (progress_total is null or progress_total >= 0),
  -- The user-started attempt (a retry of a failed job increments it) and the slices that failed in a row in this attempt.
  attempt integer not null default 1 check (attempt >= 1),
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  slice_count integer not null default 0 check (slice_count >= 0),
  reclaim_count integer not null default 0 check (reclaim_count >= 0),
  lease_owner text,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  last_slice_at timestamptz,
  error_code text check (error_code is null or char_length(error_code) <= 80),
  error_message_sanitised text check (error_message_sanitised is null or char_length(error_message_sanitised) <= 500),
  -- The finished import's summary (what the process route used to answer inline), so a reload or a second poll gets it again.
  result_summary jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_fdh_bank_import_jobs_document unique (statement_upload_id),
  constraint uq_fdh_bank_import_jobs_idempotency unique (user_id, idempotency_key),
  constraint chk_fdh_bank_import_jobs_review check ((status = 'review_required') = (review_reason is not null))
);

comment on table fdh_bank_import_jobs is
  '0310: one durable background job per uploaded bank statement. Advanced in short lease-guarded slices by the browser poll and a scheduled backstop. Browsers can read their own rows; only the server writes.';

create index if not exists idx_fdh_bank_import_jobs_user on fdh_bank_import_jobs (user_id, created_at desc);
-- The backstop's "find work" query: unfinished jobs, oldest lease first.
create index if not exists idx_fdh_bank_import_jobs_work on fdh_bank_import_jobs (lease_expires_at nulls first, updated_at)
  where status in ('queued', 'processing');

alter table fdh_bank_import_jobs enable row level security;

-- SELECT only for the signed-in owner. There is deliberately NO insert / update / delete policy: a user must not be able to mint,
-- re-point or finish a job; only the server (service role, after authenticating the caller) writes.
drop policy if exists "own rows read - fdh_bank_import_jobs" on fdh_bank_import_jobs;
create policy "own rows read - fdh_bank_import_jobs" on fdh_bank_import_jobs
  for select using (auth.uid() = user_id);

-- Cross-tenant guard (same shape as fdh_ingestion_jobs, 0058): a job can only point at a statement of its own user.
create or replace function fdh_bank_import_assert_job_owner() returns trigger as $$
declare
  doc_owner uuid;
begin
  select user_id into doc_owner from fdh_statement_uploads where id = new.statement_upload_id;
  if doc_owner is null then
    raise exception 'fdh_bank_import_jobs: statement_upload_id % does not exist', new.statement_upload_id;
  end if;
  if doc_owner <> new.user_id then
    raise exception 'fdh_bank_import_jobs: cross-tenant reference - statement_upload % belongs to a different user', new.statement_upload_id;
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists trg_fdh_bank_import_jobs_owner on fdh_bank_import_jobs;
create trigger trg_fdh_bank_import_jobs_owner
  before insert or update of user_id, statement_upload_id on fdh_bank_import_jobs
  for each row execute function fdh_bank_import_assert_job_owner();

-- ---------------------------------------------------------------------------
-- Staging chunks
-- ---------------------------------------------------------------------------
create table if not exists fdh_bank_import_job_chunks (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references fdh_bank_import_jobs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  -- plan_meta: the staged plan's non-row facts (one row). plan_rows: a batch of insert-ready transaction rows.
  -- ai_text: one masked page group for an AI reading. ai_result: that group's validated reading.
  kind text not null check (kind in ('plan_meta', 'plan_rows', 'ai_text', 'ai_result')),
  seq integer not null check (seq >= 0),
  payload jsonb not null,
  -- How many times an AI part has been tried (a part that keeps failing stops the job instead of looping).
  attempts integer not null default 0 check (attempts >= 0),
  created_at timestamptz not null default now(),
  constraint uq_fdh_bank_import_job_chunks unique (job_id, kind, seq)
);

comment on table fdh_bank_import_job_chunks is
  '0310: temporary server-only staging for one bank import job (staged plan batches, masked page groups for an AI reading, each part''s result). Never readable by a browser role. Removed when the job finishes or fails for good, and by the sweep.';

create index if not exists idx_fdh_bank_import_job_chunks_user on fdh_bank_import_job_chunks (user_id);

alter table fdh_bank_import_job_chunks enable row level security;
-- No policy for anon / authenticated at all: only the service role reads or writes staging.

create or replace function fdh_bank_import_assert_chunk_owner() returns trigger as $$
declare
  job_owner uuid;
begin
  select user_id into job_owner from fdh_bank_import_jobs where id = new.job_id;
  if job_owner is null or job_owner <> new.user_id then
    raise exception 'fdh_bank_import_job_chunks: the chunk does not belong to the job''s user';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists trg_fdh_bank_import_job_chunks_owner on fdh_bank_import_job_chunks;
create trigger trg_fdh_bank_import_job_chunks_owner
  before insert or update of user_id, job_id on fdh_bank_import_job_chunks
  for each row execute function fdh_bank_import_assert_chunk_owner();

-- ---------------------------------------------------------------------------
-- Lease claim: ONE winner, DATABASE clock, takes over an expired lease, counts the take-over.
-- ---------------------------------------------------------------------------
create or replace function fdh_bank_import_claim_job(p_job_id uuid, p_owner text, p_lease_seconds integer default 90)
returns setof fdh_bank_import_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_owner is null or length(p_owner) < 8 then
    raise exception 'fdh_bank_import_claim_job: an owner token of at least 8 characters is required';
  end if;
  return query
  update fdh_bank_import_jobs j
     set lease_owner = p_owner,
         lease_expires_at = now() + make_interval(secs => greatest(10, least(p_lease_seconds, 300))),
         heartbeat_at = now(),
         status = 'processing',
         started_at = coalesce(j.started_at, now()),
         slice_count = j.slice_count + 1,
         reclaim_count = j.reclaim_count + case when j.lease_owner is not null and j.lease_expires_at < now() then 1 else 0 end,
         updated_at = now()
   where j.id = p_job_id
     and j.status in ('queued', 'processing')
     and (j.lease_expires_at is null or j.lease_expires_at < now())
  returning j.*;
end;
$$;

-- Backstop variant: claims the single most overdue unfinished job (skips rows another caller is claiming right now).
create or replace function fdh_bank_import_claim_next(p_owner text, p_lease_seconds integer default 90)
returns setof fdh_bank_import_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if p_owner is null or length(p_owner) < 8 then
    raise exception 'fdh_bank_import_claim_next: an owner token of at least 8 characters is required';
  end if;
  select j.id into v_id
    from fdh_bank_import_jobs j
   where j.status in ('queued', 'processing')
     and (j.lease_expires_at is null or j.lease_expires_at < now())
   order by j.lease_expires_at nulls first, j.updated_at
   limit 1
   for update skip locked;
  if v_id is null then
    return;
  end if;
  return query select * from fdh_bank_import_claim_job(v_id, p_owner, p_lease_seconds);
end;
$$;

-- Extends a lease the caller STILL holds. false = the lease was lost (expired and taken over): the slice must stop writing.
create or replace function fdh_bank_import_heartbeat(p_job_id uuid, p_owner text, p_lease_seconds integer default 90)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows integer;
begin
  update fdh_bank_import_jobs
     set lease_expires_at = now() + make_interval(secs => greatest(10, least(p_lease_seconds, 300))),
         heartbeat_at = now(),
         updated_at = now()
   where id = p_job_id
     and lease_owner = p_owner
     and status = 'processing';
  get diagnostics v_rows = row_count;
  return v_rows = 1;
end;
$$;

-- Server-only. A browser role must never be able to claim, extend or release a lease.
revoke all on function fdh_bank_import_claim_job(uuid, text, integer) from public, anon, authenticated;
revoke all on function fdh_bank_import_claim_next(text, integer) from public, anon, authenticated;
revoke all on function fdh_bank_import_heartbeat(uuid, text, integer) from public, anon, authenticated;
grant execute on function fdh_bank_import_claim_job(uuid, text, integer) to service_role;
grant execute on function fdh_bank_import_claim_next(text, integer) to service_role;
grant execute on function fdh_bank_import_heartbeat(uuid, text, integer) to service_role;

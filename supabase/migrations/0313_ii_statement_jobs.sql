-- 0313 -- Investment Intelligence statement processing as a durable BACKGROUND JOB (Document2 (4) WP-J, Product Owner decision).
--
-- WHY. Processing or reprocessing a large CAMS or KFintech consolidated statement (many funds, a long history) ran inside ONE web
-- request. The hosting platform ends a request after about 28 seconds and the handler never gets to run its error path, so the
-- browser waited on an answer the platform had already abandoned, the parse run stayed running, and a retry was answered with
-- already being processed. There is no long-running worker on this platform, so the work is cut into short, resumable SLICES whose
-- progress lives in this table (the same mechanism as the bank statement import jobs of 0310).
--
-- WHAT THIS ADDS (additive only, no existing table, column, constraint or policy is changed).
--   * ii_statement_jobs        one row per processing request: status, step, checkpoint, lease, counters, the finished answer.
--                              A browser can read its own rows (row-level security, select only). Only the server writes.
--   * ii_statement_job_chunks  TEMPORARY server-only staging for one job: the parsed statement (folios, schemes, transaction lines,
--                              holding lines), the account and instrument resolution tables and the position list. No policy for any
--                              browser role. Deleted when the job ends, and by the sweep after 24 hours. It never holds the file,
--                              the extracted text or a password.
--   * ii_statement_job_claim, ii_statement_job_claim_next and ii_statement_job_heartbeat: the ATOMIC lease claim.
--
-- JOB KINDS. process covers the first processing of an uploaded statement, the reprocessing after a replacement copy and an ordinary
-- Reprocess. reevaluate covers Re-evaluate all positions, which reads no file at all.
--
-- ONE ACTIVE JOB PER STATEMENT. A partial unique index allows at most one queued or processing job for a statement, so a second
-- click, a second tab or a retry resumes the job that is already there instead of starting another.
--
-- LEASE MODEL. A slice claims the job with a random owner token and a lease. Every write a slice makes to the job row is conditional
-- on that token, so a slice that was killed or stalled and later wakes up cannot overwrite the slice that took over. A killed slice
-- simply stops renewing: after the lease runs out the next poll or the scheduled backstop claims the job and carries on at the
-- checkpoint. Every slice is idempotent: what remains to do is recomputed using the database, never trusted using a counter.
--
-- NO NEW AUDIT EVENT TYPES. No existing CHECK constraint is widened here. Jobs use the audit event types that already exist.

create table if not exists ii_statement_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_document_id uuid not null references ii_source_documents(id) on delete cascade,
  job_kind text not null default 'process' check (job_kind in ('process', 'reevaluate')),
  -- Client supplied (Idempotency-Key header) or generated. One key means one job.
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 200),
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'review_required', 'completed', 'failed')),
  -- The pipeline step the next slice runs.
  phase text not null default 'read'
    check (phase in ('read', 'accounts', 'owner', 'schemes', 'transactions', 'holdings', 'analyse', 'certify', 'finalize', 'done')),
  -- Why a review_required job waits for a person.
  review_reason text check (review_reason is null or review_reason in ('password', 'ai_review')),
  checkpoint jsonb not null default '{}'::jsonb,
  progress_done integer not null default 0 check (progress_done >= 0),
  progress_total integer check (progress_total is null or progress_total >= 0),
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
  -- The finished answer (what the process route used to answer inline), so a reload or a second poll gets it again.
  result_summary jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_ii_statement_jobs_idempotency unique (user_id, idempotency_key),
  constraint chk_ii_statement_jobs_review check ((status = 'review_required') = (review_reason is not null))
);

comment on table ii_statement_jobs is
  '0313: one durable background job per statement processing request. Advanced in short lease-guarded slices by the browser poll and a scheduled backstop. Browsers can read their own rows, only the server writes.';

create unique index if not exists uq_ii_statement_jobs_one_active
  on ii_statement_jobs (source_document_id)
  where status in ('queued', 'processing');
create index if not exists idx_ii_statement_jobs_user on ii_statement_jobs (user_id, created_at desc);
create index if not exists idx_ii_statement_jobs_document on ii_statement_jobs (source_document_id, created_at desc);
-- The backstop find-work query: unfinished jobs, oldest lease first.
create index if not exists idx_ii_statement_jobs_work on ii_statement_jobs (lease_expires_at nulls first, updated_at)
  where status in ('queued', 'processing');

alter table ii_statement_jobs enable row level security;

-- Select only for the signed-in owner. There is deliberately NO insert, update or delete policy: a user must not be able to mint,
-- re-point or finish a job. Only the server (service role, after authenticating the caller) writes.
drop policy if exists own_rows_read_ii_statement_jobs on ii_statement_jobs;
create policy own_rows_read_ii_statement_jobs on ii_statement_jobs
  for select using (auth.uid() = user_id);

-- Cross-tenant guard: a job can only point at a statement of its own user.
create or replace function ii_statement_job_assert_owner() returns trigger as $fn$
declare
  doc_owner uuid;
begin
  select user_id into doc_owner from ii_source_documents where id = new.source_document_id;
  if doc_owner is null then
    raise exception using message = 'ii_statement_jobs: the statement does not exist: ' || new.source_document_id::text;
  end if;
  if doc_owner <> new.user_id then
    raise exception using message = 'ii_statement_jobs: cross-tenant reference, statement ' || new.source_document_id::text || ' belongs to a different user';
  end if;
  return new;
end;
$fn$ language plpgsql security definer set search_path = public;

drop trigger if exists trg_ii_statement_jobs_owner on ii_statement_jobs;
create trigger trg_ii_statement_jobs_owner
  before insert or update of user_id, source_document_id on ii_statement_jobs
  for each row execute function ii_statement_job_assert_owner();

-- ---------------------------------------------------------------------------
-- Staging chunks
-- ---------------------------------------------------------------------------
create table if not exists ii_statement_job_chunks (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references ii_statement_jobs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  -- parsed_meta is the staged statement facts that are not lines (one row, seq 0). parsed_txns and parsed_holds are batches of lines.
  -- acct and inst are the account and instrument resolution tables. pairs is the list of positions to certify.
  kind text not null check (kind in ('parsed_meta', 'parsed_txns', 'parsed_holds', 'acct', 'inst', 'pairs')),
  seq integer not null check (seq >= 0),
  payload jsonb not null,
  created_at timestamptz not null default now(),
  constraint uq_ii_statement_job_chunks unique (job_id, kind, seq)
);

comment on table ii_statement_job_chunks is
  '0313: temporary server-only staging for one statement job (the parsed statement and the resolution tables). Never readable by a browser role. Removed when the job ends, and by the sweep.';

create index if not exists idx_ii_statement_job_chunks_user on ii_statement_job_chunks (user_id);

alter table ii_statement_job_chunks enable row level security;
-- No policy for anon or authenticated at all: only the service role reads or writes staging.

create or replace function ii_statement_job_assert_chunk_owner() returns trigger as $fn$
declare
  job_owner uuid;
begin
  select user_id into job_owner from ii_statement_jobs where id = new.job_id;
  if job_owner is null or job_owner <> new.user_id then
    raise exception using message = 'ii_statement_job_chunks: the chunk does not belong to the user of the job';
  end if;
  return new;
end;
$fn$ language plpgsql security definer set search_path = public;

drop trigger if exists trg_ii_statement_job_chunks_owner on ii_statement_job_chunks;
create trigger trg_ii_statement_job_chunks_owner
  before insert or update of user_id, job_id on ii_statement_job_chunks
  for each row execute function ii_statement_job_assert_chunk_owner();

-- ---------------------------------------------------------------------------
-- Lease claim: ONE winner, DATABASE clock, takes over an expired lease, counts the take-over.
-- ---------------------------------------------------------------------------
create or replace function ii_statement_job_claim(p_job_id uuid, p_owner text, p_lease_seconds integer default 60)
returns setof ii_statement_jobs
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if p_owner is null or length(p_owner) < 8 then
    raise exception using message = 'ii_statement_job_claim: an owner token of at least 8 characters is required';
  end if;
  return query
  update ii_statement_jobs j
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
$fn$;

-- Backstop variant: claims the single most overdue unfinished job (skips rows another caller is claiming right now).
create or replace function ii_statement_job_claim_next(p_owner text, p_lease_seconds integer default 60)
returns setof ii_statement_jobs
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_id uuid;
begin
  if p_owner is null or length(p_owner) < 8 then
    raise exception using message = 'ii_statement_job_claim_next: an owner token of at least 8 characters is required';
  end if;
  select j.id into v_id
    from ii_statement_jobs j
   where j.status in ('queued', 'processing')
     and (j.lease_expires_at is null or j.lease_expires_at < now())
   order by j.lease_expires_at nulls first, j.updated_at
   limit 1
   for update skip locked;
  if v_id is null then
    return;
  end if;
  return query select * from ii_statement_job_claim(v_id, p_owner, p_lease_seconds);
end;
$fn$;

-- Extends a lease the caller STILL holds. false means the lease was lost (it expired and was taken over): the slice must stop writing.
create or replace function ii_statement_job_heartbeat(p_job_id uuid, p_owner text, p_lease_seconds integer default 60)
returns boolean
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_rows integer;
begin
  update ii_statement_jobs
     set lease_expires_at = now() + make_interval(secs => greatest(10, least(p_lease_seconds, 300))),
         heartbeat_at = now(),
         updated_at = now()
   where id = p_job_id
     and lease_owner = p_owner
     and status = 'processing';
  get diagnostics v_rows = row_count;
  return v_rows = 1;
end;
$fn$;

-- Server-only. A browser role must never be able to claim, extend or release a lease.
revoke all on function ii_statement_job_claim(uuid, text, integer) from public, anon, authenticated;
revoke all on function ii_statement_job_claim_next(text, integer) from public, anon, authenticated;
revoke all on function ii_statement_job_heartbeat(uuid, text, integer) from public, anon, authenticated;
grant execute on function ii_statement_job_claim(uuid, text, integer) to service_role;
grant execute on function ii_statement_job_claim_next(text, integer) to service_role;
grant execute on function ii_statement_job_heartbeat(uuid, text, integer) to service_role;

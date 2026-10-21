/**
 * Document2 (4) WP-G (F15, PO-D24-03) -- database access for the bank import job (`fdh_bank_import_jobs` and
 * `fdh_bank_import_job_chunks`, migration 0310).
 *
 * SERVICE ROLE, BY DESIGN. Browsers can only READ their own jobs (row-level security); every write is made here, after the caller
 * has been authenticated and the job's owner resolved from the job row itself. The scheduled backstop has no user session at all.
 * Every query below is scoped by `user_id` (or by the job id obtained from a user-scoped read), so a job or a staged chunk of
 * another user is indistinguishable from a missing one.
 *
 * FENCING. Every write a slice makes to the job row goes through `updateOwned`, which is conditional on `lease_owner = <the slice's
 * token>`. A slice whose lease was taken over (it was killed, or stalled past its lease) writes nothing: the update matches zero
 * rows and the slice stops.
 */

import { createAdminClient } from '@/lib/supabase/admin';
import {
  BANK_IMPORT_LEASE_SECONDS,
  BANK_IMPORT_STAGING_TTL_MS,
  defaultBankImportIdempotencyKey,
  type BankImportJobRow,
  type BankImportSourceKind,
} from '../bankImport/jobModel';

export type ChunkKind = 'plan_meta' | 'plan_rows' | 'ai_text' | 'ai_result';

export interface ChunkRow {
  id: string;
  job_id: string;
  user_id: string;
  kind: ChunkKind;
  seq: number;
  payload: Record<string, unknown>;
  attempts: number;
}

function isMissingTable(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return error.code === '42P01' || error.code === 'PGRST205' || /fdh_bank_import_job/.test(error.message ?? '') && /does not exist|could not find/i.test(error.message ?? '');
}

/** Thrown when migration 0310 has not been applied in this environment. Callers answer "not available yet", never a 500 with SQL. */
export class BankImportJobsUnavailableError extends Error {
  constructor() {
    super('Background statement import is not available in this environment yet.');
    this.name = 'BankImportJobsUnavailableError';
  }
}

function raise(error: { code?: string; message?: string }): never {
  if (isMissingTable(error)) throw new BankImportJobsUnavailableError();
  throw new Error(error.message ?? 'database error');
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export async function getJobForUser(userId: string, jobId: string): Promise<BankImportJobRow | null> {
  const { data, error } = await createAdminClient().from('fdh_bank_import_jobs').select('*').eq('id', jobId).eq('user_id', userId).maybeSingle();
  if (error) raise(error);
  return (data as BankImportJobRow | null) ?? null;
}

export async function getJobByDocument(userId: string, documentId: string): Promise<BankImportJobRow | null> {
  const { data, error } = await createAdminClient().from('fdh_bank_import_jobs').select('*').eq('statement_upload_id', documentId).eq('user_id', userId).maybeSingle();
  if (error) raise(error);
  return (data as BankImportJobRow | null) ?? null;
}

/** Unfinished jobs of one user (a page that was reloaded asks for these to pick the work up again). */
export async function listActiveJobsForUser(userId: string, limit = 10): Promise<BankImportJobRow[]> {
  const { data, error } = await createAdminClient()
    .from('fdh_bank_import_jobs')
    .select('*')
    .eq('user_id', userId)
    .in('status', ['queued', 'processing', 'review_required'])
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    if (isMissingTable(error)) return [];
    throw new Error(error.message);
  }
  return (data ?? []) as BankImportJobRow[];
}

export type CreateJobResult =
  | { outcome: 'created' | 'existing'; job: BankImportJobRow }
  | { outcome: 'idempotency_key_in_use' };

/**
 * Creates the ONE job of a statement, or returns the one that exists (admission is idempotent). Race-safe: the unique constraints
 * decide, and the loser of a race simply reads the winner's row.
 */
export async function createJobIfAbsent(params: {
  userId: string;
  documentId: string;
  kind: BankImportSourceKind;
  idempotencyKey?: string | null;
}): Promise<CreateJobResult> {
  const existing = await getJobByDocument(params.userId, params.documentId);
  if (existing) return { outcome: 'existing', job: existing };
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('fdh_bank_import_jobs')
    .insert({
      user_id: params.userId,
      statement_upload_id: params.documentId,
      source_kind: params.kind,
      idempotency_key: params.idempotencyKey ?? defaultBankImportIdempotencyKey(params.documentId),
    })
    .select('*')
    .single();
  if (error) {
    if (isMissingTable(error)) throw new BankImportJobsUnavailableError();
    // A concurrent admission won the race for this statement (or used this key): read what exists.
    const again = await getJobByDocument(params.userId, params.documentId);
    if (again) return { outcome: 'existing', job: again };
    if (/uq_fdh_bank_import_jobs_idempotency|duplicate key/i.test(error.message ?? '')) return { outcome: 'idempotency_key_in_use' };
    throw new Error(error.message);
  }
  return { outcome: 'created', job: data as BankImportJobRow };
}

/** Atomic lease claim (database clock). null = someone else holds a live lease, or the job is not runnable. */
export async function claimJob(jobId: string, owner: string, leaseSeconds: number = BANK_IMPORT_LEASE_SECONDS): Promise<BankImportJobRow | null> {
  const { data, error } = await createAdminClient().rpc('fdh_bank_import_claim_job', { p_job_id: jobId, p_owner: owner, p_lease_seconds: leaseSeconds });
  if (error) raise(error);
  const rows = (data ?? []) as BankImportJobRow[];
  return rows[0] ?? null;
}

/** Backstop variant: the most overdue unfinished job nobody holds. */
export async function claimNextJob(owner: string, leaseSeconds: number = BANK_IMPORT_LEASE_SECONDS): Promise<BankImportJobRow | null> {
  const { data, error } = await createAdminClient().rpc('fdh_bank_import_claim_next', { p_owner: owner, p_lease_seconds: leaseSeconds });
  if (error) raise(error);
  const rows = (data ?? []) as BankImportJobRow[];
  return rows[0] ?? null;
}

/** Extends the caller's lease. false = the lease was lost; the slice must stop writing. */
export async function heartbeat(jobId: string, owner: string, leaseSeconds: number = BANK_IMPORT_LEASE_SECONDS): Promise<boolean> {
  const { data, error } = await createAdminClient().rpc('fdh_bank_import_heartbeat', { p_job_id: jobId, p_owner: owner, p_lease_seconds: leaseSeconds });
  if (error) raise(error);
  return data === true;
}

/** Fenced write: applies only while `owner` still holds the lease. null = the lease was lost. */
export async function updateOwned(jobId: string, owner: string, patch: Record<string, unknown>): Promise<BankImportJobRow | null> {
  const { data, error } = await createAdminClient()
    .from('fdh_bank_import_jobs')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', jobId)
    .eq('lease_owner', owner)
    .select('*')
    .maybeSingle();
  if (error) raise(error);
  return (data as BankImportJobRow | null) ?? null;
}

/** Ends a slice that has more to do: the lease is released so the very next poll can continue without waiting for it to run out. */
export async function releaseForNextSlice(jobId: string, owner: string, patch: Record<string, unknown> = {}): Promise<BankImportJobRow | null> {
  return updateOwned(jobId, owner, {
    ...patch,
    status: 'queued',
    lease_owner: null,
    lease_expires_at: null,
    last_slice_at: new Date().toISOString(),
    consecutive_failures: 0,
  });
}

/** Writes a final state (completed / failed / review_required) and releases the lease. */
export async function finishJob(jobId: string, owner: string, patch: Record<string, unknown>): Promise<BankImportJobRow | null> {
  return updateOwned(jobId, owner, { ...patch, lease_owner: null, lease_expires_at: null, last_slice_at: new Date().toISOString() });
}

/**
 * Not fenced: used by admission-side transitions that happen while NO slice holds the lease (a retry of a failed job, the person
 * answering a review). Conditional on the job still being in the state the caller saw, so two such requests cannot both win.
 */
export async function transitionJob(
  jobId: string,
  expected: { status: BankImportJobRow['status']; reviewReason?: BankImportJobRow['review_reason'] },
  patch: Record<string, unknown>,
): Promise<BankImportJobRow | null> {
  let q = createAdminClient()
    .from('fdh_bank_import_jobs')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', jobId)
    .eq('status', expected.status);
  if (expected.reviewReason !== undefined) q = q.eq('review_reason', expected.reviewReason as string);
  const { data, error } = await q.select('*').maybeSingle();
  if (error) raise(error);
  return (data as BankImportJobRow | null) ?? null;
}

// ---------------------------------------------------------------------------
// Staging chunks
// ---------------------------------------------------------------------------

export async function putChunks(jobId: string, userId: string, kind: ChunkKind, items: Array<{ seq: number; payload: Record<string, unknown> }>): Promise<void> {
  if (items.length === 0) return;
  const admin = createAdminClient();
  const BATCH = 20;
  for (let i = 0; i < items.length; i += BATCH) {
    const { error } = await admin
      .from('fdh_bank_import_job_chunks')
      .upsert(
        items.slice(i, i + BATCH).map((it) => ({ job_id: jobId, user_id: userId, kind, seq: it.seq, payload: it.payload })),
        { onConflict: 'job_id,kind,seq' },
      );
    if (error) raise(error);
  }
}

export async function getChunk(jobId: string, userId: string, kind: ChunkKind, seq: number): Promise<ChunkRow | null> {
  const { data, error } = await createAdminClient()
    .from('fdh_bank_import_job_chunks')
    .select('*')
    .eq('job_id', jobId)
    .eq('user_id', userId)
    .eq('kind', kind)
    .eq('seq', seq)
    .maybeSingle();
  if (error) raise(error);
  return (data as ChunkRow | null) ?? null;
}

export async function listChunks(jobId: string, userId: string, kind: ChunkKind, options: { withPayload?: boolean } = {}): Promise<ChunkRow[]> {
  const { data, error } = await createAdminClient()
    .from('fdh_bank_import_job_chunks')
    .select(options.withPayload === false ? 'id, job_id, user_id, kind, seq, attempts' : '*')
    .eq('job_id', jobId)
    .eq('user_id', userId)
    .eq('kind', kind)
    .order('seq', { ascending: true });
  if (error) raise(error);
  return (data ?? []) as unknown as ChunkRow[];
}

export async function bumpChunkAttempts(chunk: ChunkRow): Promise<void> {
  const { error } = await createAdminClient()
    .from('fdh_bank_import_job_chunks')
    .update({ attempts: chunk.attempts + 1 })
    .eq('id', chunk.id)
    .eq('user_id', chunk.user_id);
  if (error) raise(error);
}

export async function resetChunkAttempts(jobId: string, userId: string, kind: ChunkKind): Promise<void> {
  const { error } = await createAdminClient().from('fdh_bank_import_job_chunks').update({ attempts: 0 }).eq('job_id', jobId).eq('user_id', userId).eq('kind', kind);
  if (error) raise(error);
}

export async function deleteChunks(jobId: string, userId: string, kinds?: ChunkKind[]): Promise<void> {
  let q = createAdminClient().from('fdh_bank_import_job_chunks').delete().eq('job_id', jobId).eq('user_id', userId);
  if (kinds && kinds.length > 0) q = q.in('kind', kinds);
  const { error } = await q;
  if (error) raise(error);
}

// ---------------------------------------------------------------------------
// Backstop / purge integration
// ---------------------------------------------------------------------------

/** Of the given documents, those whose job already holds a staged plan (persist / finalize / confirmed): their structured result is
 * durable, so the raw-file backstop purges the file but does not reject the document. Missing table = empty set. */
export async function documentsWithStagedBankImportPlan(documentIds: string[]): Promise<Set<string>> {
  if (documentIds.length === 0) return new Set();
  const { data, error } = await createAdminClient()
    .from('fdh_bank_import_jobs')
    .select('statement_upload_id')
    .in('statement_upload_id', documentIds)
    .in('status', ['queued', 'processing'])
    .in('phase', ['plan_confirmed', 'persist', 'finalize']);
  if (error) return new Set();
  return new Set(((data ?? []) as Array<{ statement_upload_id: string }>).map((r) => r.statement_upload_id));
}

/** Jobs that finished (or failed for good) long ago but left staging behind, and chunks whose job no longer exists. Returns how many
 * jobs were swept. Cross-user by nature (a scheduled sweep). */
export async function sweepStaleStaging(nowMs: number = Date.now()): Promise<number> {
  const admin = createAdminClient();
  const cutoff = new Date(nowMs - BANK_IMPORT_STAGING_TTL_MS).toISOString();
  const { data, error } = await admin
    .from('fdh_bank_import_jobs')
    .select('id, user_id')
    .in('status', ['completed', 'failed'])
    .lt('updated_at', cutoff)
    .limit(200);
  if (error) {
    if (isMissingTable(error)) return 0;
    throw new Error(error.message);
  }
  let swept = 0;
  for (const j of (data ?? []) as Array<{ id: string; user_id: string }>) {
    const { data: left } = await admin.from('fdh_bank_import_job_chunks').select('id').eq('job_id', j.id).eq('user_id', j.user_id).limit(1);
    if ((left ?? []).length === 0) continue;
    await deleteChunks(j.id, j.user_id);
    swept += 1;
  }
  return swept;
}

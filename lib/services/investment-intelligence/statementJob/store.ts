/**
 * Document2 (4) WP-J -- database access for the statement job (`ii_statement_jobs` and `ii_statement_job_chunks`, migration 0313).
 *
 * SERVICE ROLE, BY DESIGN. Browsers can only READ their own jobs (row-level security); every write is made here, after the caller has
 * been authenticated and the job's owner resolved from the job row itself. The scheduled backstop has no user session at all. Every
 * query is scoped by `user_id` (or by a job id obtained from a user-scoped read), so a job or a staged chunk of another user is
 * indistinguishable from a missing one.
 *
 * FENCING. Every write a slice makes to the job row goes through `updateOwned`, conditional on `lease_owner = <the slice's token>`. A
 * slice whose lease was taken over (killed, or stalled past its lease) writes nothing: the update matches zero rows and it stops.
 */

import { createAdminClient } from '@/lib/supabase/admin';
import {
  STATEMENT_JOB_LEASE_SECONDS,
  STATEMENT_JOB_STAGING_TTL_MS,
  type StatementJobKind,
  type StatementJobRow,
} from './model';

export type StatementChunkKind = 'parsed_meta' | 'parsed_txns' | 'parsed_holds' | 'acct' | 'inst' | 'pairs' | 'claims';

export interface StatementChunkRow {
  id: string;
  job_id: string;
  user_id: string;
  kind: StatementChunkKind;
  seq: number;
  payload: unknown;
}

type DbError = { code?: string; message?: string } | null;

function isMissingTable(error: DbError): boolean {
  if (!error) return false;
  const msg = error.message ?? '';
  return error.code === '42P01' || error.code === 'PGRST205' || (/ii_statement_job/.test(msg) && /does not exist|could not find/i.test(msg));
}

/** Thrown when migration 0313 has not been applied in this environment. Callers answer "not available yet", never a 500 with SQL. */
export class StatementJobsUnavailableError extends Error {
  constructor() {
    super('Background statement processing is not available in this environment yet.');
    this.name = 'StatementJobsUnavailableError';
  }
}

function raise(error: { code?: string; message?: string }): never {
  if (isMissingTable(error)) throw new StatementJobsUnavailableError();
  throw new Error(error.message ?? 'database error');
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export async function getJobForUser(userId: string, jobId: string): Promise<StatementJobRow | null> {
  const { data, error } = await createAdminClient().from('ii_statement_jobs').select('*').eq('id', jobId).eq('user_id', userId).maybeSingle();
  if (error) raise(error);
  return (data as StatementJobRow | null) ?? null;
}

export async function getActiveJobForDocument(userId: string, documentId: string): Promise<StatementJobRow | null> {
  const { data, error } = await createAdminClient()
    .from('ii_statement_jobs')
    .select('*')
    .eq('source_document_id', documentId)
    .eq('user_id', userId)
    .in('status', ['queued', 'processing'])
    .maybeSingle();
  if (error) raise(error);
  return (data as StatementJobRow | null) ?? null;
}

/** The most recent job of a statement, whatever its state. */
export async function getLatestJobForDocument(userId: string, documentId: string): Promise<StatementJobRow | null> {
  const { data, error } = await createAdminClient()
    .from('ii_statement_jobs')
    .select('*')
    .eq('source_document_id', documentId)
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) raise(error);
  return ((data ?? [])[0] as StatementJobRow | undefined) ?? null;
}

export async function getJobByIdempotencyKey(userId: string, key: string): Promise<StatementJobRow | null> {
  const { data, error } = await createAdminClient().from('ii_statement_jobs').select('*').eq('user_id', userId).eq('idempotency_key', key).maybeSingle();
  if (error) raise(error);
  return (data as StatementJobRow | null) ?? null;
}

/** Unfinished jobs of one user (a page that was reloaded asks for these to pick the work up again). Missing table = empty. */
export async function listActiveJobsForUser(userId: string, limit = 20): Promise<StatementJobRow[]> {
  const { data, error } = await createAdminClient()
    .from('ii_statement_jobs')
    .select('*')
    .eq('user_id', userId)
    .in('status', ['queued', 'processing', 'review_required'])
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    if (isMissingTable(error)) return [];
    throw new Error(error.message);
  }
  return (data ?? []) as StatementJobRow[];
}

export type CreateJobResult =
  | { outcome: 'created'; job: StatementJobRow }
  | { outcome: 'existing'; job: StatementJobRow }
  | { outcome: 'idempotency_key_in_use' };

/**
 * Creates the job of a statement, or returns the active one (admission is idempotent). Race-safe: the unique constraints decide, and
 * the loser of a race simply reads the winner's row.
 */
export async function createJobIfNoneActive(params: {
  userId: string;
  documentId: string;
  kind: StatementJobKind;
  idempotencyKey: string;
  checkpoint: Record<string, unknown>;
}): Promise<CreateJobResult> {
  const sameKey = await getJobByIdempotencyKey(params.userId, params.idempotencyKey);
  if (sameKey) return sameKey.source_document_id === params.documentId ? { outcome: 'existing', job: sameKey } : { outcome: 'idempotency_key_in_use' };
  const active = await getActiveJobForDocument(params.userId, params.documentId);
  if (active) return { outcome: 'existing', job: active };
  const { data, error } = await createAdminClient()
    .from('ii_statement_jobs')
    .insert({
      user_id: params.userId,
      source_document_id: params.documentId,
      job_kind: params.kind,
      idempotency_key: params.idempotencyKey,
      checkpoint: params.checkpoint,
    })
    .select('*')
    .single();
  if (error) {
    if (isMissingTable(error)) throw new StatementJobsUnavailableError();
    // A concurrent admission won the race for this statement (or used this key): read what exists.
    const again = (await getActiveJobForDocument(params.userId, params.documentId)) ?? (await getJobByIdempotencyKey(params.userId, params.idempotencyKey));
    if (again) return { outcome: 'existing', job: again };
    throw new Error(error.message);
  }
  return { outcome: 'created', job: data as StatementJobRow };
}

/** Atomic lease claim (database clock). null = someone else holds a live lease, or the job is not runnable. */
export async function claimJob(jobId: string, owner: string, leaseSeconds: number = STATEMENT_JOB_LEASE_SECONDS): Promise<StatementJobRow | null> {
  const { data, error } = await createAdminClient().rpc('ii_statement_job_claim', { p_job_id: jobId, p_owner: owner, p_lease_seconds: leaseSeconds });
  if (error) raise(error);
  const rows = (data ?? []) as StatementJobRow[];
  return rows[0] ?? null;
}

/** Backstop variant: the most overdue unfinished job nobody holds. */
export async function claimNextJob(owner: string, leaseSeconds: number = STATEMENT_JOB_LEASE_SECONDS): Promise<StatementJobRow | null> {
  const { data, error } = await createAdminClient().rpc('ii_statement_job_claim_next', { p_owner: owner, p_lease_seconds: leaseSeconds });
  if (error) raise(error);
  const rows = (data ?? []) as StatementJobRow[];
  return rows[0] ?? null;
}

/** Extends the caller's lease. false = the lease was lost; the slice must stop writing. */
export async function heartbeat(jobId: string, owner: string, leaseSeconds: number = STATEMENT_JOB_LEASE_SECONDS): Promise<boolean> {
  const { data, error } = await createAdminClient().rpc('ii_statement_job_heartbeat', { p_job_id: jobId, p_owner: owner, p_lease_seconds: leaseSeconds });
  if (error) raise(error);
  return data === true;
}

/** Fenced write: applies only while `owner` still holds the lease. null = the lease was lost. */
export async function updateOwned(jobId: string, owner: string, patch: Record<string, unknown>): Promise<StatementJobRow | null> {
  const { data, error } = await createAdminClient()
    .from('ii_statement_jobs')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', jobId)
    .eq('lease_owner', owner)
    .select('*')
    .maybeSingle();
  if (error) raise(error);
  return (data as StatementJobRow | null) ?? null;
}

/** Ends a slice that has more to do: the lease is released so the very next poll can continue without waiting for it to run out. */
export async function releaseForNextSlice(jobId: string, owner: string, patch: Record<string, unknown> = {}): Promise<StatementJobRow | null> {
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
export async function finishJob(jobId: string, owner: string, patch: Record<string, unknown>): Promise<StatementJobRow | null> {
  return updateOwned(jobId, owner, { ...patch, lease_owner: null, lease_expires_at: null, last_slice_at: new Date().toISOString() });
}

/**
 * Not fenced: used by admission-side transitions that happen while NO slice holds the lease (a retry of a failed job, the person
 * supplying a password). Conditional on the job still being in the state the caller saw, so two such requests cannot both win.
 */
export async function transitionJob(
  jobId: string,
  expected: { status: StatementJobRow['status']; reviewReason?: StatementJobRow['review_reason'] },
  patch: Record<string, unknown>,
): Promise<StatementJobRow | null> {
  let q = createAdminClient()
    .from('ii_statement_jobs')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', jobId)
    .eq('status', expected.status);
  if (expected.reviewReason !== undefined) q = q.eq('review_reason', expected.reviewReason as string);
  const { data, error } = await q.select('*').maybeSingle();
  if (error) raise(error);
  return (data as StatementJobRow | null) ?? null;
}

// ---------------------------------------------------------------------------
// Staging chunks
// ---------------------------------------------------------------------------

export async function putChunk(jobId: string, userId: string, kind: StatementChunkKind, seq: number, payload: unknown): Promise<void> {
  const { error } = await createAdminClient()
    .from('ii_statement_job_chunks')
    .upsert({ job_id: jobId, user_id: userId, kind, seq, payload }, { onConflict: 'job_id,kind,seq' });
  if (error) raise(error);
}

export async function getChunk(jobId: string, userId: string, kind: StatementChunkKind, seq: number): Promise<StatementChunkRow | null> {
  const { data, error } = await createAdminClient()
    .from('ii_statement_job_chunks')
    .select('*')
    .eq('job_id', jobId)
    .eq('user_id', userId)
    .eq('kind', kind)
    .eq('seq', seq)
    .maybeSingle();
  if (error) raise(error);
  return (data as StatementChunkRow | null) ?? null;
}

export async function listChunks(jobId: string, userId: string, kind: StatementChunkKind): Promise<StatementChunkRow[]> {
  const { data, error } = await createAdminClient()
    .from('ii_statement_job_chunks')
    .select('*')
    .eq('job_id', jobId)
    .eq('user_id', userId)
    .eq('kind', kind)
    .order('seq', { ascending: true })
    .limit(5000);
  if (error) raise(error);
  return (data ?? []) as StatementChunkRow[];
}

export async function deleteChunks(jobId: string, userId: string, kinds?: StatementChunkKind[]): Promise<void> {
  let q = createAdminClient().from('ii_statement_job_chunks').delete().eq('job_id', jobId).eq('user_id', userId);
  if (kinds && kinds.length > 0) q = q.in('kind', kinds);
  const { error } = await q;
  if (error) raise(error);
}

// ---------------------------------------------------------------------------
// Backstop / purge integration
// ---------------------------------------------------------------------------

/** Of the given statements, those with an unfinished job: the raw-file retention backstop leaves their file for the job's read slice. Missing table = empty. */
export async function documentsWithActiveStatementJob(documentIds: string[]): Promise<Set<string>> {
  if (documentIds.length === 0) return new Set();
  const { data, error } = await createAdminClient().from('ii_statement_jobs').select('source_document_id').in('source_document_id', documentIds).in('status', ['queued', 'processing']);
  if (error) return new Set();
  return new Set(((data ?? []) as Array<{ source_document_id: string }>).map((r) => r.source_document_id));
}

/** Jobs that finished (or failed for good) long ago but left staging behind. Cross-user by nature (a scheduled sweep). */
export async function sweepStaleStaging(nowMs: number = Date.now()): Promise<number> {
  const admin = createAdminClient();
  const cutoff = new Date(nowMs - STATEMENT_JOB_STAGING_TTL_MS).toISOString();
  const { data, error } = await admin.from('ii_statement_jobs').select('id, user_id').in('status', ['completed', 'failed', 'review_required']).lt('updated_at', cutoff).limit(200);
  if (error) {
    if (isMissingTable(error)) return 0;
    throw new Error(error.message);
  }
  let swept = 0;
  for (const j of (data ?? []) as Array<{ id: string; user_id: string }>) {
    const { data: left } = await admin.from('ii_statement_job_chunks').select('id').eq('job_id', j.id).eq('user_id', j.user_id).limit(1);
    if ((left ?? []).length === 0) continue;
    await deleteChunks(j.id, j.user_id);
    swept += 1;
  }
  return swept;
}

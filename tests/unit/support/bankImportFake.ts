/**
 * Document2 (4) WP-G test support -- an in-memory stand-in for the database the bank import job uses.
 *
 * Built on `createInMemoryDb` (filters really apply, so a query that forgets its user scope returns the wrong rows here too) and adds
 * the three things the job relies on that the plain fake lacks:
 *   - the lease functions (`fdh_bank_import_claim_job`, `_claim_next`, `_heartbeat`) mirroring migration 0310 exactly (the real SQL is
 *     proven separately on a real Postgres in doc2_4_wpG_bankImportJobsPglite.test.ts);
 *   - the column defaults and unique constraints of `fdh_bank_import_jobs` (one job per statement, one per user + key);
 *   - the unique index of migration 0311 on `fdh_transactions (statement_upload_id, source_row)`.
 */
import { createInMemoryDb, type InMemoryDb, type Row } from './inMemorySupabase';

export interface BankImportFake {
  db: InMemoryDb;
  client: { from: (t: string) => unknown; rpc: (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }> };
  jobs: () => Row[];
  rows: (table: string) => Row[];
  /** Makes the Nth (1-based) insert into fdh_transactions throw, as a killed request would stop mid-write. */
  failTransactionInsertAt: (n: number | null) => void;
  transactionInsertCalls: () => number;
  /** The 0311 unique index on (statement_upload_id, source_row): on by default; switch off to prove the worker's own rule alone. */
  enforceUniqueSourceRow: (on: boolean) => void;
}

const JOB_DEFAULTS = (): Row => ({
  status: 'queued', phase: 'read', review_reason: null, checkpoint: {}, progress_done: 0, progress_total: null, attempt: 1,
  consecutive_failures: 0, slice_count: 0, reclaim_count: 0, lease_owner: null, lease_expires_at: null, heartbeat_at: null, last_slice_at: null,
  error_code: null, error_message_sanitised: null, result_summary: null, started_at: null, completed_at: null,
  created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
});

export function createBankImportFake(): BankImportFake {
  const db = createInMemoryDb({ upsertMerges: true });
  let failAt: number | null = null;
  let txInserts = 0;
  let uniqueOn = true;

  const jobs = () => db.tables.fdh_bank_import_jobs ?? [];
  const nowMs = () => Date.now();

  function claim(jobId: string, owner: string, seconds: number): Row[] {
    const j = jobs().find((r) => r.id === jobId);
    if (!j) return [];
    if (!['queued', 'processing'].includes(String(j.status))) return [];
    const lease = j.lease_expires_at ? Date.parse(String(j.lease_expires_at)) : null;
    if (lease !== null && lease >= nowMs()) return [];
    const expiredHolder = j.lease_owner !== null && lease !== null && lease < nowMs();
    Object.assign(j, {
      lease_owner: owner,
      lease_expires_at: new Date(nowMs() + Math.max(10, Math.min(seconds, 300)) * 1000).toISOString(),
      heartbeat_at: new Date().toISOString(),
      status: 'processing',
      started_at: j.started_at ?? new Date().toISOString(),
      slice_count: Number(j.slice_count) + 1,
      reclaim_count: Number(j.reclaim_count) + (expiredHolder ? 1 : 0),
      updated_at: new Date().toISOString(),
    });
    return [{ ...j }];
  }

  const client = {
    from(table: string) {
      const q = db.client.from(table) as Record<string, (...a: unknown[]) => unknown>;
      if (table === 'fdh_bank_import_jobs') {
        const insert = q.insert;
        q.insert = (r: unknown) => {
          const row = { ...JOB_DEFAULTS(), ...(r as Row) } as Row;
          const dupDoc = jobs().some((e) => e.statement_upload_id === row.statement_upload_id);
          const dupKey = jobs().some((e) => e.user_id === row.user_id && e.idempotency_key === row.idempotency_key);
          if (dupDoc || dupKey) {
            const err = { message: dupDoc ? 'duplicate key value violates unique constraint "uq_fdh_bank_import_jobs_document"' : 'duplicate key value violates unique constraint "uq_fdh_bank_import_jobs_idempotency"' };
            const failed = { select: () => failed, single: async () => ({ data: null, error: err }), maybeSingle: async () => ({ data: null, error: err }) };
            return failed;
          }
          return insert(row);
        };
      }
      if (table === 'fdh_transactions') {
        const insert = q.insert;
        q.insert = (r: unknown) => {
          txInserts += 1;
          if (failAt !== null && txInserts === failAt) throw new Error('simulated kill: the request ended while writing');
          const incoming = Array.isArray(r) ? (r as Row[]) : [r as Row];
          const existing = db.tables.fdh_transactions ?? [];
          const clash = uniqueOn && incoming.some((n) => n.source_row != null && existing.some((e) => e.statement_upload_id === n.statement_upload_id && e.source_row === n.source_row));
          if (clash) {
            const err = { message: 'duplicate key value violates unique constraint "uq_fdh_transactions_statement_source_row"' };
            const failed = { select: () => failed, then: (res: (v: unknown) => unknown) => Promise.resolve(res({ data: null, error: err })) };
            return failed;
          }
          const chain = insert(r) as { select: (c?: string) => unknown; then: unknown };
          return chain;
        };
      }
      return q;
    },
    async rpc(name: string, args: Record<string, unknown>) {
      if (name === 'fdh_bank_import_claim_job') return { data: claim(String(args.p_job_id), String(args.p_owner), Number(args.p_lease_seconds ?? 90)), error: null };
      if (name === 'fdh_bank_import_claim_next') {
        const eligible = jobs()
          .filter((j) => ['queued', 'processing'].includes(String(j.status)) && (!j.lease_expires_at || Date.parse(String(j.lease_expires_at)) < nowMs()))
          .sort((a, b) => String(a.lease_expires_at ?? '').localeCompare(String(b.lease_expires_at ?? '')) || String(a.updated_at).localeCompare(String(b.updated_at)));
        if (eligible.length === 0) return { data: [], error: null };
        return { data: claim(String(eligible[0].id), String(args.p_owner), Number(args.p_lease_seconds ?? 90)), error: null };
      }
      if (name === 'fdh_bank_import_heartbeat') {
        const j = jobs().find((r) => r.id === args.p_job_id && r.lease_owner === args.p_owner && r.status === 'processing');
        if (!j) return { data: false, error: null };
        j.lease_expires_at = new Date(nowMs() + Number(args.p_lease_seconds ?? 90) * 1000).toISOString();
        return { data: true, error: null };
      }
      return { data: null, error: { message: `unknown rpc ${name}` } };
    },
  };

  return {
    db,
    client: client as BankImportFake['client'],
    jobs,
    rows: (t) => db.tables[t] ?? [],
    failTransactionInsertAt: (n) => {
      failAt = n;
      txInserts = 0;
    },
    transactionInsertCalls: () => txInserts,
    enforceUniqueSourceRow: (on) => {
      uniqueOn = on;
    },
  };
}

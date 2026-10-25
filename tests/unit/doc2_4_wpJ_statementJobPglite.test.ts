/**
 * Document2 (4) WP-J -- the statement processing JOB against a REAL Postgres (PGlite, this repository's whole migration chain including
 * 0312 and 0313), with the REAL application code, REAL PDF bytes, the REAL pdf text layer and the REAL CAMS parser. Only object storage
 * is an in-memory map and the real malware scan is switched off (the documented structural-only mode).
 *
 * What is proven here (PGLITE-VERIFIED; nothing is DEV- or production-verified by this file):
 *   - the job's slices produce exactly the economics of the one-request run (the economic ORACLE: accounts, funds, transactions, source
 *     links, holdings, publications, canonical investments, the Net Worth investments leg),
 *   - a replay (replacement copy reprocess) and a killed-and-resumed run change nothing economically, at every kill point,
 *   - NULL source_reference lines and a re-read whose units / NAV / type differ from the stored rows (WP-H3): each stored row is claimed
 *     once across slices, corrected exactly once, also when a slice is killed,
 *   - one job per statement under duplicate admission, repeated polling, retry, dead-job takeover and the dead-run guard,
 *   - the password is used in memory by the read step only and is in no row of any table,
 *   - two-user tenancy.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { replayAll } from './support/promoTestHelpers';
import { createPgliteSupabase, pgliteOptions, type PgliteSupabase } from './support/pgliteSupabase';
import { buildWpjLargeCas } from '../support/buildWpjLargeCas';
import { buildEncryptedTextPdf, TEST_USER_PASSWORD } from '../support/buildEncryptedPdf';
import { attachCopy, economicDiff, expireLease, newUser, oracle, seedStatement, stagingRows, statementPdf, type Harness } from './support/wpjHarness';

const h = vi.hoisted(() => ({ client: null as unknown as PgliteSupabase, files: new Map<string, Uint8Array>() }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => h.client }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => h.client }));
vi.mock('@/lib/services/investment-intelligence/pc6/userNavHistoryKick', () => ({ kickUserNavHistory: () => undefined }));
vi.mock('@/lib/services/investment-intelligence/storage', async (orig) => ({
  ...(await orig<typeof import('@/lib/services/investment-intelligence/storage')>()),
  uploadSourceDocumentObject: async (key: string, bytes: Uint8Array) => {
    h.files.set(key, bytes);
    return { error: null };
  },
  downloadSourceDocumentObject: async (key: string) => {
    const bytes = h.files.get(key);
    // a fresh copy per download, as object storage gives: the PDF library detaches the buffer it is handed
    return bytes ? { bytes: new Uint8Array(bytes), error: null } : { bytes: null, error: 'not found' };
  },
  deleteSourceDocumentObject: async (key: string) => {
    h.files.delete(key);
    return { error: null };
  },
  verifySourceDocumentObjectAbsent: async (key: string) => !h.files.has(key),
}));
vi.mock('@/lib/aie/malware/config', async (orig) => ({ ...(await orig<typeof import('@/lib/aie/malware/config')>()), isRealMalwareScanEnabled: () => false }));

import { processSourceDocument } from '@/lib/services/investment-intelligence/documentProcessing';
import { admitStatementJob } from '@/lib/services/investment-intelligence/statementJob/admission';
import { advanceNextStatementJob, advanceStatementJob, SimulatedSliceKill } from '@/lib/services/investment-intelligence/statementJob/worker';
import { abandonIdleStatementJobs } from '@/lib/services/investment-intelligence/statementJob/abandoned';
import { closeAllDeadParseRuns } from '@/lib/services/investment-intelligence/statementJob/deadRuns';
import { getJobForUser, sweepStaleStaging } from '@/lib/services/investment-intelligence/statementJob/store';
import { publishPosition } from '@/lib/services/investment-intelligence/investmentPublicationService';

let db: PGlite;
let H: Harness;

beforeAll(async () => {
  db = new PGlite(pgliteOptions);
  await replayAll(db);
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ role: 'service_role' })]);
  h.client = createPgliteSupabase(db);
  H = { db, client: h.client, files: h.files };
}, 900_000);
afterAll(async () => {
  await db?.close();
});
beforeEach(() => h.files.clear());

const stampOf = (() => {
  let k = 0;
  return () => String(100000 + ++k * 7);
})();

/** A statement with no provider reference on any line (source_reference stays NULL, as on real CAS lines). */
function fixture(positions: number, txns: number, extra: Partial<Parameters<typeof buildWpjLargeCas>[0]> = {}) {
  return buildWpjLargeCas({ positions, txnsPerPosition: txns, stamp: stampOf(), omitRefs: true, ...extra });
}

interface Prepared {
  userId: string;
  memberId: string;
  docId: string;
}
async function prepare(label: string, cas: { lines: string[] }, userCtx?: { userId: string; memberId: string }): Promise<Prepared> {
  const user = userCtx ?? (await newUser(db, label));
  const docId = await seedStatement(H, user, statementPdf(cas.lines, label), label);
  return { ...user, docId };
}

type Fault = (point: string) => void | Promise<void>;
async function drive(jobId: string, userId: string, opts: { budget?: number; password?: string; fault?: Fault; max?: number } = {}) {
  let slices = 0;
  for (;;) {
    const out = await advanceStatementJob(jobId, { userId, sliceBudgetMs: opts.budget ?? 0, password: opts.password, fault: opts.fault });
    if (out.kind === 'not_found') throw new Error('job not found');
    slices += out.kind === 'advanced' ? 1 : 0;
    const job = out.job;
    if (job.status !== 'queued' && job.status !== 'processing') return { slices, job };
    if (out.kind === 'busy') throw new Error('unexpected busy');
    if (slices > (opts.max ?? 3000)) throw new Error(`job did not finish in ${slices} slices (phase ${job.phase})`);
  }
}

async function admit(p: Prepared, extra: { forceReparse?: boolean; idempotencyKey?: string; password?: string } = {}) {
  const a = await admitStatementJob({ userId: p.userId, documentId: p.docId, kind: 'process', ...extra });
  if (a.kind !== 'job') throw new Error(`expected a job, got ${JSON.stringify(a)}`);
  return a.job;
}

async function runJob(p: Prepared, opts: Parameters<typeof drive>[2] & { forceReparse?: boolean; password?: string } = {}) {
  const job = await admit(p, { forceReparse: opts.forceReparse, password: opts.password });
  return { jobId: job.id, ...(await drive(job.id, p.userId, opts)) };
}

class Once {
  fired = false;
  constructor(private readonly point: string) {}
  hook: Fault = (p) => {
    if (!this.fired && p === this.point) {
      this.fired = true;
      throw new SimulatedSliceKill(p);
    }
  };
}

async function runWithKill(p: Prepared, point: string, extra: { forceReparse?: boolean } = {}) {
  const job = await admit(p, extra);
  const once = new Once(point);
  let killed = false;
  for (let i = 0; i < 4000; i++) {
    try {
      const out = await advanceStatementJob(job.id, { userId: p.userId, sliceBudgetMs: 0, fault: once.hook });
      if (out.kind === 'busy' || out.kind === 'not_found') throw new Error(`unexpected ${out.kind} without a kill`);
      if (out.job.status !== 'queued' && out.job.status !== 'processing') return { jobId: job.id, killed, job: out.job };
    } catch (e) {
      if (!(e instanceof SimulatedSliceKill)) throw e;
      killed = true;
      // the dead slice still holds its lease: nothing can claim the job until it runs out
      const during = await advanceStatementJob(job.id, { userId: p.userId, sliceBudgetMs: 0 });
      expect(during.kind, 'a job whose slice died is busy until its lease runs out').toBe('busy');
      await expireLease(H, job.id);
    }
  }
  throw new Error('did not finish');
}

const runningRuns = async (userId: string) => Number((await db.query<{ n: string }>(`select count(*)::text n from ii_document_parse_runs where user_id = $1 and run_status = 'running'`, [userId])).rows[0].n);

// ---------------------------------------------------------------------------------------------------------------------
describe('WP-J statement job: equals the one-request run', () => {
  it('25 positions x 12 purchases (no references): the job in single-unit slices gives the same economics as the synchronous run', async () => {
    const cas = fixture(25, 12);
    const sync = await prepare('sync', cas);
    const r = await processSourceDocument({ userId: sync.userId, sourceDocumentId: sync.docId });
    expect(r.ok, r.error ?? '').toBe(true);
    const o1 = await oracle(H, sync.userId);

    const viaJob = await prepare('job', cas);
    const { slices, job } = await runJob(viaJob);
    expect(job.status).toBe('completed');
    expect(slices, 'one unit per slice must take many slices').toBeGreaterThanOrEqual(8);
    const o2 = await oracle(H, viaJob.userId);
    expect(economicDiff(o1, o2)).toEqual({});
    expect(o2.economic).toMatchObject({ accounts: 13, transactionsActive: 300, transactionsReversed: 0, holdingSnapshots: 25, transactionOriginatingLinks: 300 });
    expect(o2.economic.portfolioTruthCertified).toBe(25);
    expect(o2.bookkeeping.parseRunsRunning).toBe(0);
    expect(await stagingRows(H, viaJob.userId), 'staging is removed when the job ends').toBe(0);
    // the file is deleted by design, the document is parsed and the run succeeded
    const doc = (await db.query<{ status: string; storage_purged_at: string | null }>(`select status, storage_purged_at from ii_source_documents where id = $1`, [viaJob.docId])).rows[0];
    expect(doc.status).toBe('parsed');
    expect(doc.storage_purged_at).not.toBeNull();
    const result = job.result_summary as { ok: boolean; summary: Record<string, number> };
    expect(result.ok).toBe(true);
    expect(result.summary).toMatchObject({ transactionsFound: 300, holdingsFound: 25, newTransactionsCount: 300, duplicateTransactionsLinked: 0, accountsFound: 13, schemesFound: 25 });
    expect(job.progress_done).toBe(100);
  }, 600_000);

  it.each([
    [25, 12],
    [200, 10],
  ])('%i positions x %i purchases: exact counts, every position certified, run closed, staging empty', async (positions, txns) => {
    const cas = fixture(positions, txns);
    const p = await prepare(`scale${positions}`, cas);
    const { slices, job } = await runJob(p, { budget: 400 });
    expect(job.status, JSON.stringify(job.result_summary)).toBe('completed');
    const o = await oracle(H, p.userId);
    expect(o.economic).toMatchObject({ accounts: cas.folios.length, transactionsActive: cas.totalTransactions, holdingSnapshots: positions, portfolioTruthRows: positions, portfolioTruthCertified: positions });
    expect(o.bookkeeping).toMatchObject({ parseRuns: 1, parseRunsRunning: 0 });
    expect(await stagingRows(H, p.userId)).toBe(0);
    expect(slices).toBeGreaterThanOrEqual(1);
  }, 900_000);

  it('1,000 positions x 6 purchases (6,000 transactions, 500 folios): completes in bounded slices with exact counts', async () => {
    const cas = fixture(1000, 6);
    const p = await prepare('scale1000', cas);
    const { slices, job } = await runJob(p, { budget: 3000 });
    expect(job.status, JSON.stringify(job.result_summary)).toBe('completed');
    const o = await oracle(H, p.userId);
    expect(o.economic).toMatchObject({ accounts: 500, transactionsActive: 6000, holdingSnapshots: 1000, portfolioTruthCertified: 1000, transactionOriginatingLinks: 6000 });
    expect(o.bookkeeping.parseRunsRunning).toBe(0);
    expect(slices).toBeGreaterThan(1);
  }, 1_800_000);
});

// ---------------------------------------------------------------------------------------------------------------------
describe('WP-J statement job: replay (replacement copy reprocess) changes nothing economically', () => {
  it('process, publish, then reprocess three times with a fresh copy each time: the oracle never moves, one run per attempt', async () => {
    const cas = fixture(25, 12);
    const p = await prepare('replay', cas);
    expect((await runJob(p)).job.status).toBe('completed');
    // publish one position to FHIP so publications, canonical investments and Net Worth are part of the oracle
    const snap = (await db.query<{ id: string }>(`select id from ii_holding_snapshots where user_id = $1 order by as_of_date desc, id limit 1`, [p.userId])).rows[0];
    const pub = await publishPosition(p.userId, snap.id);
    expect(pub.error, `publish: ${pub.error}`).toBeNull();
    const o0 = await oracle(H, p.userId);
    expect(o0.economic).toMatchObject({ publicationsPublished: 1, investmentsActive: 1 });
    expect(o0.economic.netWorthInvestmentsPublishedTotal).toBeGreaterThan(0);

    for (let i = 1; i <= 3; i++) {
      await attachCopy(H, p.userId, p.docId, statementPdf(cas.lines, `replay-copy-${i}`), `copy${i}`);
      const { job } = await runJob(p, { forceReparse: true });
      expect(job.status, JSON.stringify(job.result_summary)).toBe('completed');
      expect((job.result_summary as { summary: Record<string, number> }).summary).toMatchObject({ newTransactionsCount: 0, duplicateTransactionsLinked: 300 });
      expect(economicDiff(o0, await oracle(H, p.userId)), `after replacement ${i}`).toEqual({});
    }
    expect((await oracle(H, p.userId)).bookkeeping).toMatchObject({ parseRuns: 4, parseRunsRunning: 0 });
  }, 900_000);

  it('a replay killed at any point and resumed: same economics as the uninterrupted replay', async () => {
    const cas = fixture(25, 12);
    const base = await prepare('replay-kill-base', cas);
    expect((await runJob(base)).job.status).toBe('completed');
    const o0 = await oracle(H, base.userId);
    for (const point of ['accounts:written', 'schemes:written', 'transactions:decided', 'transactions:written', 'holdings:written', 'certify:batch', 'finalize:before_purge']) {
      await attachCopy(H, base.userId, base.docId, statementPdf(cas.lines, `kc-${point}`), `kc${point.replace(/\W/g, '')}`);
      const r = await runWithKill(base, point, { forceReparse: true });
      expect(r.killed, `the hook at ${point} never fired`).toBe(true);
      expect(r.job.status, point).toBe('completed');
      expect(economicDiff(o0, await oracle(H, base.userId)), `killed at ${point}`).toEqual({});
      expect(await runningRuns(base.userId)).toBe(0);
    }
  }, 1_800_000);
});

// ---------------------------------------------------------------------------------------------------------------------
describe('WP-J statement job: a slice killed at every named point, then resumed', () => {
  const points = [
    'read:run_created',
    'read:staged',
    'accounts:written',
    'owner:applied',
    'schemes:written',
    'transactions:decided',
    'transactions:rows_written_before_links',
    'transactions:written',
    'transactions:reversed',
    'holdings:written',
    'analyse:cases',
    'certify:batch',
    'finalize:before_purge',
    'finalize:after_purge',
  ];
  it.each(points)('killed at %s: the resumed job ends with the same economics as a clean run, no duplicate, no run left running', async (point) => {
    const cas = fixture(25, 12);
    const clean = await prepare(`clean-${point}`, cas);
    expect((await runJob(clean)).job.status).toBe('completed');
    const oClean = await oracle(H, clean.userId);

    const victim = await prepare(`kill-${point}`, cas);
    const r = await runWithKill(victim, point);
    // 'transactions:reversed' and 'analyse:cases' only fire when there is something to reverse / a missing-transaction case; they are
    // exercised with real data in the aged-rows and the missing-transaction tests below.
    if (!r.killed) return;
    expect(r.job.status, JSON.stringify(r.job.result_summary)).toBe('completed');
    expect(economicDiff(oClean, await oracle(H, victim.userId)), `killed at ${point}`).toEqual({});
    const after = await oracle(H, victim.userId);
    expect(after.bookkeeping.parseRunsRunning).toBe(0);
    expect(after.bookkeeping.parseRuns, 'one run, resumed, not a second one').toBe(1);
    const job = await getJobForUser(victim.userId, r.jobId);
    expect(job!.reclaim_count, 'the take-over was counted').toBeGreaterThanOrEqual(1);
    expect(await stagingRows(H, victim.userId)).toBe(0);
  }, 600_000);
});

// ---------------------------------------------------------------------------------------------------------------------
describe('WP-J statement job: WP-H3 re-read of aged rows (NULL references, other units / NAV / type)', () => {
  /** How rows written by an EARLIER parse differ from a re-read today: other units / NAV (and for one date another type), fingerprint over the old values. */
  async function ageRows(userId: string, count: number, changeTypeOnFirst = true): Promise<number> {
    const rows = (await db.query<{ id: string }>(`select id from ii_transactions where user_id = $1 order by transaction_date, id limit $2`, [userId, count])).rows;
    for (let i = 0; i < rows.length; i++) {
      await db.query(
        `update ii_transactions set units = units * 10, price_per_unit = price_per_unit / 10, ${changeTypeOnFirst && i === 0 ? `transaction_type = 'adjustment',` : ''} transaction_fingerprint = 'earlier-parse-' || id where id = $1`,
        [rows[0 + i].id],
      );
    }
    return rows.length;
  }

  async function agedFixture(label: string, cas: { lines: string[] }) {
    const p = await prepare(label, cas);
    expect((await runJob(p)).job.status).toBe('completed');
    const aged = await ageRows(p.userId, 12);
    const before = await oracle(H, p.userId);
    return { p, aged, before };
  }

  it('the corrected re-read replaces each aged row exactly once; units and amounts return to the statement; replays change nothing', async () => {
    const cas = fixture(25, 12);
    const { p, aged, before } = await agedFixture('aged', cas);
    expect(before.economic.transactionsActive).toBe(300);
    await attachCopy(H, p.userId, p.docId, statementPdf(cas.lines, 'aged-copy-1'), 'agedcopy1');
    const { job } = await runJob(p, { forceReparse: true });
    expect(job.status, JSON.stringify(job.result_summary)).toBe('completed');
    const o1 = await oracle(H, p.userId);
    // active rows stay 300: the 12 aged rows are replaced by 12 corrections, the old ones are reversed (soft, kept)
    expect(o1.economic).toMatchObject({ transactionsActive: 300, transactionsReversed: aged, transactionsCorrected: aged });
    // a second and third re-read find exact matches and change nothing
    for (let i = 2; i <= 3; i++) {
      await attachCopy(H, p.userId, p.docId, statementPdf(cas.lines, `aged-copy-${i}`), `agedcopy${i}`);
      expect((await runJob(p, { forceReparse: true })).job.status).toBe('completed');
      expect(economicDiff(o1, await oracle(H, p.userId)), `re-read ${i}`).toEqual({});
    }
  }, 900_000);

  it.each(['transactions:decided', 'transactions:rows_written_before_links', 'transactions:written', 'transactions:reversed'])(
    'killed at %s during the corrected re-read: each aged row is claimed once and corrected once, never doubled',
    async (point) => {
      const cas = fixture(25, 12);
      const clean = await agedFixture(`aged-clean-${point}`, cas);
      await attachCopy(H, clean.p.userId, clean.p.docId, statementPdf(cas.lines, 'c'), `c${point.replace(/\W/g, '')}`);
      expect((await runJob(clean.p, { forceReparse: true })).job.status).toBe('completed');
      const oClean = await oracle(H, clean.p.userId);

      const victim = await agedFixture(`aged-kill-${point}`, cas);
      await attachCopy(H, victim.p.userId, victim.p.docId, statementPdf(cas.lines, 'v'), `v${point.replace(/\W/g, '')}`);
      const r = await runWithKill(victim.p, point, { forceReparse: true });
      expect(r.killed, `the hook at ${point} never fired`).toBe(true);
      expect(r.job.status, JSON.stringify(r.job.result_summary)).toBe('completed');
      expect(economicDiff(oClean, await oracle(H, victim.p.userId)), `killed at ${point}`).toEqual({});
      const o = await oracle(H, victim.p.userId);
      expect(o.economic).toMatchObject({ transactionsActive: 300, transactionsReversed: victim.aged, transactionsCorrected: victim.aged });
      // every correction points at exactly one distinct stored row
      const dup = (await db.query<{ n: string }>(`select count(*)::text n from (select corrects_transaction_id from ii_transactions where user_id = $1 and corrects_transaction_id is not null group by 1 having count(*) > 1) t`, [victim.p.userId])).rows[0].n;
      expect(Number(dup)).toBe(0);
    },
    900_000,
  );

  it('a row a person corrected stands: the re-read links to it and writes nothing', async () => {
    const cas = fixture(25, 12);
    const { p, aged } = await agedFixture('aged-person', cas);
    const one = (await db.query<{ id: string }>(`select id from ii_transactions where user_id = $1 and transaction_fingerprint like 'earlier-parse-%' order by transaction_date, id limit 1`, [p.userId])).rows[0].id;
    await db.query(`insert into ii_audit_events (user_id, event_type, subject_type, subject_id, actor_type, actor_id) values ($1, 'user_correction', 'ii_transactions', $2, 'user', $1)`, [p.userId, one]);
    await attachCopy(H, p.userId, p.docId, statementPdf(cas.lines, 'person-copy'), 'personcopy');
    expect((await runJob(p, { forceReparse: true })).job.status).toBe('completed');
    const o = await oracle(H, p.userId);
    expect(o.economic).toMatchObject({ transactionsActive: 300, transactionsReversed: aged - 1, transactionsCorrected: aged - 1 });
    const stillThere = (await db.query<{ status: string }>(`select status from ii_transactions where id = $1`, [one])).rows[0].status;
    expect(stillThere).not.toBe('reversed');
  }, 900_000);
});

// ---------------------------------------------------------------------------------------------------------------------
describe('WP-J statement job: admission, polling, retry, dead jobs, dead runs', () => {
  it('four admissions at the same moment create ONE job; an Idempotency-Key answers the same job; a key cannot move to another statement', async () => {
    const cas = fixture(25, 12);
    const p = await prepare('adm', cas);
    const results = await Promise.all([1, 2, 3, 4].map(() => admitStatementJob({ userId: p.userId, documentId: p.docId, kind: 'process' })));
    const jobs = results.map((r) => (r.kind === 'job' ? r.job.id : 'x'));
    expect(new Set(jobs).size).toBe(1);
    expect(jobs[0]).not.toBe('x');
    expect(Number((await db.query<{ n: string }>(`select count(*)::text n from ii_statement_jobs where source_document_id = $1`, [p.docId])).rows[0].n)).toBe(1);
    // finish it, then the key
    await drive(jobs[0], p.userId, { budget: 5000 });
    await attachCopy(H, p.userId, p.docId, statementPdf(cas.lines, 'adm-copy'), 'admcopy'); // the first file was deleted by design
    const keyed = await admitStatementJob({ userId: p.userId, documentId: p.docId, kind: 'process', forceReparse: true, idempotencyKey: 'client-key-0001' });
    const again = await admitStatementJob({ userId: p.userId, documentId: p.docId, kind: 'process', forceReparse: true, idempotencyKey: 'client-key-0001' });
    expect(keyed.kind === 'job' && again.kind === 'job' && keyed.job.id === again.job.id).toBe(true);
    const other = await prepare('adm2', cas, { userId: p.userId, memberId: p.memberId });
    const stolen = await admitStatementJob({ userId: p.userId, documentId: other.docId, kind: 'process', forceReparse: true, idempotencyKey: 'client-key-0001' });
    expect(stolen).toEqual({ kind: 'conflict', code: 'idempotency_key_in_use' });
  }, 600_000);

  it('a processed statement answers inline (no job) unless a reprocess is asked for', async () => {
    const cas = fixture(25, 12);
    const p = await prepare('cached', cas);
    expect((await runJob(p)).job.status).toBe('completed');
    const a = await admitStatementJob({ userId: p.userId, documentId: p.docId, kind: 'process' });
    expect(a.kind).toBe('answer');
    expect(a.kind === 'answer' && a.result.ok).toBe(true);
    // the file is gone and a reprocess is asked for: the typed "needs a replacement copy" answer, no job, no run opened
    const gone = await admitStatementJob({ userId: p.userId, documentId: p.docId, kind: 'process', forceReparse: true });
    expect(gone.kind).toBe('answer');
    expect(gone.kind === 'answer' && gone.result.status).toBe('source_file_not_stored');
    expect(Number((await db.query<{ n: string }>(`select count(*)::text n from ii_document_parse_runs where source_document_id = $1`, [p.docId])).rows[0].n)).toBe(1);
  }, 600_000);

  it('three polls at the same moment: exactly one advances, the others are told it is busy', async () => {
    const cas = fixture(25, 12);
    const p = await prepare('poll', cas);
    const job = await admit(p);
    const outs = await Promise.all([1, 2, 3].map(() => advanceStatementJob(job.id, { userId: p.userId, sliceBudgetMs: 0 })));
    expect(outs.filter((o) => o.kind === 'advanced')).toHaveLength(1);
    expect(outs.filter((o) => o.kind === 'busy')).toHaveLength(2);
    // repeated polling afterwards (sequential) is safe and the job still completes with exact counts
    const { job: done } = await drive(job.id, p.userId);
    expect(done.status).toBe('completed');
    expect((await oracle(H, p.userId)).economic.transactionsActive).toBe(300);
    // asking after the end is harmless
    const late = await advanceStatementJob(job.id, { userId: p.userId });
    expect(late.kind).toBe('not_runnable');
  }, 600_000);

  it('three unexpected errors in a row end the job as failed, close its run as failed (never left running) and a retry starts a new attempt that completes', async () => {
    const cas = fixture(25, 12);
    const p = await prepare('retry', cas);
    const job = await admit(p);
    const boom: Fault = (point) => {
      if (point === 'accounts:written') throw new Error('database went away');
    };
    let last = job;
    for (let i = 0; i < 6 && (last.status === 'queued' || last.status === 'processing'); i++) {
      const out = await advanceStatementJob(job.id, { userId: p.userId, sliceBudgetMs: 0, fault: boom });
      if (out.kind === 'not_found') throw new Error('job not found');
      last = out.job;
    }
    expect(last.status).toBe('failed');
    expect(last.error_code).toBe('internal_error');
    expect(await runningRuns(p.userId), 'a failed job must not leave its run running').toBe(0);
    expect(await stagingRows(H, p.userId)).toBe(0);
    // retry: a new job (the file is still stored because the read step never finished)
    const second = await runJob(p, { forceReparse: true });
    expect(second.job.status).toBe('completed');
    expect(second.jobId).not.toBe(job.id);
    expect((await oracle(H, p.userId)).economic).toMatchObject({ transactionsActive: 300, accounts: 13 });
  }, 600_000);

  it('a dead job (lease ran out) is taken over by the next poll, once, and the take-over is counted', async () => {
    const cas = fixture(25, 12);
    const p = await prepare('dead', cas);
    const r = await runWithKill(p, 'schemes:written');
    expect(r.killed).toBe(true);
    const job = await getJobForUser(p.userId, r.jobId);
    expect(job!.status).toBe('completed');
    expect(job!.reclaim_count).toBe(1);
  }, 600_000);

  it('the dead-run guard: a run with no heartbeat is closed with an honest reason and the statement can be processed at once; a fresh run is still "already being processed"', async () => {
    const cas = fixture(25, 12);
    const p = await prepare('deadrun', cas);
    // a run the platform killed long ago (the production symptom)
    await db.query(
      `insert into ii_document_parse_runs (user_id, source_document_id, parser_code, parser_version, run_status, started_at, idempotency_key)
       values ($1, $2, 'r2-orchestrator', 'pending', 'running', now() - interval '3 minutes', 'old-key-1')`,
      [p.userId, p.docId],
    );
    const a = await admitStatementJob({ userId: p.userId, documentId: p.docId, kind: 'process', forceReparse: true });
    expect(a.kind, JSON.stringify(a)).toBe('job');
    const closed = (await db.query<{ run_status: string; errors: Array<{ code: string; message: string }> }>(`select run_status, errors from ii_document_parse_runs where idempotency_key = 'old-key-1'`)).rows[0];
    expect(closed.run_status).toBe('failed');
    expect(closed.errors[0].code).toBe('run_abandoned');
    expect(closed.errors[0].message).toMatch(/showed no sign of progress/);
    const { job } = await drive((a as { job: { id: string } }).job.id, p.userId);
    expect(job.status).toBe('completed');

    // a run that is only seconds old and has no job is still alive
    const q = await prepare('freshrun', cas);
    await db.query(
      `insert into ii_document_parse_runs (user_id, source_document_id, parser_code, parser_version, run_status, started_at, idempotency_key)
       values ($1, $2, 'r2-orchestrator', 'pending', 'running', now() - interval '10 seconds', 'fresh-key-1')`,
      [q.userId, q.docId],
    );
    const b = await admitStatementJob({ userId: q.userId, documentId: q.docId, kind: 'process' });
    expect(b.kind === 'answer' && b.result.error).toBe('This document is already being processed.');
  }, 600_000);

  it('the sweep closes dead runs of every user, spares runs of a live job, and removes staging left behind', async () => {
    const cas = fixture(25, 12);
    const live = await prepare('sweep-live', cas);
    const job = await admit(live);
    await advanceStatementJob(job.id, { userId: live.userId, sliceBudgetMs: 0 }); // the read step: a run exists, the job is unfinished
    const dead = await prepare('sweep-dead', cas);
    await db.query(
      `insert into ii_document_parse_runs (user_id, source_document_id, parser_code, parser_version, run_status, started_at, idempotency_key)
       values ($1, $2, 'r2-orchestrator', 'pending', 'running', now() - interval '2 days', 'sweep-dead-key')`,
      [dead.userId, dead.docId],
    );
    // a run keyed to a job that has ended is dead too
    const ended = await prepare('sweep-ended', cas);
    await db.query(
      `insert into ii_document_parse_runs (user_id, source_document_id, parser_code, parser_version, run_status, started_at, idempotency_key)
       values ($1, $2, 'r2-orchestrator', 'pending', 'running', now() - interval '5 minutes', 'job:00000000-0000-4000-8000-0000000000ff:1')`,
      [ended.userId, ended.docId],
    );
    const closed = await closeAllDeadParseRuns(h.client as never);
    expect(closed).toBe(2);
    expect(await runningRuns(live.userId), 'the live job run is not touched').toBe(1);
    expect(await runningRuns(dead.userId)).toBe(0);
    expect(await runningRuns(ended.userId)).toBe(0);
    // finish the live one; then plant old staging and sweep it
    await drive(job.id, live.userId);
    await db.query(`update ii_statement_jobs set updated_at = now() - interval '2 days' where id = $1`, [job.id]);
    await db.query(`insert into ii_statement_job_chunks (job_id, user_id, kind, seq, payload) values ($1, $2, 'acct', 99, '[]'::jsonb)`, [job.id, live.userId]);
    expect(await sweepStaleStaging()).toBe(1);
    expect(await stagingRows(H, live.userId)).toBe(0);
  }, 600_000);
});

// ---------------------------------------------------------------------------------------------------------------------
describe('WP-J statement job: the password', () => {
  it('a protected statement: no password -> review_required (password), nothing staged; with the password the read step opens it; the password is in no row of any table', async () => {
    const cas = fixture(3, 4); // small enough for the one-page protected PDF the helper builds
    const secret = TEST_USER_PASSWORD;
    const user = await newUser(db, 'pw');
    const bytes = await buildEncryptedTextPdf(cas.lines, { userPassword: secret });
    const docId = await seedStatement(H, user, bytes, 'protected');
    const p: Prepared = { ...user, docId };

    const first = await runJob(p);
    expect(first.job.status).toBe('review_required');
    expect(first.job.review_reason).toBe('password');
    expect((await db.query<{ status: string }>(`select status from ii_source_documents where id = $1`, [docId])).rows[0].status).toBe('password_required');
    expect(await stagingRows(H, user.userId)).toBe(0);
    expect(await runningRuns(user.userId)).toBe(0);

    // the person supplies the password: the same statement, a new job; only the read slice gets the password
    const job = await admit(p, { forceReparse: true, password: secret });
    const out1 = await advanceStatementJob(job.id, { userId: user.userId, sliceBudgetMs: 0, password: secret });
    expect(out1.kind).toBe('advanced');
    // every later slice runs WITHOUT the password and still completes: nothing needs it any more
    const { job: done } = await drive(job.id, user.userId, { budget: 0 });
    expect(done.status, JSON.stringify(done.result_summary)).toBe('completed');
    expect((await oracle(H, user.userId)).economic).toMatchObject({ transactionsActive: 12, holdingSnapshots: 3 });

    // the password appears nowhere: not in a job row, a chunk, an audit event, a case, a run, the document
    for (const table of ['ii_statement_jobs', 'ii_statement_job_chunks', 'ii_audit_events', 'ii_reconciliation_cases', 'ii_document_parse_runs', 'ii_source_documents']) {
      const dump = (await db.query<{ t: string }>(`select coalesce(string_agg(to_jsonb(x)::text, ' '), '') as t from ${table} x where user_id = $1`, [user.userId])).rows[0].t;
      expect(dump.includes(secret), `the password must not be stored in ${table}`).toBe(false);
    }
  }, 600_000);
});

// ---------------------------------------------------------------------------------------------------------------------
describe('WP-J statement job: two-user tenancy', () => {
  it('another user can neither read, advance nor start a job on a statement that is not theirs; rows are invisible to the browser role', async () => {
    const cas = fixture(5, 6);
    const a = await prepare('tenant-a', cas);
    const b = await newUser(db, 'tenant-b');
    const job = await admit(a);
    expect(await getJobForUser(b.userId, job.id)).toBeNull();
    expect((await advanceStatementJob(job.id, { userId: b.userId })).kind).toBe('not_found');
    const stolen = await admitStatementJob({ userId: b.userId, documentId: a.docId, kind: 'process' });
    expect(stolen.kind === 'answer' && stolen.result.status).toBe('not_found');
    await drive(job.id, a.userId);

    // row-level security as the browser role
    const as = async <T,>(uid: string, fn: () => Promise<T>): Promise<T> => {
      await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: uid, role: 'authenticated' })]);
      await db.exec('set role authenticated;');
      try {
        return await fn();
      } finally {
        await db.exec('reset role;');
        await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ role: 'service_role' })]);
      }
    };
    expect((await as(a.userId, () => db.query(`select id from ii_statement_jobs`))).rows).toHaveLength(1);
    expect((await as(b.userId, () => db.query(`select id from ii_statement_jobs`))).rows).toHaveLength(0);
    // no write policy: an update by the browser role touches no row; staging has no policy at all: it reads as empty
    expect((await as(a.userId, () => db.query(`update ii_statement_jobs set error_code = 'tampered' where id = $1 returning id`, [job.id]))).rows).toHaveLength(0);
    expect((await db.query<{ error_code: string | null }>(`select error_code from ii_statement_jobs where id = $1`, [job.id])).rows[0].error_code).not.toBe('tampered');
    await db.query(`insert into ii_statement_job_chunks (job_id, user_id, kind, seq, payload) values ($1, $2, 'acct', 7, '[]'::jsonb)`, [job.id, a.userId]);
    expect((await as(a.userId, () => db.query(`select id from ii_statement_job_chunks`))).rows).toHaveLength(0);
    expect(Number((await db.query<{ n: string }>(`select count(*)::text n from ii_statement_job_chunks where user_id = $1`, [a.userId])).rows[0].n)).toBe(1);
    await expect(as(a.userId, () => db.query(`select * from ii_statement_job_claim($1, 'browser-owner-1', 60)`, [job.id]))).rejects.toThrow(/permission denied/i);
    // a job cannot be pointed at another user's statement
    await expect(db.query(`insert into ii_statement_jobs (user_id, source_document_id, idempotency_key) values ($1, $2, 'x-tenant-key-1')`, [b.userId, a.docId])).rejects.toThrow(/cross-tenant/);
  }, 600_000);
});

// ---------------------------------------------------------------------------------------------------------------------
describe('WP-J statement job: a stored row is claimed ONCE across slices (two genuine same-day instalments, one natural key)', () => {
  it('two lines for the same date and amount in DIFFERENT staging batches, both aged: each claims its own stored row; one correction per old row; also when killed between the batches', async () => {
    // 205 purchases on one position; lines 199 and 200 are the twins and fall in staging batch 0 and batch 1 (batches hold 200 lines)
    const cas = buildWpjLargeCas({ positions: 1, txnsPerPosition: 205, stamp: stampOf(), omitRefs: true, twinAt: 199 });
    for (const killPoint of [null, 'transactions:written']) {
      const p = await prepare(`twins-${killPoint ?? 'clean'}`, cas);
      expect((await runJob(p)).job.status).toBe('completed');
      expect((await oracle(H, p.userId)).economic.transactionsActive).toBe(205);
      // age BOTH twins (they share date and amount, so they share a natural key)
      const twins = (await db.query<{ id: string }>(`select id from ii_transactions where user_id = $1 and gross_amount = 600 order by transaction_date, id`, [p.userId])).rows;
      expect(twins.length).toBeGreaterThanOrEqual(2);
      for (const t of twins) {
        await db.query(`update ii_transactions set units = units * 10, price_per_unit = price_per_unit / 10, transaction_fingerprint = 'earlier-parse-' || id where id = $1`, [t.id]);
      }
      await attachCopy(H, p.userId, p.docId, statementPdf(cas.lines, `twin-copy-${killPoint}`), `twin${killPoint ?? 'c'}`.replace(/\W/g, ''));
      const r = killPoint ? await runWithKill(p, killPoint, { forceReparse: true }) : await runJob(p, { forceReparse: true });
      expect(r.job.status, JSON.stringify(r.job.result_summary)).toBe('completed');
      const o = await oracle(H, p.userId);
      expect(o.economic.transactionsActive, 'the position keeps its 205 lines').toBe(205);
      expect(o.economic.transactionsReversed, 'each aged twin is replaced once').toBe(twins.length);
      expect(o.economic.transactionsCorrected).toBe(twins.length);
      const pointers = (await db.query<{ corrects_transaction_id: string }>(`select corrects_transaction_id from ii_transactions where user_id = $1 and corrects_transaction_id is not null`, [p.userId])).rows.map((x) => x.corrects_transaction_id);
      expect(new Set(pointers).size, 'one correction per stored row, never two for the same row').toBe(twins.length);
      expect(pointers.sort()).toEqual(twins.map((t) => t.id).sort());
    }
  }, 1_200_000);
});

// ---------------------------------------------------------------------------------------------------------------------
describe('WP-J statement job: a slice that lost its lease writes nothing (fencing)', () => {
  it('slice A stalls, its lease runs out, slice B takes over and finishes the job; when A wakes it changes nothing', async () => {
    const cas = fixture(25, 12);
    const p = await prepare('fence', cas);
    const job = await admit(p);
    let tookOver = false;
    const stall: Fault = async (point) => {
      if (point === 'read:staged' && !tookOver) {
        tookOver = true;
        // A is "stalled": its lease runs out and another slice (B) takes the job over and runs it to the end
        await expireLease(H, job.id);
        const { job: done } = await drive(job.id, p.userId, { budget: 0 });
        expect(done.status).toBe('completed');
      }
    };
    const a = await advanceStatementJob(job.id, { userId: p.userId, sliceBudgetMs: 0, fault: stall });
    expect(tookOver).toBe(true);
    // A woke up, tried to checkpoint and found the lease gone: the finished job is exactly as B left it
    const final = await getJobForUser(p.userId, job.id);
    expect(final!.status).toBe('completed');
    expect(final!.phase).toBe('done');
    expect(final!.progress_done).toBe(100);
    expect(a.kind === 'advanced' || a.kind === 'not_runnable' || a.kind === 'busy').toBe(true);
    const o = await oracle(H, p.userId);
    expect(o.economic).toMatchObject({ transactionsActive: 300, accounts: 13, holdingSnapshots: 25 });
    expect(o.bookkeeping).toMatchObject({ parseRuns: 1, parseRunsRunning: 0 });
    expect(final!.reclaim_count).toBeGreaterThanOrEqual(1);
  }, 600_000);
});

// ---------------------------------------------------------------------------------------------------------------------
describe('WP-J statement job: missing-transaction detection through the job', () => {
  it('a later statement that omits earlier lines opens ONE case per position and counts them; a kill in the middle changes nothing', async () => {
    const full = buildWpjLargeCas({ positions: 6, txnsPerPosition: 12, stamp: stampOf(), omitRefs: true });
    const stamp = full.positions[0].scheme.split(' ')[1];
    const shorter = buildWpjLargeCas({ positions: 6, txnsPerPosition: 8, stamp, omitRefs: true });
    for (const killPoint of [null, 'analyse:cases']) {
      const first = await newUser(db, `miss-${killPoint ?? 'c'}`);
      const doc1 = await seedStatement(H, first, statementPdf(full.lines, `full-${killPoint ?? 'c'}`), `full${killPoint ?? 'c'}`.replace(/\W/g, ''));
      expect((await runJob({ ...first, docId: doc1 })).job.status).toBe('completed');
      const doc2 = await seedStatement(H, first, statementPdf(shorter.lines, `short-${killPoint ?? 'c'}`), `short${killPoint ?? 'c'}`.replace(/\W/g, ''));
      const second: Prepared = { ...first, docId: doc2 };
      const r = killPoint ? await runWithKill(second, killPoint) : await runJob(second);
      expect(r.job.status, JSON.stringify(r.job.result_summary)).toBe('completed');
      const result = r.job.result_summary as { summary: { missingTransactionsCount: number; duplicateTransactionsLinked: number; newTransactionsCount: number } };
      expect(result.summary).toMatchObject({ missingTransactionsCount: 24, duplicateTransactionsLinked: 48, newTransactionsCount: 0 });
      const cases = Number((await db.query<{ n: string }>(`select count(*)::text n from ii_reconciliation_cases where user_id = $1 and discrepancy_type = 'transaction_missing_from_restatement'`, [first.userId])).rows[0].n);
      expect(cases, 'one case per position, never doubled').toBe(6);
    }
  }, 900_000);
});

// ---------------------------------------------------------------------------------------------------------------------
describe('WP-J statement job: the backstop and jobs nobody came back to', () => {
  it('the backstop leaves a job admitted moments ago to its browser (which brings the password) and takes it over once it is old', async () => {
    await db.query(`update ii_statement_jobs set status = 'completed', phase = 'done', lease_owner = null, lease_expires_at = null where status in ('queued', 'processing')`); // earlier tests' leftovers
    const cas = fixture(5, 6);
    const p = await prepare('grace', cas);
    const job = await admit(p);
    // a protected statement would fail here without its password, so the backstop must not touch a fresh read
    const fresh = await advanceNextStatementJob({ sliceBudgetMs: 0 });
    expect(fresh && fresh.kind).toBe('busy');
    const same = await getJobForUser(p.userId, job.id);
    expect(same).toMatchObject({ status: 'queued', phase: 'read' });
    expect((await oracle(H, p.userId)).bookkeeping.parseRuns, 'nothing was read').toBe(0);
    // the browser that admitted it still gets to run the read step at once
    const mine = await advanceStatementJob(job.id, { userId: p.userId, sliceBudgetMs: 0 });
    expect(mine.kind).toBe('advanced');
    expect((await drive(job.id, p.userId)).job.status).toBe('completed');
    // a job nobody drove for a few minutes is taken by the backstop
    const q = await prepare('grace-old', cas);
    const old = await admit(q);
    await db.query(`update ii_statement_jobs set created_at = now() - interval '5 minutes' where id = $1`, [old.id]);
    const taken = await advanceNextStatementJob({ sliceBudgetMs: 0 });
    expect(taken && taken.kind).toBe('advanced');
    expect((await oracle(H, q.userId)).bookkeeping.parseRuns).toBe(1);
  }, 600_000);

  it('a job idle for a day with no live lease is ended as abandoned: run closed as failed, staging removed; a young or live one is untouched', async () => {
    const cas = fixture(5, 6);
    await db.query(`update ii_statement_jobs set status = 'completed', phase = 'done', lease_owner = null, lease_expires_at = null where status in ('queued', 'processing')`);
    const idle = await prepare('abandon-idle', cas);
    const idleJob = await admit(idle);
    await advanceStatementJob(idleJob.id, { userId: idle.userId, sliceBudgetMs: 0 }); // read step: staging exists, a run exists
    expect(await stagingRows(H, idle.userId)).toBeGreaterThan(0);
    await db.query(`update ii_statement_jobs set updated_at = now() - interval '2 days', lease_expires_at = null where id = $1`, [idleJob.id]);
    const live = await prepare('abandon-live', cas);
    const liveJob = await admit(live);
    await advanceStatementJob(liveJob.id, { userId: live.userId, sliceBudgetMs: 0 });
    await db.query(`update ii_statement_jobs set updated_at = now() - interval '2 days', lease_owner = 'someone-live-1', lease_expires_at = now() + interval '1 minute' where id = $1`, [liveJob.id]);
    const young = await prepare('abandon-young', cas);
    const youngJob = await admit(young);

    expect(await abandonIdleStatementJobs()).toBe(1);
    const ended = await getJobForUser(idle.userId, idleJob.id);
    expect(ended).toMatchObject({ status: 'failed', error_code: 'abandoned' });
    expect(await stagingRows(H, idle.userId)).toBe(0);
    expect(await runningRuns(idle.userId), 'its run is closed, never left running').toBe(0);
    expect((await getJobForUser(live.userId, liveJob.id))!.status, 'a live lease is never ended').not.toBe('failed');
    expect((await getJobForUser(young.userId, youngJob.id))!.status).toBe('queued');
    // the statement can be processed again at once (the file is still stored: the read step never finished)
    const again = await admitStatementJob({ userId: idle.userId, documentId: idle.docId, kind: 'process', forceReparse: true });
    expect(again.kind).toBe('job');
  }, 600_000);
});

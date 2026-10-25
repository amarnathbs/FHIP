/**
 * Document2 (4) WP-J -- UNIT-TESTED pieces of the statement job that need no database: the staging round trip of a parsed statement
 * (exact bigints, the same account and fund keys as the one-request pipeline), the job model (states, liveness, progress, what a browser
 * may see), and the page driver (busy, dropped connections, the password only for the step that opens the file, plain end messages).
 */
import { describe, expect, it } from 'vitest';
import { buildWpjLargeCas } from '../support/buildWpjLargeCas';
import { parseExtractedDocument } from '@/lib/services/investment-intelligence/parsers/registry';
import { planFolioAccountResolution } from '@/lib/services/investment-intelligence/accountResolution';
import { createSchemeKeying } from '@/lib/services/investment-intelligence/schemeKeying';
import { deterministicUuid, fromPlain, makeResolveRowKey, mergeSchemeRecords, stageParsed, toPlain, unstageHold, unstageTxn, type StagedTxn } from '@/lib/services/investment-intelligence/statementStaging';
import {
  JOBLESS_RUN_DEAD_AFTER_MS,
  normaliseStatementIdempotencyKey,
  sanitiseStatementJobError,
  statementJobLiveness,
  statementJobProgress,
  statementJobStatusMessage,
  STATEMENT_JOB_STEP_ORDER,
  STATEMENT_JOB_STEP_WEIGHT,
  toStatementJobView,
  type StatementJobRow,
} from '@/lib/services/investment-intelligence/statementJob/model';
import { hydratePipelineState, initialPipelineState, pipelineProgress } from '@/lib/services/investment-intelligence/statementPipeline';
import {
  describeJobEnd,
  driveStatementJob,
  isUnansweredAsk,
  jobProgressPercent,
  JOB_MAX_CONSECUTIVE_NETWORK_FAILURES,
  type AdvanceAnswer,
  type StatementJobViewLike,
} from '@/components/investment-intelligence/statementJobDriver';

function parsedFixture(positions = 25, txns = 12) {
  const cas = buildWpjLargeCas({ positions, txnsPerPosition: txns, stamp: '424242', omitRefs: true });
  const { parsed } = parseExtractedDocument(cas.text);
  if (!parsed) throw new Error('fixture did not parse');
  return { cas, parsed };
}

describe('staging a parsed statement', () => {
  it('bigints survive the round trip bit for bit, including inside arrays and objects', () => {
    const value = { a: BigInt('12345678901234567890'), nested: { list: [BigInt(1), BigInt(2), { x: BigInt(-7) }], s: 'text', n: null, k: 3 } };
    const plain = JSON.parse(JSON.stringify(toPlain(value))); // exactly what a jsonb column stores
    expect(fromPlain(plain)).toEqual(value);
    expect(toPlain({ u: undefined, k: 1 })).toEqual({ k: 1 });
  });

  it('every staged transaction and holding comes back equal to what the parser produced', () => {
    const { parsed } = parsedFixture();
    const staged = stageParsed(parsed);
    const meta = fromPlain<typeof staged.meta>(JSON.parse(JSON.stringify(toPlain(staged.meta))));
    const txns = staged.txnBatches.flatMap((b) => fromPlain<StagedTxn[]>(JSON.parse(JSON.stringify(toPlain(b))))).map((t) => unstageTxn(t, meta.schemes));
    expect(txns).toEqual(parsed.transactions);
    const holds = staged.holdBatches.flatMap((b) => fromPlain<typeof b>(JSON.parse(JSON.stringify(toPlain(b))))).map((h) => unstageHold(h, meta.schemes));
    expect(holds).toEqual(parsed.holdings);
    expect(meta.txnCount).toBe(300);
    expect(meta.holdCount).toBe(25);
    expect(staged.txnBatches.length).toBe(2); // 200 + 100
  });

  it('batches are bounded (the table row stays small) and cover every line exactly once, in order', () => {
    const { parsed } = parsedFixture(60, 30);
    const staged = stageParsed(parsed);
    expect(staged.txnBatches.every((b) => b.length <= 200)).toBe(true);
    expect(staged.txnBatches.flat().length).toBe(1800);
    expect(JSON.stringify(toPlain(staged.txnBatches[0])).length).toBeLessThan(400_000);
  });

  it('the row-key rule rebuilt from the staged folio table equals the one the one-request pipeline used, for every line', () => {
    const { parsed } = parsedFixture(60, 4);
    const plan = planFolioAccountResolution({ accounts: parsed.accounts, transactions: parsed.transactions, holdings: parsed.holdings });
    const staged = stageParsed(parsed);
    const rebuilt = makeResolveRowKey(staged.meta.accAmcNameByFolio);
    for (const t of parsed.transactions) expect(rebuilt(t.folioNumber, t.scheme.amcName)).toBe(plan.resolveRowKey(t.folioNumber, t.scheme.amcName));
    for (const h of parsed.holdings) expect(rebuilt(h.folioNumber, h.scheme.amcName)).toBe(plan.resolveRowKey(h.folioNumber, h.scheme.amcName));
    expect(staged.meta.assignments).toEqual(plan.assignments);
  });

  it('the distinct scheme table gives the same fund keys and merged records as walking every line', () => {
    const { parsed } = parsedFixture(25, 6);
    // the one-request way: key every line's scheme, merge same keys
    const oldKeying = createSchemeKeying([...parsed.transactions.map((t) => t.scheme), ...parsed.holdings.map((h) => h.scheme)]);
    const oldUnique = new Map<string, (typeof parsed.transactions)[number]['scheme']>();
    for (const t of parsed.transactions) {
      const k = oldKeying.keyOf(t.scheme);
      const e = oldUnique.get(k);
      oldUnique.set(k, e ? mergeSchemeRecords(e, t.scheme) : t.scheme);
    }
    for (const h of parsed.holdings) {
      const k = oldKeying.keyOf(h.scheme);
      const e = oldUnique.get(k);
      oldUnique.set(k, e ? mergeSchemeRecords(e, h.scheme) : h.scheme);
    }
    const staged = stageParsed(parsed);
    const newKeying = createSchemeKeying(staged.meta.schemes);
    const newUnique = new Map<string, (typeof staged.meta.schemes)[number]>();
    for (const s of staged.meta.schemes) {
      const k = newKeying.keyOf(s);
      const e = newUnique.get(k);
      newUnique.set(k, e ? mergeSchemeRecords(e, s) : s);
    }
    expect([...newUnique.entries()]).toEqual([...oldUnique.entries()]);
    expect(staged.meta.schemes.length).toBe(25);
  });

  it('derived ids are stable for the same inputs and differ for different ones (a replayed step writes the same row)', () => {
    expect(deterministicUuid('ii-txn', 'run', 'acct', 'fp')).toBe(deterministicUuid('ii-txn', 'run', 'acct', 'fp'));
    expect(deterministicUuid('ii-txn', 'run', 'acct', 'fp')).not.toBe(deterministicUuid('ii-txn', 'run2', 'acct', 'fp'));
    expect(deterministicUuid('a', 'b')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

const baseJob = (over: Partial<StatementJobRow> = {}): StatementJobRow => ({
  id: 'job-1',
  user_id: 'user-1',
  source_document_id: 'doc-1',
  job_kind: 'process',
  idempotency_key: 'key-0001',
  status: 'queued',
  phase: 'read',
  review_reason: null,
  checkpoint: { v: 1, secret: 'internal' },
  progress_done: 0,
  progress_total: 100,
  attempt: 1,
  consecutive_failures: 0,
  slice_count: 0,
  reclaim_count: 0,
  lease_owner: 'lease-token-abcdef',
  lease_expires_at: null,
  heartbeat_at: null,
  last_slice_at: null,
  error_code: null,
  error_message_sanitised: null,
  result_summary: null,
  started_at: null,
  completed_at: null,
  created_at: '2026-10-25T10:00:00.000Z',
  updated_at: '2026-10-25T10:00:00.000Z',
  ...over,
});

describe('the job model', () => {
  it('a browser sees no lease token, no checkpoint, no owner', () => {
    const view = toStatementJobView(baseJob({ status: 'processing', phase: 'transactions', progress_done: 40 }));
    const text = JSON.stringify(view);
    expect(text).not.toContain('lease-token-abcdef');
    expect(text).not.toContain('internal');
    expect(text).not.toContain('user-1');
    expect(Object.keys(view)).not.toContain('checkpoint');
    expect(view.keep_polling).toBe(true);
    expect(view.password_step).toBe(false);
  });

  it('only the step that opens the file asks for the password', () => {
    expect(toStatementJobView(baseJob({ status: 'queued', phase: 'read' })).password_step).toBe(true);
    expect(toStatementJobView(baseJob({ status: 'processing', phase: 'schemes' })).password_step).toBe(false);
    expect(toStatementJobView(baseJob({ status: 'completed', phase: 'done' })).password_step).toBe(false);
    expect(toStatementJobView(baseJob({ job_kind: 'reevaluate', phase: 'certify' })).password_step).toBe(false);
  });

  it('liveness: working while a lease is live, stalled when it ran out, idle when never claimed, finished or waiting for a person otherwise', () => {
    const now = Date.parse('2026-10-25T10:00:00Z');
    expect(statementJobLiveness(baseJob({ status: 'processing', lease_expires_at: '2026-10-25T10:00:30Z', slice_count: 1 }), now)).toBe('working');
    expect(statementJobLiveness(baseJob({ status: 'processing', lease_expires_at: '2026-10-25T09:59:00Z', slice_count: 1 }), now)).toBe('stalled');
    expect(statementJobLiveness(baseJob({ status: 'queued' }), now)).toBe('idle');
    expect(statementJobLiveness(baseJob({ status: 'completed' }), now)).toBe('finished');
    expect(statementJobLiveness(baseJob({ status: 'review_required', review_reason: 'password' }), now)).toBe('waiting_for_person');
  });

  it('progress only moves forward through the steps and stays within 0..100', () => {
    expect(Object.values(STATEMENT_JOB_STEP_WEIGHT).reduce((a, b) => a + b, 0)).toBe(100);
    let last = -1;
    for (const step of STATEMENT_JOB_STEP_ORDER) {
      for (const f of [0, 0.5, 1]) {
        const p = statementJobProgress(step, f).done;
        expect(p).toBeGreaterThanOrEqual(last);
        expect(p).toBeLessThanOrEqual(100);
        last = p;
      }
    }
    expect(statementJobProgress('done').done).toBe(100);
    const s = initialPipelineState('process', false);
    s.step = 'transactions';
    s.counts.txnBatches = 10;
    s.cursors.txnBatch = 5;
    const mid = pipelineProgress(s).done;
    s.cursors.txnBatch = 9;
    expect(pipelineProgress(s).done).toBeGreaterThan(mid);
  });

  it('every in-progress message is honest and says the page can be left; none is a bare spinner', () => {
    for (const phase of ['accounts', 'owner', 'schemes', 'transactions', 'holdings', 'analyse', 'certify'] as const) {
      const msg = statementJobStatusMessage({ status: 'processing', phase, review_reason: null, job_kind: 'process', progress_done: 10 });
      expect(msg, phase).toMatch(/Still working: this large statement is processed in steps\. You can leave this page; it continues\./);
    }
    expect(statementJobStatusMessage({ status: 'failed', phase: 'read', review_reason: null, job_kind: 'process', progress_done: 0 })).toBe('This statement could not be processed.');
    expect(statementJobStatusMessage({ status: 'review_required', phase: 'read', review_reason: 'password', job_kind: 'process', progress_done: 0 })).toMatch(/password-protected/);
  });

  it('an old checkpoint is read back into a complete state; garbage falls back to a fresh one', () => {
    const fresh = initialPipelineState('process', true);
    expect(hydratePipelineState(null, 'process', true)).toEqual(fresh);
    expect(hydratePipelineState({ v: 2 }, 'process', true)).toEqual(fresh);
    const partial = hydratePipelineState({ v: 1, step: 'schemes', cursors: { accounts: 4 } }, 'process', false);
    expect(partial.step).toBe('schemes');
    expect(partial.cursors).toMatchObject({ accounts: 4, schemes: 0, txnBatch: 0 });
    expect(partial.counters).toEqual({ casesOpened: 0, duplicateLinked: 0, missing: 0, matchedToExisting: 0 });
  });

  it('error text is bounded and carries no long digit runs; the idempotency key is validated', () => {
    expect(sanitiseStatementJobError('x'.repeat(900)).length).toBeLessThanOrEqual(300);
    expect(sanitiseStatementJobError('account 123456789012 failed')).toBe('account [number] failed');
    expect(normaliseStatementIdempotencyKey('short')).toBeNull();
    expect(normaliseStatementIdempotencyKey('client-key-0001')).toBe('client-key-0001');
    expect(normaliseStatementIdempotencyKey('bad key with spaces')).toBeNull();
    expect(JOBLESS_RUN_DEAD_AFTER_MS).toBe(120_000);
  });
});

const view = (over: Partial<StatementJobViewLike> = {}): StatementJobViewLike => ({
  job_id: 'j',
  document_id: 'd',
  job_kind: 'process',
  status: 'processing',
  phase: 'transactions',
  review_reason: null,
  progress_done: 40,
  progress_total: 100,
  message: 'm',
  error_code: null,
  error_message: null,
  result: null,
  keep_polling: true,
  password_step: false,
  ...over,
});
const answer = (v: StatementJobViewLike, extra: { busy?: boolean } = {}): AdvanceAnswer => ({ ok: true, status: 200, json: { data: { job: v, ...extra } } });

describe('the page driver', () => {
  const noWait = async () => undefined;

  it('keeps asking until the job completes; passes the password only while the job is at the step that opens the file', async () => {
    const sent: boolean[] = [];
    const script = [view({ phase: 'read', password_step: true }), view({ phase: 'schemes', password_step: false }), view({ phase: 'certify' }), view({ status: 'completed', phase: 'done', keep_polling: false })];
    let i = 0;
    const out = await driveStatementJob({
      jobId: 'j',
      advance: async (_id, o) => {
        sent.push(o.sendPassword);
        return answer(script[i++]);
      },
      wait: noWait,
    });
    expect(out.outcome).toBe('completed');
    // first ask: no state yet, send it; then only while the last state said password_step
    expect(sent).toEqual([true, true, false, false]);
  });

  it('waits when another worker holds the lease and keeps going when the connection drops; gives up honestly after too many dropped asks', async () => {
    const waits: number[] = [];
    let n = 0;
    const out = await driveStatementJob({
      jobId: 'j',
      advance: async () => {
        n += 1;
        if (n === 1) return answer(view(), { busy: true });
        if (n === 2) return { ok: false, status: 0, json: null };
        if (n === 3) return { ok: false, status: 504, json: {} };
        return answer(view({ status: 'completed', keep_polling: false, phase: 'done' }));
      },
      wait: async (ms) => void waits.push(ms),
    });
    expect(out.outcome).toBe('completed');
    expect(waits[0]).toBe(3000); // busy
    expect(waits.slice(1, 3)).toEqual([4000, 4000]); // dropped asks
    const gave = await driveStatementJob({ jobId: 'j', advance: async () => ({ ok: false, status: 0, json: null }), wait: noWait });
    expect(gave.outcome).toBe('gave_up');
    expect(JOB_MAX_CONSECUTIVE_NETWORK_FAILURES).toBeGreaterThan(1);
  });

  it('a refusal (not yours / signed out) stops at once; a person-needed state and a failure are handed back', async () => {
    expect((await driveStatementJob({ jobId: 'j', advance: async () => ({ ok: false, status: 404, json: { error: 'not found' } }), wait: noWait })).outcome).toBe('failed');
    expect((await driveStatementJob({ jobId: 'j', advance: async () => answer(view({ status: 'review_required', review_reason: 'password', keep_polling: false })), wait: noWait })).outcome).toBe('needs_person');
    expect((await driveStatementJob({ jobId: 'j', advance: async () => answer(view({ status: 'failed', keep_polling: false, error_message: 'No' })), wait: noWait })).outcome).toBe('failed');
  });

  it('cancelling (the page was left) stops without calling the server again', async () => {
    let calls = 0;
    const out = await driveStatementJob({ jobId: 'j', advance: async () => (calls++, answer(view())), wait: noWait, isCancelled: () => calls >= 2 });
    expect(out.outcome).toBe('cancelled');
    expect(calls).toBe(2);
  });

  it('classifies unanswered asks, percentages and end messages', () => {
    expect(isUnansweredAsk({ ok: false, status: 0, json: null })).toBe(true);
    expect(isUnansweredAsk({ ok: false, status: 500, json: {} })).toBe(true);
    expect(isUnansweredAsk({ ok: false, status: 404, json: { error: 'x' } })).toBe(false);
    expect(jobProgressPercent(view({ progress_done: 40, progress_total: 100 }))).toBe(40);
    expect(jobProgressPercent(view({ progress_total: null }))).toBeNull();
    expect(jobProgressPercent(view({ status: 'completed' }))).toBe(100);
    const done = describeJobEnd('completed', view({ status: 'completed', result: { summary: { transactionsFound: 300, holdingsFound: 25, reconciliationCasesOpened: 0, newTransactionsCount: 0, duplicateTransactionsLinked: 300 } } }));
    expect(done).toEqual({ ok: true, text: 'Done. 300 transactions and 25 holdings read; nothing was added twice. Review is ready.' });
    expect(describeJobEnd('completed', view({ status: 'completed', result: { summary: { transactionsFound: 3, holdingsFound: 1, reconciliationCasesOpened: 2 } } })).text).toMatch(/2 items need your review/);
    expect(describeJobEnd('completed', view({ status: 'completed', job_kind: 'reevaluate', result: { reevaluated: { evaluated: 60, failed: 0 } } })).text).toBe('Re-evaluated 60 positions from the retained data.');
    expect(describeJobEnd('needs_person', view({ status: 'review_required', review_reason: 'password' })).text).toMatch(/password was missing or wrong/);
    expect(describeJobEnd('gave_up', null).text).toMatch(/keeps going in the background/);
    expect(describeJobEnd('failed', view({ status: 'failed', error_message: 'Plain reason.' }))).toEqual({ ok: false, text: 'Plain reason.' });
  });
});

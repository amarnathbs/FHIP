/**
 * FDH-10 — zero-amount statement lines and the atomic statement persist
 * (2026-09-25).
 *
 * THE DEFECT, AS OBSERVED LIVE IN DEV. `POST /liability-statement/{id}/process`
 * on `tests/fixtures/financial-data-hub/fdh14-smoke-liability-cc.csv` (whose
 * first line is `2026-07-01,FDH14 SMOKE OPENING,0.00,PURCHASE`) returned 500
 * with `new row for relation "fdh_liability_statement_activities" violates
 * check constraint "fdh_liability_statement_activities_amount_check"`. A
 * `fdh_liability_statements` row had already been committed with zero
 * activities, and the document stayed `queued`.
 *
 * HOW THIS FILE MODELS THE DATABASE. `FakeDb` below is an in-memory stand-in
 * for exactly the two write semantics that matter here:
 *   - `.from(table).insert(...)` commits PER CALL, as each PostgREST request is
 *     its own transaction — the semantics that produced the orphan;
 *   - `.rpc('fdh10_persist_liability_statement', ...)` is ALL-OR-NOTHING, as a
 *     PL/pgSQL function body runs inside the one transaction PostgREST opens
 *     for the call (migration 0208).
 * Both enforce 0096's `CHECK (amount > 0)` with the exact message DEV
 * returned. The "fake is not vacuous" block proves both properties directly,
 * so a green run elsewhere cannot come from a fake that never rejects. The
 * per-call UPDATE path also enforces migration 0076's document transition
 * guard, which is what exposed the second defect: the old code's direct
 * `queued -> extracted` UPDATE was refused, its error was ignored, and every
 * successfully persisted statement left its document `queued`.
 *
 * Everything else on the request path is the REAL code: the route handler,
 * `extractLiabilityStatement` (detection + CSV extraction) on the real fixture
 * bytes, `statementReconciliation.ts` and `bankMatching.ts`.
 *
 * NEGATIVE CONTROL (recorded in the commit message and run by hand, not in
 * CI): running this file against the pre-fix `csvExtraction.ts`,
 * `mapping.ts` and `liabilityStatementProcessingService.ts` from `origin/main`
 * fails the named tests below — the route returns 500 and leaves one
 * statement row with zero activities, i.e. it reproduces the DEV incident.
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;

/** The subset of migration 0076's `trg_fdh7_guard_document_processing_status`
 * edges this path touches. `queued -> extracted` is deliberately absent — it
 * is absent from the real trigger too. */
const LEGAL_DOCUMENT_EDGES: Record<string, string[]> = {
  queued: ['processing', 'failed', 'rejected'],
  processing: ['extracted', 'review_required', 'failed', 'rejected'],
};

const AMOUNT_CHECK_MESSAGE =
  'new row for relation "fdh_liability_statement_activities" violates check constraint "fdh_liability_statement_activities_amount_check"';

class FakeDb {
  uploads = new Map<string, Row>();
  statements: Row[] = [];
  activities: Row[] = [];
  rpcCalls: string[] = [];
  /** Fault injection: reject the activity whose source_row_number is this
   * value, the way an unrelated trigger (0108's country gate, 0096's owner
   * trigger) could — proves atomicity is not specific to the zero case. */
  failActivitySourceRow: number | null = null;
  private seq = 0;

  nextId(prefix: string) {
    this.seq += 1;
    return `${prefix}-${this.seq}`;
  }

  activityError(row: Row): string | null {
    if (!(Number(row.amount) > 0)) return AMOUNT_CHECK_MESSAGE;
    if (this.failActivitySourceRow !== null && row.source_row_number === this.failActivitySourceRow) {
      return 'simulated trigger failure on fdh_liability_statement_activities';
    }
    return null;
  }

  /** Migration 0208's `fdh10_persist_liability_statement`, same contract. */
  persistRpc(userId: string, args: { p_statement_upload_id: string; p_statement: Row; p_activities: Row[] }) {
    const upload = this.uploads.get(args.p_statement_upload_id);
    if (!upload || upload.user_id !== userId) {
      return { data: { ok: false, code: 'DOCUMENT_NOT_FOUND', error: 'document not found' }, error: null };
    }
    if (upload.processing_status !== 'queued') {
      return { data: { ok: false, code: 'INVALID_STATE', error: `cannot persist while the document is ${upload.processing_status}` }, error: null };
    }
    const existing = this.statements.find((s) => s.statement_upload_id === args.p_statement_upload_id && s.user_id === userId);
    if (existing) {
      return { data: { ok: false, code: 'EVIDENCE_EXISTS', error: 'statement evidence already exists for this document', statement_id: existing.id }, error: null };
    }
    // Staged, then committed only if every row passes: a raise anywhere in
    // the function body rolls back the whole call.
    const statementId = this.nextId('stmt');
    const staged = args.p_activities.map((a) => ({ ...a, id: this.nextId('act'), user_id: userId, statement_id: statementId }));
    for (const a of staged) {
      const err = this.activityError(a);
      if (err) return { data: null, error: { message: err } };
    }
    this.statements.push({ ...args.p_statement, id: statementId, user_id: userId, statement_upload_id: args.p_statement_upload_id });
    this.activities.push(...staged);
    // queued -> processing -> extracted, the two legal 0076 edges.
    upload.processing_status = 'extracted';
    upload.error_code = null;
    upload.processing_completed_at = 'now';
    return { data: { ok: true, statement_id: statementId, activity_count: staged.length }, error: null };
  }

  client(userId: string) {
    return {
      rpc: async (name: string, args: Record<string, unknown>) => {
        this.rpcCalls.push(name);
        if (name !== 'fdh10_persist_liability_statement') {
          return { data: null, error: { message: `Could not find the function public.${name}` } };
        }
        return this.persistRpc(userId, args as never);
      },
      from: (table: string) => new FakeQuery(this, table),
    };
  }
}

/** Per-call-commit query builder covering exactly the chains the service
 * uses (and the chains the PRE-FIX service used, so the negative control
 * exercises the real old code rather than crashing on a missing method). */
class FakeQuery implements PromiseLike<{ data: unknown; error: { message: string } | null }> {
  private op: 'select' | 'insert' | 'update' = 'select';
  private payload: Row | null = null;
  private filters: Array<[string, unknown]> = [];
  constructor(private db: FakeDb, private table: string) {}

  select() { return this; }
  insert(payload: Row) { this.op = 'insert'; this.payload = payload; return this; }
  update(payload: Row) { this.op = 'update'; this.payload = payload; return this; }
  eq(col: string, val: unknown) { this.filters.push([col, val]); return this; }
  gte() { return this; }
  lte() { return this; }
  limit() { return this; }
  order() { return this; }
  // WP-10 (G4): the candidate read now pages (fetchAllRows) and excludes
  // debits already matched to another activity (`.in`).
  in() { return this; }
  range() { return Promise.resolve(this.run()); }
  single() { return Promise.resolve(this.run()).then((r) => ({ ...r, data: Array.isArray(r.data) ? r.data[0] ?? null : r.data })); }
  maybeSingle() { return this.single(); }
  then<A, B>(onF?: ((v: { data: unknown; error: { message: string } | null }) => A | PromiseLike<A>) | null, onR?: ((e: unknown) => B | PromiseLike<B>) | null) {
    return Promise.resolve(this.run()).then(onF, onR);
  }

  private matches(row: Row) { return this.filters.every(([c, v]) => row[c] === v); }

  private run(): { data: unknown; error: { message: string } | null } {
    const { db, table } = this;
    if (this.op === 'insert') {
      if (table === 'fdh_liability_statements') {
        const row = { ...this.payload!, id: db.nextId('stmt') };
        db.statements.push(row);
        return { data: { id: row.id }, error: null };
      }
      if (table === 'fdh_liability_statement_activities') {
        const err = db.activityError(this.payload!);
        if (err) return { data: null, error: { message: err } };
        db.activities.push({ ...this.payload!, id: db.nextId('act') });
        return { data: null, error: null };
      }
      return { data: null, error: null };
    }
    if (this.op === 'update') {
      if (table === 'fdh_statement_uploads') {
        for (const u of db.uploads.values()) {
          if (!this.matches(u)) continue;
          const to = this.payload!.processing_status as string | undefined;
          const from = u.processing_status as string;
          if (to && to !== from && !(LEGAL_DOCUMENT_EDGES[from] ?? []).includes(to)) {
            return { data: null, error: { message: `fdh_statement_uploads: processing_status transition ${from} -> ${to} is not permitted` } };
          }
          Object.assign(u, this.payload);
        }
      }
      return { data: null, error: null };
    }
    if (table === 'fdh_liability_statements') return { data: db.statements.filter((s) => this.matches(s)), error: null };
    return { data: [], error: null }; // fdh_transactions: no bank candidates
  }
}

const USER = 'user-1';
let db = new FakeDb();
const auditEvents: string[] = [];
const FIXTURE_BYTES = new Uint8Array(
  fs.readFileSync(path.join(process.cwd(), 'tests', 'fixtures', 'financial-data-hub', 'fdh14-smoke-liability-cc.csv')),
);

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(async () => db.client(USER)) }));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  requireCountryConfirmedUser: vi.fn(async () => ({ user: { id: USER }, unauthenticated: null })),
}));
vi.mock('@/lib/financial-data-hub/constants/featureFlags', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/financial-data-hub/constants/featureFlags')>()),
  isFdhDocumentUploadEnabled: () => true,
}));
vi.mock('@/lib/financial-data-hub/repositories', () => ({
  statementUploadsRepository: {
    getForUser: vi.fn(async (userId: string, id: string) => {
      const u = db.uploads.get(id);
      return { data: u && u.user_id === userId ? { ...u } : null, error: null };
    }),
  },
}));
vi.mock('@/lib/financial-data-hub/services/storage', () => ({
  downloadDocumentObject: vi.fn(async () => ({ ok: true, bytes: FIXTURE_BYTES })),
}));
vi.mock('@/lib/financial-data-hub/services/auditLog', () => ({
  recordDocumentAuditEvent: vi.fn(async (e: { eventType: string }) => { auditEvents.push(e.eventType); }),
}));
// Forward-port note (WP-10, 2026-09-27): since 24281b8 was written, main added
// the shared identical-upload rule, the durable AI-draft store and the pilot
// cohort lookup to this path (each reads through the service-role client).
// None is what this suite tests, so each answers "nothing earlier / no draft",
// exactly as tests/unit/fdh3AsyncMalwareScanResume.test.ts does.
vi.mock('@/lib/financial-data-hub/services/identicalUpload', () => ({
  findEarlierIdenticalUpload: async () => null,
  IDENTICAL_UPLOAD_SPECS: { liability: {} },
}));
vi.mock('@/lib/financial-data-hub/services/aiFallbackDrafts', () => ({
  loadPendingAiFallbackDraft: async () => ({ found: false, reason: 'none_pending' }),
  saveAiFallbackDraft: async () => ({ persisted: false, reason: 'table_missing' }),
  claimPendingAiFallbackDraft: async () => ({ claimed: false, reason: 'table_missing' }),
  releaseClaimedAiFallbackDraftIfNothingWritten: vi.fn(async () => ({ released: true })),
}));
vi.mock('@/lib/aie/pilotCohortEmail', () => ({ resolveEmailForAiePilotCohort: async () => null }));

import { POST as processRoute } from '@/app/api/financial-data-hub/liability-statement/[documentId]/process/route';
import {
  assertPersistableLiabilityActivities,
  confirmAiLiabilityFallback,
  persistLiabilityStatementEvidence,
  LiabilityStatementProcessingError,
} from '@/lib/financial-data-hub/services/liabilityStatementProcessingService';
import { extractLiabilityStatement } from '@/lib/financial-data-hub/liability/statementIntake';
import { mapLiabilityStatementFactsToDraft } from '@/lib/aie/adapters/liability';
import type { LiabilityStatementActivity } from '@/lib/financial-data-hub/liability/types';
import type { FdhStatementUpload } from '@/lib/financial-data-hub/domain/types';

const CARD_METADATA_BODY = { statement_type: 'credit_card', country_code: 'AU', currency_code: 'AUD' };
const CARD_METADATA = { statementType: 'credit_card' as const, countryCode: 'AU' as const, currencyCode: 'AUD' };

function seedUpload(id = 'doc-1', overrides: Row = {}) {
  db.uploads.set(id, {
    id,
    user_id: USER,
    processing_status: 'queued',
    error_code: null,
    duplicate_of_document_id: null,
    raw_document_storage_reference: `${USER}/${id}/${id}.bin`,
    mime_type: 'text/csv',
    ...overrides,
  });
}

async function callProcess(documentId = 'doc-1') {
  const res = await processRoute(
    new Request(`http://localhost/api/financial-data-hub/liability-statement/${documentId}/process`, {
      method: 'POST',
      body: JSON.stringify(CARD_METADATA_BODY),
      headers: { 'content-type': 'application/json' },
    }),
    { params: Promise.resolve({ documentId }) },
  );
  const json = (await res.json()) as { data?: Record<string, unknown>; error?: string };
  // `ok()` wraps its payload as `{ data }`; `bad()` returns `{ error }`.
  return { status: res.status, body: { ...(json.data ?? {}), error: json.error } as Record<string, unknown> };
}

const activity = (overrides: Partial<LiabilityStatementActivity> = {}): LiabilityStatementActivity => ({
  activityType: 'PURCHASE',
  activityDate: '2026-07-05',
  amount: 85.4,
  sourceRowNumber: 1,
  ...overrides,
});

beforeEach(() => {
  db = new FakeDb();
  auditEvents.length = 0;
});

describe('the fake database is not vacuous (it rejects what DEV rejected)', () => {
  it('per-call inserts reproduce the DEV orphan: the statement commits, the zero activity fails with the exact CHECK message', async () => {
    const client = db.client(USER);
    const stmt = await client.from('fdh_liability_statements').insert({ user_id: USER, statement_upload_id: 'doc-1' }).select().single();
    expect(stmt.error).toBeNull();
    const act = await client.from('fdh_liability_statement_activities').insert({ amount: 0, source_row_number: 1 });
    expect(act.error?.message).toBe(AMOUNT_CHECK_MESSAGE);
    expect(db.statements).toHaveLength(1);
    expect(db.activities).toHaveLength(0);
  });

  it('per-call updates enforce the 0076 guard: queued -> extracted is refused and the document stays queued', async () => {
    seedUpload();
    const r = await db.client(USER).from('fdh_statement_uploads').update({ processing_status: 'extracted' }).eq('id', 'doc-1').eq('user_id', USER);
    expect(r.error?.message).toMatch(/queued -> extracted is not permitted/);
    expect(db.uploads.get('doc-1')!.processing_status).toBe('queued');
  });

  it('the RPC with a zero activity fails with the exact CHECK message and commits nothing', async () => {
    seedUpload();
    const r = await db.client(USER).rpc('fdh10_persist_liability_statement', {
      p_statement_upload_id: 'doc-1',
      p_statement: {},
      p_activities: [{ amount: 10, source_row_number: 1 }, { amount: 0, source_row_number: 2 }],
    });
    expect(r.error?.message).toBe(AMOUNT_CHECK_MESSAGE);
    expect(db.statements).toHaveLength(0);
    expect(db.activities).toHaveLength(0);
    expect(db.uploads.get('doc-1')!.processing_status).toBe('queued');
  });
});

describe('zero-amount lines: excluded at extraction with a recorded warning', () => {
  it('[NC] the real fdh14 smoke fixture extracts its two money lines and records the zero line as row_1_zero_amount', () => {
    const result = extractLiabilityStatement({ bytes: FIXTURE_BYTES, statementType: 'credit_card', country: 'AU', currencyCode: 'AUD' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { activities, warnings } = result.extraction;
    expect(activities.map((a) => [a.activityType, a.amount])).toEqual([['PURCHASE', 85.4], ['PAYMENT', 200]]);
    expect(activities.every((a) => a.amount > 0)).toBe(true);
    expect(warnings).toContain('row_1_zero_amount');
  });

  it('[NC] the AI-fallback mapper drops a zero-amount line with ai_activity_N_zero_amount, and never reads a blank amount as zero', () => {
    const line = (amount: string | null) => ({
      activityType: 'PURCHASE', activityDate: '2026-07-05', amount,
      descriptionRaw: 'X', merchantRaw: null, principalComponent: null, interestComponent: null, feeComponent: null,
    });
    const absent = { value: null };
    const mapped = mapLiabilityStatementFactsToDraft({
      institutionName: absent, maskedIdentifier: absent,
      statementPeriodStart: absent, statementPeriodEnd: absent, statementDate: absent, dueDate: absent,
      openingBalance: absent, closingBalance: absent, creditLimit: absent, minimumPayment: absent, interestRate: absent,
      allActivitiesListed: true, documentMissingReasonCode: null,
      activities: [line('0.00'), line(''), line('12.50')],
    } as never);
    expect(mapped).not.toBeNull();
    expect(mapped!.activities.map((a) => a.amount)).toEqual([12.5]);
    expect(mapped!.warnings).toContain('ai_activity_1_zero_amount');
    expect(mapped!.warnings).toContain('ai_activity_2_unreadable_amount');
  });
});

describe('POST /liability-statement/{id}/process on the zero-line fixture', () => {
  it('[NC] returns 200 ok (was 500), writes one statement with two activities, moves the document to extracted', async () => {
    seedUpload();
    const { status, body } = await callProcess();
    expect(status).toBe(200);
    expect(body.pipeline_status).toBe('ok');
    expect(db.statements).toHaveLength(1);
    expect(body.statement_id).toBe(db.statements[0].id);
    expect(db.activities.map((a) => a.amount)).toEqual([85.4, 200]);
    expect(db.activities.every((a) => a.statement_id === db.statements[0].id)).toBe(true);
    // The warning is what sends the statement to review rather than letting
    // the exclusion pass unnoticed.
    expect(db.statements[0].review_status).toBe('pending');
    // Pre-fix, this stayed `queued`: the direct `queued -> extracted` UPDATE
    // was refused by 0076's guard and its error ignored (DEV upload 33f47e18).
    expect(db.uploads.get('doc-1')!.processing_status).toBe('extracted');
    expect(db.uploads.get('doc-1')!.processing_completed_at).toBeTruthy();
    expect(auditEvents).toContain('liability_statement_extraction_completed');
  });

  it('[NC] a failure on ANY activity row leaves no statement row, no activity rows, and the document retryable', async () => {
    seedUpload();
    db.failActivitySourceRow = 3; // the PAYMENT line, the last one written
    const { status } = await callProcess();
    expect(status).toBe(500);
    expect(db.statements).toHaveLength(0);
    expect(db.activities).toHaveLength(0);
    expect(db.uploads.get('doc-1')!.processing_status).toBe('queued');
    expect(auditEvents).not.toContain('liability_statement_extraction_completed');

    // ...and because nothing was left behind, the retry is clean.
    db.failActivitySourceRow = null;
    const retry = await callProcess();
    expect(retry.status).toBe(200);
    expect(db.statements).toHaveLength(1);
    expect(db.activities).toHaveLength(2);
  });

  it('[NC] a document that already has statement evidence (the DEV orphan) is refused with 409, never a second statement row', async () => {
    seedUpload();
    db.statements.push({ id: 'orphan-1', user_id: USER, statement_upload_id: 'doc-1' });
    const { status, body } = await callProcess();
    expect(status).toBe(409);
    expect(body.error).toBe('Evidence has already been saved for this statement.');
    expect(db.statements.map((s) => s.id)).toEqual(['orphan-1']);
    expect(db.activities).toHaveLength(0);
  });
});

describe('persistLiabilityStatementEvidence refuses unpersistable activities before any write', () => {
  const persist = (activities: LiabilityStatementActivity[]) =>
    persistLiabilityStatementEvidence(USER, { id: 'doc-1' } as FdhStatementUpload, activities, CARD_METADATA, [], 'p', '1', 0.9, 'credit_card');

  it.each([
    ['a zero amount', activity({ amount: 0, sourceRowNumber: 4 }), /line 4 has no positive amount/],
    ['a sub-cent amount that rounds to zero at numeric(20,4)', activity({ amount: 0.00001 }), /no positive amount/],
    ['a non-finite amount', activity({ amount: Number.NaN }), /no positive amount/],
    ['a negative component', activity({ activityType: 'PAYMENT', amount: 100, interestComponent: -1 }), /invalid repayment split/],
    ['a split larger than the amount', activity({ activityType: 'PAYMENT', amount: 100, principalComponent: 90, interestComponent: 20 }), /split larger than its amount/],
  ])('[NC] %s -> invalid_state, zero RPC calls, zero rows', async (_label, bad, message) => {
    seedUpload();
    const err = await persist([activity(), bad]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LiabilityStatementProcessingError);
    expect((err as LiabilityStatementProcessingError).code).toBe('invalid_state');
    expect((err as Error).message).toMatch(message);
    expect(db.rpcCalls).toHaveLength(0);
    expect(db.statements).toHaveLength(0);
  });

  it('accepts a valid decomposed repayment exactly at its amount', () => {
    expect(() => assertPersistableLiabilityActivities([
      activity({ activityType: 'PAYMENT', amount: 2000, principalComponent: 1550, interestComponent: 430, feeComponent: 20 }),
    ])).not.toThrow();
  });

  it('[NC] the AI-fallback confirm path is covered by the same guard (a reviewed zero line never reaches the database)', async () => {
    seedUpload();
    const err = await confirmAiLiabilityFallback(USER, 'doc-1', {
      metadata: CARD_METADATA,
      facilityType: 'credit_card',
      activities: [activity(), activity({ amount: 0, sourceRowNumber: 2 })],
    }).catch((e: unknown) => e);
    expect((err as LiabilityStatementProcessingError).code).toBe('invalid_state');
    expect(db.rpcCalls).toHaveLength(0);
    expect(db.statements).toHaveLength(0);
  });
});

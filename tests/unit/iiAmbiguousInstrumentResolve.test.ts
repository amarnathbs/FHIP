// Document2 final non-benchmark closure #3 (2026-09-30) —
// POST /api/investment-intelligence/reconciliation-cases/[id]/resolve-instrument.
//
// 'ambiguous_instrument' previously had NO real resolution path (confirmed
// by the prior mission: Acknowledge/Dismiss only, disclosed as a genuine
// gap). This route is the fix: a candidate-restricted instrument choice that
// resolves the case and immediately reprocesses the originating source
// document so the correction takes effect without a second, separate action.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createInMemoryDb, type Row } from './support/inMemorySupabase';
import { countryRegistryFrom } from './support/countryRegistryFake';

const mockGetUser = vi.fn();
const mockUserFrom = vi.fn();
const mockAdminFrom = vi.fn();
const { processSourceDocumentMock } = vi.hoisted(() => ({ processSourceDocumentMock: vi.fn() }));

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: mockGetUser }, from: mockUserFrom }) }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ from: mockAdminFrom }) }));
vi.mock('@/lib/services/investment-intelligence/documentProcessing', () => ({ processSourceDocument: processSourceDocumentMock }));
vi.mock('@/lib/services/investment-intelligence/audit', () => ({ emitAuditEvent: vi.fn().mockResolvedValue(undefined) }));

import { POST } from '@/app/api/investment-intelligence/reconciliation-cases/[id]/resolve-instrument/route';

const USER_ID = 'user-1';
const CASE_ID = 'case-1';
const DOC_ID = 'doc-1';
const CANDIDATE_A = '11111111-1111-1111-1111-111111111111';
const CANDIDATE_B = '22222222-2222-2222-2222-222222222222';
const OUTSIDER = '99999999-9999-9999-9999-999999999999';

function seed(overrides: Partial<Row> = {}) {
  const db = createInMemoryDb();
  db.reset({
    user_profiles: [{ user_id: USER_ID, country_of_residence: 'AU', country_confirmed_at: '2026-08-29T00:00:00Z', country_source: 'USER_CONFIRMED', onboarding_completed: true }],
    ii_reconciliation_cases: [
      {
        id: CASE_ID,
        user_id: USER_ID,
        status: 'open',
        discrepancy_type: 'ambiguous_instrument',
        subject_id: DOC_ID,
        discrepancy_details: { scheme: 'Some Fund - Growth', candidateInstrumentIds: [CANDIDATE_A, CANDIDATE_B], candidates: [{ instrumentId: CANDIDATE_A, displayName: 'Some Fund A - Growth' }, { instrumentId: CANDIDATE_B, displayName: 'Some Fund B - Growth' }] },
        ...overrides,
      },
    ],
  });
  mockUserFrom.mockImplementation((table: string) => countryRegistryFrom(table) ?? db.client.from(table));
  mockAdminFrom.mockImplementation((table: string) => db.client.from(table));
  return db;
}

function post(caseId: string, body: unknown) {
  return POST(new Request('http://test/x', { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id: caseId }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetUser.mockResolvedValue({ data: { user: { id: USER_ID, email: 'u@example.com' } } });
  processSourceDocumentMock.mockResolvedValue({ ok: true, status: 'succeeded', parseRunId: 'run-1', error: null });
});

describe('POST reconciliation-cases/[id]/resolve-instrument', () => {
  it('401s when unauthenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });
    seed();
    const res = await post(CASE_ID, { resolvedInstrumentId: CANDIDATE_A });
    expect(res.status).toBe(401);
  });

  it('404s for a case that does not belong to this user (tenant isolation)', async () => {
    seed({ user_id: 'someone-else' });
    const res = await post(CASE_ID, { resolvedInstrumentId: CANDIDATE_A });
    expect(res.status).toBe(404);
  });

  it('422s for a discrepancy type this route does not handle', async () => {
    seed({ discrepancy_type: 'owner_unmatched' });
    const res = await post(CASE_ID, { resolvedInstrumentId: CANDIDATE_A });
    expect(res.status).toBe(422);
  });

  it('rejects an instrument id that is NOT one of the case’s own candidates — never fuzzy-auto-selects', async () => {
    seed();
    const res = await post(CASE_ID, { resolvedInstrumentId: OUTSIDER });
    expect(res.status).toBe(422);
    expect(processSourceDocumentMock).not.toHaveBeenCalled();
  });

  it('single candidate: resolves, marks the case resolved, and reprocesses the source document', async () => {
    const db = seed({ discrepancy_details: { scheme: 'X', candidateInstrumentIds: [CANDIDATE_A], candidates: [{ instrumentId: CANDIDATE_A, displayName: 'X' }] } });
    const res = await post(CASE_ID, { resolvedInstrumentId: CANDIDATE_A });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.reprocessed).toBe(true);
    const row = db.tables.ii_reconciliation_cases[0];
    expect(row.status).toBe('resolved');
    expect(row.resolution_method).toBe('user_mapped_instrument');
    expect((row.discrepancy_details as Row).resolvedInstrumentId).toBe(CANDIDATE_A);
    expect(processSourceDocumentMock).toHaveBeenCalledWith(expect.objectContaining({ userId: USER_ID, sourceDocumentId: DOC_ID, forceReparse: true }));
  });

  it('multiple candidates: resolves to the chosen one, not the other', async () => {
    const db = seed();
    const res = await post(CASE_ID, { resolvedInstrumentId: CANDIDATE_B });
    expect(res.status).toBe(200);
    expect((db.tables.ii_reconciliation_cases[0].discrepancy_details as Row).resolvedInstrumentId).toBe(CANDIDATE_B);
  });

  it('no candidates recorded on the case: any instrument id is rejected (never guesses)', async () => {
    seed({ discrepancy_details: { scheme: 'X', candidateInstrumentIds: [], candidates: [] } });
    const res = await post(CASE_ID, { resolvedInstrumentId: CANDIDATE_A });
    expect(res.status).toBe(422);
  });

  it('already-resolved with the SAME instrument: idempotent success, no duplicate reprocessing side effect asserted twice', async () => {
    seed({ status: 'resolved', discrepancy_details: { scheme: 'X', candidateInstrumentIds: [CANDIDATE_A, CANDIDATE_B], resolvedInstrumentId: CANDIDATE_A } });
    const res = await post(CASE_ID, { resolvedInstrumentId: CANDIDATE_A });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.alreadyResolved).toBe(true);
  });

  it('already resolved with a DIFFERENT instrument: refused — must go through amend, not silently overwritten', async () => {
    seed({ status: 'resolved', discrepancy_details: { scheme: 'X', candidateInstrumentIds: [CANDIDATE_A, CANDIDATE_B], resolvedInstrumentId: CANDIDATE_A } });
    const res = await post(CASE_ID, { resolvedInstrumentId: CANDIDATE_B });
    expect(res.status).toBe(409);
  });

  it('double submit (two rapid identical requests) is idempotent, not a duplicate error', async () => {
    seed();
    const first = await post(CASE_ID, { resolvedInstrumentId: CANDIDATE_A });
    expect(first.status).toBe(200);
    const second = await post(CASE_ID, { resolvedInstrumentId: CANDIDATE_A });
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(secondBody.data.alreadyResolved).toBe(true);
  });

  it('a reprocess failure is surfaced but does not undo the resolution already recorded', async () => {
    processSourceDocumentMock.mockResolvedValue({ ok: false, status: 'parse_failed', parseRunId: null, error: 'boom' });
    const db = seed();
    const res = await post(CASE_ID, { resolvedInstrumentId: CANDIDATE_A });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.reprocessed).toBe(false);
    expect(body.data.reprocessError).toBe('boom');
    expect(db.tables.ii_reconciliation_cases[0].status).toBe('resolved');
  });
});

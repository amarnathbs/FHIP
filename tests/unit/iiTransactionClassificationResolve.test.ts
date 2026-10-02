// Document2 final non-benchmark closure #10 (2026-09-30) —
// POST /api/investment-intelligence/reconciliation-cases/[id]/resolve-classification.
//
// 'transaction_unclassified' previously had NO real user-facing
// re-classification action (a prior report's claim that one existed was
// inaccurate — only the system's own initial parse-time classification
// existed). A MATERIAL instance is a genuine certification blocker
// (certification.ts's hasMaterialUnclassifiedTransaction), so this matters
// more than most of the disclosed Review-actionability gaps.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createInMemoryDb, type Row } from './support/inMemorySupabase';
import { countryRegistryFrom } from './support/countryRegistryFake';

const mockGetUser = vi.fn();
const mockUserFrom = vi.fn();
const mockAdminFrom = vi.fn();
const { recertifyPositionMock } = vi.hoisted(() => ({ recertifyPositionMock: vi.fn() }));

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: mockGetUser }, from: mockUserFrom }) }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ from: mockAdminFrom }) }));
vi.mock('@/lib/services/investment-intelligence/documentProcessing', () => ({ recertifyPosition: recertifyPositionMock }));
vi.mock('@/lib/services/investment-intelligence/audit', () => ({ emitAuditEvent: vi.fn().mockResolvedValue(undefined) }));

import { POST } from '@/app/api/investment-intelligence/reconciliation-cases/[id]/resolve-classification/route';

const USER_ID = 'user-1';
const CASE_ID = 'case-1';
const TXN_ID = 'txn-1';
const ACCOUNT_ID = 'acct-1';
const INSTRUMENT_ID = 'inst-1';

function seed(caseOverrides: Partial<Row> = {}) {
  const db = createInMemoryDb();
  db.reset({
    user_profiles: [{ user_id: USER_ID, country_of_residence: 'AU', country_confirmed_at: '2026-08-29T00:00:00Z', country_source: 'USER_CONFIRMED', onboarding_completed: true }],
    ii_reconciliation_cases: [
      {
        id: CASE_ID,
        user_id: USER_ID,
        status: 'open',
        discrepancy_type: 'transaction_unclassified',
        discrepancy_details: { description: 'Misc Adj', date: '2026-01-01', amount: '500.00', material: true, newTransactionId: TXN_ID },
        ...caseOverrides,
      },
    ],
    ii_transactions: [{ id: TXN_ID, user_id: USER_ID, account_id: ACCOUNT_ID, instrument_id: INSTRUMENT_ID, transaction_type: 'unclassified' }],
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
  recertifyPositionMock.mockResolvedValue({ ok: true, error: null });
});

describe('POST reconciliation-cases/[id]/resolve-classification', () => {
  it('401s when unauthenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });
    seed();
    const res = await post(CASE_ID, { transactionType: 'fee' });
    expect(res.status).toBe(401);
  });

  it('404s for a case belonging to another user', async () => {
    seed({ user_id: 'someone-else' });
    const res = await post(CASE_ID, { transactionType: 'fee' });
    expect(res.status).toBe(404);
  });

  it('422s for a discrepancy type this route does not handle', async () => {
    seed({ discrepancy_type: 'ambiguous_instrument' });
    const res = await post(CASE_ID, { transactionType: 'fee' });
    expect(res.status).toBe(422);
  });

  it("rejects 'unclassified' as a target type — that would be a no-op, not a fix", async () => {
    seed();
    const res = await post(CASE_ID, { transactionType: 'unclassified' });
    expect(res.status).toBe(422);
  });

  it('resolves: updates the transaction type, resolves the case, and recertifies the position', async () => {
    const db = seed();
    const res = await post(CASE_ID, { transactionType: 'fee' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.recertified).toBe(true);
    expect(db.tables.ii_transactions[0].transaction_type).toBe('fee');
    expect(db.tables.ii_reconciliation_cases[0].status).toBe('resolved');
    expect(recertifyPositionMock).toHaveBeenCalledWith(USER_ID, ACCOUNT_ID, INSTRUMENT_ID);
  });

  it('idempotent repeat of the same classification', async () => {
    seed();
    const first = await post(CASE_ID, { transactionType: 'fee' });
    expect(first.status).toBe(200);
    const second = await post(CASE_ID, { transactionType: 'fee' });
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(secondBody.data.alreadyResolved).toBe(true);
  });

  it('a different classification after already resolved is refused, not silently overwritten', async () => {
    seed();
    const first = await post(CASE_ID, { transactionType: 'fee' });
    expect(first.status).toBe(200);
    const second = await post(CASE_ID, { transactionType: 'tax' });
    expect(second.status).toBe(409);
  });
});

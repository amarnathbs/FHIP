// Document2 final non-benchmark closure #4 (2026-09-30) —
// POST /api/investment-intelligence/reconciliation-cases/[id]/resolve-cross-source.
//
// 'cross_source_conflict'/'cross_source_review_required' are the only two
// cross_source_* codes ever left OPEN (the exact/high-confidence duplicate
// siblings auto-resolve the instant they are created — see
// documentProcessing.ts). This is the real explicit conflict-choice action:
// the user decides whether a second source's transaction is the SAME
// real-world event (already-correctly-excluded evidence, nothing to
// mutate) or a genuinely DISTINCT one (brought back into aggregation by
// flipping its status from 'review_required' to 'parsed').
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createInMemoryDb, type Row } from './support/inMemorySupabase';
import { countryRegistryFrom } from './support/countryRegistryFake';

const mockGetUser = vi.fn();
const mockUserFrom = vi.fn();
const mockAdminFrom = vi.fn();

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: mockGetUser }, from: mockUserFrom }) }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ from: mockAdminFrom }) }));
vi.mock('@/lib/services/investment-intelligence/audit', () => ({ emitAuditEvent: vi.fn().mockResolvedValue(undefined) }));

import { POST } from '@/app/api/investment-intelligence/reconciliation-cases/[id]/resolve-cross-source/route';

const USER_ID = 'user-1';
const CASE_ID = 'case-1';
const TXN_ID = 'txn-new-1';

function seed(caseOverrides: Partial<Row> = {}, txnOverrides: Partial<Row> = {}) {
  const db = createInMemoryDb();
  db.reset({
    user_profiles: [{ user_id: USER_ID, country_of_residence: 'AU', country_confirmed_at: '2026-08-29T00:00:00Z', country_source: 'USER_CONFIRMED', onboarding_completed: true }],
    ii_reconciliation_cases: [
      {
        id: CASE_ID,
        user_id: USER_ID,
        status: 'open',
        discrepancy_type: 'cross_source_conflict',
        discrepancy_details: { matchedFields: ['transactionDate'], differingFields: ['grossAmount'], rationale: 'amount differs', newTransactionId: TXN_ID },
        ...caseOverrides,
      },
    ],
    ii_transactions: [{ id: TXN_ID, user_id: USER_ID, status: 'review_required', ...txnOverrides }],
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
});

describe('POST reconciliation-cases/[id]/resolve-cross-source', () => {
  it('401s when unauthenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });
    seed();
    const res = await post(CASE_ID, { decision: 'confirmed_duplicate' });
    expect(res.status).toBe(401);
  });

  it('404s for a case belonging to another user (tenant isolation)', async () => {
    seed({ user_id: 'someone-else' });
    const res = await post(CASE_ID, { decision: 'confirmed_duplicate' });
    expect(res.status).toBe(404);
  });

  it('422s for a discrepancy type this route does not handle', async () => {
    seed({ discrepancy_type: 'ambiguous_instrument' });
    const res = await post(CASE_ID, { decision: 'confirmed_duplicate' });
    expect(res.status).toBe(422);
  });

  it('422s when the case has no recorded transaction to resolve', async () => {
    seed({ discrepancy_details: { matchedFields: [], differingFields: [], rationale: 'x' } });
    const res = await post(CASE_ID, { decision: 'confirmed_duplicate' });
    expect(res.status).toBe(422);
  });

  it("'confirmed_duplicate': resolves the case, transaction stays 'review_required' (already correctly excluded, never mutated)", async () => {
    const db = seed();
    const res = await post(CASE_ID, { decision: 'confirmed_duplicate' });
    expect(res.status).toBe(200);
    expect(db.tables.ii_reconciliation_cases[0].status).toBe('resolved');
    expect(db.tables.ii_reconciliation_cases[0].resolution_method).toBe('user_resolved_duplicate');
    expect(db.tables.ii_transactions[0].status).toBe('review_required');
  });

  it("'confirmed_distinct': resolves the case AND brings the transaction back into aggregation ('parsed')", async () => {
    const db = seed();
    const res = await post(CASE_ID, { decision: 'confirmed_distinct' });
    expect(res.status).toBe(200);
    expect(db.tables.ii_reconciliation_cases[0].status).toBe('resolved');
    expect(db.tables.ii_reconciliation_cases[0].resolution_method).toBe('user_classified_transaction');
    expect(db.tables.ii_transactions[0].status).toBe('parsed');
  });

  it('also handles cross_source_review_required the same way as cross_source_conflict', async () => {
    const db = seed({ discrepancy_type: 'cross_source_review_required' });
    const res = await post(CASE_ID, { decision: 'confirmed_distinct' });
    expect(res.status).toBe(200);
    expect(db.tables.ii_transactions[0].status).toBe('parsed');
  });

  it('double submit of the same decision is idempotent', async () => {
    seed();
    const first = await post(CASE_ID, { decision: 'confirmed_duplicate' });
    expect(first.status).toBe(200);
    const second = await post(CASE_ID, { decision: 'confirmed_duplicate' });
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(secondBody.data.alreadyResolved).toBe(true);
  });

  it('resolving with a DIFFERENT decision after already resolved is refused, not silently overwritten', async () => {
    seed();
    const first = await post(CASE_ID, { decision: 'confirmed_duplicate' });
    expect(first.status).toBe(200);
    const second = await post(CASE_ID, { decision: 'confirmed_distinct' });
    expect(second.status).toBe(409);
  });

  it('404s if the recorded transaction id no longer exists for this user', async () => {
    seed({}, { id: 'a-different-id' });
    const res = await post(CASE_ID, { decision: 'confirmed_distinct' });
    expect(res.status).toBe(404);
  });
});

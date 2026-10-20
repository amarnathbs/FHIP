// Document2 (4) WP-B (F7) -- "Re-evaluate" end to end: button -> route -> service -> database -> recalculated status -> what the screen says.
//
// The PO's finding was that Re-evaluate "does nothing". The recalculation itself works; what was missing is a visible reason when the
// position is still blocked and a visible outcome when it is not. These tests drive the REAL certify route and the REAL
// recertifyPosition against an in-memory database and then feed the stored result through the SAME functions the screen uses
// (describeTruthBlocker / describeReevaluationOutcome), so the loop "fix the cause, Re-evaluate, it clears" is proved, and a cause
// that Re-evaluate cannot fix (missing history) is proved to stay and to say what the person must do.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryDb, type Row } from './support/inMemorySupabase';

const h = vi.hoisted(() => ({ db: null as unknown as ReturnType<typeof import('./support/inMemorySupabase').createInMemoryDb> }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => h.db.client }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => h.db.client }));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  requireCountryConfirmedUser: async () => ({ user: { id: 'user-1', email: null }, unauthenticated: null }),
}));

import { POST as certifyPOST } from '@/app/api/investment-intelligence/portfolio-truth/certify/route';
import { describeReevaluationOutcome, describeTruthBlocker } from '@/lib/services/investment-intelligence/caseLifecycle';

const U = 'user-1';
const ACC = '11111111-1111-4111-8111-111111111111';
const INS = '22222222-2222-4222-8222-222222222222';

function seed(opts: { owner: string | null; closingUnits: string; boughtUnits: string; openCase?: boolean }) {
  h.db = createInMemoryDb({ upsertMerges: true });
  h.db.reset({
    ii_accounts: [{ id: ACC, user_id: U, owner_member_id: opts.owner, source_document_id: 'doc1' }],
    ii_ownership_allocation: [],
    ii_holding_snapshots: [{ id: 's1', user_id: U, account_id: ACC, instrument_id: INS, as_of_date: '2026-09-04', units: opts.closingUnits, value: '5200', source_document_id: 'doc1' }],
    ii_transactions: [{ id: 't1', user_id: U, account_id: ACC, instrument_id: INS, transaction_type: 'purchase', units: opts.boughtUnits, transaction_date: '2026-01-10', source_reference: null }],
    ii_reconciliation_cases: opts.openCase
      ? [{ id: 'c1', user_id: U, subject_type: 'account', subject_id: ACC, discrepancy_type: 'owner_unmatched', severity: 'blocking', status: 'open', source_document_id: 'doc1', discrepancy_details: {} }]
      : [],
    ii_portfolio_truth_status: [],
    ii_audit_events: [],
    ii_reconciliation_config: [],
  });
}

async function reevaluate() {
  const res = await certifyPOST(new Request('http://t/x', { method: 'POST', body: JSON.stringify({ accountId: ACC, instrumentId: INS }) }));
  expect(res.status).toBe(200);
  return (await res.json()).data as { status: string; blocking_reasons: { code: string; message: string }[] };
}
const truthRows = () => h.db.tables.ii_portfolio_truth_status;

beforeEach(() => seed({ owner: null, closingUnits: '100', boughtUnits: '100', openCase: true }));

describe('Re-evaluate: fix the cause, Re-evaluate, it clears (owner)', () => {
  it('blocked while the owner is not chosen, and the stored reason maps to an actionable fix with a real link', async () => {
    const before = await reevaluate();
    expect(before.status).toBe('reconciliation_required');
    const codes = before.blocking_reasons.map((b) => b.code);
    expect(codes).toContain('unresolved_owner');
    const guidance = describeTruthBlocker('unresolved_owner', before.blocking_reasons[0].message);
    expect(guidance.cta).toMatchObject({ kind: 'link', href: '/investment-intelligence/review' });
    // the screen's message for an unchanged blocked position names the reason (the click is never silent)
    expect(describeReevaluationOutcome('reconciliation_required', before.status, before.blocking_reasons.map((b) => b.message))).toMatch(/still needs review/);
  });

  it('after the person chooses the owner and the case is resolved, Re-evaluate recalculates and the position is publishable', async () => {
    await reevaluate();
    // what PATCH .../accounts/[id]/owner does: sets the owner and resolves the open owner case
    h.db.tables.ii_accounts[0].owner_member_id = 'member-1';
    h.db.tables.ii_reconciliation_cases[0].status = 'resolved';
    const after = await reevaluate();
    expect(['certified', 'certified_with_warnings']).toContain(after.status);
    expect(after.blocking_reasons).toEqual([]);
    expect(truthRows()).toHaveLength(1); // updated in place, not duplicated
    expect(describeReevaluationOutcome('reconciliation_required', after.status, [])).toMatch(/now ready to publish/);
    // the holding snapshot is marked certified: this is what makes "Publish to FHIP" appear
    expect(h.db.tables.ii_holding_snapshots[0].quality_status).toBe('certified');
  });

  it('NEGATIVE CONTROL: choosing the owner but leaving the blocking case open still blocks (the reason is the open case)', async () => {
    h.db.tables.ii_accounts[0].owner_member_id = 'member-1';
    const r = await reevaluate();
    expect(r.status).toBe('reconciliation_required');
    expect(r.blocking_reasons.map((b) => b.code)).toContain('open_blocking_reconciliation_case');
    expect(describeTruthBlocker('open_blocking_reconciliation_case').cta.kind).toBe('anchor');
  });
});

describe('Re-evaluate cannot invent history: a missing-history block stays and says what to do', () => {
  it('units that do not reconcile stay blocked after Re-evaluate, with the real fix named', async () => {
    seed({ owner: 'member-1', closingUnits: '100', boughtUnits: '40' });
    const first = await reevaluate();
    const second = await reevaluate();
    expect(first.status).toBe('reconciliation_required');
    expect(second.status).toBe('reconciliation_required');
    const codes = second.blocking_reasons.map((b) => b.code);
    expect(codes).toContain('unit_variance_exceeds_tolerance');
    expect(describeTruthBlocker('unit_variance_exceeds_tolerance').how).toMatch(/consolidated statement/i);
    expect(truthRows()).toHaveLength(1);
  });
});

describe('Re-evaluate is scoped to the caller', () => {
  it("another user's account is a 404 and nothing is written", async () => {
    seed({ owner: 'member-1', closingUnits: '100', boughtUnits: '100' });
    h.db.tables.ii_accounts[0].user_id = 'user-2';
    const res = await certifyPOST(new Request('http://t/x', { method: 'POST', body: JSON.stringify({ accountId: ACC, instrumentId: INS }) }));
    expect(res.status).toBe(404);
    expect(truthRows()).toHaveLength(0);
  });
});

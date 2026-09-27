/**
 * GOLDEN PAIR GP-D2 (found live on DEV, 2026-09-27): a card/loan repayment is never linked to its bank
 * debit when the user approves the BANK statement first and the card/loan statement afterwards.
 *
 *   - extraction-time matching sees only APPROVED bank debits (none yet at upload);
 *   - the post-bank-approval back-match only considers card/loan statements that are ALREADY approved;
 *   - approving / applying the card/loan statement never looked again.
 *
 * Live on DEV the loan's $2,000 repayment stayed 'bank_evidence_not_available' after both approvals, the
 * Apply reported linksCreated 0, and the Expenses tab showed "Loan principal repaid" 3,550 (the bank's
 * 2,000 + the loan's own 1,550). The fix matches forward when the card/loan statement is approved, with
 * the same certified rule and the same re-verifying RPC.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDb, type Row } from './helpers/fdh11FakeDb';

const h = vi.hoisted(() => ({ db: null as unknown as { client: unknown }, U: '00000000-0000-4000-8000-0000000000a1', STATEMENT: '00000000-0000-4000-8000-00000000c001' }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => h.db.client }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => h.db.client }));
vi.mock('@/lib/financial-data-hub/services/auditLog', () => ({ recordDocumentAuditEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/api', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/api')>();
  return { ...orig, requireCountryConfirmedUser: vi.fn().mockResolvedValue({ user: { id: h.U, email: 'gp@fhip-test.invalid' } }) };
});
vi.mock('@/lib/financial-data-hub/services/liabilityStatementProcessingService', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getLiabilityStatementIdForDocument: vi.fn(async () => h.STATEMENT),
}));
vi.mock('@/lib/import-bridge/applyLiabilityProposalAtomic', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  approveLiabilityStatementAtomic: vi.fn(async (id: string) => {
    const st = h.db && (h.db as unknown as FakeDb).rows('fdh_liability_statements').find((s) => s.id === id);
    if (st) st.approval_status = 'approved';
    return { ok: true };
  }),
}));

const U = h.U;
const OTHER = '00000000-0000-4000-8000-0000000000b2';
const STATEMENT = h.STATEMENT;
const BANK_UPLOAD = '00000000-0000-4000-8000-00000000d001';
const ACT = '00000000-0000-4000-8000-00000000e001';
const DEBIT = '00000000-0000-4000-8000-00000000f001';

import { liabilityBankBackMatcher, runLiabilityStatementForwardMatch } from '@/lib/import-bridge/liabilityBankBackMatch';
import { POST as approveRoute } from '@/app/api/financial-data-hub/liability-statement/[documentId]/approve/route';

/** The RPC's own re-verification (0209 H), reduced to what these cases exercise. */
function matchRpc(name: string, args: Row, db: FakeDb) {
  if (name !== 'fdh10_match_liability_payment') return { data: null, error: { message: `no rpc ${name}` } };
  const act = db.rows('fdh_liability_statement_activities').find((a) => a.id === args.p_activity_id);
  const debit = db.rows('fdh_transactions').find((t) => t.id === args.p_bank_transaction_id);
  if (!act || !debit || debit.user_id !== act.user_id) return { data: { ok: false, code: 'FOREIGN_TRANSACTION' }, error: null };
  if (act.bank_match_status === 'matched') return { data: { ok: false, code: 'NOT_ACTIONABLE' }, error: null };
  if (debit.approval_status !== 'approved' || Number(debit.amount_original) !== Number(act.amount)) return { data: { ok: false, code: 'BANK_MATCH_INVALID' }, error: null };
  if (db.rows('fdh_liability_statement_activities').some((o) => o.linked_transaction_id === debit.id && o.bank_match_status === 'matched')) return { data: { ok: false, code: 'ALREADY_MATCHED' }, error: null };
  act.linked_transaction_id = debit.id;
  act.bank_match_status = 'matched';
  return { data: { ok: true, outcome: 'matched', link: act.ledger_transaction_id ? 'created+reclassified' : null }, error: null };
}

function world(opts: { statementApproved?: boolean; debit?: Partial<Row>; extraActivities?: Row[] } = {}) {
  return new FakeDb({
    fdh_liability_statements: [{ id: STATEMENT, user_id: U, institution_name: 'FHIP Test Home Loan', approval_status: opts.statementApproved ? 'approved' : 'pending', ledger_status: 'not_applied', statement_upload_id: 'doc-loan' }],
    fdh_liability_statement_activities: [
      { id: ACT, user_id: U, statement_id: STATEMENT, activity_type: 'PAYMENT', activity_date: '2026-08-15', amount: 2000, currency_code: 'AUD', bank_match_status: 'bank_evidence_not_available', ledger_disposition: null, linked_transaction_id: null, ledger_transaction_id: null },
      ...(opts.extraActivities ?? []),
    ],
    fdh_transactions: [{
      id: DEBIT, user_id: U, statement_upload_id: BANK_UPLOAD, credit_debit: 'debit', approval_status: 'approved', dedup_status: 'unique',
      amount_original: 2000, currency_original: 'AUD', transaction_date: '2026-08-15',
      description_clean: null, description_raw: 'FHIP TEST HOME LOAN REPAYMENT GP', merchant_raw: null, ...(opts.debit ?? {}),
    }],
  }, { rpc: matchRpc });
}

let db: FakeDb;
beforeEach(() => { db = world(); h.db = db; });

describe('GP-D2: bank approved FIRST, card/loan statement approved LATER', () => {
  it('NEGATIVE CONTROL: the post-bank-approval back-match skips a card/loan statement that is not approved yet', async () => {
    const out = await liabilityBankBackMatcher.run({ userId: U, statementUploadId: BANK_UPLOAD, trigger: 'category_approve_all' });
    expect(out).toEqual({ linked: 0, reclassified: 0 });
    expect(db.rows('fdh_liability_statement_activities')[0].bank_match_status).toBe('bank_evidence_not_available');
  });

  it('approving the card/loan statement links the repayment to the already-approved bank debit', async () => {
    const res = await approveRoute(new Request('http://x', { method: 'POST' }), { params: Promise.resolve({ documentId: 'doc-loan' }) });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data).toMatchObject({ approved: true, bank_payments_linked: 1 });
    expect(db.rpcCalls).toEqual([{ name: 'fdh10_match_liability_payment', args: { p_activity_id: ACT, p_bank_transaction_id: DEBIT, p_method: 'bank_back_match' } }]);
    expect(db.rows('fdh_liability_statement_activities')[0]).toMatchObject({ bank_match_status: 'matched', linked_transaction_id: DEBIT });
  });

  it('never on amount alone: a same-amount debit that does not name the lender is not linked', async () => {
    db = world({ statementApproved: true, debit: { description_raw: 'TRANSFER TO SAVINGS' } }); h.db = db;
    expect(await runLiabilityStatementForwardMatch(U, STATEMENT)).toEqual({ linked: 0, reclassified: 0 });
    expect(db.rpcCalls).toHaveLength(0);
  });

  it('a statement that is not approved is never matched forward', async () => {
    expect(await runLiabilityStatementForwardMatch(U, STATEMENT)).toEqual({ linked: 0, reclassified: 0 });
    expect(db.rpcCalls).toHaveLength(0);
  });

  it('a debit that already settles another repayment is never offered; another user\'s debit is never seen', async () => {
    db = world({ statementApproved: true, extraActivities: [{ id: 'other-act', user_id: U, statement_id: 'other-statement', activity_type: 'PAYMENT', activity_date: '2026-08-15', amount: 2000, currency_code: 'AUD', bank_match_status: 'matched', linked_transaction_id: DEBIT }] });
    h.db = db;
    expect(await runLiabilityStatementForwardMatch(U, STATEMENT)).toEqual({ linked: 0, reclassified: 0 });
    db = world({ statementApproved: true, debit: { user_id: OTHER } }); h.db = db;
    expect(await runLiabilityStatementForwardMatch(U, STATEMENT)).toEqual({ linked: 0, reclassified: 0 });
    expect(db.rpcCalls).toHaveLength(0);
  });

  it('a failing matcher never undoes the approval (best effort, audited)', async () => {
    db = new FakeDb(world().tables, { rpc: () => ({ data: null, error: { message: 'boom' } }) }); h.db = db;
    const res = await approveRoute(new Request('http://x', { method: 'POST' }), { params: Promise.resolve({ documentId: 'doc-loan' }) });
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ approved: true, bank_payments_linked: 0 });
  });
});

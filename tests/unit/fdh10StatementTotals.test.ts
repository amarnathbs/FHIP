/**
 * WP-10 (G5, G6, G4): liability statement evidence -- the totals rule, the
 * persisted warnings / GST / bank candidates, and the candidate query.
 *
 * NEGATIVE CONTROLS (run against the base branch, see the WP-10/11 report):
 * before WP-10 `principal_repayments_total` ignored standalone PRINCIPAL lines,
 * `adjustments_total` was never written and both reconciliations were passed
 * null, a loan redraw and capitalised interest were missing from the loan
 * identity, and the persist payload carried no warnings, GST or candidates.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LIABILITY_LEDGER_MAPPING } from '@/lib/financial-data-hub/liability/creditCardEconomics';
import { decomposeLoanPayment } from '@/lib/financial-data-hub/liability/repaymentDecomposition';
import { computeStatementTotals, type StatementTotalsActivity } from '@/lib/financial-data-hub/liability/statementReconciliation';
import { toExtractionWarnings } from '@/lib/financial-data-hub/liability/extractionWarnings';
import { LIABILITY_ACTIVITY_TYPES } from '@/lib/financial-data-hub/liability/types';

const act = (activityType: string, amount: number, extra: Partial<StatementTotalsActivity> = {}): StatementTotalsActivity => ({ activityType, amount, ...extra });

describe('computeStatementTotals -- the one totals rule (G5)', () => {
  it('a standalone PRINCIPAL line is counted in principal_repayments_total (it was dropped)', () => {
    const t = computeStatementTotals({ statementType: 'loan', activities: [act('PRINCIPAL', 1550), act('PAYMENT', 500, { principalComponent: 400, interestComponent: 100 })], opening: null, closing: null, currencyCode: 'AUD' });
    expect(t.principalRepaymentsTotal).toBe(1950);
  });

  it('card: a single ADJUSTMENT takes the sign that reconciles to the cent, and says so', () => {
    const credit = computeStatementTotals({ statementType: 'credit_card', activities: [act('PURCHASE', 100), act('ADJUSTMENT', 30)], opening: 0, closing: 70, currencyCode: 'AUD' });
    expect(credit.adjustmentsTotal).toBe(-30);
    expect(credit.reconciliation.status).toBe('reconciled');
    expect(credit.warnings).toContain('adjustment_sign_inferred_from_balance');
    const debit = computeStatementTotals({ statementType: 'credit_card', activities: [act('PURCHASE', 100), act('ADJUSTMENT', 30)], opening: 0, closing: 130, currencyCode: 'AUD' });
    expect(debit.adjustmentsTotal).toBe(30);
  });

  it('card: an ADJUSTMENT whose direction cannot be established is never forced -- insufficient_data + a visible warning', () => {
    const t = computeStatementTotals({ statementType: 'credit_card', activities: [act('PURCHASE', 100), act('ADJUSTMENT', 30)], opening: 0, closing: 999, currencyCode: 'AUD' });
    expect(t.adjustmentsTotal).toBeNull();
    expect(t.reconciliation.status).toBe('insufficient_data');
    expect(t.warnings).toContain('adjustment_direction_unknown');
  });

  it('loan: a redraw/cash advance is a drawdown and capitalised interest is in the identity -- a correct loan statement reconciles', () => {
    // opening 20,000 + redraw 1,000 + interest charged 430 - repayment 2,000 (no split) = 19,430
    const t = computeStatementTotals({
      statementType: 'loan',
      activities: [act('CASH_ADVANCE', 1000), act('INTEREST', 430), act('PAYMENT', 2000)],
      opening: 20000, closing: 19430, currencyCode: 'AUD',
    });
    expect(t.drawdownsTotal).toBe(1000);
    expect(t.cashAdvancesTotal).toBeNull();
    expect(t.capitalisedTotal).toBe(430);
    expect(t.principalRepaymentsTotal).toBe(2000);
    expect(t.reconciliation.status).toBe('reconciled');
  });

  it('loan with a decomposed payment: principal only reduces the principal (the brief oracle)', () => {
    const t = computeStatementTotals({
      statementType: 'loan',
      activities: [act('PAYMENT', 2000, { principalComponent: 1550, interestComponent: 430, feeComponent: 20 })],
      opening: 20000, closing: 18450, currencyCode: 'AUD',
    });
    expect(t).toMatchObject({ principalRepaymentsTotal: 1550, interestTotal: 430, feesTotal: 20, paymentsTotal: 2000, capitalisedTotal: null });
    expect(t.reconciliation.status).toBe('reconciled');
  });

  it('OTHER lines are never silently summed: a visible warning says they are outside the totals', () => {
    const t = computeStatementTotals({ statementType: 'credit_card', activities: [act('OTHER', 5), act('OTHER', 6)], opening: null, closing: null, currencyCode: 'AUD' });
    expect(t.warnings).toEqual(['other_activity_not_in_totals_2']);
  });

  it('INVARIANT over all 10 activity types: each persisted total equals the sum of the ledger rows the Apply writes for it', () => {
    const activities = [
      act('PURCHASE', 200), act('PURCHASE', 20), act('REFUND', 15), act('PAYMENT', 220), act('CASH_ADVANCE', 300),
      act('INTEREST', 12), act('FEE', 9), act('PRINCIPAL', 100), act('LOAN_ADVANCE', 50), act('ADJUSTMENT', 4), act('OTHER', 3),
      act('PAYMENT', 2000, { principalComponent: 1550, interestComponent: 430, feeComponent: 20 }),
    ];
    expect(new Set(activities.map((a) => a.activityType))).toEqual(new Set(LIABILITY_ACTIVITY_TYPES));
    const t = computeStatementTotals({ statementType: 'credit_card', activities, opening: null, closing: null, currencyCode: 'AUD' });
    // What the ledger Apply writes, per economic type (header, or allocations for a decomposed payment).
    const ledger: Record<string, number> = {};
    for (const a of activities) {
      const m = LIABILITY_LEDGER_MAPPING[a.activityType as keyof typeof LIABILITY_LEDGER_MAPPING];
      if (!m) continue;
      const d = a.activityType === 'PAYMENT' && a.principalComponent !== undefined
        ? decomposeLoanPayment({ totalPayment: a.amount, principalComponent: a.principalComponent, interestComponent: a.interestComponent, feeComponent: a.feeComponent, currencyCode: 'AUD' })
        : null;
      const parts = d ? d.allocations.map((x) => ({ type: x.economicType, amount: x.amount })) : [{ type: m.economicType, amount: a.amount }];
      for (const p of parts) ledger[p.type] = (ledger[p.type] ?? 0) + p.amount;
    }
    expect(ledger.expense).toBe(t.purchasesTotal);
    expect(ledger.refund).toBe(t.refundsTotal);
    expect(ledger.cash_withdrawal).toBe(t.cashAdvancesTotal);
    expect(ledger.debt_interest).toBe(t.interestTotal);
    expect(ledger.fee).toBe(t.feesTotal);
    expect(ledger.debt_principal).toBe(t.principalRepaymentsTotal);
    // transfer = undecomposed PAYMENT (220) + LOAN_ADVANCE (50); payments_total counts every PAYMENT line.
    expect(ledger.transfer).toBe(220 + (t.drawdownsTotal ?? 0));
    expect(t.paymentsTotal).toBe(2220);
  });
});

describe('extraction warnings persist as structured, visible evidence (G6)', () => {
  it('keeps the row and the unrecognised type label; never loses a warning', () => {
    expect(toExtractionWarnings(['row_3_zero_amount', 'row_7_unrecognised_activity_type_Cashback', 'adjustment_direction_unknown', 'ai_activity_2_zero_amount']))
      .toEqual([
        { code: 'zero_amount', row: 3 },
        { code: 'unrecognised_activity_type', row: 7, detail: 'Cashback' },
        { code: 'adjustment_direction_unknown' },
        { code: 'zero_amount', row: 2 },
      ]);
  });
});

// ---------------------------------------------------------------------------
// The persist payload and the candidate query (service level).
// ---------------------------------------------------------------------------
const calls: { table: string; filters: Array<[string, string, unknown]> }[] = [];
let rpcArgs: Record<string, unknown> | null = null;
let bankRows: Record<string, unknown>[] = [];
let matchedRows: Record<string, unknown>[] = [];

function query(table: string) {
  const entry = { table, filters: [] as Array<[string, string, unknown]> };
  calls.push(entry);
  const q: Record<string, unknown> = {};
  const chain = (op: string) => (col: string, val?: unknown) => { entry.filters.push([op, col, val]); return q; };
  Object.assign(q, {
    select: () => q, eq: chain('eq'), gte: chain('gte'), lte: chain('lte'), in: chain('in'), order: chain('order'),
    range: async () => ({ data: table === 'fdh_transactions' ? bankRows : [], error: null }),
    then: (resolve: (v: unknown) => void) => resolve({ data: table === 'fdh_liability_statement_activities' ? matchedRows : [], error: null }),
  });
  return q;
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    from: (t: string) => query(t),
    rpc: async (_name: string, args: Record<string, unknown>) => { rpcArgs = args; return { data: { ok: true, statement_id: 'st-1', activity_count: 2 }, error: null }; },
  }),
}));
vi.mock('@/lib/financial-data-hub/services/auditLog', () => ({ recordDocumentAuditEvent: vi.fn(async () => undefined) }));

describe('persistLiabilityStatementEvidence payload + candidate query (G4, G5, G6)', () => {
  beforeEach(() => { calls.length = 0; rpcArgs = null; bankRows = []; matchedRows = []; });

  it('persists warnings, GST, signed adjustments, capitalised totals and the candidate ids of an ambiguous repayment', async () => {
    const { persistLiabilityStatementEvidence } = await import('@/lib/financial-data-hub/services/liabilityStatementProcessingService');
    bankRows = [
      { id: 'b1', transaction_date: '2026-08-19', amount_original: 220, description_clean: 'TEST BANK CARD PAYMENT', description_raw: null, merchant_raw: null, dedup_status: 'unique' },
      { id: 'b2', transaction_date: '2026-08-21', amount_original: 220, description_clean: 'TEST BANK CARD PAYMENT', description_raw: null, merchant_raw: null, dedup_status: 'unique' },
      { id: 'dup', transaction_date: '2026-08-20', amount_original: 220, description_clean: 'TEST BANK CARD PAYMENT', description_raw: null, merchant_raw: null, dedup_status: 'user_confirmed_duplicate' },
      { id: 'taken', transaction_date: '2026-08-20', amount_original: 220, description_clean: 'TEST BANK CARD PAYMENT', description_raw: null, merchant_raw: null, dedup_status: 'unique' },
    ];
    matchedRows = [{ linked_transaction_id: 'taken' }];
    await persistLiabilityStatementEvidence(
      'user-1',
      { id: 'doc-1' } as never,
      [
        { activityType: 'PURCHASE', activityDate: '2026-08-03', amount: 250, gstAmountRaw: '22.73', sourceRowNumber: 1 },
        { activityType: 'PAYMENT', activityDate: '2026-08-20', amount: 220, sourceRowNumber: 2 },
      ],
      { statementType: 'credit_card', countryCode: 'AU', currencyCode: 'AUD', institutionName: 'Test Bank', openingBalance: 0, closingBalance: 30 },
      ['row_4_zero_amount'],
      'fdh10_generic_liability_csv', '1.0.0', 0.7, 'credit_card',
    );
    const statement = rpcArgs!.p_statement as Record<string, unknown>;
    const activities = rpcArgs!.p_activities as Record<string, unknown>[];
    expect(statement.extraction_warnings).toEqual([{ code: 'zero_amount', row: 4 }]);
    expect(statement).toMatchObject({ purchases_total: 250, payments_total: 220, adjustments_total: null, capitalised_total: null, reconciliation_status: 'reconciled' });
    expect(activities[0].gst_amount_raw).toBe('22.73');
    expect(activities[1]).toMatchObject({ bank_match_status: 'multiple_candidates', linked_transaction_id: null, bank_match_candidate_ids: ['b1', 'b2'] });

    const txnQuery = calls.find((c) => c.table === 'fdh_transactions')!;
    const eqs = Object.fromEntries(txnQuery.filters.filter((f) => f[0] === 'eq').map((f) => [f[1], f[2]]));
    expect(eqs).toMatchObject({ user_id: 'user-1', credit_debit: 'debit', currency_original: 'AUD', approval_status: 'approved', amount_original: '220.0000' });
    expect(txnQuery.filters.some((f) => f[0] === 'order')).toBe(true);
  });
});

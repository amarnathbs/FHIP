/**
 * The read-model rules agree with the CERTIFIED FDH-7 approved-summary oracle
 * (lib/financial-data-hub/domain/approvedSummary.ts) on every case both
 * define -- one definition of spending, not a second one that drifts.
 *
 * A seeded generator builds 300 approved bank transactions on an ordinary
 * account (every economic type, splits, duplicates, confirmed and pending
 * refund links) and both implementations must produce the same bucket totals.
 * Also: every FDH economic_transaction_type has exactly one bucket (R9).
 */
import { describe, expect, it } from 'vitest';

import { computeApprovedFinancialSummary, type ApprovedSummaryTransaction } from '@/lib/financial-data-hub/domain/approvedSummary';
import { FDH_ECONOMIC_TRANSACTION_TYPES, type FdhEconomicTransactionType } from '@/lib/financial-data-hub/constants/enums';
import { fxContext } from '@/lib/read-models/core/currency';
import { emptyRawLedger, normaliseLedger, type LedgerTransactionRow } from '@/lib/read-models/core/ledger';
import { ECONOMIC_TYPE_BUCKET, bucketForType } from '@/lib/read-models/core/spendingRules';
import { explicitWindow } from '@/lib/read-models/core/window';

function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

describe('bucket map (registry rule R9)', () => {
  it('every FDH economic_transaction_type maps to exactly one bucket, and nothing else is mapped', () => {
    expect(Object.keys(ECONOMIC_TYPE_BUCKET).sort()).toEqual([...FDH_ECONOMIC_TRANSACTION_TYPES].sort());
  });

  it('facility rule: interest and fee on a card/loan facility are cost of debt; elsewhere spending', () => {
    expect(bucketForType('debt_interest', true)).toBe('cost_of_debt');
    expect(bucketForType('fee', true)).toBe('cost_of_debt');
    expect(bucketForType('debt_interest', false)).toBe('spending');
    expect(bucketForType('expense', true)).toBe('spending');
  });
});

describe('parity with the certified FDH-7 approved-summary oracle', () => {
  const window = explicitWindow('2026-08-01', '2026-08-31');
  const fx = fxContext('AUD', 56);

  for (const seed of [1, 7, 42]) {
    it(`seed ${seed}: identical totals for every bucket`, () => {
      const rand = rng(seed);
      const types = FDH_ECONOMIC_TRANSACTION_TYPES.filter((t) => t !== 'unknown') as FdhEconomicTransactionType[];
      const raw = emptyRawLedger();
      raw.accounts = [{ id: 'bank', account_type: 'transaction', display_name: 'Bank', currency_code: 'AUD', owner_role: null, liability_id: null }];
      raw.statements = [{ id: 's', financial_account_id: 'bank', statement_period_start: '2026-08-01', statement_period_end: '2026-08-31', document_type: 'bank_statement' }];
      const summaryTxns: ApprovedSummaryTransaction[] = [];
      for (let i = 0; i < 300; i += 1) {
        const id = `t${i}`;
        const type = types[Math.floor(rand() * types.length)];
        const amount = Math.round(rand() * 100000) / 100 + 1;
        const dedup = rand() < 0.08 ? 'user_confirmed_duplicate' : rand() < 0.04 ? 'duplicate_confirmed' : 'unique';
        const row: LedgerTransactionRow = {
          id, financial_account_id: 'bank', statement_upload_id: 's', transaction_date: `2026-08-${String(1 + (i % 28)).padStart(2, '0')}`,
          amount_original: amount, currency_original: 'AUD', credit_debit: 'debit', economic_transaction_type: type,
          category_id: null, subcategory_id: null, description_clean: null, dedup_status: dedup, approval_status: 'approved', user_override: false,
        };
        raw.transactions.push(row);
        const allocations: ApprovedSummaryTransaction['allocations'] = [];
        if (rand() < 0.15) {
          const first = Math.round(amount * 60) / 100;
          const t2 = types[Math.floor(rand() * types.length)];
          raw.allocations.push({ transaction_id: id, allocation_sequence: 1, economic_transaction_type: 'expense', category_id: null, subcategory_id: null, amount: first, currency_code: 'AUD' });
          raw.allocations.push({ transaction_id: id, allocation_sequence: 2, economic_transaction_type: t2, category_id: null, subcategory_id: null, amount: Math.round((amount - first) * 10000) / 10000, currency_code: 'AUD' });
          allocations.push({ economic_transaction_type: 'expense', category_id: null, amount: first, currency_code: 'AUD' });
          allocations.push({ economic_transaction_type: t2, category_id: null, amount: Math.round((amount - first) * 10000) / 10000, currency_code: 'AUD' });
        }
        summaryTxns.push({ id, amount_original: amount, currency_original: 'AUD', economic_transaction_type: type, category_id: null, dedup_status: dedup as ApprovedSummaryTransaction['dedup_status'], allocations });
      }
      // Confirmed refund links: each unsplit refund -> an unsplit, counted expense original.
      const originals = summaryTxns.filter((t) => t.economic_transaction_type === 'expense' && t.allocations.length === 0 && t.dedup_status === 'unique');
      const refunds = summaryTxns.filter((t) => t.economic_transaction_type === 'refund' && t.allocations.length === 0);
      const refundLinks: { refundTransactionId: string; originalTransactionId: string }[] = [];
      refunds.forEach((r, i) => {
        if (i % 2 === 0 && originals[i]) {
          refundLinks.push({ refundTransactionId: r.id, originalTransactionId: originals[i].id });
          raw.links.push({ id: `l${i}`, transaction_id_from: r.id, transaction_id_to: originals[i].id, link_type: 'refund_original', status: 'confirmed' });
        } else if (originals[i]) {
          raw.links.push({ id: `p${i}`, transaction_id_from: r.id, transaction_id_to: originals[i].id, link_type: 'refund_original', status: 'pending' });
        }
      });

      const oracle = computeApprovedFinancialSummary('AUD', summaryTxns, refundLinks);
      const ledger = normaliseLedger(raw, fx, window);
      const sum = (bucket: string) => Math.round(ledger.lines.filter((l) => l.bucket === bucket).reduce((s, l) => s + l.amountNative, 0) * 100) / 100;
      const netted = ledger.nettedRefunds.reduce((s, n) => s + n.refund.amountNative, 0);
      const allRefunds = [...ledger.nettedRefunds.map((n) => n.refund), ...ledger.unlinkedRefunds].reduce((s, l) => s + l.amountNative, 0);
      const round = (n: number) => Math.round(n * 100) / 100;

      expect(refundLinks.length).toBeGreaterThan(0); // anti-vacuity: netting really exercised
      expect(ledger.excludedDuplicates).toBe(oracle.duplicate_excluded_count);
      expect(round(sum('spending') - netted)).toBe(round(oracle.expense_total + oracle.fee_total + oracle.tax_total + oracle.debt_interest_total));
      expect(sum('income')).toBe(round(oracle.income_total));
      expect(sum('transfer')).toBe(round(oracle.transfer_total));
      expect(sum('investment')).toBe(round(oracle.investment_total));
      expect(sum('cash_withdrawal')).toBe(round(oracle.cash_withdrawal_total));
      expect(sum('debt_principal')).toBe(round(oracle.debt_principal_total));
      expect(sum('asset_purchase')).toBe(round(oracle.asset_purchase_total));
      expect(sum('asset_sale')).toBe(round(oracle.asset_sale_total));
      expect(round(allRefunds)).toBe(round(oracle.refund_total));
    });
  }
});

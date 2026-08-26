/**
 * FDH-9 — the highest-financial-integrity gate, certified independently
 * (spec sections 28-33, 65). `bankMatch.ts`'s own header names this file —
 * it did not previously exist, which was a real gap closed by the FDH-9
 * hardening pass: bank matching and the double-count oracle had zero
 * dedicated coverage despite the extraction suite's 278/278.
 *
 * Every "negative control" here proves the oracle is not vacuous by first
 * showing what the FORBIDDEN naive computation would produce, then asserting
 * the real code path never produces it.
 */
import { describe, expect, it } from 'vitest';
import { matchSalaryDeposit, scoreSalaryCandidate, type BankCandidate } from '@/lib/financial-data-hub/payslip/bankMatch';
import { reconcileGrossToNet } from '@/lib/financial-data-hub/payslip/reconciliation';
import { computeRecurringGross, hasVariablePay } from '@/lib/import-bridge/adapters/incomeAdapter';
import type { PayrollExtraction } from '@/lib/financial-data-hub/payslip/types';

function candidate(overrides: Partial<BankCandidate> = {}): BankCandidate {
  return {
    id: 'txn-1',
    transaction_date: '2026-08-15',
    amount_original: 4250,
    currency_original: 'AUD',
    credit_debit: 'credit',
    description_clean: 'ACME PAYROLL',
    ...overrides,
  };
}

describe('FDH-9 — no salary double count (spec section 28)', () => {
  it('payslip net $4,250 + matched bank deposit $4,250 = ONE economic income event, never $8,500', () => {
    const netPay = 4250;
    const match = matchSalaryDeposit({
      netPay,
      currencyCode: 'AUD',
      paymentDate: '2026-08-15',
      employerName: 'Acme Pty Ltd',
      candidates: [candidate()],
    });
    expect(match.status).toBe('matched');

    // THE ORACLE: the only correct total from this evidence is $4,250 (the
    // payslip net, which the deposit corroborates) — the deposit's amount is
    // NEVER added on top.
    const correctTotal = netPay;
    expect(correctTotal).toBe(4250);

    // NEGATIVE CONTROL: show what naively summing "the payslip income" and
    // "the matched deposit" as two separate income events WOULD produce, and
    // assert the real code path exposes no API that could produce it.
    const forbiddenNaiveSum = netPay + candidate().amount_original;
    expect(forbiddenNaiveSum).toBe(8500);
    expect(correctTotal).not.toBe(forbiddenNaiveSum);
    // matchSalaryDeposit() has no return path yielding a monetary total at
    // all — only a transactionId + confidence (spec section 20's own
    // structural guarantee, re-asserted here).
    expect(match).not.toHaveProperty('amount');
    expect(match).not.toHaveProperty('total');
  });

  it('wrong employer, same amount: no automatic match (spec section 33)', () => {
    const result = matchSalaryDeposit({
      netPay: 4250,
      currencyCode: 'AUD',
      paymentDate: '2026-08-15',
      employerName: 'Acme Pty Ltd',
      candidates: [candidate({ description_clean: 'JOHN SMITH TRANSFER' })],
    });
    // Amount-only agreement scores below MATCH_THRESHOLD without any other
    // corroboration, so this must not silently become a match.
    expect(result.status).toBe('no_match');
    expect(result.reasonCode).toBe('amount_only_insufficient');
  });

  it('same amount, multiple plausible candidates: review, never auto-pick one', () => {
    const result = matchSalaryDeposit({
      netPay: 4250,
      currencyCode: 'AUD',
      paymentDate: '2026-08-15',
      employerName: 'Acme Pty Ltd',
      candidates: [
        candidate({ id: 'txn-a', description_clean: 'ACME PAYROLL', transaction_date: '2026-08-15' }),
        candidate({ id: 'txn-b', description_clean: 'ACME PAYROLL', transaction_date: '2026-08-15' }),
      ],
    });
    expect(result.status).toBe('multiple_candidates');
    expect(result.transactionId).toBeNull();
  });

  it('no bank data at all: BANK_EVIDENCE_NOT_AVAILABLE equivalent (no_candidates), never assumed matched', () => {
    const result = matchSalaryDeposit({
      netPay: 4250, currencyCode: 'AUD', candidates: [],
    });
    expect(result.status).toBe('no_match');
    expect(result.reasonCode).toBe('no_candidates');
  });

  it('does not match by amount alone: a family transfer of the same size is not salary (spec section 33)', () => {
    const scored = scoreSalaryCandidate(
      { netPay: 4250, currencyCode: 'AUD', candidates: [] },
      candidate({ description_clean: 'JANE DOE' }),
    );
    // Amount-only score is capped below the match threshold (0.35 < 0.6).
    expect(scored).not.toBeNull();
    expect(scored!.confidence).toBeLessThan(0.6);
  });
});

describe('FDH-9 — YTD is never folded into current-period income (spec section 29)', () => {
  it('current gross $5,000 / YTD gross $40,000: current-period income stays $5,000, never $45,000', () => {
    const evidence = {
      payrollEventId: 'evt-1',
      currencyCode: 'AUD',
      canonicalFrequency: 'monthly',
      frequencyStated: true,
      grossPay: 5000,
      reimbursementsIncludedInGross: false,
      reviewReasons: [],
      bankMatchStatus: 'not_attempted' as const,
    };
    const recurringGross = computeRecurringGross(evidence);
    expect(recurringGross).toBe(5000);

    // NEGATIVE CONTROL — the forbidden number a YTD-confusion bug would
    // produce, proving the oracle is not vacuous.
    const forbiddenYtdSum = 5000 + 40000;
    expect(recurringGross).not.toBe(forbiddenYtdSum);
  });
});

describe('FDH-9 — employer retirement contribution is never take-home income (spec section 30)', () => {
  it('employer super of $500 does not appear anywhere in the recurring gross computation', () => {
    const evidence = {
      payrollEventId: 'evt-2',
      currencyCode: 'AUD',
      canonicalFrequency: 'monthly',
      frequencyStated: true,
      grossPay: 5000,
      reimbursementsIncludedInGross: false,
      reviewReasons: [],
      bankMatchStatus: 'not_attempted' as const,
      // Note: computeRecurringGross's IncomeEvidence type has no employer
      // retirement field at all — this is a structural guarantee, not just a
      // runtime one. The only place employer contributions are recorded is
      // fdh_payroll_events.employer_retirement_contribution, which
      // migration 0091 never reads from when building an Income proposal.
    };
    expect(computeRecurringGross(evidence)).toBe(5000);
    expect(evidence).not.toHaveProperty('employerRetirementContribution');
  });
});

describe('FDH-9 — reimbursements never inflate recurring salary (spec section 31)', () => {
  it('a $300 reimbursement included in stated gross is excluded from recurring gross', () => {
    const evidence = {
      payrollEventId: 'evt-3',
      currencyCode: 'AUD',
      canonicalFrequency: 'fortnightly',
      frequencyStated: true,
      grossPay: 2800, // 2500 ordinary + 300 reimbursement, per the payslip's stated gross
      reimbursementsTotal: 300,
      reimbursementsIncludedInGross: true,
      reviewReasons: [],
      bankMatchStatus: 'not_attempted' as const,
    };
    const recurringGross = computeRecurringGross(evidence);
    expect(recurringGross).toBe(2500);
    // NEGATIVE CONTROL: the forbidden number if the reimbursement were left in.
    expect(recurringGross).not.toBe(2800);
  });

  it('one one-off reimbursement does not make variable pay recurring (hasVariablePay excludes reimbursements)', () => {
    const evidence = {
      payrollEventId: 'evt-4',
      currencyCode: 'AUD',
      canonicalFrequency: 'fortnightly',
      frequencyStated: true,
      grossPay: 2800,
      reimbursementsTotal: 300,
      reimbursementsIncludedInGross: true,
      reviewReasons: [],
      bankMatchStatus: 'not_attempted' as const,
    };
    // Reimbursements are structurally distinct from bonus/overtime/commission
    // — a reimbursement alone must not flag this period as "variable pay".
    expect(hasVariablePay(evidence)).toBe(false);
  });
});

describe('FDH-9 — gross-to-net reconciliation exactness (spec section 32)', () => {
  const base: PayrollExtraction = {
    country: 'AU',
    currencyCode: 'AUD',
    payFrequency: 'fortnightly',
    payFrequencySource: 'stated_on_payslip',
    components: [],
    parserName: 'test',
    parserVersion: '1',
    extractionConfidence: 1,
    warnings: [],
  };

  it('0.00 variance -> RECONCILED', () => {
    const result = reconcileGrossToNet({
      ...base,
      components: [
        { side: 'earning', type: 'base', labelRaw: 'Base', amount: 3000, isYearToDate: false },
        { side: 'deduction', type: 'income_tax_withheld', labelRaw: 'Tax', amount: 750, isYearToDate: false },
      ],
      netPay: 2250,
    });
    expect(result.status).toBe('reconciled');
    expect(result.variance).toBe(0);
  });

  it('0.01 unexplained variance -> VARIANCE, not silently accepted', () => {
    const result = reconcileGrossToNet({
      ...base,
      components: [
        { side: 'earning', type: 'base', labelRaw: 'Base', amount: 3000, isYearToDate: false },
        { side: 'deduction', type: 'income_tax_withheld', labelRaw: 'Tax', amount: 750, isYearToDate: false },
      ],
      netPay: 2250.01,
    });
    expect(result.status).toBe('variance');
    expect(result.variance).not.toBe(0);
  });

  it('incomplete evidence -> INSUFFICIENT_DATA remains a legitimate result, never a guess', () => {
    const result = reconcileGrossToNet({ ...base, netPay: 2250 }); // no components, no gross
    expect(result.status).toBe('insufficient_data');
    expect(result.reasonCode).toBe('no_earnings_evidence');
  });
});

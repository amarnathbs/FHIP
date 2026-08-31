/**
 * FDH-12 — payslip contribution reconciliation (spec sections 23-32, 64-67,
 * 120).
 *
 * FDH-9 already extracts employer retirement evidence from payslips. FDH-12
 * must RECONCILE with it, not build a second contribution engine. This file
 * certifies the matching rules, and in particular the three negative controls
 * the brief names: wrong employer (26), multiple candidates (27), and amount
 * mismatch (66).
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  matchContributionToPayslip,
  reconciledContributionMinorUnits,
  PAYSLIP_MATCH_WINDOW_DAYS_FORWARD,
  PAYSLIP_MATCH_WINDOW_DAYS_BACKWARD,
  PAYSLIP_MATCH_AMOUNT_TOLERANCE_MINOR_UNITS,
  type PayrollEventEvidence,
  type FundContributionEvidence,
} from '@/lib/financial-data-hub/retirement/payslipReconciliation';
import { parseMoneyToMinorUnits } from '@/lib/financial-data-hub/retirement/money';

const M = (s: string) => parseMoneyToMinorUnits(s);

function payslip(overrides: Partial<PayrollEventEvidence> & { id: string }): PayrollEventEvidence {
  return {
    employer_name: 'Acme Pty Ltd',
    employer_normalised: 'acme',
    pay_period_start: '2026-07-01',
    pay_period_end: '2026-07-31',
    payment_date: '2026-07-31',
    currency_code: 'AUD',
    employer_retirement_contribution: '1000.00',
    employee_retirement_contribution: null,
    ...overrides,
  };
}

function fundContribution(overrides: Partial<FundContributionEvidence> = {}): FundContributionEvidence {
  return {
    activityType: 'EMPLOYER_CONTRIBUTION',
    amount: '1000.00',
    currencyCode: 'AUD',
    activityDate: '2026-08-14',
    employerNameRaw: 'Acme Pty Ltd',
    ...overrides,
  };
}

// ===========================================================================
// spec 24 — never amount alone
// ===========================================================================

describe('FDH-12 spec 24 — the match key is employer + amount + date', () => {
  it('matches when all three agree', () => {
    const r = matchContributionToPayslip(fundContribution(), [payslip({ id: 'p1' })]);
    expect(r.status).toBe('matched');
    expect(r.payrollEventId).toBe('p1');
    expect(r.reason).toBe('matched_on_employer_amount_and_date');
  });

  it('does NOT match on amount alone when the employer is missing on the fund side', () => {
    const r = matchContributionToPayslip(
      fundContribution({ employerNameRaw: null }),
      [payslip({ id: 'p1' })],
    );
    expect(r.status).toBe('no_match');
  });

  it('does NOT match on amount alone when the employer is missing on the payslip side', () => {
    const r = matchContributionToPayslip(
      fundContribution(),
      [payslip({ id: 'p1', employer_name: null, employer_normalised: null })],
    );
    expect(r.status).toBe('no_match');
  });

  it('does NOT match on amount alone when neither has a usable date', () => {
    const r = matchContributionToPayslip(
      fundContribution({ activityDate: null, effectivePeriodStart: null }),
      [payslip({ id: 'p1', payment_date: null, pay_period_end: null, pay_period_start: null })],
    );
    expect(r.status).toBe('no_match');
  });
});

// ===========================================================================
// spec 26 — the wrong-employer negative control
// ===========================================================================

describe('FDH-12 spec 26 — wrong employer, same amount', () => {
  it('Employer A $1,000 does not match Employer B $1,000', () => {
    const r = matchContributionToPayslip(
      fundContribution({ employerNameRaw: 'Employer A' }),
      [payslip({ id: 'p-b', employer_name: 'Employer B', employer_normalised: 'employer b' })],
    );
    expect(r.status).toBe('no_match');
    expect(r.payrollEventId).toBeNull();
  });

  it('picks the RIGHT employer when both are present with the same amount', () => {
    const r = matchContributionToPayslip(
      fundContribution({ employerNameRaw: 'Employer B' }),
      [
        payslip({ id: 'p-a', employer_name: 'Employer A', employer_normalised: 'employer a' }),
        payslip({ id: 'p-b', employer_name: 'Employer B', employer_normalised: 'employer b' }),
      ],
    );
    expect(r.status).toBe('matched');
    expect(r.payrollEventId).toBe('p-b');
  });

  it('ignores legal-suffix noise so "Acme Pty Ltd" matches "Acme"', () => {
    const r = matchContributionToPayslip(
      fundContribution({ employerNameRaw: 'ACME PTY LTD' }),
      [payslip({ id: 'p1', employer_name: 'Acme', employer_normalised: 'acme' })],
    );
    expect(r.status).toBe('matched');
  });
});

// ===========================================================================
// spec 25 / 67 — contribution timing
// ===========================================================================

describe('FDH-12 spec 25/67 — contributions arrive after payroll', () => {
  it('does not require same-day matching', () => {
    // Payroll 31 July, fund credits 14 August — a completely ordinary delay.
    const r = matchContributionToPayslip(
      fundContribution({ activityDate: '2026-08-14' }),
      [payslip({ id: 'p1', payment_date: '2026-07-31' })],
    );
    expect(r.status).toBe('matched');
    expect(r.candidates[0].dayGap).toBe(14);
  });

  it('accepts the full statutory quarterly cycle (28 October for a July period)', () => {
    const r = matchContributionToPayslip(
      fundContribution({ activityDate: '2026-10-28' }),
      [payslip({ id: 'p1', payment_date: '2026-07-31' })],
    );
    expect(r.status).toBe('matched');
  });

  it('rejects a delay beyond the documented window', () => {
    const r = matchContributionToPayslip(
      fundContribution({ activityDate: '2027-03-01' }),
      [payslip({ id: 'p1', payment_date: '2026-07-31' })],
    );
    expect(r.status).toBe('no_match');
  });

  it('the window is asymmetric — super arrives after payroll, not long before', () => {
    expect(PAYSLIP_MATCH_WINDOW_DAYS_FORWARD).toBeGreaterThan(PAYSLIP_MATCH_WINDOW_DAYS_BACKWARD);
    // A fund credit two months BEFORE the payslip is not that payslip's super.
    const r = matchContributionToPayslip(
      fundContribution({ activityDate: '2026-05-31' }),
      [payslip({ id: 'p1', payment_date: '2026-07-31' })],
    );
    expect(r.status).toBe('no_match');
  });

  it('matches on the STATED pay period when no credit date is given', () => {
    const r = matchContributionToPayslip(
      fundContribution({ activityDate: null, effectivePeriodStart: '2026-07-01' }),
      [payslip({ id: 'p1', pay_period_start: '2026-07-01', payment_date: null, pay_period_end: null })],
    );
    expect(r.status).toBe('matched');
  });

  it('does not produce a FALSE duplicate from a realistic delay', () => {
    // Two consecutive months' contributions, each credited two weeks late.
    // Each must match its OWN payslip, not the other's.
    const july = matchContributionToPayslip(
      fundContribution({ amount: '1000.00', activityDate: '2026-08-14' }),
      [
        payslip({ id: 'p-jul', payment_date: '2026-07-31', employer_retirement_contribution: '1000.00' }),
        payslip({ id: 'p-aug', payment_date: '2026-08-31', employer_retirement_contribution: '1100.00' }),
      ],
    );
    expect(july.payrollEventId).toBe('p-jul');
  });
});

// ===========================================================================
// spec 27 — multiple candidates
// ===========================================================================

describe('FDH-12 spec 27 — multiple plausible matches go to review', () => {
  it('returns REVIEW rather than choosing the first', () => {
    const r = matchContributionToPayslip(fundContribution(), [
      payslip({ id: 'p1', payment_date: '2026-07-31' }),
      payslip({ id: 'p2', payment_date: '2026-08-14' }),
    ]);
    expect(r.status).toBe('multiple_candidates');
    expect(r.payrollEventId).toBeNull();
    expect(r.candidates.length).toBe(2);
  });

  it('lists every candidate so the user can choose', () => {
    const r = matchContributionToPayslip(fundContribution(), [
      payslip({ id: 'p1', payment_date: '2026-07-31' }),
      payslip({ id: 'p2', payment_date: '2026-08-14' }),
    ]);
    expect(r.candidates.map((c) => c.payrollEventId).sort()).toEqual(['p1', 'p2']);
  });
});

// ===========================================================================
// spec 66 — payslip/fund amount mismatch
// ===========================================================================

describe('FDH-12 spec 66 — payslip $1,000 vs fund $950', () => {
  it('does NOT silently choose one', () => {
    const r = matchContributionToPayslip(
      fundContribution({ amount: '950.00' }),
      [payslip({ id: 'p1', employer_retirement_contribution: '1000.00' })],
    );
    expect(r.status).toBe('variance_review_required');
    expect(r.payrollEventId).toBeNull();
  });

  it('reports the exact variance so the user can see the gap', () => {
    const r = matchContributionToPayslip(
      fundContribution({ amount: '950.00' }),
      [payslip({ id: 'p1', employer_retirement_contribution: '1000.00' })],
    );
    expect(r.varianceMinorUnits).toBe(-M('50.00'));
  });

  it('the amount tolerance is genuinely zero — even $0.01 is not absorbed', () => {
    expect(PAYSLIP_MATCH_AMOUNT_TOLERANCE_MINOR_UNITS).toBe(BigInt(0));
    const r = matchContributionToPayslip(
      fundContribution({ amount: '1000.01' }),
      [payslip({ id: 'p1', employer_retirement_contribution: '1000.00' })],
    );
    expect(r.status).toBe('variance_review_required');
  });

  it('reconciledContributionMinorUnits refuses to pick a side on disagreement', () => {
    expect(reconciledContributionMinorUnits('950.00', '1000.00')).toBeNull();
  });

  it('an unrelated amount is not offered as a variance candidate at all', () => {
    const r = matchContributionToPayslip(
      fundContribution({ amount: '5.00' }),
      [payslip({ id: 'p1', employer_retirement_contribution: '1000.00' })],
    );
    expect(r.status).toBe('no_match');
  });
});

// ===========================================================================
// spec 65 — missing payslip is not a rejection
// ===========================================================================

describe('FDH-12 spec 65 — fund contribution without a payslip is still valid', () => {
  it('reports PAYSLIP_EVIDENCE_NOT_AVAILABLE, not a failure', () => {
    const r = matchContributionToPayslip(fundContribution(), []);
    expect(r.status).toBe('payslip_evidence_not_available');
    expect(r.reason).toBe('no_payslip_evidence_on_file');
  });

  it('the evidence still stands on its own for reconciliation', () => {
    expect(reconciledContributionMinorUnits('1000.00', null)).toBe(M('1000.00'));
  });

  it('a no-match is DIFFERENT from no-evidence', () => {
    // Payslips exist but none matches — a meaningfully different state, so
    // the UI can say "no matching payslip" rather than "no payslips".
    const r = matchContributionToPayslip(
      fundContribution({ employerNameRaw: 'Someone Else' }),
      [payslip({ id: 'p1' })],
    );
    expect(r.status).toBe('no_match');
    expect(r.status).not.toBe('payslip_evidence_not_available');
  });
});

// ===========================================================================
// spec 29-32 — semantics preserved
// ===========================================================================

describe('FDH-12 spec 29-32 — contribution semantics', () => {
  it('a PERSONAL contribution is matched against the EMPLOYEE payslip column', () => {
    const r = matchContributionToPayslip(
      fundContribution({ activityType: 'PERSONAL_CONTRIBUTION', amount: '200.00', employerNameRaw: null }),
      [payslip({ id: 'p1', employee_retirement_contribution: '200.00', employer_retirement_contribution: '1000.00' })],
    );
    expect(r.status).toBe('matched');
  });

  it('a personal contribution is exempt from the employer requirement', () => {
    // It is made by the member, not an employer, so employer is not part of
    // its key. Its key remains amount + date, never amount alone.
    const r = matchContributionToPayslip(
      fundContribution({ activityType: 'PERSONAL_CONTRIBUTION', amount: '200.00', employerNameRaw: null }),
      [payslip({ id: 'p1', employer_name: null, employer_normalised: null, employee_retirement_contribution: '200.00' })],
    );
    expect(r.status).toBe('matched');
  });

  it('SALARY SACRIFICE is matched against the employer-routed column', () => {
    const r = matchContributionToPayslip(
      fundContribution({ activityType: 'SALARY_SACRIFICE', amount: '1000.00' }),
      [payslip({ id: 'p1' })],
    );
    expect(r.status).toBe('matched');
  });

  it('spec 31: never recomputes gross salary or tax from the statement', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', 'lib', 'financial-data-hub', 'retirement', 'payslipReconciliation.ts'),
      'utf8',
    ).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(/gross_pay|grossPay|tax_withheld|taxWithheld|net_pay|netPay/.test(src)).toBe(false);
  });

  it('never writes back to FDH-9 payroll evidence', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', 'lib', 'financial-data-hub', 'services', 'retirementStatementProcessingService.ts'),
      'utf8',
    ).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(/from\('fdh_payroll_events'\)[\s\S]{0,120}?\.(insert|update|upsert|delete)\(/.test(src)).toBe(false);
    expect(/from\('fdh_payroll_components'\)/.test(src)).toBe(false);
  });
});

// ===========================================================================
// spec 68 — currency
// ===========================================================================

describe('FDH-12 spec 68 — currency is never crossed', () => {
  it('an INR payslip never matches an AUD fund contribution', () => {
    const r = matchContributionToPayslip(
      fundContribution({ currencyCode: 'AUD' }),
      [payslip({ id: 'p1', currency_code: 'INR' })],
    );
    expect(r.status).toBe('no_match');
  });
});

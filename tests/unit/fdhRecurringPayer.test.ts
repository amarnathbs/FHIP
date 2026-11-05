/**
 * Repeating payer -> salary or loan repayment (PO 05-11-2026). Synthetic payers and amounts only.
 *
 * Pinned here: a payer that arrives on a regular schedule for a near-constant amount is proposed as income (salary, or rental / pension / government
 * type when the text says so); a fixed repeating debit is proposed as a loan repayment ONLY when the payee text carries loan wording; and every look-alike
 * that must NOT match (too few lines, irregular gaps, wildly different amounts, card purchases, person-to-person rails, refund / interest / tax wording,
 * rent with no loan wording) is left alone.
 */
import { describe, it, expect } from 'vitest';
import { detectCadence, proposeRecurringPayers, type RecurringPayerLine } from '@/lib/financial-data-hub/classification/recurringPayer';

let n = 0;
function line(over: Partial<RecurringPayerLine> & Pick<RecurringPayerLine, 'creditDebit' | 'date' | 'amount'>): RecurringPayerLine {
  n += 1;
  return { id: `t${n}`, description: 'ACME HOLDINGS PTY LTD', currency: 'AUD', ...over };
}
/** A series every `stepDays` from `start`, `count` times, amounts from `amounts` (cycled). */
function series(stepDays: number, count: number, start: string, build: (i: number, date: string) => Partial<RecurringPayerLine> & Pick<RecurringPayerLine, 'creditDebit' | 'amount'>): RecurringPayerLine[] {
  const out: RecurringPayerLine[] = [];
  for (let i = 0; i < count; i += 1) {
    const date = new Date(Date.parse(start) + i * stepDays * 86_400_000).toISOString().slice(0, 10);
    out.push(line({ date, ...build(i, date) }));
  }
  return out;
}
const pay = (i: number) => ({ creditDebit: 'credit' as const, amount: 3800 + (i % 3) * 20, description: `${10000 + i} Acme Payroll Services ${50000 + i}` });

describe('cadence', () => {
  const dates = (step: number, count: number) => series(step, count, '2026-01-01', () => ({ creditDebit: 'credit', amount: 1 })).map((l) => l.date);
  it('weekly, fortnightly and monthly are found', () => {
    expect(detectCadence(dates(7, 6))).toBe('weekly');
    expect(detectCadence(dates(14, 6))).toBe('fortnightly');
    expect(detectCadence(dates(30, 6))).toBe('monthly');
  });
  it('a missed period (a gap of two cadences, e.g. between two statements) is tolerated', () => {
    const d = dates(14, 8);
    d.splice(4, 1); // one fortnight missing
    expect(detectCadence(d)).toBe('fortnightly');
  });
  it('LOOK-ALIKES: fewer than 4 dates, irregular gaps, and mostly-missed periods are not a cadence', () => {
    expect(detectCadence(dates(14, 3))).toBeNull();
    expect(detectCadence(['2026-01-01', '2026-01-04', '2026-02-20', '2026-02-23', '2026-05-30', '2026-06-01'])).toBeNull();
    expect(detectCadence(['2026-01-01', '2026-01-15', '2026-04-01', '2026-07-30', '2026-12-25'])).toBeNull();
  });
});

describe('credits: regular income', () => {
  it('26 fortnightly credits from one payer (reference numbers changing) are proposed as Income, Salary & Wages', () => {
    const ps = proposeRecurringPayers(series(14, 26, '2025-07-01', (i) => pay(i)));
    expect(ps).toHaveLength(26);
    expect(ps.every((p) => p.categoryKey === 'income' && p.subcategoryKey === 'salary_wages' && p.cadence === 'fortnightly')).toBe(true);
  });

  it('pay that varies with overtime (within 25 percent) is still salary', () => {
    const ps = proposeRecurringPayers(series(14, 8, '2026-01-01', (i) => ({ creditDebit: 'credit', amount: [3800, 4100, 3700, 4300, 3900, 3800, 4200, 3800][i] })));
    expect(ps).toHaveLength(8);
  });

  it('the type follows the wording: rent, pension and government payers', () => {
    const typed = (description: string) => proposeRecurringPayers(series(30, 6, '2026-01-01', () => ({ creditDebit: 'credit', amount: 2100, description })))[0]?.subcategoryKey;
    expect(typed('Ray White Real Estate Rent')).toBe('rental_income');
    expect(typed('Super Pension Payment')).toBe('pension_income');
    expect(typed('Centrelink Payment')).toBe('government_benefit');
  });

  it('LOOK-ALIKES: too few lines, irregular dates, very different amounts, and a mix of payers are not proposed', () => {
    expect(proposeRecurringPayers(series(14, 3, '2026-01-01', (i) => pay(i)))).toEqual([]);
    const irregular = ['2026-01-01', '2026-01-05', '2026-02-20', '2026-02-22', '2026-05-30', '2026-06-01'].map((date, i) => line({ date, ...pay(i) }));
    expect(proposeRecurringPayers(irregular)).toEqual([]);
    expect(proposeRecurringPayers(series(14, 8, '2026-01-01', (i) => ({ creditDebit: 'credit', amount: [100, 2000, 50, 3000, 10, 9000, 70, 1500][i] })))).toEqual([]);
  });

  it('LOOK-ALIKES: refund, interest, dividend and tax wording, card purchases and person-to-person rails are never salary', () => {
    for (const description of ['Acme Refund', 'Acme Interest Payment', 'Acme Dividend', 'ATO Payment', 'Acme Fee Reversal']) {
      expect(proposeRecurringPayers(series(14, 8, '2026-01-01', () => ({ creditDebit: 'credit', amount: 500, description }))), description).toEqual([]);
    }
    expect(proposeRecurringPayers(series(14, 8, '2026-01-01', () => ({ creditDebit: 'credit', amount: 500, description: 'VISA-ACME CAFE MELBOURNE' })))).toEqual([]);
    expect(proposeRecurringPayers(series(14, 8, '2026-01-01', () => ({ creditDebit: 'credit', amount: 500, description: 'Osko Payment From Riley Tenant Rent' })))).toEqual([]);
  });

  it('currencies are never mixed: the same payer in two currencies is two groups', () => {
    const aud = series(14, 3, '2026-01-01', (i) => pay(i));
    const inr = series(14, 3, '2026-02-01', (i) => ({ ...pay(i), currency: 'INR' }));
    expect(proposeRecurringPayers([...aud, ...inr])).toEqual([]);
  });
});

describe('debits: loan repayments', () => {
  const loan = (description: string, amount = 215.5) => series(30, 11, '2026-01-01', () => ({ creditDebit: 'debit', amount, description }));

  it('a fixed monthly debit to a payee whose text says loan or finance is a loan repayment', () => {
    for (const d of ['SOLVIC IN883 STSOLARVIC 4471', 'Solar Victoria Instalment', 'Sample Vehicle Finance Pty', 'Acme Equipment Lease']) {
      const ps = proposeRecurringPayers(loan(d));
      expect(ps, d).toHaveLength(11);
      expect(ps[0]).toMatchObject({ categoryKey: 'loan_principal', subcategoryKey: 'other_loan_principal', cadence: 'monthly' });
    }
  });

  it('LOOK-ALIKE THAT MATTERS MOST: a fixed monthly debit with NO loan wording (rent, gym, insurance) is not guessed', () => {
    for (const d of ['Ray White Rentals', 'Fitness First Membership', 'Sample Insurance Premium', 'Mystery Payee Pty']) {
      expect(proposeRecurringPayers(loan(d)), d).toEqual([]);
    }
  });

  it('LOOK-ALIKES: a loan-worded payee whose amount varies, whose gaps are irregular, or that is a card purchase is not proposed', () => {
    expect(proposeRecurringPayers(series(30, 11, '2026-01-01', (i) => ({ creditDebit: 'debit', amount: 100 + i * 40, description: 'Sample Loan Co' })))).toEqual([]);
    const irregular = ['2026-01-01', '2026-01-06', '2026-03-20', '2026-03-23', '2026-08-01'].map((date) => line({ date, creditDebit: 'debit', amount: 215.5, description: 'Sample Loan Co' }));
    expect(proposeRecurringPayers(irregular)).toEqual([]);
    expect(proposeRecurringPayers(loan('EFTPOS SAMPLE LOAN CAFE'))).toEqual([]);
  });

  it('a loan fee is a fee, not a repayment', () => {
    expect(proposeRecurringPayers(loan('Sample Loan Account Fee'))).toEqual([]);
  });
});

describe('NEGATIVE CONTROL', () => {
  it('the same debit series WITH loan wording is proposed and WITHOUT it is not, so the wording test above really bites', () => {
    const base = (d: string) => series(30, 6, '2026-01-01', () => ({ creditDebit: 'debit', amount: 300, description: d }));
    expect(proposeRecurringPayers(base('Sample Loan Co')).length).toBeGreaterThan(0);
    expect(proposeRecurringPayers(base('Sample Co'))).toHaveLength(0);
  });
});

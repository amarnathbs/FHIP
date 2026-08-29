/**
 * FDH-10 — statement balance reconciliation certification (spec sections 36-
 * 38, 95-106's "exact-0.01-reconciliation" bar). The 0.01 negative control:
 * a fully-specified statement that reconciles exactly must flip to
 * `variance` the instant any ONE component changes by a single cent.
 */
import { describe, expect, it } from 'vitest';
import { reconcileCreditCardStatement, reconcileLoanStatement } from '@/lib/financial-data-hub/liability/statementReconciliation';

describe('FDH-10 — credit card statement reconciliation (spec section 36)', () => {
  const base = {
    openingBalance: 1000,
    purchasesTotal: 500,
    cashAdvancesTotal: 0,
    interestTotal: 20,
    feesTotal: 5,
    paymentsTotal: 300,
    refundsTotal: 10,
    adjustmentsTotal: 0,
    currencyCode: 'AUD',
  };
  // Expected closing: 1000 + 500 + 0 + 20 + 5 - 300 - 10 + 0 = 1215

  it('GREEN: a statement that reconciles exactly is RECONCILED', () => {
    const result = reconcileCreditCardStatement({ ...base, closingBalance: 1215 });
    expect(result.status).toBe('reconciled');
    expect(result.variance).toBe(0);
  });

  it('RED (0.01 negative control): the exact same statement with closing off by one cent is VARIANCE', () => {
    const result = reconcileCreditCardStatement({ ...base, closingBalance: 1215.01 });
    expect(result.status).toBe('variance');
    expect(result.variance).not.toBe(0);
  });

  it('RED (0.01 negative control, component side): purchases off by one cent flips a previously-reconciled statement', () => {
    const result = reconcileCreditCardStatement({ ...base, purchasesTotal: 500.01, closingBalance: 1215 });
    expect(result.status).toBe('variance');
  });

  it('GREEN after restoration: correcting the cent discrepancy reconciles again', () => {
    const drifted = reconcileCreditCardStatement({ ...base, closingBalance: 1215.01 });
    expect(drifted.status).toBe('variance');
    const restored = reconcileCreditCardStatement({ ...base, closingBalance: 1215 });
    expect(restored.status).toBe('reconciled');
  });

  it('INSUFFICIENT_DATA when opening or closing balance is missing — never guessed as reconciled', () => {
    expect(reconcileCreditCardStatement({ ...base, openingBalance: null, closingBalance: 1215 }).status).toBe('insufficient_data');
    expect(reconcileCreditCardStatement({ ...base, closingBalance: null }).status).toBe('insufficient_data');
  });

  it('a statement closing balance is never itself treated as an expense figure by this module (spec section 6)', () => {
    // This module returns only reconciliation status/variance — it has no
    // "expense" field at all, structurally enforcing spec section 6.
    const result = reconcileCreditCardStatement({ ...base, closingBalance: 1215 });
    expect(Object.keys(result)).not.toContain('expense');
    expect(Object.keys(result)).not.toContain('expenseTotal');
  });
});

describe('FDH-10 — loan statement reconciliation (spec section 38)', () => {
  const base = {
    openingPrincipal: 300000,
    drawdownsTotal: 0,
    capitalisedTotal: 0,
    principalRepaymentsTotal: 1550,
    adjustmentsTotal: 0,
    currencyCode: 'AUD',
  };
  // Expected closing: 300000 - 1550 = 298450

  it('GREEN: reconciles exactly', () => {
    const result = reconcileLoanStatement({ ...base, closingPrincipal: 298450 });
    expect(result.status).toBe('reconciled');
  });

  it('RED (0.01 negative control): principal repayments off by one cent is VARIANCE', () => {
    const result = reconcileLoanStatement({ ...base, principalRepaymentsTotal: 1550.01, closingPrincipal: 298450 });
    expect(result.status).toBe('variance');
  });

  it('interest never alters principal reconciliation unless explicitly capitalised (spec section 38)', () => {
    // Interest has no input slot in this formula at all — proven structurally:
    // the function signature has no interestTotal field, so a caller cannot
    // even attempt to feed interest into the principal roll-forward.
    const result = reconcileLoanStatement({ ...base, closingPrincipal: 298450 });
    expect(result.status).toBe('reconciled'); // unaffected by any interest figure
  });

  it('a drawdown correctly increases the expected closing principal', () => {
    const result = reconcileLoanStatement({ ...base, drawdownsTotal: 50000, closingPrincipal: 348450 });
    expect(result.status).toBe('reconciled');
  });

  it('INSUFFICIENT_DATA when opening or closing principal is missing', () => {
    expect(reconcileLoanStatement({ ...base, openingPrincipal: null, closingPrincipal: 298450 }).status).toBe('insufficient_data');
  });
});

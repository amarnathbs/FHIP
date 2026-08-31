/**
 * FDH-12 — balance reconciliation and exact-decimal money
 * (spec sections 46-49, 127-128, 142-143).
 *
 * The headline control is spec section 48/128: for a fully reconcilable
 * statement, moving ONE figure by $0.01 must produce VARIANCE. That is only
 * meaningful if the arithmetic is exact, so this file also certifies the money
 * primitives that make it so.
 */

import { describe, it, expect } from 'vitest';
import {
  parseMoneyToMinorUnits,
  tryParseMoneyToMinorUnits,
  minorUnitsToDecimalString,
  toMinorUnits,
  sumMinorUnits,
  absMinorUnits,
  RetirementMoneyParseError,
  ZERO,
} from '@/lib/financial-data-hub/retirement/money';
import {
  reconcileFromActivities,
  reconcileFromSummaryTotals,
  reconcileStatement,
  compareCurrentVsStatement,
  RETIREMENT_RECONCILIATION_TOLERANCE_MINOR_UNITS,
} from '@/lib/financial-data-hub/retirement/reconciliation';
import type {
  RetirementActivityEvidence,
  RetirementStatementExtraction,
} from '@/lib/financial-data-hub/retirement/types';

const M = (s: string) => parseMoneyToMinorUnits(s);

function activity(
  type: RetirementActivityEvidence['activityType'],
  amount: string,
  overrides: Partial<RetirementActivityEvidence> = {},
): RetirementActivityEvidence {
  return {
    activityType: type,
    amount,
    currencyCode: 'AUD',
    activityDate: '2026-07-15',
    isSummaryTotal: false,
    isYearToDate: false,
    ...overrides,
  };
}

// ===========================================================================
// Exact decimal money (spec section 142)
// ===========================================================================

describe('FDH-12 spec 142 — exact decimal money, never binary float', () => {
  it('parses plain decimals exactly', () => {
    expect(M('0.00')).toBe(BigInt(0));
    expect(M('1000.00')).toBe(BigInt(100000));
    expect(M('113500.01')).toBe(BigInt(11350001));
  });

  it('survives the classic float failure 0.1 + 0.2', () => {
    // The reason this module exists.
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(sumMinorUnits([M('0.10'), M('0.20')])).toBe(M('0.30'));
  });

  it('handles thousands separators, currency symbols and accounting negatives', () => {
    expect(M('$1,234.56')).toBe(M('1234.56'));
    expect(M('A$1,234.56')).toBe(M('1234.56'));
    expect(M('1,234.56 AUD')).toBe(M('1234.56'));
    expect(M('(1,234.56)')).toBe(-M('1234.56'));
    expect(M('-1234.56')).toBe(-M('1234.56'));
    expect(M('1234.56 DR')).toBe(-M('1234.56'));
  });

  it('handles INR formatting', () => {
    expect(M('Rs. 1,234.56')).toBe(M('1234.56'));
    expect(M('₹1,234.56')).toBe(M('1234.56'));
  });

  it('round-trips exactly', () => {
    for (const s of ['0.00', '0.01', '1000.00', '123456789.99', '-42.50']) {
      expect(minorUnitsToDecimalString(M(s))).toBe(s === '-42.50' ? '-42.50' : s);
    }
  });

  it('handles amounts beyond Number.MAX_SAFE_INTEGER when scaled', () => {
    // numeric(20,4) holds 16 integral digits; scaled by 100 that exceeds
    // 2^53, which is why the representation is bigint and not number.
    const huge = '99999999999999.99';
    expect(minorUnitsToDecimalString(M(huge))).toBe(huge);
    expect(Number(M(huge))).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
  });

  // --- FAILING SAFE (spec section 143) ------------------------------------

  it('THROWS on a malformed amount — never returns 0', () => {
    for (const bad of ['', 'abc', '12.3.4', '1,2,3', '12abc', 'N/A', '--5', '$']) {
      expect(() => parseMoneyToMinorUnits(bad), bad).toThrow(RetirementMoneyParseError);
      expect(tryParseMoneyToMinorUnits(bad), bad).toBeNull();
      // The critical assertion: the failure is NOT silently zero.
      expect(tryParseMoneyToMinorUnits(bad)).not.toBe(ZERO);
    }
  });

  it('THROWS on more precision than the currency supports rather than rounding', () => {
    expect(() => parseMoneyToMinorUnits('1234.567')).toThrow();
    // ...but trailing zeros beyond scale are harmless and accepted.
    expect(M('1234.5600')).toBe(M('1234.56'));
  });

  it('THROWS on an amount that would overflow numeric(20,4)', () => {
    expect(() => parseMoneyToMinorUnits('99999999999999999999.00')).toThrow();
  });

  it('reads a PostgREST numeric string without ever constructing a float', () => {
    expect(toMinorUnits('113500.01')).toBe(M('113500.01'));
    expect(toMinorUnits(null)).toBeNull();
    expect(toMinorUnits(undefined)).toBeNull();
    expect(toMinorUnits(Number.NaN)).toBeNull();
  });

  it('absMinorUnits is sign-correct', () => {
    expect(absMinorUnits(M('-5.00'))).toBe(M('5.00'));
    expect(absMinorUnits(M('5.00'))).toBe(M('5.00'));
  });
});

// ===========================================================================
// The live scenario from spec section 127
// ===========================================================================

describe('FDH-12 spec 127 — the certified reconciliation scenario', () => {
  // Opening 100,000 + employer 8,000 + personal 2,000 + earnings 5,000
  //   - fees 500 - tax 1,000 = closing 113,500
  const scenario = () => [
    activity('EMPLOYER_CONTRIBUTION', '8000.00'),
    activity('PERSONAL_CONTRIBUTION', '2000.00'),
    activity('INVESTMENT_EARNINGS', '5000.00'),
    activity('FEE', '500.00'),
    activity('TAX', '1000.00'),
  ];

  it('reports RECONCILED for the exact statement', () => {
    const result = reconcileFromActivities('100000.00', '113500.00', scenario());
    expect(result.status).toBe('reconciled');
    expect(result.varianceMinorUnits).toBe(M('0.00'));
    expect(result.detail.movementTermCount).toBe(5);
  });

  it('spec 128: closing balance moved by $0.01 -> VARIANCE', () => {
    const result = reconcileFromActivities('100000.00', '113500.01', scenario());
    expect(result.status).toBe('variance');
    // Computed 113,500.00 minus stated 113,500.01 = -0.01.
    expect(result.varianceMinorUnits).toBe(-M('0.01'));
  });

  it('spec 48: ONE ACTIVITY moved by $0.01 -> VARIANCE', () => {
    const tweaked = scenario();
    tweaked[0] = activity('EMPLOYER_CONTRIBUTION', '8000.01');
    const result = reconcileFromActivities('100000.00', '113500.00', tweaked);
    expect(result.status).toBe('variance');
    expect(result.varianceMinorUnits).toBe(M('0.01'));
  });

  it('a $0.01 move on the OPENING balance is caught too', () => {
    const result = reconcileFromActivities('100000.01', '113500.00', scenario());
    expect(result.status).toBe('variance');
    expect(result.varianceMinorUnits).toBe(M('0.01'));
  });

  it('the tolerance really is zero — not a small number', () => {
    expect(RETIREMENT_RECONCILIATION_TOLERANCE_MINOR_UNITS).toBe(BigInt(0));
  });

  it('every debit type reduces the balance', () => {
    // Flip a fee to a contribution and the statement stops balancing, which
    // proves the direction table is genuinely load-bearing here.
    const wrongDirection = scenario();
    wrongDirection[3] = activity('EMPLOYER_CONTRIBUTION', '500.00');
    const result = reconcileFromActivities('100000.00', '113500.00', wrongDirection);
    expect(result.status).toBe('variance');
    expect(result.varianceMinorUnits).toBe(M('1000.00'));
  });
});

// ===========================================================================
// INSUFFICIENT_DATA is a first-class answer (spec sections 47, 49)
// ===========================================================================

describe('FDH-12 spec 47/49 — never force a reconciliation', () => {
  it('closing balance only, no opening -> INSUFFICIENT_DATA, not VARIANCE', () => {
    const result = reconcileFromActivities(null, '113500.00', [activity('FEE', '500.00')]);
    expect(result.status).toBe('insufficient_data');
    expect(result.varianceMinorUnits).toBeNull();
    expect(result.detail.hasOpening).toBe(false);
    expect(result.detail.hasClosing).toBe(true);
  });

  it('does NOT invent an opening balance of zero', () => {
    // If it did, the variance would be the whole account — a fabricated,
    // alarming and wrong result. It reports insufficient data instead.
    const result = reconcileFromActivities(undefined, '113500.00', [activity('FEE', '500.00')]);
    expect(result.status).not.toBe('variance');
    expect(result.varianceMinorUnits).toBeNull();
  });

  it('both balances but no activity detail -> INSUFFICIENT_DATA', () => {
    const result = reconcileFromActivities('100000.00', '113500.00', []);
    expect(result.status).toBe('insufficient_data');
    expect(result.detail.movementTermCount).toBe(0);
  });

  it('an UNCLASSIFIED row makes the identity incomplete -> INSUFFICIENT_DATA', () => {
    const result = reconcileFromActivities('100000.00', '113500.00', [
      activity('EMPLOYER_CONTRIBUTION', '8000.00'),
      activity('UNKNOWN', '5500.00'),
    ]);
    // NOT a false RECONCILED, and NOT a VARIANCE that blames the fund for our
    // own failure to classify.
    expect(result.status).toBe('insufficient_data');
    expect(result.detail.undirectedRows).toBe(1);
  });

  it('an UNREADABLE amount makes the identity incomplete -> INSUFFICIENT_DATA', () => {
    const result = reconcileFromActivities('100000.00', '113500.00', [
      activity('EMPLOYER_CONTRIBUTION', '8000.00'),
      activity('FEE', 'not a number'),
    ]);
    expect(result.status).toBe('insufficient_data');
    expect(result.detail.unparseableRows).toBe(1);
  });
});

// ===========================================================================
// Summary-total path (spec section 118)
// ===========================================================================

describe('FDH-12 spec 118 — summary totals as an alternative evidence path', () => {
  const base = {
    openingBalance: '100000.00',
    closingBalance: '113500.00',
    employerContributions: '8000.00',
    personalContributions: '2000.00',
    investmentEarnings: '5000.00',
    fees: '500.00',
    tax: '1000.00',
  } as const;

  it('reconciles from printed totals when there is no line detail', () => {
    const result = reconcileFromSummaryTotals(base);
    expect(result.status).toBe('reconciled');
    expect(result.varianceMinorUnits).toBe(M('0.00'));
  });

  it('catches a $0.01 discrepancy in the printed totals too', () => {
    const result = reconcileFromSummaryTotals({ ...base, closingBalance: '113500.01' });
    expect(result.status).toBe('variance');
    expect(result.varianceMinorUnits).toBe(-M('0.01'));
  });

  it('NEVER combines summary totals with activity lines', () => {
    // Both present, describing the SAME movement. Summing both would double
    // everything. `reconcileStatement` must pick the line-detail path.
    const extraction = {
      ...base,
      activities: [
        activity('EMPLOYER_CONTRIBUTION', '8000.00'),
        activity('PERSONAL_CONTRIBUTION', '2000.00'),
        activity('INVESTMENT_EARNINGS', '5000.00'),
        activity('FEE', '500.00'),
        activity('TAX', '1000.00'),
      ],
      positions: [],
    } as unknown as RetirementStatementExtraction;

    const result = reconcileStatement(extraction);
    expect(result.status).toBe('reconciled');
    expect(result.varianceMinorUnits).toBe(M('0.00'));
    // Proof it took the ACTIVITY path (summary path reports no exclusions and
    // a term count of 7 for this data).
    expect(result.detail.movementTermCount).toBe(5);
  });

  it('does not shop between paths looking for a RECONCILED', () => {
    // Activity detail that genuinely does not balance must report VARIANCE,
    // even though the (contradictory) printed totals would reconcile.
    const extraction = {
      ...base,
      activities: [activity('EMPLOYER_CONTRIBUTION', '8000.00')],
      positions: [],
    } as unknown as RetirementStatementExtraction;
    const result = reconcileStatement(extraction);
    expect(result.status).toBe('variance');
  });
});

// ===========================================================================
// Current vs statement (spec section 55)
// ===========================================================================

describe('FDH-12 spec 55 — current vs statement comparison', () => {
  it('reports Current $220,000 / Statement $225,000 / Difference +$5,000', () => {
    const cmp = compareCurrentVsStatement('220000.00', '225000.00');
    expect(minorUnitsToDecimalString(cmp.currentMinorUnits!)).toBe('220000.00');
    expect(minorUnitsToDecimalString(cmp.statementMinorUnits!)).toBe('225000.00');
    expect(minorUnitsToDecimalString(cmp.differenceMinorUnits!)).toBe('5000.00');
    expect(cmp.identical).toBe(false);
  });

  it('reports a negative difference when the statement is lower', () => {
    const cmp = compareCurrentVsStatement('225000.00', '220000.00');
    expect(minorUnitsToDecimalString(cmp.differenceMinorUnits!)).toBe('-5000.00');
  });

  it('flags an identical balance so the UI can say nothing would change', () => {
    const cmp = compareCurrentVsStatement('220000.00', '220000.00');
    expect(cmp.identical).toBe(true);
    expect(cmp.differenceMinorUnits).toBe(M('0.00'));
  });

  it('returns null difference rather than a fake $0 when either side is absent', () => {
    // spec section 94 in comparison form: "no closing balance on the
    // statement" must not render as a $220,000 difference or as $0.
    const cmp = compareCurrentVsStatement('220000.00', null);
    expect(cmp.differenceMinorUnits).toBeNull();
    expect(cmp.identical).toBe(false);
  });

  it('reads a numeric current balance as exactly as a string one', () => {
    const asString = compareCurrentVsStatement('220000.00', '225000.00');
    const asNumber = compareCurrentVsStatement(220000, '225000.00');
    expect(asNumber.differenceMinorUnits).toBe(asString.differenceMinorUnits);
  });
});

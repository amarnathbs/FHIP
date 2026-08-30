/**
 * FDH-12 — deduplication, overlap, revised statements and rollover pairing
 * (spec sections 33-35, 51-54, 130-131, 141).
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  computeActivityFingerprint,
  dedupActivities,
  findSupersededStatement,
  RETIREMENT_ACTIVITY_FINGERPRINT_VERSION,
} from '@/lib/financial-data-hub/retirement/dedup';
import {
  matchRolloverCounterpart,
  householdRetirementTotalMinorUnits,
  ROLLOVER_PAIR_WINDOW_DAYS,
  type RolloverLeg,
} from '@/lib/financial-data-hub/retirement/rolloverIntelligence';
import { parseMoneyToMinorUnits } from '@/lib/financial-data-hub/retirement/money';
import type { RetirementActivityEvidence } from '@/lib/financial-data-hub/retirement/types';

const M = (s: string) => parseMoneyToMinorUnits(s);
const ACCOUNT_A = 'acc-aaaa';
const ACCOUNT_B = 'acc-bbbb';

function activity(
  overrides: Partial<RetirementActivityEvidence> = {},
): RetirementActivityEvidence {
  return {
    activityType: 'EMPLOYER_CONTRIBUTION',
    amount: '1000.00',
    currencyCode: 'AUD',
    activityDate: '2026-07-15',
    employerNameRaw: 'Acme Pty Ltd',
    isSummaryTotal: false,
    isYearToDate: false,
    ...overrides,
  };
}

function fingerprintOf(a: RetirementActivityEvidence, accountId: string | null = ACCOUNT_A) {
  return computeActivityFingerprint({
    canonicalAccountId: accountId,
    activityType: a.activityType,
    activityDate: a.activityDate ?? null,
    amount: a.amount,
    currencyCode: a.currencyCode,
    employerNameRaw: a.employerNameRaw ?? null,
    isSummaryTotal: a.isSummaryTotal,
    isYearToDate: a.isYearToDate,
  });
}

// ===========================================================================
// The fingerprint
// ===========================================================================

describe('FDH-12 spec 52-53 — the activity fingerprint', () => {
  it('is stable for the same economic event', () => {
    expect(fingerprintOf(activity())).toBe(fingerprintOf(activity()));
  });

  it('is INDEPENDENT of row number and source ordering', () => {
    // The whole point: the same event in two different files must dedup, and
    // those files will number their rows differently.
    expect(fingerprintOf(activity({ sourceRowNumber: 1 })))
      .toBe(fingerprintOf(activity({ sourceRowNumber: 99 })));
  });

  it('is independent of the description text', () => {
    // Two funds print the same contribution differently; it is still one event.
    expect(fingerprintOf(activity({ descriptionRaw: 'SG contribution' })))
      .toBe(fingerprintOf(activity({ descriptionRaw: 'Employer super' })));
  });

  it('differs when the AMOUNT differs, even by one cent', () => {
    expect(fingerprintOf(activity({ amount: '1000.00' })))
      .not.toBe(fingerprintOf(activity({ amount: '1000.01' })));
  });

  it('differs when the DATE, TYPE, CURRENCY or EMPLOYER differs', () => {
    const base = fingerprintOf(activity());
    expect(fingerprintOf(activity({ activityDate: '2026-07-16' }))).not.toBe(base);
    expect(fingerprintOf(activity({ activityType: 'PERSONAL_CONTRIBUTION' }))).not.toBe(base);
    expect(fingerprintOf(activity({ currencyCode: 'INR' }))).not.toBe(base);
    expect(fingerprintOf(activity({ employerNameRaw: 'Other Corp' }))).not.toBe(base);
  });

  it('differs across canonical ACCOUNTS', () => {
    // Two funds crediting the same employer the same amount on the same day is
    // two events, not one.
    expect(fingerprintOf(activity(), ACCOUNT_A)).not.toBe(fingerprintOf(activity(), ACCOUNT_B));
  });

  it('normalises employer legal suffixes so "Acme Pty Ltd" and "Acme" agree', () => {
    expect(fingerprintOf(activity({ employerNameRaw: 'ACME PTY LTD' })))
      .toBe(fingerprintOf(activity({ employerNameRaw: 'Acme' })));
  });

  it('cannot be spoofed by moving a delimiter into a component', () => {
    // A separator that could occur inside a component would let two different
    // splits collide. Two genuinely different employers must not collide even
    // when their names contain the other component's text.
    const a = fingerprintOf(activity({ employerNameRaw: 'Acme AUD' }));
    const b = fingerprintOf(activity({ employerNameRaw: 'Acme' , currencyCode: 'AUD' }));
    expect(a).not.toBe(b);
  });

  it('is NULL for a summary total or a YTD row', () => {
    // They are not economic events, so they have no identity in this space.
    expect(fingerprintOf(activity({ isSummaryTotal: true }))).toBeNull();
    expect(fingerprintOf(activity({ isYearToDate: true }))).toBeNull();
  });

  it('is NULL when the account is unresolved or the date is missing', () => {
    // Fail-safe: a null fingerprint means "do not dedup", which risks a
    // visible duplicate rather than silently deleting real evidence.
    expect(fingerprintOf(activity(), null)).toBeNull();
    expect(fingerprintOf(activity({ activityDate: undefined }))).toBeNull();
  });

  it('is NULL when the amount is unreadable', () => {
    expect(fingerprintOf(activity({ amount: 'not-a-number' }))).toBeNull();
  });

  it('carries a version so its meaning can change deliberately', () => {
    expect(RETIREMENT_ACTIVITY_FINGERPRINT_VERSION).toBe('v1');
  });
});

// ===========================================================================
// spec 51 / 130 — the same statement twice
// ===========================================================================

describe('FDH-12 spec 51/130 — duplicate statement', () => {
  it('flags every activity of a re-uploaded statement as a duplicate', () => {
    const activities = [activity(), activity({ activityType: 'FEE', amount: '100.00', employerNameRaw: undefined })];
    const first = dedupActivities(activities, ACCOUNT_A, new Map());
    expect(first.every((d) => !d.isDuplicate)).toBe(true);

    // Second upload: every fingerprint is already on file.
    const onFile = new Map(first.map((d, i) => [d.fingerprint!, `existing-${i}`]));
    const second = dedupActivities(activities, ACCOUNT_A, onFile);
    expect(second.every((d) => d.isDuplicate)).toBe(true);
    expect(second.map((d) => d.duplicateOfActivityId)).toEqual(['existing-0', 'existing-1']);
  });

  it('the DB has a unique index as an independent backstop', () => {
    const sql = fs.readFileSync(
      path.join(__dirname, '..', '..', 'supabase', 'migrations', '0111_fdh12_retirement_statement_intelligence.sql'),
      'utf8',
    );
    expect(sql).toMatch(/create unique index uq_fdh_retirement_activities_fingerprint/);
    expect(sql).toMatch(/where activity_fingerprint is not null/);
  });
});

// ===========================================================================
// spec 52 / 131 — overlapping periods
// ===========================================================================

describe('FDH-12 spec 52/131 — overlapping statements', () => {
  it('Jul-Dec and Oct-Mar do not duplicate the Oct-Dec activity', () => {
    // Statement A: Jul, Aug, Sep, Oct, Nov, Dec
    const statementA = ['07', '08', '09', '10', '11', '12'].map((mm) =>
      activity({ activityDate: `2026-${mm}-15` }));
    // Statement B: Oct, Nov, Dec, Jan, Feb, Mar — the first three are the SAME
    // economic events already imported from A.
    const statementB = [
      ...['10', '11', '12'].map((mm) => activity({ activityDate: `2026-${mm}-15` })),
      ...['01', '02', '03'].map((mm) => activity({ activityDate: `2027-${mm}-15` })),
    ];

    const a = dedupActivities(statementA, ACCOUNT_A, new Map());
    const onFile = new Map(a.map((d, i) => [d.fingerprint!, `a-${i}`]));
    const b = dedupActivities(statementB, ACCOUNT_A, onFile);

    const duplicates = b.filter((d) => d.isDuplicate);
    const fresh = b.filter((d) => !d.isDuplicate);
    expect(duplicates).toHaveLength(3);  // Oct, Nov, Dec
    expect(fresh).toHaveLength(3);       // Jan, Feb, Mar
    // THE CONTROL: overlap duplicates that would have been counted twice = 0.
    expect(duplicates.map((d) => d.duplicateOfActivityId)).toEqual(['a-3', 'a-4', 'a-5']);
  });
});

// ===========================================================================
// spec 53 — annual plus monthly
// ===========================================================================

describe('FDH-12 spec 53 — 12 monthly statements plus an annual one', () => {
  it('does not create 13 copies of the year', () => {
    const monthly = Array.from({ length: 12 }, (_, i) =>
      activity({ activityDate: `2026-${String(i + 1).padStart(2, '0')}-15` }));
    const fromMonthly = dedupActivities(monthly, ACCOUNT_A, new Map());
    const onFile = new Map(fromMonthly.map((d, i) => [d.fingerprint!, `m-${i}`]));

    // The annual statement repeats the same twelve lines AND prints a total.
    const annual = [
      ...monthly,
      activity({ amount: '12000.00', activityDate: '2026-12-31', isSummaryTotal: true }),
    ];
    const fromAnnual = dedupActivities(annual, ACCOUNT_A, onFile);

    // The twelve repeated lines dedup...
    expect(fromAnnual.slice(0, 12).every((d) => d.isDuplicate)).toBe(true);
    // ...and the printed total is not an economic event at all, so it has no
    // fingerprint and can never be counted as a thirteenth.
    expect(fromAnnual[12].fingerprint).toBeNull();
    expect(fromAnnual[12].isDuplicate).toBe(false);
  });
});

// ===========================================================================
// spec 54 — revised / reissued statements
// ===========================================================================

describe('FDH-12 spec 54 — a corrected statement supersedes the original', () => {
  const original = {
    id: 'stmt-original',
    canonicalAccountId: ACCOUNT_A,
    statementStartDate: '2026-07-01',
    statementEndDate: '2026-07-31',
    statementDate: '2026-08-05',
  };

  it('identifies the statement a later reissue supersedes', () => {
    const superseded = findSupersededStatement(
      { canonicalAccountId: ACCOUNT_A, statementStartDate: '2026-07-01', statementEndDate: '2026-07-31', statementDate: '2026-08-20' },
      [original],
    );
    expect(superseded).toBe('stmt-original');
  });

  it('does NOT supersede an EARLIER statement with a later date', () => {
    const superseded = findSupersededStatement(
      { canonicalAccountId: ACCOUNT_A, statementStartDate: '2026-07-01', statementEndDate: '2026-07-31', statementDate: '2026-08-01' },
      [original],
    );
    expect(superseded).toBeNull();
  });

  it('does not supersede a DIFFERENT period', () => {
    const superseded = findSupersededStatement(
      { canonicalAccountId: ACCOUNT_A, statementStartDate: '2026-08-01', statementEndDate: '2026-08-31', statementDate: '2026-09-05' },
      [original],
    );
    expect(superseded).toBeNull();
  });

  it('does not supersede a different ACCOUNT', () => {
    const superseded = findSupersededStatement(
      { canonicalAccountId: ACCOUNT_B, statementStartDate: '2026-07-01', statementEndDate: '2026-07-31', statementDate: '2026-08-20' },
      [original],
    );
    expect(superseded).toBeNull();
  });

  it('refuses to guess when the statement date is unknown', () => {
    const superseded = findSupersededStatement(
      { canonicalAccountId: ACCOUNT_A, statementStartDate: '2026-07-01', statementEndDate: '2026-07-31', statementDate: null },
      [original],
    );
    expect(superseded).toBeNull();
  });

  it('unchanged lines between the two versions dedup, so neither is counted twice', () => {
    // "Do not count both versions blindly" — the fingerprint does the work.
    const v1 = [activity(), activity({ activityType: 'FEE', amount: '100.00', employerNameRaw: undefined })];
    const first = dedupActivities(v1, ACCOUNT_A, new Map());
    const onFile = new Map(first.map((d, i) => [d.fingerprint!, `v1-${i}`]));

    // The reissue corrected the fee from 100.00 to 90.00; the contribution is
    // unchanged.
    const v2 = [activity(), activity({ activityType: 'FEE', amount: '90.00', employerNameRaw: undefined })];
    const second = dedupActivities(v2, ACCOUNT_A, onFile);
    expect(second[0].isDuplicate).toBe(true);   // unchanged contribution
    expect(second[1].isDuplicate).toBe(false);  // the genuinely corrected fee
  });
});

// ===========================================================================
// spec 141 — long history
// ===========================================================================

describe('FDH-12 spec 141 — long contribution history', () => {
  for (const years of [1, 3, 5, 10]) {
    it(`${years}-year history deduplicates without loss or false positives`, () => {
      const months = years * 12;
      const history = Array.from({ length: months }, (_, i) => {
        const d = new Date(Date.UTC(2016 + Math.floor(i / 12), i % 12, 15));
        return activity({ activityDate: d.toISOString().slice(0, 10) });
      });
      const first = dedupActivities(history, ACCOUNT_A, new Map());
      // Every month is a distinct event — no false duplicates at any scale.
      expect(first.filter((d) => d.isDuplicate)).toHaveLength(0);
      expect(new Set(first.map((d) => d.fingerprint)).size).toBe(months);

      // Re-importing the whole history duplicates all of it, none of it lost.
      const onFile = new Map(first.map((d, i) => [d.fingerprint!, `h-${i}`]));
      const second = dedupActivities(history, ACCOUNT_A, onFile);
      expect(second.filter((d) => d.isDuplicate)).toHaveLength(months);
    });
  }
});

// ===========================================================================
// spec 33-35 — rollover pairing
// ===========================================================================

describe('FDH-12 spec 33-35 — rollover pairing', () => {
  const out: RolloverLeg = {
    activityId: 'leg-out', statementId: 'stmt-a', activityType: 'ROLLOVER_OUT',
    amount: '100000.00', currencyCode: 'AUD', activityDate: '2026-07-15',
    fundName: 'Old Super', canonicalAccountId: ACCOUNT_A,
  };
  const inLeg: RolloverLeg = {
    activityId: 'leg-in', statementId: 'stmt-b', activityType: 'ROLLOVER_IN',
    amount: '100000.00', currencyCode: 'AUD', activityDate: '2026-07-18',
    fundName: 'New Super', canonicalAccountId: ACCOUNT_B,
  };

  it('pairs the two legs of one transfer', () => {
    const r = matchRolloverCounterpart(out, [out, inLeg]);
    expect(r.status).toBe('matched');
    expect(r.counterpartActivityId).toBe('leg-in');
  });

  it('pairs symmetrically from the other side', () => {
    const r = matchRolloverCounterpart(inLeg, [out, inLeg]);
    expect(r.status).toBe('matched');
    expect(r.counterpartActivityId).toBe('leg-out');
  });

  it('never pairs two legs of the SAME account (an intra-fund switch)', () => {
    const sameAccountIn = { ...inLeg, canonicalAccountId: ACCOUNT_A, statementId: 'stmt-c' };
    const r = matchRolloverCounterpart(out, [out, sameAccountIn]);
    expect(r.status).toBe('no_match');
  });

  it('never pairs two legs from the same statement', () => {
    const sameStatementIn = { ...inLeg, statementId: 'stmt-a' };
    const r = matchRolloverCounterpart(out, [out, sameStatementIn]);
    expect(r.status).toBe('no_match');
  });

  it('requires the amounts to match exactly', () => {
    const r = matchRolloverCounterpart(out, [out, { ...inLeg, amount: '99999.99' }]);
    expect(r.status).toBe('no_match');
  });

  it('requires the same currency', () => {
    const r = matchRolloverCounterpart(out, [out, { ...inLeg, currencyCode: 'INR' }]);
    expect(r.status).toBe('no_match');
  });

  it(`allows up to ${ROLLOVER_PAIR_WINDOW_DAYS} days between the legs`, () => {
    const late = { ...inLeg, activityDate: '2026-08-10' }; // 26 days
    expect(matchRolloverCounterpart(out, [out, late]).status).toBe('matched');
    const tooLate = { ...inLeg, activityDate: '2026-09-30' };
    expect(matchRolloverCounterpart(out, [out, tooLate]).status).toBe('no_match');
  });

  it('REVIEWS rather than guessing between two possible counterparts', () => {
    const alt = { ...inLeg, activityId: 'leg-in-2', statementId: 'stmt-c', canonicalAccountId: 'acc-cccc' };
    const r = matchRolloverCounterpart(out, [out, inLeg, alt]);
    expect(r.status).toBe('multiple_candidates');
    expect(r.counterpartActivityId).toBeNull();
  });

  it('an unpaired rollover is still valid evidence, not an error', () => {
    const r = matchRolloverCounterpart(out, [out]);
    expect(r.status).toBe('no_match');
    expect(r.reason).toBe('counterpart_statement_not_available');
  });

  it('does not attempt to pair a non-rollover activity', () => {
    const notARollover = { ...out, activityType: 'FEE' as const };
    expect(matchRolloverCounterpart(notARollover, [notARollover, inLeg]).status).toBe('not_attempted');
  });

  it('spec 34: the household total is unchanged by a full rollover', () => {
    expect(householdRetirementTotalMinorUnits(['0.00', '100000.00'])).toBe(M('100000.00'));
  });

  it('spec 35: a partial rollover leaves Fund A $100,000 and Fund B $50,000', () => {
    expect(householdRetirementTotalMinorUnits(['100000.00', '50000.00'])).toBe(M('150000.00'));
  });

  it('returns null rather than a wrong total when a balance is unreadable', () => {
    expect(householdRetirementTotalMinorUnits(['100000.00', 'oops'])).toBeNull();
  });
});

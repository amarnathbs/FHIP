// Document2 D-3 (PO decision 2026-10-03): a holdings-only position (a statement
// holding with NO purchase date) is not silently valued from the statement and
// not silently excluded -- the user is asked for the investment date, it is
// validated, the NAV on that date gives the cost, and the existing pipeline
// computes from there.
//
// NAMED NEGATIVE CONTROLS (each is built to FAIL against the old behaviour):
//   NC-A1  "OLD: a missing date was treated as excluded" -- the old report
//          label and the old portfolio maths are reproduced and shown to differ.
//   NC-A2  "OLD: a holdings-only value inflated the portfolio return" --
//          the dataset WITHOUT the holdingsOnly flag (the old shape) yields a
//          higher portfolio XIRR than the same dataset with it.
import { describe, expect, it } from 'vitest';
import {
  NAV_MAX_STALE_DAYS,
  USER_INVESTMENT_DATE_REFERENCE_PREFIX,
  deriveInvestmentDatePurchase,
  isUserSuppliedInvestmentDateReference,
  needsInvestmentDate,
  pickNavForInvestmentDate,
  userInvestmentDateReference,
  validateInvestmentDate,
} from '@/lib/investment-intelligence/investmentDate';
import { runAnalytics, splitHoldingsOnlySchemes, type AnalyticsDataset, type SchemeDataset } from '@/lib/engines/investment-intelligence/analyticsOrchestrator';
import { computePosition, type MfAccount, type MfInstrument, type MfSnapshot, type MfTransaction } from '@/lib/engines/investment-intelligence/indiaMfReport';

const TODAY = '2026-10-03';

describe('validateInvestmentDate: day-first, real, not future, not before inception, not after the statement', () => {
  const ok = (text: string, extra: Partial<Parameters<typeof validateInvestmentDate>[0]> = {}) => validateInvestmentDate({ text, todayIso: TODAY, ...extra });

  it('accepts a day-first date and returns ISO for the wire', () => {
    expect(ok('15-03-2024')).toEqual({ ok: true, iso: '2024-03-15' });
    expect(ok('15/03/2024')).toEqual({ ok: true, iso: '2024-03-15' });
    expect(ok(' 5-3-2024 ')).toEqual({ ok: true, iso: '2024-03-05' });
  });

  it('refuses empty, impossible and non day-first input', () => {
    expect(ok('')).toMatchObject({ ok: false, code: 'required' });
    expect(ok(null as unknown as string)).toMatchObject({ ok: false, code: 'required' });
    expect(ok('31-02-2024')).toMatchObject({ ok: false, code: 'not_a_date' });
    expect(ok('2024-03-15')).toMatchObject({ ok: false, code: 'not_a_date' }); // year first is never reinterpreted
    expect(ok('03-15-2024')).toMatchObject({ ok: false, code: 'not_a_date' }); // month first is never reinterpreted
    expect(ok('yesterday')).toMatchObject({ ok: false, code: 'not_a_date' });
  });

  it('refuses a future date, and accepts today', () => {
    expect(ok('04-10-2026')).toMatchObject({ ok: false, code: 'in_future' });
    expect(ok('03-10-2026')).toEqual({ ok: true, iso: '2026-10-03' });
  });

  it('refuses a date before the fund\'s first known price, but only when that is known', () => {
    const early = ok('01-01-2010', { inceptionIso: '2013-01-01' });
    expect(early).toMatchObject({ ok: false, code: 'before_inception' });
    expect(early.ok === false && early.message).toContain('01-01-2013'); // shown day-first, never ISO
    expect(ok('01-01-2010', { inceptionIso: null })).toEqual({ ok: true, iso: '2010-01-01' });
    expect(ok('01-01-2013', { inceptionIso: '2013-01-01' })).toEqual({ ok: true, iso: '2013-01-01' });
  });

  it('refuses a date after the statement date the units were counted on', () => {
    const late = ok('20-09-2026', { statementAsOfIso: '2026-09-04' });
    expect(late).toMatchObject({ ok: false, code: 'after_statement' });
    expect(late.ok === false && late.message).toContain('04-09-2026');
    expect(ok('04-09-2026', { statementAsOfIso: '2026-09-04' })).toEqual({ ok: true, iso: '2026-09-04' });
  });

  it('no message ever shows an ISO date', () => {
    const messages = [
      ok('', {}),
      ok('31-02-2024'),
      ok('04-10-2026'),
      ok('01-01-2010', { inceptionIso: '2013-01-01' }),
      ok('20-09-2026', { statementAsOfIso: '2026-09-04' }),
    ].map((r) => (r.ok ? '' : r.message));
    for (const m of messages) expect(m).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});

describe('NAV on the investment date and the derived purchase', () => {
  const navs = [
    { date: '2024-03-12', price: 40 },
    { date: '2024-03-14', price: 41 }, // Thursday
    { date: '2024-03-18', price: 42 },
  ];

  it('uses the latest NAV on or before the date', () => {
    expect(pickNavForInvestmentDate(navs, '2024-03-14')).toEqual({ date: '2024-03-14', price: 41 });
    expect(pickNavForInvestmentDate(navs, '2024-03-16')).toEqual({ date: '2024-03-14', price: 41 }); // a Saturday
  });

  it('never uses a NAV from after the date, and never one older than the allowed gap', () => {
    expect(pickNavForInvestmentDate(navs, '2024-03-11')).toBeNull();
    expect(pickNavForInvestmentDate(navs, '2024-03-30')).toBeNull();
    expect(NAV_MAX_STALE_DAYS).toBe(7);
  });

  it('ignores non-positive prices rather than inventing a cost', () => {
    expect(pickNavForInvestmentDate([{ date: '2024-03-14', price: 0 }], '2024-03-14')).toBeNull();
  });

  it('derives all the held units bought on the date at that NAV, to 2 places', () => {
    expect(deriveInvestmentDatePurchase({ units: 123.456, navPrice: 41.1234 })).toEqual({ units: 123.456, pricePerUnit: 41.1234, grossAmount: 5076.93 });
    expect(deriveInvestmentDatePurchase({ units: 0, navPrice: 41 })).toBeNull();
    expect(deriveInvestmentDatePurchase({ units: 10, navPrice: 0 })).toBeNull();
  });

  it('marks the derived row so every reader can tell the date came from the user', () => {
    const ref = userInvestmentDateReference('abc');
    expect(ref).toBe(`${USER_INVESTMENT_DATE_REFERENCE_PREFIX}abc`);
    expect(isUserSuppliedInvestmentDateReference(ref)).toBe(true);
    expect(isUserSuppliedInvestmentDateReference('OPENING_BALANCE')).toBe(false);
    expect(isUserSuppliedInvestmentDateReference(null)).toBe(false);
  });
});

describe('which positions need a date', () => {
  const held = { snapshotUnits: 100, hasActiveInput: false };

  it('a holding with no transaction at all needs one', () => {
    expect(needsInvestmentDate({ ...held, transactions: [] })).toBe(true);
  });

  it('a holding whose only transactions are reversed or parked still needs one (nothing usable)', () => {
    expect(needsInvestmentDate({ ...held, transactions: [{ type: 'purchase', status: 'reversed', sourceReference: null }] })).toBe(true);
    expect(needsInvestmentDate({ ...held, transactions: [{ type: 'purchase', status: 'review_required', sourceReference: null }] })).toBe(true);
  });

  it('a holding with a usable transaction, an answered question, or no units does not', () => {
    expect(needsInvestmentDate({ ...held, transactions: [{ type: 'purchase', status: 'parsed', sourceReference: 'R1' }] })).toBe(false);
    expect(needsInvestmentDate({ ...held, hasActiveInput: true, transactions: [] })).toBe(false);
    expect(needsInvestmentDate({ snapshotUnits: 0, hasActiveInput: false, transactions: [] })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The India MF report: the derived purchase is computed exactly like a
// statement purchase, with an honest label.
// ---------------------------------------------------------------------------
const account: MfAccount = { id: 'A1', folioNumber: 'F1', ownerMemberId: 'M1', currencyCode: 'INR', countryCode: 'IN' };
const fund: MfInstrument = { id: 'I1', name: 'Test Fund', isin: null, instrumentClass: 'mutual_fund' };
const VAL = '2026-09-30';
const snapshot: MfSnapshot = { accountId: 'A1', instrumentId: 'I1', asOfDate: VAL, units: 100, value: 15000 };

function position(transactions: MfTransaction[]) {
  return computePosition({ account, instrument: fund, transactions, snapshot, nav: { instrumentId: 'I1', date: VAL, price: 150 }, truth: null, valuationDate: VAL });
}

describe('NC-A1: the report treats a missing purchase date as "date needed", and a supplied date as a real purchase', () => {
  const derived: MfTransaction = {
    id: 'T1', accountId: 'A1', instrumentId: 'I1', type: 'purchase', date: '2024-09-30', units: 100, amount: 10000, pricePerUnit: 100, status: 'parsed',
    sourceReference: userInvestmentDateReference('in1'),
  };

  it('no date: labelled as needing the date, cost-based figures and XIRR not shown', () => {
    const p = position([]);
    expect(p.basis.label).toBe('holding only; investment date needed');
    expect(p.xirr.status).toBe('na');
    expect(p.avgNav).toBeNull();
  });

  it('with the supplied date: cost, average NAV and XIRR are computed from it, and the label says where the date came from', () => {
    const p = position([derived]);
    expect(p.flags.noTransactions).toBe(false);
    expect(p.purchase).toBe(10000);
    expect(p.avgNav).toBeCloseTo(100, 6);
    expect(p.startDate).toBe('2024-09-30');
    expect(p.xirr.status).toBe('ok');
    // 10,000 -> 15,000 over exactly one year (2024-09-30 to 2026-09-30 is two years).
    if (p.xirr.status === 'ok') expect(p.xirr.rate).toBeCloseTo(Math.sqrt(1.5) - 1, 2);
    expect(p.basis.label).toBe('purchase date supplied by you; cost is the fund price on that date');
  });

  it('is identical to the same purchase captured from a statement, apart from the label (treated "exactly as if" it came from the statement)', () => {
    const fromStatement = position([{ ...derived, sourceReference: 'CAMS-REF-1' }]);
    const fromUser = position([derived]);
    expect(fromUser.purchase).toBe(fromStatement.purchase);
    expect(fromUser.units).toBe(fromStatement.units);
    expect(fromUser.costValue).toBe(fromStatement.costValue);
    expect(fromUser.currentValue).toBe(fromStatement.currentValue);
    expect(fromUser.xirr).toEqual(fromStatement.xirr);
    expect(fromStatement.basis.label).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Portfolio return: a holdings-only value no longer inflates it.
// ---------------------------------------------------------------------------
const d = (s: string) => new Date(`${s}T00:00:00Z`);
const EMPTY_DS = { userId: 'u1', mappings: [], benchmarkSeriesById: {}, riskFreeSeries: [], navDataVersion: null, benchmarkDataVersion: null, benchmarkMappingVersion: null };

function scheme(id: string, purchases: { date: string; amount: number }[], currentValue: number, valuationDate: string, extra: Partial<SchemeDataset> = {}): SchemeDataset {
  const real = purchases.map((p) => ({ date: d(p.date), amount: -Math.abs(p.amount) }));
  const terminal = { date: d(valuationDate), amount: currentValue };
  return {
    instrumentId: id, instrumentName: `Scheme ${id}`, currencyCode: 'INR', countryOfDomicile: 'IN', historyCompleteness: 'complete_from_inception',
    optionType: null, hasDistributionAdjustment: false,
    cashFlows: [...real, terminal], externalCashFlows: [...real, terminal], externalCashFlowsExcludingTerminal: real,
    currentValue, currentValueDate: d(valuationDate), navSeries: [], valuationSeries: [{ date: d(valuationDate), value: currentValue }],
    ...extra,
  };
}

describe('NC-A2: a holdings-only value no longer inflates the portfolio return', () => {
  const traded = scheme('A', [{ date: '2023-09-30', amount: 100000 }], 110000, '2026-09-30');
  const holdingsOnlyOld = scheme('H', [], 500000, '2026-09-30'); // the OLD shape: no flag
  const holdingsOnlyNew = { ...holdingsOnlyOld, holdingsOnly: true };
  const ds = (schemes: SchemeDataset[]): AnalyticsDataset => ({ ...EMPTY_DS, asOfDate: d('2026-09-30'), periodStart: d('2023-09-30'), schemes });
  const rate = (schemes: SchemeDataset[]) => runAnalytics(ds(schemes)).portfolios[0].portfolioXirr.value?.rate ?? NaN;

  it('OLD behaviour (reproduced): the 500,000 holding with no cost flow is counted in the terminal value and the return balloons', () => {
    const alone = rate([traded]);
    const old = rate([traded, holdingsOnlyOld]);
    expect(old).toBeGreaterThan(alone * 5); // 3-year return of ~3.2% a year becomes a huge one
  });

  it('NEW behaviour: the holdings-only scheme is left out, the return is the traded scheme\'s own', () => {
    expect(rate([traded, holdingsOnlyNew])).toBeCloseTo(rate([traded]), 10);
  });

  it('the omission is disclosed, never silent, and names the holding', () => {
    const result = runAnalytics(ds([traded, holdingsOnlyNew]));
    const note = result.portfolios[0].annotations.find((a) => a.detail.includes('no purchase date'));
    expect(note).toBeDefined();
    expect(note!.detail).toContain('Scheme H');
    expect(note!.detail).toContain('investment date');
  });

  it('once the date is supplied the scheme has a purchase flow, is no longer holdings-only, and is included', () => {
    const supplied = scheme('H', [{ date: '2024-09-30', amount: 400000 }], 500000, '2026-09-30', { holdingsOnly: false });
    const split = splitHoldingsOnlySchemes([traded, supplied]);
    expect(split.holdingsOnly).toHaveLength(0);
    expect(split.included).toHaveLength(2);
    expect(rate([traded, supplied])).not.toBeCloseTo(rate([traded]), 3);
  });

  it('a scheme that merely has no cash flow but DOES have transactions (e.g. switch-only) is not treated as holdings-only', () => {
    const switchOnly = scheme('S', [], 50000, '2026-09-30', { holdingsOnly: false });
    expect(splitHoldingsOnlySchemes([traded, switchOnly]).holdingsOnly).toHaveLength(0);
  });
});

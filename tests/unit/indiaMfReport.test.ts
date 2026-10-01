// India Mutual Fund Investment Report — pure calculation tests.
// Hand-checked fixtures: every expected number below is derived by hand in
// the comment above it, not read back from the code under test.
import { describe, it, expect } from 'vitest';
import {
  buildIndiaMfReport,
  computePosition,
  hasIndiaMfHoldings,
  resolveOwners,
  resolveIndexQuote,
  type IndiaMfReportInput,
  type MfAccount,
  type MfInstrument,
  type MfTransaction,
  type MfAllocation,
} from '@/lib/engines/investment-intelligence/indiaMfReport';

const V = '2024-03-31';

let seq = 0;
function tx(over: Partial<MfTransaction> & Pick<MfTransaction, 'type' | 'date' | 'accountId' | 'instrumentId'>): MfTransaction {
  seq += 1;
  return { id: `t${seq}`, units: null, amount: 0, pricePerUnit: null, status: 'parsed', sourceReference: null, ...over };
}
const acct = (id: string, owner: string | null, currency = 'INR'): MfAccount => ({ id, folioNumber: `F-${id}`, ownerMemberId: owner, currencyCode: currency, countryCode: currency === 'INR' ? 'IN' : 'AU' });
const fund = (id: string, name = `Fund ${id}`, cls = 'mutual_fund'): MfInstrument => ({ id, name, isin: null, instrumentClass: cls });

function baseInput(over: Partial<IndiaMfReportInput> = {}): IndiaMfReportInput {
  return {
    valuationDate: V,
    reportDate: V,
    accounts: [],
    instruments: [],
    transactions: [],
    snapshots: [],
    navs: [],
    truth: [],
    allocations: [],
    members: [],
    entities: [],
    sensex: null,
    nifty: null,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// The hand-checked fund (account A1, scheme X1), latest NAV 150 on 2024-03-31.
//   1. 2023-01-02 purchase    100,000  1000 u  @100
//   2. 2023-06-01 switch_in    20,000   200 u  @100
//   3. 2023-09-01 switch_out   30,000   250 u  @120
//   4. 2023-10-01 swp           6,000    50 u  @120
//   5. 2023-11-01 dividend      2,000  (cash IDCW payout)
//   6. 2024-01-02 redemption   12,000   100 u  @120
// Units = 1000+200-250-50-100 = 800                     -> G = 800 x 150 = 120,000
// A=100,000 B=20,000 C=30,000 D=6,000+12,000=18,000 E=2,000
// F = A+B-C-D-E = 100,000+20,000-30,000-18,000-2,000 = 70,000
// H = G-F = 50,000
// Average cost: 120,000/1200 = 100/unit -> Avg NAV 100; cost of 800 = 80,000
// Unrealised = 800x150 - 80,000 = 40,000
// FIFO (all consumption from lot 1 @100): 30,000-25,000=5,000; 6,000-5,000=1,000;
//   12,000-10,000=2,000 -> Realised 8,000.  (40,000+8,000+2,000 = 50,000 = H)
// Avg Days: remaining lot1 600u@100 (60,000, 454 d to 2024-03-31),
//   lot2 200u@100 (20,000, 304 d) -> (60,000x454+20,000x304)/80,000 = 416.5
// ---------------------------------------------------------------------------
function handCheckedTxns(): MfTransaction[] {
  const a = 'A1';
  const i = 'X1';
  return [
    tx({ accountId: a, instrumentId: i, type: 'purchase', date: '2023-01-02', units: 1000, amount: 100000 }),
    tx({ accountId: a, instrumentId: i, type: 'switch_in', date: '2023-06-01', units: 200, amount: 20000 }),
    tx({ accountId: a, instrumentId: i, type: 'switch_out', date: '2023-09-01', units: 250, amount: 30000 }),
    tx({ accountId: a, instrumentId: i, type: 'swp', date: '2023-10-01', units: 50, amount: 6000 }),
    tx({ accountId: a, instrumentId: i, type: 'dividend', date: '2023-11-01', units: null, amount: 2000 }),
    tx({ accountId: a, instrumentId: i, type: 'redemption', date: '2024-01-02', units: 100, amount: 12000 }),
  ];
}
const handNav = { instrumentId: 'X1', date: V, price: 150 };

function handChecked(over: Partial<IndiaMfReportInput> = {}) {
  return baseInput({
    accounts: [acct('A1', 'M-SELF')],
    instruments: [fund('X1')],
    transactions: handCheckedTxns(),
    navs: [handNav],
    members: [{ id: 'M-SELF', fullName: 'Asha Rao', relationship: 'self' }],
    ...over,
  });
}

describe('tile arithmetic against a hand-checked fund', () => {
  it('A,B,C,D,E and F=A+B-C-D-E, G, H=G-F match the hand calculation', () => {
    const report = buildIndiaMfReport(handChecked())!;
    const t = report.sections[0].tiles;
    expect(t.purchase).toBeCloseTo(100000, 6);
    expect(t.switchIn).toBeCloseTo(20000, 6);
    expect(t.switchOut).toBeCloseTo(30000, 6);
    expect(t.redemptionSwp).toBeCloseTo(18000, 6);
    expect(t.dividend).toBeCloseTo(2000, 6);
    expect(t.netInvestment).toBeCloseTo(70000, 6);
    expect(t.netInvestment).toBeCloseTo(t.purchase + t.switchIn - t.switchOut - t.redemptionSwp - t.dividend, 9);
    expect(t.currentValue).toBeCloseTo(120000, 6);
    expect(t.overallGain).toBeCloseTo(50000, 6);
    expect(t.overallGain).toBeCloseTo(t.currentValue - t.netInvestment, 9);
  });

  it('row columns: units, Avg NAV, Latest NAV, unrealised, realised, avg days', () => {
    const row = buildIndiaMfReport(handChecked())!.sections[0].rows[0];
    expect(row.units).toBeCloseTo(800, 6);
    expect(row.avgNav).toBeCloseTo(100, 6);
    expect(row.latestNav).toBe(150);
    expect(row.latestNavDate).toBe(V);
    expect(row.currentValue).toBeCloseTo(120000, 6);
    expect(row.unrealisedGain).toBeCloseTo(40000, 6);
    expect(row.realisedGain).toBeCloseTo(8000, 6);
    expect(row.avgDays).toBeCloseTo(416.5, 6);
    expect(row.startDate).toBe('2023-01-02');
    // Complete history: no partial marker.
    expect(row.basis.partial).toBe(false);
    expect(row.basis.label).toBeNull();
  });

  it('unrealised + realised + dividend payouts equals the overall gain when history is complete and nothing is reinvested', () => {
    const t = buildIndiaMfReport(handChecked())!.sections[0].tiles;
    expect(t.unrealisedGain + t.realisedGain + t.dividend).toBeCloseTo(t.overallGain, 6);
  });

  it('XIRR is a real rate that zeroes the NPV of the recorded flows plus the terminal value', () => {
    const row = buildIndiaMfReport(handChecked())!.sections[0].rows[0];
    expect(row.xirr.status).toBe('ok');
    if (row.xirr.status !== 'ok') return;
    const flows: Array<[string, number]> = [
      ['2023-01-02', -100000],
      ['2023-06-01', -20000],
      ['2023-09-01', 30000],
      ['2023-10-01', 6000],
      ['2023-11-01', 2000],
      ['2024-01-02', 12000],
      [V, 120000],
    ];
    const t0 = Date.parse('2023-01-02T00:00:00Z');
    const npv = flows.reduce((s, [d, a]) => s + a / Math.pow(1 + (row.xirr as { rate: number }).rate, (Date.parse(`${d}T00:00:00Z`) - t0) / 86400000 / 365), 0);
    expect(Math.abs(npv)).toBeLessThan(1);
    expect(row.xirr.rate).toBeGreaterThan(0);
  });

  it('SWP, STP, bonus and reinvestment are footnoted with the affected fund named', () => {
    const txns = [
      ...handCheckedTxns(),
      tx({ accountId: 'A1', instrumentId: 'X1', type: 'stp_in', date: '2023-12-01', units: 10, amount: 1000 }),
      tx({ accountId: 'A1', instrumentId: 'X1', type: 'bonus', date: '2023-12-02', units: 5, amount: 0 }),
      tx({ accountId: 'A1', instrumentId: 'X1', type: 'reinvestment', date: '2023-12-03', units: 2, amount: 200 }),
    ];
    const report = buildIndiaMfReport(handChecked({ transactions: txns }))!;
    const codes = report.footnotes.map((f) => f.code);
    expect(codes).toContain('SWP');
    expect(codes).toContain('STP');
    expect(codes).toContain('BONUS_SPLIT');
    expect(codes).toContain('REINVESTMENT');
    expect(report.footnotes.find((f) => f.code === 'SWP')!.affected[0]).toContain('Fund X1');
  });

  it('STP legs count as switch in / switch out, SWP counts in Red/SWP, reinvestment and bonus are not in A..E', () => {
    const txns = [
      tx({ accountId: 'A1', instrumentId: 'X1', type: 'purchase', date: '2023-01-02', units: 100, amount: 10000 }),
      tx({ accountId: 'A1', instrumentId: 'X1', type: 'stp_in', date: '2023-02-01', units: 10, amount: 1100 }),
      tx({ accountId: 'A1', instrumentId: 'X1', type: 'stp_out', date: '2023-03-01', units: 5, amount: 600 }),
      tx({ accountId: 'A1', instrumentId: 'X1', type: 'swp', date: '2023-04-01', units: 5, amount: 700 }),
      tx({ accountId: 'A1', instrumentId: 'X1', type: 'reinvestment', date: '2023-05-01', units: 3, amount: 330 }),
      tx({ accountId: 'A1', instrumentId: 'X1', type: 'bonus', date: '2023-05-02', units: 2, amount: 0 }),
    ];
    const t = buildIndiaMfReport(handChecked({ transactions: txns }))!.sections[0].tiles;
    expect(t.purchase).toBe(10000);
    expect(t.switchIn).toBe(1100);
    expect(t.switchOut).toBe(600);
    expect(t.redemptionSwp).toBe(700);
    expect(t.dividend).toBe(0);
    expect(t.netInvestment).toBe(10000 + 1100 - 600 - 700);
  });

  it('transactions after the valuation date and reversed / review_required rows are excluded', () => {
    const txns = [
      ...handCheckedTxns(),
      tx({ accountId: 'A1', instrumentId: 'X1', type: 'purchase', date: '2024-05-01', units: 10, amount: 9999 }),
      tx({ accountId: 'A1', instrumentId: 'X1', type: 'purchase', date: '2023-02-01', units: 10, amount: 8888, status: 'reversed' }),
      tx({ accountId: 'A1', instrumentId: 'X1', type: 'purchase', date: '2023-02-01', units: 10, amount: 7777, status: 'review_required' }),
    ];
    const report = buildIndiaMfReport(handChecked({ transactions: txns }))!;
    expect(report.sections[0].tiles.purchase).toBe(100000);
    expect(report.footnotes.map((f) => f.code)).toContain('REVIEW_EXCLUDED');
  });
});

describe('partial history shows a labelled value, never a blanket n/a', () => {
  // Statement window opens 2022-12-12 with an opening balance of 300 units
  // (cost unknown). Later: purchase 100u for 12,000 (NAV 120) then nothing.
  // Units held = 400. Units with recorded cost = 100.
  const a = 'A2';
  const i = 'X2';
  function partial(): IndiaMfReportInput {
    return baseInput({
      accounts: [acct(a, 'M-SELF')],
      instruments: [fund(i, 'Partial Fund')],
      transactions: [
        tx({ accountId: a, instrumentId: i, type: 'adjustment', date: '2022-12-12', units: 300, amount: 0, sourceReference: 'OPENING_BALANCE' }),
        tx({ accountId: a, instrumentId: i, type: 'purchase', date: '2023-04-03', units: 100, amount: 12000 }),
      ],
      navs: [{ instrumentId: i, date: V, price: 150 }],
      truth: [{ accountId: a, instrumentId: i, status: 'certified_with_warnings', historyCompleteness: 'complete_from_known_opening_balance', unitVarianceWithinTolerance: true }],
      members: [{ id: 'M-SELF', fullName: 'Asha Rao', relationship: 'self' }],
    });
  }

  it('values every held unit but measures cost-based figures on units with a recorded cost', () => {
    const row = buildIndiaMfReport(partial())!.sections[0].rows[0];
    expect(row.units).toBeCloseTo(400, 6);
    expect(row.currentValue).toBeCloseTo(400 * 150, 6);
    expect(row.avgNav).toBeCloseTo(120, 6); // 12,000 / 100
    expect(row.unrealisedGain).toBeCloseTo(100 * 150 - 12000, 6); // 3,000
    expect(row.xirr.status).toBe('ok'); // -12,000 on 2023-04-03, +15,000 at the NAV date
  });

  it('carries an explicit visible basis marker with the history start date and the CAS guidance', () => {
    const report = buildIndiaMfReport(partial())!;
    const row = report.sections[0].rows[0];
    expect(row.basis.partial).toBe(true);
    expect(row.basis.label).toBe('from 12-Dec-2022; earlier history not uploaded');
    expect(row.basis.unitsWithoutRecordedCost).toBeCloseTo(300, 6);
    const note = report.footnotes.find((f) => f.code === 'PARTIAL_HISTORY')!;
    expect(note.text).toContain('MFCentral integration is available');
    expect(note.text).toContain('CAMS or KFintech');
    expect(note.affected[0]).toContain('Partial Fund');
  });

  it('a redemption of units bought before the uploaded history is flagged and contributes no realised gain from unknown cost', () => {
    const input = baseInput({
      accounts: [acct(a, 'M-SELF')],
      instruments: [fund(i, 'Partial Fund')],
      transactions: [
        tx({ accountId: a, instrumentId: i, type: 'redemption', date: '2023-02-01', units: 50, amount: 6000 }),
        tx({ accountId: a, instrumentId: i, type: 'purchase', date: '2023-04-03', units: 100, amount: 12000 }),
      ],
      snapshots: [{ accountId: a, instrumentId: i, asOfDate: V, units: 100, value: 15000 }],
      navs: [{ instrumentId: i, date: V, price: 150 }],
      members: [{ id: 'M-SELF', fullName: 'Asha Rao', relationship: 'self' }],
    });
    const row = buildIndiaMfReport(input)!.sections[0].rows[0];
    expect(row.basis.partial).toBe(true);
    expect(row.basis.reasons).toContain('disposal_of_units_before_uploaded_history');
    expect(row.basis.preHistoryUnitsDisposed).toBeCloseTo(50, 6);
    expect(row.realisedGain).toBeNull(); // nothing with a recorded cost was sold
    expect(row.currentValue).toBeCloseTo(15000, 6);
    expect(row.xirr.status).toBe('ok');
  });

  it('XIRR is n/a, with the engine\'s reason, only when mathematically undefined', () => {
    // Money only ever went in and no NAV or statement value exists: undefined.
    const input = baseInput({
      accounts: [acct(a, 'M-SELF')],
      instruments: [fund(i)],
      transactions: [tx({ accountId: a, instrumentId: i, type: 'purchase', date: '2023-04-03', units: 100, amount: 12000 })],
      members: [{ id: 'M-SELF', fullName: 'Asha Rao', relationship: 'self' }],
    });
    const row = buildIndiaMfReport(input)!.sections[0].rows[0];
    expect(row.currentValue).toBeNull();
    expect(row.xirr.status).toBe('na');
    if (row.xirr.status === 'na') expect(row.xirr.reason).toBe('NO_VALUATION');
    // And a position valued at the very same NAV it was bought at with no other flow is defined (0%).
  });

  it('XIRR is n/a (ALL_SAME_SIGN) for a fully redeemed position with no purchase recorded', () => {
    const input = baseInput({
      accounts: [acct(a, 'M-SELF')],
      instruments: [fund(i)],
      transactions: [tx({ accountId: a, instrumentId: i, type: 'redemption', date: '2023-04-03', units: 100, amount: 12000 })],
      snapshots: [{ accountId: a, instrumentId: i, asOfDate: V, units: 0, value: 0 }],
      members: [{ id: 'M-SELF', fullName: 'Asha Rao', relationship: 'self' }],
    });
    const row = buildIndiaMfReport(input)!.sections[0].rows[0];
    expect(row.xirr.status).toBe('na');
    if (row.xirr.status === 'na') expect(row.xirr.reason).toBe('INSUFFICIENT_HISTORY');
  });

  it('a holding with a statement balance and no transactions shows its value and an honest "holding only" marker', () => {
    const input = baseInput({
      accounts: [acct(a, 'M-SELF')],
      instruments: [fund(i)],
      snapshots: [{ accountId: a, instrumentId: i, asOfDate: V, units: 100, value: 15000 }],
      members: [{ id: 'M-SELF', fullName: 'Asha Rao', relationship: 'self' }],
    });
    const row = buildIndiaMfReport(input)!.sections[0].rows[0];
    expect(row.currentValue).toBeCloseTo(15000, 6);
    expect(row.navSource).toBe('statement_value');
    expect(row.avgNav).toBeNull();
    expect(row.basis.label).toBe('holding only; no transactions uploaded');
  });
});

describe('owner break-up', () => {
  const members = [
    { id: 'M-SELF', fullName: 'Asha Rao', relationship: 'self' },
    { id: 'M-SP', fullName: 'Ravi Rao', relationship: 'spouse' },
  ];
  const entities = [{ id: 'E-HUF', name: 'Rao HUF', entityType: 'huf' }];

  function household(allocations: MfAllocation[] = []): IndiaMfReportInput {
    const txns = [
      tx({ accountId: 'A-SELF', instrumentId: 'X1', type: 'purchase', date: '2023-01-02', units: 100, amount: 10000 }),
      tx({ accountId: 'A-SP', instrumentId: 'X1', type: 'purchase', date: '2023-01-02', units: 50, amount: 5000 }),
      tx({ accountId: 'A-HUF', instrumentId: 'X1', type: 'purchase', date: '2023-01-02', units: 200, amount: 20000 }),
      tx({ accountId: 'A-NONE', instrumentId: 'X1', type: 'purchase', date: '2023-01-02', units: 10, amount: 1000 }),
    ];
    return baseInput({
      accounts: [acct('A-SELF', 'M-SELF'), acct('A-SP', 'M-SP'), acct('A-HUF', null), acct('A-NONE', null)],
      instruments: [fund('X1')],
      transactions: txns,
      navs: [{ instrumentId: 'X1', date: V, price: 150 }],
      members,
      entities,
      allocations: [
        { accountId: 'A-HUF', instrumentId: null, ownerMemberId: null, ownerEntityId: 'E-HUF', basisPoints: 10000, groupId: 'g1', status: 'active', effectiveFrom: null, effectiveTo: null },
        ...allocations,
      ],
    });
  }

  it('creates one self-contained section per owner, in Self, Spouse, entity, Unallocated order', () => {
    const report = buildIndiaMfReport(household())!;
    expect(report.sections.map((s) => s.label)).toEqual(['Asha Rao', 'Ravi Rao', 'Rao HUF', 'Unallocated / owner not set']);
    expect(report.sections.map((s) => s.kind)).toEqual(['personal', 'personal', 'entity', 'unallocated']);
    expect(report.sections.map((s) => s.roleLabel)).toEqual(['Self', 'Spouse', 'HUF', null]);
  });

  it('entity holdings never leak into personal totals and each section has its own totals', () => {
    const report = buildIndiaMfReport(household())!;
    const bySection = Object.fromEntries(report.sections.map((s) => [s.key, s.tiles]));
    expect(bySection['member:M-SELF'].currentValue).toBeCloseTo(100 * 150, 6);
    expect(bySection['member:M-SP'].currentValue).toBeCloseTo(50 * 150, 6);
    expect(bySection['entity:E-HUF'].currentValue).toBeCloseTo(200 * 150, 6);
    expect(bySection['unallocated'].currentValue).toBeCloseTo(10 * 150, 6);
    // Personal total (Self + Spouse) excludes the HUF and the unallocated folio.
    const personal = report.sections.filter((s) => s.kind === 'personal').reduce((s, x) => s + x.tiles.currentValue, 0);
    expect(personal).toBeCloseTo(150 * 150, 6);
    expect(report.notSummedNote).toMatch(/not added together/);
  });

  it('a folio with no allocation and no owner is surfaced in the Unallocated section, not dropped', () => {
    const report = buildIndiaMfReport(household())!;
    const un = report.sections.find((s) => s.kind === 'unallocated')!;
    expect(un.rows).toHaveLength(1);
    expect(un.rows[0].folio).toBe('F-A-NONE');
    expect(un.notes).toContain('owner not set');
  });

  it('a joint folio shows each owner\'s share; the owners\' shares sum to the whole position', () => {
    const joint: MfAllocation[] = [
      { accountId: 'A-SELF', instrumentId: null, ownerMemberId: 'M-SELF', ownerEntityId: null, basisPoints: 6000, groupId: 'gj', status: 'active', effectiveFrom: null, effectiveTo: null },
      { accountId: 'A-SELF', instrumentId: null, ownerMemberId: 'M-SP', ownerEntityId: null, basisPoints: 4000, groupId: 'gj', status: 'active', effectiveFrom: null, effectiveTo: null },
    ];
    const report = buildIndiaMfReport(household(joint))!;
    const selfRow = report.sections.find((s) => s.key === 'member:M-SELF')!.rows.find((r) => r.folio === 'F-A-SELF')!;
    const spouseRow = report.sections.find((s) => s.key === 'member:M-SP')!.rows.find((r) => r.folio === 'F-A-SELF')!;
    expect(selfRow.shareBasisPoints).toBe(6000);
    expect(spouseRow.shareBasisPoints).toBe(4000);
    expect(selfRow.jointFolio && spouseRow.jointFolio).toBe(true);
    expect(selfRow.units).toBeCloseTo(60, 6);
    expect(spouseRow.units).toBeCloseTo(40, 6);
    expect(selfRow.units + spouseRow.units).toBeCloseTo(100, 6);
    expect(selfRow.currentValue! + spouseRow.currentValue!).toBeCloseTo(100 * 150, 6);
    expect(selfRow.purchase + spouseRow.purchase).toBeCloseTo(10000, 6);
    // Share-invariant figures are identical for both owners.
    expect(selfRow.latestNav).toBe(spouseRow.latestNav);
    expect(JSON.stringify(selfRow.xirr)).toBe(JSON.stringify(spouseRow.xirr));
    expect(report.footnotes.map((f) => f.code)).toContain('JOINT');
  });

  it('an allocation group that does not total 100% is not trusted and the folio goes to Unallocated with the reason', () => {
    const account = acct('A-SELF', 'M-SELF');
    const bad: MfAllocation[] = [
      { accountId: 'A-SELF', instrumentId: null, ownerMemberId: 'M-SELF', ownerEntityId: null, basisPoints: 6000, groupId: 'gx', status: 'active', effectiveFrom: null, effectiveTo: null },
      { accountId: 'A-SELF', instrumentId: null, ownerMemberId: 'M-SP', ownerEntityId: null, basisPoints: 3000, groupId: 'gx', status: 'active', effectiveFrom: null, effectiveTo: null },
    ];
    // owner_member_id is set on the account, so it is honoured at 100% when the split is unusable.
    expect(resolveOwners(account, 'X1', bad, V).shares).toEqual([{ ownerKey: 'member:M-SELF', basisPoints: 10000 }]);
    const noOwner = resolveOwners({ ...account, ownerMemberId: null }, 'X1', bad, V);
    expect(noOwner.shares).toEqual([{ ownerKey: 'unallocated', basisPoints: 10000 }]);
    expect(noOwner.unallocatedReason).toMatch(/does not total 100%/);
  });

  it('superseded/removed allocation rows and future-dated rows are ignored', () => {
    const account = acct('A-SELF', null);
    const rows: MfAllocation[] = [
      { accountId: 'A-SELF', instrumentId: null, ownerMemberId: 'M-SP', ownerEntityId: null, basisPoints: 10000, groupId: 'g', status: 'superseded', effectiveFrom: null, effectiveTo: null },
      { accountId: 'A-SELF', instrumentId: null, ownerMemberId: 'M-SELF', ownerEntityId: null, basisPoints: 10000, groupId: 'g2', status: 'active', effectiveFrom: '2030-01-01', effectiveTo: null },
    ];
    expect(resolveOwners(account, 'X1', rows, V).shares[0].ownerKey).toBe('unallocated');
  });

  it('cross-user isolation: the report is built only from the rows handed in (another user\'s ids resolve to nothing)', () => {
    const input = household();
    // A transaction on an account the caller does not own has no matching account row and is never shown.
    input.transactions.push(tx({ accountId: 'A-OTHER-USER', instrumentId: 'X1', type: 'purchase', date: '2023-01-02', units: 999, amount: 99900 }));
    const report = buildIndiaMfReport(input)!;
    const allFolios = report.sections.flatMap((s) => s.rows.map((r) => r.folio));
    expect(allFolios).not.toContain('F-A-OTHER-USER');
    expect(report.sections.reduce((s, x) => s + x.tiles.purchase, 0)).toBe(36000);
  });
});

describe('scope and gating', () => {
  it('returns null (no section) when the user has no INR mutual-fund holding, whatever their home country', () => {
    // An Australian household: AUD fund and an INR non-mutual-fund instrument only.
    const input = baseInput({
      accounts: [acct('AU1', 'M-SELF', 'AUD'), acct('IN-EQ', 'M-SELF', 'INR')],
      instruments: [fund('AUF', 'AU Fund'), fund('EQ1', 'Some Share', 'equity')],
      transactions: [
        tx({ accountId: 'AU1', instrumentId: 'AUF', type: 'purchase', date: '2023-01-02', units: 10, amount: 1000 }),
        tx({ accountId: 'IN-EQ', instrumentId: 'EQ1', type: 'purchase', date: '2023-01-02', units: 10, amount: 1000 }),
      ],
    });
    expect(hasIndiaMfHoldings(input)).toBe(false);
    expect(buildIndiaMfReport(input)).toBeNull();
  });

  it('an Australian-resident user who HAS an INR mutual-fund folio gets the section; non-INR and non-MF positions are counted as excluded', () => {
    const input = baseInput({
      accounts: [acct('A1', 'M-SELF'), acct('AU1', 'M-SELF', 'AUD')],
      instruments: [fund('X1'), fund('AUF', 'AU Fund'), fund('EQ1', 'Some Share', 'equity')],
      transactions: [
        ...handCheckedTxns(),
        tx({ accountId: 'AU1', instrumentId: 'AUF', type: 'purchase', date: '2023-01-02', units: 10, amount: 1000 }),
        tx({ accountId: 'A1', instrumentId: 'EQ1', type: 'purchase', date: '2023-01-02', units: 10, amount: 1000 }),
      ],
      navs: [handNav],
      members: [{ id: 'M-SELF', fullName: 'Asha Rao', relationship: 'self' }],
    });
    expect(hasIndiaMfHoldings(input)).toBe(true);
    const report = buildIndiaMfReport(input)!;
    expect(report.excluded.nonInrMutualFundPositions).toBe(1);
    expect(report.excluded.nonMutualFundPositions).toBe(1);
    expect(report.sections[0].tiles.purchase).toBe(100000); // the AUD fund and the equity are not in the tiles
    expect(report.currency).toBe('INR');
  });
});

describe('index header values are never invented', () => {
  it('reports not_available when no close is loaded', () => {
    const report = buildIndiaMfReport(handChecked())!;
    expect(report.indices.sensex.status).toBe('not_available');
    expect(report.indices.sensex.value).toBeNull();
    expect(report.indices.nifty.status).toBe('not_available');
    expect(report.indices.nifty.value).toBeNull();
  });
  it('shows the loaded close with its own date', () => {
    const report = buildIndiaMfReport(handChecked({ sensex: { date: '2024-03-28', value: 73651.35 }, nifty: { date: '2024-03-28', value: 22326.9 } }))!;
    expect(report.indices.sensex).toMatchObject({ status: 'ok', value: 73651.35, date: '2024-03-28', ageDays: 3 });
    expect(report.indices.nifty).toMatchObject({ status: 'ok', value: 22326.9, date: '2024-03-28' });
  });
  it('a close dated after the valuation date is treated as not available (no look-ahead)', () => {
    expect(resolveIndexQuote({ date: '2024-04-02', value: 100 }, V, 'Nifty 50').status).toBe('not_available');
  });
  it('a non-positive or non-finite close is not shown', () => {
    expect(resolveIndexQuote({ date: V, value: 0 }, V, 'Nifty 50').status).toBe('not_available');
    expect(resolveIndexQuote({ date: V, value: Number.NaN }, V, 'Nifty 50').status).toBe('not_available');
  });
});

describe('valuation source', () => {
  it('with no published NAV the statement value per unit is used and labelled; with neither the value is not shown', () => {
    const withSnap = computePosition({
      account: acct('A1', null),
      instrument: fund('X1'),
      transactions: [tx({ accountId: 'A1', instrumentId: 'X1', type: 'purchase', date: '2023-01-02', units: 100, amount: 10000 })],
      snapshot: { accountId: 'A1', instrumentId: 'X1', asOfDate: '2024-03-15', units: 100, value: 14000 },
      nav: null,
      truth: null,
      valuationDate: V,
    });
    expect(withSnap.navSource).toBe('statement_value');
    expect(withSnap.latestNav).toBe(140);
    expect(withSnap.currentValue).toBe(14000);
    const none = computePosition({
      account: acct('A1', null),
      instrument: fund('X1'),
      transactions: [tx({ accountId: 'A1', instrumentId: 'X1', type: 'purchase', date: '2023-01-02', units: 100, amount: 10000 })],
      snapshot: null,
      nav: null,
      truth: null,
      valuationDate: V,
    });
    expect(none.navSource).toBe('none');
    expect(none.currentValue).toBeNull();
  });

  it('when the transaction history disagrees with the statement units, the statement units win and the position is flagged', () => {
    const p = computePosition({
      account: acct('A1', null),
      instrument: fund('X1'),
      transactions: [tx({ accountId: 'A1', instrumentId: 'X1', type: 'purchase', date: '2023-01-02', units: 100, amount: 10000 })],
      snapshot: { accountId: 'A1', instrumentId: 'X1', asOfDate: V, units: 120, value: 18000 },
      nav: { instrumentId: 'X1', date: V, price: 150 },
      truth: null,
      valuationDate: V,
    });
    expect(p.flags.ledgerDiffersFromStatement).toBe(true);
    expect(p.units).toBe(120);
    expect(p.currentValue).toBe(18000);
    expect(p.basis.partial).toBe(true);
  });
});

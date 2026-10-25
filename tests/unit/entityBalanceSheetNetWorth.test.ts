// EntityBalanceSheet (SMSF) and its use by the consolidated family view. EVIDENCE LABEL: UNIT-TESTED with hand-calculated oracles.
//
// PO household (AUD): personal assets 1,670,298 + investments 590,000 = 2,260,298; personal liabilities 600,000 + 700,000 + 85,857 = 1,385,857;
// personal net 874,441. SMSF assets 475,000 + 3,000 + 25,000 = 503,000; SMSF liability 370,000; derived net 133,000; family 1,007,441.
import { describe, expect, it } from 'vitest';
import { buildSmsfBalanceSheet, type SmsfSheetInput } from '@/lib/engines/entityBalanceSheet';
import { computeNetWorthLevels, type NetWorthEntityInput, type NetWorthRowInput } from '@/lib/engines/netWorthLevels';

const R = (r: Partial<NetWorthRowInput> & Pick<NetWorthRowInput, 'id' | 'register' | 'owner' | 'amountReporting'>): NetWorthRowInput => ({ name: r.id, currencyCode: 'AUD', ...r });

const PERSONAL: NetWorthRowInput[] = [
  R({ id: 'assets', register: 'assets', owner: 'self', amountReporting: 1_670_298 }),
  R({ id: 'inv', register: 'investments', owner: 'self', amountReporting: 590_000 }),
  R({ id: 'home-loan', register: 'liabilities', owner: 'self', amountReporting: 600_000 }),
  R({ id: 'inv-loan', register: 'liabilities', owner: 'joint', amountReporting: 700_000 }),
  R({ id: 'car-loan', register: 'liabilities', owner: 'spouse', amountReporting: 85_857 }),
];
const fundRow = (balance: number) => R({ id: 'fund', name: 'SMSF', register: 'retirement', owner: 'self', masterItemKey: 'smsf', amountReporting: balance });
const LEGACY_133 = R({ id: 'other', name: 'Other Retirement Assets', register: 'retirement', owner: 'smsf', masterItemKey: 'other_retirement', amountReporting: 133_000 });

const HOLDINGS = [
  { id: 'h1', name: '250 Elizebth st Melbourne 3000', holdingType: 'residential_property', value: 475_000, currency: 'AUD', valueReporting: 475_000 },
  { id: 'h2', name: 'Bank Australia', holdingType: 'cash_account', value: 3_000, currency: 'AUD', valueReporting: 3_000 },
  { id: 'h3', name: 'Secured finance', holdingType: 'cash_account', value: 25_000, currency: 'AUD', valueReporting: 25_000 },
];
const LOAN = (balance = 370_000) => [{ id: 'l1', name: 'SMSF property loan', type: 'property_loan', lender: 'Example Bank', balance, currency: 'AUD', balanceReporting: balance }];

const sheetInput = (over: Partial<SmsfSheetInput> = {}, fund: Partial<SmsfSheetInput['fund']> = {}): SmsfSheetInput => ({
  fund: { id: 'fund-1', name: 'PO SMSF', mode: 'detailed', currency: 'AUD', retirementAccountId: 'fund', typedNetReporting: null, typedNetPresent: false, ...fund },
  reportingCurrency: 'AUD',
  holdings: HOLDINGS,
  liabilities: LOAN(),
  linkedLoans: [],
  ...over,
});

describe('buildSmsfBalanceSheet: itemised OR net value only', () => {
  it('itemised: assets 503,000 less liability 370,000 DERIVES a net of 133,000', () => {
    const s = buildSmsfBalanceSheet(sheetInput());
    expect(s.mode).toBe('itemised');
    expect(s.assetsTotal).toBe(503_000);
    expect(s.liabilitiesTotal).toBe(370_000);
    expect(s.net).toBe(133_000);
    expect(s.typedNet).toBeNull();
  });

  it('net value only: the typed 133,000 is the net', () => {
    const s = buildSmsfBalanceSheet(sheetInput({ holdings: [], liabilities: [] }, { mode: 'summary', typedNetReporting: 133_000, typedNetPresent: true }));
    expect(s.mode).toBe('net_only');
    expect(s.net).toBe(133_000);
    expect(s.typedNet).toBe(133_000);
    expect(s.assets).toEqual([]);
  });

  it('BOTH PRESENT (legacy data): itemised reads only the lines, a stale typed 138,000 is ignored', () => {
    const s = buildSmsfBalanceSheet(sheetInput({}, { typedNetReporting: 138_000, typedNetPresent: true }));
    expect(s.net).toBe(133_000);
    expect(s.typedNet).toBeNull();
  });

  it('BOTH PRESENT (legacy data): net-only reads only the typed net, stray lines are ignored', () => {
    const s = buildSmsfBalanceSheet(sheetInput({}, { mode: 'summary', typedNetReporting: 138_000, typedNetPresent: true }));
    expect(s.net).toBe(138_000);
    expect(s.assets).toEqual([]);
    expect(s.liabilities).toEqual([]);
  });

  it('a personal loan still linked to the fund is a liability of the fund, counted once: 503,000 - 370,000 linked = 133,000', () => {
    const s = buildSmsfBalanceSheet(sheetInput({ liabilities: [], linkedLoans: [{ id: 'p1', name: 'SMSF property loan', lender: null, balance: 370_000, currency: 'AUD', balanceReporting: 370_000 }] }));
    expect(s.net).toBe(133_000);
    expect(s.liabilities[0].origin).toBe('linked_personal_loan');
  });

  it('an underwater fund has a NEGATIVE net (never clamped): assets 100,000 less 150,000 = -50,000', () => {
    const s = buildSmsfBalanceSheet(
      sheetInput({ holdings: [{ id: 'h', name: 'Cash', holdingType: 'cash', value: 100_000, currency: 'AUD', valueReporting: 100_000 }], liabilities: LOAN(150_000) }),
    );
    expect(s.net).toBe(-50_000);
  });

  it('MISSING != ZERO: an unconvertible line is left out and counted', () => {
    const s = buildSmsfBalanceSheet(sheetInput({ holdings: [...HOLDINGS, { id: 'h4', name: 'Foreign', holdingType: 'cash', value: 9, currency: 'GBP', valueReporting: null }] }));
    expect(s.unconvertedCount).toBe(1);
    expect(s.net).toBe(133_000);
  });
});

describe('the family view reads the sheet and nothing else for the SMSF', () => {
  const sheet = buildSmsfBalanceSheet(sheetInput());
  const levels = (rows: NetWorthRowInput[], extra: Partial<Parameters<typeof computeNetWorthLevels>[0]> = {}) =>
    computeNetWorthLevels({ currency: 'AUD', rows: [...PERSONAL, ...rows], entitySheets: [sheet], ...extra });
  const smsf = (l: ReturnType<typeof levels>) => l.entities.blocks.find((b) => b.kind === 'smsf');

  it('PO household after the build: personal 874,441, SMSF block 133,000 (503,000 assets, 370,000 liabilities), family 1,007,441', () => {
    const l = levels([fundRow(133_000)]);
    expect(l.personal.total.net).toBe(874_441);
    expect(smsf(l)?.source).toBe('entity_record');
    expect(smsf(l)?.entityTotals.totalAssets).toBe(503_000);
    expect(smsf(l)?.entityTotals.liabilities).toBe(370_000);
    expect(smsf(l)?.included.net).toBe(133_000);
    expect(l.family.net).toBe(1_007_441);
  });

  it('NOT DOUBLE COUNTED with the legacy 133,000 owner-smsf row or the fund row: family stays 1,007,441, the row is listed as not counted', () => {
    const l = levels([fundRow(133_000), LEGACY_133]);
    expect(l.family.net).toBe(1_007_441);
    expect(smsf(l)?.legacyRowsNotCounted).toEqual({ count: 1, net: 133_000, rows: [{ id: 'other', name: 'Other Retirement Assets', register: 'retirement', amount: 133_000 }] });
    expect(l.dataStatus.smsfPossibleDoubleCount).toContain('Other Retirement Assets');
    expect(smsf(l)?.suppressedFundRecord).toBeNull();
  });

  it('the fund record at its OLD gross value (503,000) cannot inflate the figure: the sheet is the source', () => {
    const l = levels([fundRow(503_000), LEGACY_133]);
    expect(l.family.net).toBe(1_007_441);
  });

  it('a personal loan still linked to the fund is not deducted again: the sheet already holds it (family 1,007,441)', () => {
    const linkedSheet = buildSmsfBalanceSheet(sheetInput({ liabilities: [], linkedLoans: [{ id: 'p1', name: 'SMSF property loan', lender: null, balance: 370_000, currency: 'AUD', balanceReporting: 370_000 }] }));
    const l = computeNetWorthLevels({
      currency: 'AUD',
      rows: [...PERSONAL, fundRow(133_000), R({ id: 'p1', name: 'SMSF property loan', register: 'liabilities', owner: 'joint', amountReporting: 370_000, smsfLinkedLoan: true, nettedInFundBalance: true })],
      entitySheets: [linkedSheet],
    });
    expect(l.personal.total.net).toBe(874_441);
    expect(l.family.net).toBe(1_007_441);
  });

  it('the bridge to the previously reported (all-rows) figure explains the difference exactly, with the fund row and the legacy row', () => {
    // previous = personal 874,441 + fund row 133,000 + legacy row 133,000 = 1,140,441
    const l = levels([fundRow(133_000), LEGACY_133], { previouslyReported: 1_140_441 });
    expect(l.bridge.parityOk).toBe(true);
    expect(l.bridge.lines.map((x) => x.key)).toEqual(['smsf_legacy_rows_not_counted']);
    expect(l.bridge.lines[0].amount).toBe(133_000);
  });

  it('the bridge handles a linked loan that history deducted twice (previous = 874,441 + 133,000 - 370,000 = 637,441)', () => {
    const linkedSheet = buildSmsfBalanceSheet(sheetInput({ liabilities: [], linkedLoans: [{ id: 'p1', name: 'SMSF property loan', lender: null, balance: 370_000, currency: 'AUD', balanceReporting: 370_000 }] }));
    const l = computeNetWorthLevels({
      currency: 'AUD',
      rows: [...PERSONAL, fundRow(133_000), R({ id: 'p1', name: 'SMSF property loan', register: 'liabilities', owner: 'joint', amountReporting: 370_000, smsfLinkedLoan: true, nettedInFundBalance: true })],
      entitySheets: [linkedSheet],
      previouslyReported: 637_441,
    });
    expect(l.bridge.parityOk).toBe(true);
    expect(l.bridge.lines.map((x) => x.key)).toEqual(['smsf_loan_counted_once']);
  });

  it('an underwater fund flows through as NEGATIVE in the family figure although the Retirement mirror is floored at 0', () => {
    const under = buildSmsfBalanceSheet(sheetInput({ holdings: [{ id: 'h', name: 'Cash', holdingType: 'cash', value: 100_000, currency: 'AUD', valueReporting: 100_000 }], liabilities: LOAN(150_000) }));
    const l = computeNetWorthLevels({ currency: 'AUD', rows: [...PERSONAL, fundRow(0)], entitySheets: [under], previouslyReported: 874_441 });
    expect(l.family.net).toBe(874_441 - 50_000);
    expect(l.bridge.parityOk).toBe(true);
    expect(l.bridge.lines.map((x) => x.key)).toEqual(['smsf_fund_row_differs']);
  });

  it('JOINT 60/40: a joint pool of 1,000,000 splits 600,000 / 400,000, totals 100%, and the SMSF changes neither share', () => {
    const joint = R({ id: 'jointprop', register: 'assets', owner: 'joint', amountReporting: 1_000_000, jointShares: [{ role: 'self', basisPoints: 6000 }, { role: 'spouse', basisPoints: 4000 }] });
    const l = computeNetWorthLevels({ currency: 'AUD', rows: [joint, fundRow(133_000)], entitySheets: [sheet] });
    const self = l.personal.parties.find((p) => p.key === 'self')!;
    const spouse = l.personal.parties.find((p) => p.key === 'spouse')!;
    expect(self.jointShare.assets).toBe(600_000);
    expect(spouse.jointShare.assets).toBe(400_000);
    expect(self.jointShare.assets + spouse.jointShare.assets).toBe(l.personal.jointPool.assets);
    expect(l.personal.total.net).toBe(1_000_000);
    expect(l.family.net).toBe(1_133_000);
  });

  it('Trust / HUF in full and Company at its share sit beside the SMSF unchanged: SMSF 133,000 + Trust 600,000 + Company 40% of 250,000 = 100,000', () => {
    const entities: NetWorthEntityInput[] = [
      { id: 't1', name: 'Family Trust', kind: 'family_trust', ownershipPercent: 100, netAssetValue: 600_000, detail: { assets: 1_000_000, liabilities: 400_000 } },
      { id: 'c1', name: 'Company', kind: 'company', ownershipPercent: 40, netAssetValue: 250_000, detail: null },
    ];
    const l = levels([fundRow(133_000)], { entities });
    expect(l.entities.byKind.smsf.net).toBe(133_000);
    expect(l.entities.byKind.family_trust.net).toBe(600_000);
    expect(l.entities.byKind.company.net).toBe(100_000);
    expect(l.family.net).toBe(874_441 + 133_000 + 600_000 + 100_000);
  });

  it('net value only: the SMSF block is the typed 133,000 and a leftover owner-smsf row is still not added', () => {
    const net = buildSmsfBalanceSheet(sheetInput({ holdings: [], liabilities: [] }, { mode: 'summary', typedNetReporting: 133_000, typedNetPresent: true }));
    const l = computeNetWorthLevels({ currency: 'AUD', rows: [...PERSONAL, fundRow(133_000), LEGACY_133], entitySheets: [net] });
    expect(smsf2(l)?.included.net).toBe(133_000);
    expect(l.family.net).toBe(1_007_441);
  });

  it('ENTITY-FREE households are unchanged: no sheet, no SMSF block, family = personal', () => {
    const l = computeNetWorthLevels({ currency: 'AUD', rows: PERSONAL, entitySheets: [] });
    expect(l.hasEntities).toBe(false);
    expect(l.family.net).toBe(874_441);
  });

  it('NEGATIVE CONTROL: WITHOUT the sheet the same rows follow the earlier row-based path (fund record 133,000 plus the owner-smsf row: the fund-level row wins, family 1,007,441, record shown uncounted)', () => {
    const l = computeNetWorthLevels({ currency: 'AUD', rows: [...PERSONAL, fundRow(133_000), LEGACY_133] });
    expect(smsf2(l)?.source).toBe('owner_tag');
    expect(smsf2(l)?.suppressedFundRecord).toEqual({ count: 1, amount: 133_000 });
    expect(l.family.net).toBe(1_007_441);
  });
});

function smsf2(l: ReturnType<typeof computeNetWorthLevels>) {
  return l.entities.blocks.find((b) => b.kind === 'smsf');
}

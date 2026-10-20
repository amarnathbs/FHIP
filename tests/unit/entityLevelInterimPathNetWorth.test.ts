// Interim path for the PO household (17-10-2026), REAL main model (netWorthLevels.ts with the personal-basis change a2a0f24).
// EVIDENCE LABEL: UNIT-TESTED with hand-calculated oracles. Each state below is one step of the click-by-click interim path in
// docs/architecture/ENTITY_LEVEL_ASSETS_AND_LIABILITIES_DESIGN_2026-10-16.md section 8.2.
//
//   personal: assets register 1,670,298 + investments 590,000 = 2,260,298; liabilities 600,000 + 700,000 + 85,857 = 1,385,857; net 874,441.
//   SMSF: holdings 503,000; loan 365,000 -> fund net 138,000; loan 370,000 -> fund net 133,000.
import { describe, expect, it } from 'vitest';
import { computeNetWorthLevels, type NetWorthRowInput } from '@/lib/engines/netWorthLevels';

const R = (r: Partial<NetWorthRowInput> & Pick<NetWorthRowInput, 'id' | 'register' | 'owner' | 'amountReporting'>): NetWorthRowInput => ({ name: r.id, currencyCode: 'AUD', ...r });

const PERSONAL: NetWorthRowInput[] = [
  R({ id: 'assets', register: 'assets', owner: 'self', amountReporting: 1_670_298 }),
  R({ id: 'inv', register: 'investments', owner: 'self', amountReporting: 590_000 }),
  R({ id: 'home-loan', register: 'liabilities', owner: 'self', amountReporting: 600_000 }),
  R({ id: 'inv-loan', register: 'liabilities', owner: 'joint', amountReporting: 700_000 }),
  R({ id: 'car-loan', register: 'liabilities', owner: 'spouse', amountReporting: 85_857 }),
  R({ id: 'spouse-contribution', register: 'retirement', owner: 'spouse', amountReporting: 0, masterItemKey: 'spouse_contribution' }),
];
const fundRow = (balance: number) => R({ id: 'fund', name: 'SMSF', register: 'retirement', owner: 'self', masterItemKey: 'smsf', amountReporting: balance });
const OTHER = R({ id: 'other', name: 'Other Retirement Assets', register: 'retirement', owner: 'smsf', masterItemKey: 'other_retirement', amountReporting: 133_000 });
const loan = (amount: number, over: Partial<NetWorthRowInput> = {}) => R({ id: 'smsf-loan', name: 'SMSF property loan', register: 'liabilities', owner: 'smsf', amountReporting: amount, ...over });
const linkedLoan = (amount: number) => loan(amount, { smsfLinkedLoan: true, nettedInFundBalance: true });

const levels = (rows: NetWorthRowInput[], previouslyReported?: number) => computeNetWorthLevels({ currency: 'AUD', rows: [...PERSONAL, ...rows], previouslyReported });
const smsf = (l: ReturnType<typeof levels>) => l.entities.blocks.find((b) => b.kind === 'smsf');

describe('interim path: PO household, every step', () => {
  it('S0 today on main: fund record 503,000 + fund-level row 133,000, no loan: personal 874,441, SMSF 133,000, family 1,007,441; fund record shown but not counted', () => {
    const l = levels([fundRow(503_000), OTHER]);
    expect(l.personal.total.net).toBe(874_441);
    expect(smsf(l)?.included.net).toBe(133_000);
    expect(l.family.net).toBe(1_007_441);
    expect(smsf(l)?.suppressedFundRecord).toEqual({ count: 1, amount: 503_000 });
    expect(l.dataStatus.smsfPossibleDoubleCount).not.toBeNull();
  });

  it('S1 TRAP, loan added with a balance and not yet linked (owner SMSF): deducted at the SMSF, family 642,441 (1,007,441 - 365,000)', () => {
    const l = levels([fundRow(503_000), OTHER, loan(365_000)]);
    expect(l.family.net).toBe(642_441);
    expect(l.personal.total.net).toBe(874_441);
  });

  it('S1 TRAP, same loan entered with a PERSONAL owner (joint) and not yet linked: personal falls to 509,441 and family to 642,441', () => {
    const l = levels([fundRow(503_000), OTHER, loan(365_000, { owner: 'joint' })]);
    expect(l.personal.total.net).toBe(509_441);
    expect(l.family.net).toBe(642_441);
  });

  it('S1 SAFE, loan entered with balance 0 (owner SMSF) and not yet linked: nothing moves', () => {
    const l = levels([fundRow(503_000), OTHER, loan(0)]);
    expect(l.personal.total.net).toBe(874_441);
    expect(l.family.net).toBe(1_007_441);
  });

  it('S2 loan linked, balance 365,000, fund record now 138,000, the 133,000 row still there: family STAYS 1,007,441 (the SMSF edits are hidden behind the 133,000 row)', () => {
    const l = levels([fundRow(138_000), OTHER, linkedLoan(365_000)]);
    expect(l.personal.total.net).toBe(874_441);
    expect(smsf(l)?.included.net).toBe(133_000);
    expect(l.family.net).toBe(1_007_441);
    expect(smsf(l)?.suppressedFundRecord).toEqual({ count: 1, amount: 138_000 });
  });

  it('S3 the 133,000 row removed, loan 365,000: SMSF block = fund net 138,000, loan counted once (not deducted again), family 1,012,441', () => {
    const l = levels([fundRow(138_000), linkedLoan(365_000)]);
    expect(l.personal.total.net).toBe(874_441);
    expect(smsf(l)?.included.net).toBe(138_000);
    expect(smsf(l)?.nettedLoans).toEqual({ count: 1, amount: 365_000 });
    expect(smsf(l)?.suppressedFundRecord).toBeNull();
    expect(l.family.net).toBe(1_012_441);
    expect(l.dataStatus.smsfPossibleDoubleCount).toBeNull();
  });

  it('S3 the 133,000 row removed, loan 370,000: fund net 133,000, family 1,007,441 (the number the PO expects)', () => {
    const l = levels([fundRow(133_000), linkedLoan(370_000)]);
    expect(smsf(l)?.included.net).toBe(133_000);
    expect(l.family.net).toBe(1_007_441);
    expect(l.personal.total.net).toBe(874_441);
  });

  it('WRONG ORDER TRAP: the 133,000 row removed BEFORE the loan is linked: the fund record counts at its gross 503,000, family 1,377,441', () => {
    const l = levels([fundRow(503_000)]);
    expect(l.personal.total.net).toBe(874_441);
    expect(l.family.net).toBe(1_377_441);
  });

  it('HISTORY-BASIS observation: the stored monthly history point still deducts the linked loan a second time; the bridge explains it exactly', () => {
    // History basis = every row, every liability: 874,441 + fund 138,000 - loan 365,000 = 647,441.
    const l = levels([fundRow(138_000), linkedLoan(365_000)], 647_441);
    expect(l.family.net).toBe(1_012_441);
    expect(l.bridge.parityOk).toBe(true);
    expect(l.bridge.lines.map((x) => x.key)).toEqual(['smsf_loan_counted_once']);
    expect(l.bridge.lines[0].amount).toBe(-365_000);
  });

  it('NEGATIVE CONTROL: an owner-SMSF loan that is NOT linked is deducted at the SMSF even when the fund record already nets it (the link is what prevents a second deduction)', () => {
    const l = levels([fundRow(138_000), loan(365_000)]);
    expect(l.family.net).toBe(874_441 + 138_000 - 365_000);
  });
});

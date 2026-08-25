import { describe, it, expect } from 'vitest';
import {
  classifyLiabilityDebtPurpose,
  summarizePropertyDebtByPurpose,
  isCrossCollateralised,
  computePropertyEquity,
  type LiabilityLite,
  type PropertyLiabilityLinkLite,
} from '@/lib/engines/propertyLiabilityLinks';

function liability(id: string, debt_type: string, master_item_key: string | null, balance: number, currency_code = 'AUD'): LiabilityLite {
  return { id, debt_type, master_item_key, balance, currency_code };
}
function link(liability_id: string, link_type: string, allocation_percent = 100, is_active = true): PropertyLiabilityLinkLite {
  return { liability_id, link_type, allocation_percent, is_active };
}

describe('classifyLiabilityDebtPurpose — spec s.64 Financial DNA test cases', () => {
  it('DNA-P01: Principal Residence <-> Home Loan => owner-occupied property debt', () => {
    const l = liability('l1', 'mortgage', 'home_loan', 500000);
    const links = [link('l1', 'owner_occupied_mortgage')];
    expect(classifyLiabilityDebtPurpose(l, links)).toBe('owner_occupied');
  });

  it('DNA-P02: Investment Property <-> Investment Property Loan => investment-related property debt', () => {
    const l = liability('l2', 'mortgage', 'investment_loan', 500000);
    const links = [link('l2', 'investment_property_loan')];
    expect(classifyLiabilityDebtPurpose(l, links)).toBe('investment_property');
  });

  it('DNA-P03: Credit Card, no property link => consumer debt', () => {
    const l = liability('l3', 'credit_card', 'credit_card', 5000);
    expect(classifyLiabilityDebtPurpose(l, [])).toBe('consumer');
  });

  it('DNA-P04: mixed household (Home Loan + Investment Property Loan) classified separately, never blended', () => {
    const home = liability('l4', 'mortgage', 'home_loan', 500000);
    const invest = liability('l5', 'mortgage', 'investment_loan', 400000);
    const links = [link('l4', 'owner_occupied_mortgage'), link('l5', 'investment_property_loan')];
    expect(classifyLiabilityDebtPurpose(home, links)).toBe('owner_occupied');
    expect(classifyLiabilityDebtPurpose(invest, links)).toBe('investment_property');

    const summary = summarizePropertyDebtByPurpose([home, invest], links);
    const ownerOccupied = summary.find((s) => s.purpose === 'owner_occupied');
    const investment = summary.find((s) => s.purpose === 'investment_property');
    expect(ownerOccupied?.totalBalance).toBe(500000);
    expect(investment?.totalBalance).toBe(400000);
    // never a single blended "total debt" bucket containing both
    expect(summary.find((s) => s.purpose === 'unclassified' && s.totalBalance === 900000)).toBeUndefined();
  });

  it('spec s.26: never sums across currencies — India (INR) and AUD debt of the same purpose stay in separate buckets', () => {
    const auHome = liability('l10', 'mortgage', 'home_loan', 500000, 'AUD');
    const inHome = liability('l11', 'mortgage', 'home_loan', 12000000, 'INR');
    const links = [link('l10', 'owner_occupied_mortgage'), link('l11', 'owner_occupied_mortgage')];
    const summary = summarizePropertyDebtByPurpose([auHome, inHome], links);
    const aud = summary.find((s) => s.purpose === 'owner_occupied' && s.currencyCode === 'AUD');
    const inr = summary.find((s) => s.purpose === 'owner_occupied' && s.currencyCode === 'INR');
    expect(aud?.totalBalance).toBe(500000);
    expect(inr?.totalBalance).toBe(12000000);
    // no bucket ever nominally adds 500000 (AUD) + 12000000 (INR) together
    expect(summary.some((s) => s.totalBalance === 12500000)).toBe(false);
  });

  it('relationship evidence is preferred over label inference even when a label would suggest otherwise', () => {
    // A custom liability (no master_item_key, debt_type left at its 'other' grid default)
    // that IS linked as an investment property loan must classify by the relationship,
    // not fall through to 'unclassified' the way it would with no link at all.
    const custom = liability('l6', 'other', null, 250000);
    expect(classifyLiabilityDebtPurpose(custom, [])).toBe('unclassified');
    expect(classifyLiabilityDebtPurpose(custom, [link('l6', 'investment_property_loan')])).toBe('investment_property');
  });

  it('consumer debt never gains investment-debt treatment even via label fallback', () => {
    const carLoan = liability('l7', 'other', 'car_loan', 20000);
    expect(classifyLiabilityDebtPurpose(carLoan, [])).toBe('consumer');
  });

  it('a liability cross-collateralised across properties of different purposes collapses to property_secured_other, not blended elsewhere', () => {
    const l = liability('l8', 'mortgage', 'investment_loan', 1000000);
    const links = [link('l8', 'commercial_property_loan', 60), link('l8', 'investment_property_loan', 40)];
    expect(classifyLiabilityDebtPurpose(l, links)).toBe('property_secured_other');
  });

  it('a deactivated (unlinked) link no longer influences classification — falls back to label inference', () => {
    const l = liability('l9', 'mortgage', 'home_loan', 500000);
    const links = [link('l9', 'owner_occupied_mortgage', 100, false)];
    expect(classifyLiabilityDebtPurpose(l, links)).toBe('owner_occupied'); // falls back to isGoodDebt('mortgage','home_loan')
  });
});

describe('isCrossCollateralised', () => {
  it('true when a liability has more than one active property link', () => {
    const links = [link('loanX', 'cross_collateralised', 60), link('loanX', 'cross_collateralised', 40)];
    expect(isCrossCollateralised('loanX', links)).toBe(true);
  });
  it('false for a single-property loan', () => {
    const links = [link('loanY', 'owner_occupied_mortgage', 100)];
    expect(isCrossCollateralised('loanY', links)).toBe(false);
  });
  it('false when the second link is inactive (historical, not current)', () => {
    const links = [link('loanZ', 'owner_occupied_mortgage', 100, true), link('loanZ', 'owner_occupied_mortgage', 100, false)];
    expect(isCrossCollateralised('loanZ', links)).toBe(false);
  });
});

describe('computePropertyEquity — calculated at render time, never persisted (spec s.65)', () => {
  it('principal residence: $800,000 property + $500,000 loan => $300,000 equity', () => {
    const eq = computePropertyEquity(800000, [{ balance: 500000, allocation_percent: 100 }]);
    expect(eq.grossValue).toBe(800000);
    expect(eq.linkedLiabilityBalance).toBe(500000);
    expect(eq.netEquity).toBe(300000);
  });

  it('debt-free property: no linked liabilities => equity equals full gross value', () => {
    const eq = computePropertyEquity(900000, []);
    expect(eq.linkedLiabilityBalance).toBe(0);
    expect(eq.netEquity).toBe(900000);
  });

  it('cross-collateral attribution: $1,000,000 loan at 60% => $600,000 attributed to this property', () => {
    const eq = computePropertyEquity(1000000, [{ balance: 1000000, allocation_percent: 60 }]);
    expect(eq.linkedLiabilityBalance).toBe(600000);
    expect(eq.netEquity).toBe(400000);
  });

  it('multiple facilities: Split A $400,000 + Split B $250,000 => $650,000 total, never double-counted', () => {
    const eq = computePropertyEquity(1200000, [
      { balance: 400000, allocation_percent: 100 },
      { balance: 250000, allocation_percent: 100 },
    ]);
    expect(eq.linkedLiabilityBalance).toBe(650000);
    expect(eq.netEquity).toBe(550000);
  });
});

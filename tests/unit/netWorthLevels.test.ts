import { describe, expect, it } from 'vitest';
import {
  computeNetWorthLevels,
  toNetWorthEntityInput,
  type NetWorthEntityInput,
  type NetWorthRowInput,
} from '@/lib/engines/netWorthLevels';
import type { BusinessEntityWithLineItems } from '@/lib/engines/businessEntityValuation';

/**
 * PO household (production report, AUD): total assets 2,896,298, liabilities 1,385,857, net worth 1,510,441.
 * Known from the report: SMSF 503,000 (owner self) + Other Retirement Assets 133,000 (owner smsf) + Spouse
 * Contribution 0 (owner spouse). The property/cash split below is a SYNTHETIC decomposition of the report's
 * remaining totals (the report gives only the totals), chosen so every figure is hand-checkable:
 *   non-retirement assets  2,260,298 = House 900,000 (self) + Cash 60,298 (self) + Investment property 1,000,000 (joint) + Car 300,000 (spouse)
 *   liabilities            1,385,857 = Home loan 600,000 (self) + Investment loan 700,000 (joint) + Car finance 85,857 (spouse)
 */
const row = (r: Partial<NetWorthRowInput> & Pick<NetWorthRowInput, 'id' | 'register' | 'owner' | 'amountReporting'>): NetWorthRowInput => ({ name: r.id, ...r });

function poHousehold(jointShares?: NetWorthRowInput['jointShares']): NetWorthRowInput[] {
  return [
    row({ id: 'house', register: 'assets', owner: 'self', amountReporting: 900_000 }),
    row({ id: 'cash', register: 'assets', owner: 'self', amountReporting: 60_298 }),
    row({ id: 'invprop', register: 'assets', owner: 'joint', amountReporting: 1_000_000, jointShares }),
    row({ id: 'car', register: 'assets', owner: 'spouse', amountReporting: 300_000 }),
    row({ id: 'smsf-fund', register: 'retirement', owner: 'self', amountReporting: 503_000 }),
    row({ id: 'other-ret', register: 'retirement', owner: 'smsf', amountReporting: 133_000 }),
    row({ id: 'spouse-contrib', register: 'retirement', owner: 'spouse', amountReporting: 0 }),
    row({ id: 'homeloan', register: 'liabilities', owner: 'self', amountReporting: 600_000 }),
    row({ id: 'invloan', register: 'liabilities', owner: 'joint', amountReporting: 700_000, jointShares }),
    row({ id: 'carloan', register: 'liabilities', owner: 'spouse', amountReporting: 85_857 }),
  ];
}

describe('net worth at two levels: the PO household (hand-calculated oracle)', () => {
  const levels = computeNetWorthLevels({ currency: 'AUD', rows: poHousehold(), previouslyReported: 1_510_441 });

  it('reproduces the report totals: assets 2,896,298, liabilities 1,385,857, net 1,510,441 at family level', () => {
    expect(levels.family.totalAssets).toBe(2_896_298);
    expect(levels.family.liabilities).toBe(1_385_857);
    expect(levels.family.net).toBe(1_510_441);
  });

  it('Self individual level, joint split 50/50: assets 1,963,298, liabilities 950,000, net 1,013,298', () => {
    const self = levels.personal.parties.find((p) => p.key === 'self')!;
    // 900,000 + 60,298 + 503,000 + 500,000 (half of the joint property)
    expect(self.total.totalAssets).toBe(1_963_298);
    // 600,000 + 350,000 (half of the joint loan)
    expect(self.total.liabilities).toBe(950_000);
    expect(self.total.net).toBe(1_013_298);
  });

  it('Spouse individual level: assets 800,000, liabilities 435,857, net 364,143', () => {
    const spouse = levels.personal.parties.find((p) => p.key === 'spouse')!;
    expect(spouse.total.totalAssets).toBe(800_000); // 300,000 car + 0 contribution + 500,000 joint half
    expect(spouse.total.liabilities).toBe(435_857); // 85,857 + 350,000
    expect(spouse.total.net).toBe(364_143);
  });

  it('personal level = 1,377,441 and EXCLUDES the SMSF-owned 133,000', () => {
    expect(levels.personal.total.net).toBe(1_377_441);
    expect(levels.personal.total.retirement).toBe(503_000);
  });

  it('SMSF entity level: 133,000 of assets, no liabilities, net 133,000', () => {
    const smsf = levels.entities.byKind.smsf;
    expect(smsf.retirement).toBe(133_000);
    expect(smsf.liabilities).toBe(0);
    expect(smsf.net).toBe(133_000);
  });

  it('family = personal + entities, line by line: 1,377,441 + 133,000 = 1,510,441', () => {
    expect(levels.personal.total.net + levels.entities.total.net).toBe(levels.family.net);
    expect(levels.family.net).toBe(1_510_441);
    expect(levels.reconciliation.map((l) => l.net)).toEqual([1_377_441, 133_000, 1_510_441]);
  });

  it("today's figure (1,510,441) is the FAMILY figure: the bridge needs no adjustment and parity holds", () => {
    expect(levels.bridge.parityOk).toBe(true);
    expect(levels.bridge.lines).toEqual([]);
    expect(levels.bridge.reproduced).toBe(1_510_441);
  });

  it('a joint item is counted ONCE: the shares add back to 100%, never 200%', () => {
    const joint = levels.personal.jointPool;
    expect(joint.totalAssets).toBe(1_000_000);
    const shares = levels.personal.parties.reduce((s, p) => s + p.jointShare.totalAssets, 0);
    expect(shares).toBe(1_000_000);
    expect(levels.personal.jointSplitBasis).toBe('default_equal');
  });
});

describe('joint split: recorded 60/40 style', () => {
  it('divides a 1,000,000 joint property 600,000 / 400,000 and still totals 1,000,000', () => {
    const levels = computeNetWorthLevels({
      currency: 'AUD',
      rows: poHousehold([
        { role: 'self', basisPoints: 6000 },
        { role: 'spouse', basisPoints: 4000 },
      ]),
    });
    const self = levels.personal.parties.find((p) => p.key === 'self')!;
    const spouse = levels.personal.parties.find((p) => p.key === 'spouse')!;
    expect(self.jointShare.totalAssets).toBe(600_000);
    expect(spouse.jointShare.totalAssets).toBe(400_000);
    expect(self.jointShare.liabilities).toBe(420_000);
    expect(spouse.jointShare.liabilities).toBe(280_000);
    expect(self.jointShare.totalAssets + spouse.jointShare.totalAssets).toBe(1_000_000);
    // The family figure is independent of the split.
    expect(levels.family.net).toBe(1_510_441);
    expect(levels.personal.jointSplitBasis).toBe('recorded');
  });

  it('an invalid recorded split (not 100%) is never used: the default equal split applies', () => {
    const levels = computeNetWorthLevels({
      currency: 'AUD',
      rows: poHousehold([
        { role: 'self', basisPoints: 6000 },
        { role: 'spouse', basisPoints: 5000 },
      ]),
    });
    const self = levels.personal.parties.find((p) => p.key === 'self')!;
    expect(self.jointShare.totalAssets).toBe(500_000);
    expect(levels.family.net).toBe(1_510_441);
  });

  it('an odd amount never loses or gains a cent across a three-way split', () => {
    const levels = computeNetWorthLevels({
      currency: 'AUD',
      rows: [
        row({
          id: 'j',
          register: 'assets',
          owner: 'joint',
          amountReporting: 100,
          jointShares: [
            { role: 'self', basisPoints: 3333 },
            { role: 'spouse', basisPoints: 3333 },
            { role: 'other', basisPoints: 3334 },
          ],
        }),
      ],
    });
    const sum = levels.personal.parties.reduce((s, p) => s + p.jointShare.totalAssets, 0);
    expect(Math.round(sum * 100) / 100).toBe(100);
    expect(levels.family.totalAssets).toBe(100);
  });
});

describe('SMSF property loan is counted once', () => {
  const rows: NetWorthRowInput[] = [
    // Detailed-mode fund: holdings 500,000 less the linked 365,000 loan = 135,000, held as the member's retirement balance.
    row({ id: 'fund', register: 'retirement', owner: 'self', amountReporting: 135_000 }),
    row({ id: 'loan', register: 'liabilities', owner: 'self', amountReporting: 365_000, smsfLinkedLoan: true, nettedInFundBalance: true }),
  ];
  it('net worth is 135,000, not -230,000', () => {
    const levels = computeNetWorthLevels({ currency: 'AUD', rows });
    expect(levels.family.net).toBe(135_000);
    expect(levels.family.liabilities).toBe(0);
    const smsf = levels.entities.blocks.find((b) => b.kind === 'smsf')!;
    expect(smsf.nettedLoans).toEqual({ count: 1, amount: 365_000 });
  });
  it("the bridge shows the previously reported (double-deducted) figure of -230,000 and proves parity", () => {
    const levels = computeNetWorthLevels({ currency: 'AUD', rows, previouslyReported: -230_000 });
    expect(levels.bridge.parityOk).toBe(true);
    expect(levels.bridge.lines.map((l) => [l.key, l.amount])).toEqual([['smsf_loan_counted_once', -365_000]]);
  });
  it('a loan NOT netted in any fund (plain SMSF-tagged, or its fund is gone) is deducted once, at the SMSF entity', () => {
    const levels = computeNetWorthLevels({
      currency: 'AUD',
      rows: [
        row({ id: 'fund', register: 'retirement', owner: 'self', amountReporting: 500_000 }),
        row({ id: 'loan', register: 'liabilities', owner: 'self', amountReporting: 365_000, smsfLinkedLoan: true, nettedInFundBalance: false }),
      ],
    });
    expect(levels.entities.byKind.smsf.liabilities).toBe(365_000);
    expect(levels.entities.byKind.smsf.net).toBe(-365_000);
    expect(levels.personal.total.net).toBe(500_000); // the loan is the fund's debt, not the member's personal debt
    expect(levels.family.net).toBe(135_000);
  });
});

describe('Trust / HUF / Company treatment at family level (PO decision 16-10-2026)', () => {
  const entities: NetWorthEntityInput[] = [
    { id: 'co', name: 'Acme Pty Ltd', kind: 'company', ownershipPercent: 40, netAssetValue: 500_000, detail: null },
    { id: 'tr', name: 'Smith Family Trust', kind: 'family_trust', ownershipPercent: 50, netAssetValue: 300_000, detail: null },
    { id: 'hu', name: 'Rao HUF', kind: 'huf', ownershipPercent: 100, netAssetValue: 200_000, detail: null },
  ];
  const personal = [row({ id: 'cash', register: 'assets', owner: 'self', amountReporting: 100_000 })];

  it('company counted at its ownership share, trust and HUF in full', () => {
    const levels = computeNetWorthLevels({ currency: 'AUD', rows: personal, entities });
    expect(levels.entities.byKind.company.net).toBe(200_000); // 40% of 500,000
    expect(levels.entities.byKind.family_trust.net).toBe(300_000); // full, the recorded 50% is not applied
    expect(levels.entities.byKind.huf.net).toBe(200_000);
    expect(levels.family.net).toBe(100_000 + 200_000 + 300_000 + 200_000);
    expect(levels.personal.total.net).toBe(100_000); // entities never touch the personal figure
  });

  it("the previous figure (trust at its 50%) is reproduced through an explicit bridge line", () => {
    const previouslyReported = 100_000 + 200_000 + 150_000 + 200_000; // company 40%, trust 50%, HUF 100%
    const levels = computeNetWorthLevels({ currency: 'AUD', rows: personal, entities, previouslyReported });
    expect(levels.bridge.parityOk).toBe(true);
    expect(levels.bridge.lines.map((l) => [l.key, l.amount])).toEqual([['trust_huf_included_in_full', -150_000]]);
  });

  it('a detailed-mode company applies the share to assets and liabilities pro rata (net unchanged)', () => {
    const levels = computeNetWorthLevels({
      currency: 'AUD',
      rows: [],
      entities: [{ id: 'co', name: 'Acme', kind: 'company', ownershipPercent: 25, netAssetValue: 600_000, detail: { assets: 1_000_000, liabilities: 400_000 } }],
    });
    expect(levels.entities.total.totalAssets).toBe(250_000);
    expect(levels.entities.total.liabilities).toBe(100_000);
    expect(levels.entities.total.net).toBe(150_000); // 25% of 600,000
  });

  it('an entity is counted once: the net value is not also added as underlying assets', () => {
    const levels = computeNetWorthLevels({ currency: 'AUD', rows: [], entities: [entities[0]] });
    expect(levels.family.totalAssets).toBe(200_000);
    expect(levels.family.net).toBe(200_000);
  });

  it('flags a possible double entry when the same kind exists as an owner tag and as a registered entity', () => {
    const levels = computeNetWorthLevels({
      currency: 'AUD',
      rows: [row({ id: 'x', register: 'assets', owner: 'company', amountReporting: 10_000 })],
      entities,
    });
    expect(levels.dataStatus.duplicateRisk).toContain('Company');
  });

  it('legacy owner tags family_trust / company are counted as entered, in their own entity blocks, never in the personal level', () => {
    const levels = computeNetWorthLevels({
      currency: 'AUD',
      rows: [
        row({ id: 't', register: 'investments', owner: 'family_trust', amountReporting: 80_000 }),
        row({ id: 'c', register: 'assets', owner: 'company', amountReporting: 20_000 }),
        row({ id: 'tl', register: 'liabilities', owner: 'family_trust', amountReporting: 30_000 }),
      ],
    });
    expect(levels.personal.total.net).toBe(0);
    expect(levels.entities.byKind.family_trust.net).toBe(50_000);
    expect(levels.entities.byKind.company.net).toBe(20_000);
    expect(levels.family.net).toBe(70_000);
  });
});

describe('negative controls: the model breaks loudly when entities are dropped or counted twice', () => {
  const rows = poHousehold();
  it('dropping the SMSF entity assets makes the family figure miss 133,000 (proves the entity block carries them)', () => {
    const withoutEntityRows = rows.filter((r) => r.owner !== 'smsf');
    const broken = computeNetWorthLevels({ currency: 'AUD', rows: withoutEntityRows, previouslyReported: 1_510_441 });
    expect(broken.family.net).toBe(1_377_441);
    expect(broken.bridge.parityOk).toBe(false);
    expect(broken.bridge.lines.at(-1)).toMatchObject({ key: 'unexplained', amount: 133_000 });
  });
  it('counting a joint item at 100% for each partner (200%) is detectable: the family total would exceed the pool', () => {
    const levels = computeNetWorthLevels({ currency: 'AUD', rows });
    const doubled = levels.personal.parties.reduce((s, p) => s + p.jointShare.totalAssets * 2, 0);
    expect(doubled).not.toBe(levels.personal.jointPool.totalAssets);
    expect(levels.personal.parties.reduce((s, p) => s + p.jointShare.totalAssets, 0)).toBe(levels.personal.jointPool.totalAssets);
  });
  it('subtracting an already-netted SMSF loan again changes the answer (the control is real)', () => {
    const good = computeNetWorthLevels({
      currency: 'AUD',
      rows: [
        row({ id: 'fund', register: 'retirement', owner: 'self', amountReporting: 135_000 }),
        row({ id: 'loan', register: 'liabilities', owner: 'self', amountReporting: 365_000, smsfLinkedLoan: true, nettedInFundBalance: true }),
      ],
    });
    const doubleCounted = computeNetWorthLevels({
      currency: 'AUD',
      rows: [
        row({ id: 'fund', register: 'retirement', owner: 'self', amountReporting: 135_000 }),
        row({ id: 'loan', register: 'liabilities', owner: 'self', amountReporting: 365_000, smsfLinkedLoan: true, nettedInFundBalance: false }),
      ],
    });
    expect(good.family.net).toBe(135_000);
    expect(doubleCounted.family.net).toBe(-230_000);
  });
});

describe('missing is not zero; currency conversion happens upstream', () => {
  it('a row that could not be converted is left out and counted, never added as zero or raw', () => {
    const levels = computeNetWorthLevels({
      currency: 'AUD',
      rows: [
        row({ id: 'a', register: 'assets', owner: 'self', amountReporting: 1_000 }),
        row({ id: 'usd', register: 'assets', owner: 'self', amountReporting: null, currencyCode: 'USD' }),
      ],
    });
    expect(levels.family.net).toBe(1_000);
    expect(levels.dataStatus.unconvertedCount).toBe(1);
    expect(levels.dataStatus.unconvertedByCurrency).toEqual({ USD: 1 });
  });
  it('child / other / no-owner items stay in the personal total as their own labelled line', () => {
    const levels = computeNetWorthLevels({
      currency: 'AUD',
      rows: [
        row({ id: 'a', register: 'assets', owner: null, amountReporting: 5_000 }),
        row({ id: 'b', register: 'assets', owner: 'child', amountReporting: 2_000 }),
      ],
    });
    expect(levels.personal.total.net).toBe(7_000);
    expect(levels.personal.parties.map((p) => p.key)).toContain('other_household');
    expect(levels.family.net).toBe(7_000);
  });
  it('registry entity conversion uses the certified single-rate net value (INR company -> AUD)', () => {
    const entity: BusinessEntityWithLineItems = {
      entity: { id: 'e', entity_type: 'company', name: 'India Pvt Ltd', ownership_percentage: 50, valuation_mode: 'summary', summary_net_asset_value: 5_600_000, currency_code: 'INR', is_active: true },
      assets: [],
      liabilities: [],
    };
    const input = toNetWorthEntityInput(entity, 'AUD', 56)!;
    expect(input.netAssetValue).toBe(100_000);
    const levels = computeNetWorthLevels({ currency: 'AUD', rows: [], entities: [input] });
    expect(levels.family.net).toBe(50_000);
  });
  it('an inactive registry entity contributes nothing', () => {
    const entity: BusinessEntityWithLineItems = {
      entity: { id: 'e', entity_type: 'family_trust', name: 'T', ownership_percentage: 100, valuation_mode: 'summary', summary_net_asset_value: 1, currency_code: 'AUD', is_active: false },
      assets: [],
      liabilities: [],
    };
    expect(toNetWorthEntityInput(entity, 'AUD', 56)).toBeNull();
  });
});

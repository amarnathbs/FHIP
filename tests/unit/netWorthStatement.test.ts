/**
 * Net Worth Statements -- pure builder (lib/engines/netWorthStatement.ts), hand-calculated oracles.
 *
 * The PO's own household (AUD), personal level:
 *   Assets register : Principal Residence (Self) 750,000; Holiday Home (Self) 300,000; Vacant Land (Joint) 345,000;
 *                     House (Joint) 127,500; Jewellery (Self) 100,000; Motor Vehicle (Spouse) 26,000;
 *                     Offset Account (Self) 20,898; Savings Account (Self) 900                      = 1,670,298
 *   Investments     : Investment Property (Self) 565,000; Shares (Self) 25,000                       =   590,000
 *   Total personal assets 2,260,298
 *   Liabilities     : Home Loan (Self) 520,904; Investment Loan (Joint) 451,714; Construction Loan (Joint) 290,100;
 *                     Investment loan 1 (Joint) 63,710; Construction loan 1 (Joint) 59,429          = 1,385,857
 *   Personal net worth 874,441
 *
 * Groups: Property 750,000 + 300,000 + 345,000 + 127,500 = 1,522,500; Cash 20,898 + 900 = 21,798; Investments 590,000;
 *         Other 100,000 + 26,000 = 126,000   (1,522,500 + 21,798 + 590,000 + 126,000 = 2,260,298)
 * By person (joint divided 50/50, counted once):
 *   Self own   : assets 750,000 + 300,000 + 100,000 + 20,898 + 900 + 565,000 + 25,000 = 1,761,798; liabilities 520,904; net 1,240,894
 *   Spouse own : assets 26,000; net 26,000
 *   Joint pool : assets 345,000 + 127,500 = 472,500; liabilities 451,714 + 290,100 + 63,710 + 59,429 = 864,953; net -392,453
 *   Self total 1,240,894 - 196,226.5 = 1,044,667.5; Spouse total 26,000 - 196,226.5 = -170,226.5; sum 874,441
 *
 * SMSF (the PO's example): asset 503,000, liability 370,000, net 133,000. Three data shapes:
 *   (A) today's rows: SMSF 503,000 owner self (a personal retirement row) + 133,000 owner smsf
 *       personal 874,441 + 503,000 = 1,377,441; SMSF 133,000; family 1,510,441
 *   (B) interim corrected: the 503,000 personal row removed
 *       personal 874,441; SMSF net 133,000; family 1,007,441
 *   (C) future entity-level: SMSF asset 503,000 and liability 370,000 itemised
 *       same totals as (B)
 */
import { describe, expect, it } from 'vitest';
import { computeNetWorthLevels, type NetWorthEntityInput, type NetWorthLevels } from '@/lib/engines/netWorthLevels';
import {
  buildNetWorthStatements,
  classifyRow,
  parseStatementView,
  statementsForView,
  toModelRow,
  type AssetGroupKey,
  type EntityStatementInput,
  type NetWorthStatementInput,
  type StatementSourceRow,
} from '@/lib/engines/netWorthStatement';

type Reg = StatementSourceRow['register'];
let seq = 0;
function row(register: Reg, name: string, owner: string | null, amount: number | null, extra: Partial<StatementSourceRow> & { group?: AssetGroupKey | null } = {}): StatementSourceRow {
  seq += 1;
  return {
    id: `${register}:r${seq}`,
    register,
    name,
    owner,
    amountReporting: amount,
    nativeAmount: amount,
    nativeCurrency: 'AUD',
    group: register === 'assets' ? 'other' : null,
    ...extra,
  };
}

function poPersonalRows(): StatementSourceRow[] {
  return [
    row('assets', 'Principal Residence', 'self', 750_000, { group: 'property' }),
    row('assets', 'Holiday Home', 'self', 300_000, { group: 'property' }),
    row('assets', 'Vacant Land', 'joint', 345_000, { group: 'property' }),
    row('assets', 'House', 'joint', 127_500, { group: 'property' }),
    row('assets', 'Jewellery', 'self', 100_000, { group: 'other' }),
    row('assets', 'Motor Vehicle', 'spouse', 26_000, { group: 'other' }),
    row('assets', 'Offset Account', 'self', 20_898, { group: 'cash' }),
    row('assets', 'Savings Account', 'self', 900, { group: 'cash' }),
    row('investments', 'Investment Property', 'self', 565_000),
    row('investments', 'Shares', 'self', 25_000),
    row('liabilities', 'Home Loan', 'self', 520_904),
    row('liabilities', 'Investment Loan', 'joint', 451_714),
    row('liabilities', 'Construction Loan', 'joint', 290_100),
    row('liabilities', 'Investment loan 1', 'joint', 63_710),
    row('liabilities', 'Construction loan 1', 'joint', 59_429),
  ];
}

function build(rows: StatementSourceRow[], extra: Partial<NetWorthStatementInput> & { entities?: NetWorthEntityInput[]; currency?: 'AUD' | 'INR' } = {}) {
  const currency = extra.currency ?? 'AUD';
  const levels = extra.levels ?? computeNetWorthLevels({ currency, rows: rows.map((r) => toModelRow(r)), entities: extra.entities ?? [] });
  const { entities: _e, ...rest } = extra;
  void _e;
  const set = buildNetWorthStatements({ levels, currency, asAt: '2026-10-16', rows, ...rest });
  return { set, levels };
}

describe('personal statement: the PO household (hand oracle)', () => {
  const { set } = build(poPersonalRows());
  const p = set.personal;

  it('totals: assets 2,260,298, liabilities 1,385,857, net worth 874,441', () => {
    expect(p.totals).toEqual({ assets: 2_260_298, liabilities: 1_385_857, net: 874_441 });
  });

  it('group subtotals: Property 1,522,500, Cash 21,798, Investments 590,000, Other 126,000, in that order, and they add to the total', () => {
    expect(p.assetGroups.map((g) => [g.key, g.subtotal])).toEqual([
      ['property', 1_522_500],
      ['cash', 21_798],
      ['investments', 590_000],
      ['other', 126_000],
    ]);
    expect(p.assetGroups.reduce((s, g) => s + g.subtotal, 0)).toBe(2_260_298);
  });

  it('every item is listed with its owner as the app shows it (Self / Spouse/Partner / Joint) and its amount', () => {
    const find = (name: string) => p.assetGroups.flatMap((g) => g.lines).concat(p.liabilities).find((l) => l.name === name)!;
    expect([find('Principal Residence').ownerLabel, find('Principal Residence').amount]).toEqual(['Self', 750_000]);
    expect([find('Vacant Land').ownerLabel, find('Vacant Land').amount]).toEqual(['Joint', 345_000]);
    expect([find('Motor Vehicle').ownerLabel, find('Motor Vehicle').amount]).toEqual(['Spouse/Partner', 26_000]);
    expect([find('Investment Loan').ownerLabel, find('Investment Loan').amount]).toEqual(['Joint', 451_714]);
    expect(p.assetGroups.flatMap((g) => g.lines)).toHaveLength(10);
    expect(p.liabilities).toHaveLength(5);
  });

  it('the itemised lines add to the model totals, so parity is clean', () => {
    expect(set.parity).toEqual({ ok: true, messages: [] });
  });

  it('by person: Self 1,044,667.5, Spouse -170,226.5, joint counted once (50/50), total 874,441', () => {
    const [self, spouse] = p.byPerson.rows;
    expect([self.label, self.ownNet, self.net]).toEqual(['Self', 1_240_894, 1_044_667.5]);
    expect([spouse.label, spouse.ownNet, spouse.net]).toEqual(['Spouse/Partner', 26_000, -170_226.5]);
    expect(self.jointShareNet).toBe(-196_226.5);
    expect(spouse.jointShareNet).toBe(-196_226.5);
    expect(self.net + spouse.net).toBe(874_441);
    expect(p.byPerson.total.net).toBe(874_441);
    expect(p.byPerson.jointPool).toEqual({ assets: 472_500, liabilities: 864_953, net: -392_453 });
    expect(p.byPerson.jointSplitText).toMatch(/equally \(50\/50\)/);
  });

  it('no entities: no entity statements, and the family statement equals the personal one', () => {
    expect(set.entities).toEqual([]);
    expect(set.hasEntities).toBe(false);
    expect(set.family.totals).toEqual(p.totals);
    expect(set.family.contributions.map((c) => c.key)).toEqual(['personal']);
  });

  it('wording is observational, carries the standard disclaimer elements, and no advice verbs', () => {
    const text = JSON.stringify(set);
    expect(text).not.toMatch(/you should|we recommend|consider (selling|buying)|must (sell|buy)/i);
    expect(p.levelExplanation).toMatch(/does not include any SMSF, trust, HUF or company assets/);
  });
});

describe('the three SMSF data shapes (PO example: asset 503,000, liability 370,000, net 133,000)', () => {
  const smsfBalance = () => row('retirement', 'Other Retirement Assets', 'smsf', 133_000);
  const memberSmsf = () => row('retirement', 'SMSF', 'self', 503_000);

  it('(A) today: 503,000 owner self + 133,000 owner smsf -> personal 1,377,441, SMSF 133,000, family 1,510,441', () => {
    const { set } = build([...poPersonalRows(), memberSmsf(), smsfBalance()]);
    expect(set.personal.totals.net).toBe(1_377_441);
    expect(set.personal.assetGroups.find((g) => g.key === 'retirement')!.subtotal).toBe(503_000);
    expect(set.entities).toHaveLength(1);
    expect(set.entities[0]).toMatchObject({ entityKind: 'smsf', net: 133_000, contribution: 133_000, itemisation: 'net_only' });
    expect(set.entities[0].notItemisedNote).toMatch(/not itemised yet/);
    expect(set.entities[0].enteredAs).toEqual(['Other Retirement Assets']);
    expect(set.entities[0].assets).toEqual([]); // no asset rows are invented: only the one net figure exists
    expect(set.family.totals.net).toBe(1_510_441);
    expect(set.family.contributionSum).toBe(1_510_441);
    expect(set.parity.ok).toBe(true);
  });

  it('(B) interim corrected: 503,000 row removed -> personal 874,441, SMSF net 133,000, family 1,007,441', () => {
    const { set } = build([...poPersonalRows(), smsfBalance()]);
    expect(set.personal.totals.net).toBe(874_441);
    expect(set.entities[0]).toMatchObject({ net: 133_000, contribution: 133_000, itemisation: 'net_only', assetsTotal: null, liabilitiesTotal: null });
    expect(set.family.totals.net).toBe(1_007_441);
    expect(set.parity.ok).toBe(true);
  });

  it('(C) future entity-level: SMSF asset 503,000 and liability 370,000 itemised -> same totals as (B)', () => {
    const { set } = build([
      ...poPersonalRows(),
      row('assets', 'SMSF property and cash', 'smsf', 503_000),
      row('liabilities', 'SMSF property loan', 'smsf', 370_000),
    ]);
    const smsf = set.entities[0];
    expect(smsf).toMatchObject({ itemisation: 'itemised', assetsTotal: 503_000, liabilitiesTotal: 370_000, net: 133_000, contribution: 133_000, notItemisedNote: null });
    expect(smsf.assets.map((l) => l.amount)).toEqual([503_000]);
    expect(smsf.liabilities.map((l) => l.amount)).toEqual([370_000]);
    expect(set.personal.totals.net).toBe(874_441);
    expect(set.family.totals.net).toBe(1_007_441);
    expect(set.parity.ok).toBe(true);
  });

  it('(C) via the stable EntityStatementInput (assets[], liabilities[], net, source flag): the entity page itemises from it', () => {
    const asset = row('assets', 'SMSF property and cash', 'smsf', 503_000);
    const loan = row('liabilities', 'SMSF property loan', 'smsf', 370_000);
    const input: EntityStatementInput = { entityId: 'tag:smsf', kind: 'smsf', name: 'SMSF', assets: [asset], liabilities: [loan], net: 133_000, source: 'entity_level_rows' };
    const { set } = build([...poPersonalRows(), asset, loan], { entityInputs: [input] });
    expect(set.entities[0]).toMatchObject({ source: 'entity_level_rows', itemisation: 'itemised', assetsTotal: 503_000, liabilitiesTotal: 370_000, net: 133_000 });
    expect(set.parity.ok).toBe(true);
  });

  it('entity-level rows that the model does not (yet) contain are reported as a parity difference, never forced', () => {
    const asset = row('assets', 'SMSF property and cash', 'smsf', 503_000);
    const input: EntityStatementInput = { entityId: 'tag:smsf', kind: 'smsf', name: 'SMSF', assets: [asset], liabilities: [], net: 133_000, source: 'entity_level_rows' };
    const { set } = build([...poPersonalRows(), smsfBalance()], { entityInputs: [input] });
    expect(set.entities[0].net).toBe(133_000); // the model's figure stands
    expect(set.parity.ok).toBe(false);
    expect(set.parity.messages.join(' ')).toMatch(/SMSF: the itemised lines add to assets 503000/);
  });

  it('an SMSF property loan already inside the fund balance is a note, not a second deduction', () => {
    const fund = row('retirement', 'SMSF', 'smsf', 135_000);
    const loan = row('liabilities', 'SMSF property loan', 'self', 365_000, { smsfLinkedLoan: true, nettedInFundBalance: true });
    const { set } = build([fund, loan]);
    expect(set.entities[0].liabilitiesTotal).toBeNull();
    expect(set.entities[0].net).toBe(135_000);
    expect(set.entities[0].notes.join(' ')).toMatch(/1 SMSF property loan totalling \$365,000 is already deducted/);
    expect(set.personal.liabilities).toEqual([]); // the loan is NOT listed as a personal liability
    expect(classifyRow(loan, 'AUD')).toEqual({ level: 'netted_in_fund' });
    expect(set.family.totals.net).toBe(135_000);
  });
});

describe('registered entities: Company by ownership share, Trust and HUF in full', () => {
  const company: NetWorthEntityInput = { id: 'co1', name: 'Smith Pty Ltd', kind: 'company', ownershipPercent: 40, netAssetValue: 500_000, detail: null };
  const trust: NetWorthEntityInput = { id: 'tr1', name: 'Smith Family Trust', kind: 'family_trust', ownershipPercent: 50, netAssetValue: 200_000, detail: null };
  const huf: NetWorthEntityInput = { id: 'hu1', name: 'Smith HUF', kind: 'huf', ownershipPercent: 100, netAssetValue: 80_000, detail: null };

  it('company at 40% of 500,000 = 200,000; trust 200,000 in full (50% recorded is not applied); HUF 80,000', () => {
    const { set } = build(poPersonalRows(), { entities: [company, trust, huf] });
    const byKind = Object.fromEntries(set.entities.map((e) => [e.entityKind, e]));
    expect(byKind.company).toMatchObject({ net: 500_000, includedPercent: 40, recordedOwnershipPercent: 40, contribution: 200_000, basis: 'ownership_share' });
    expect(byKind.company.contributionText).toMatch(/ownership share is 40%/);
    expect(byKind.family_trust).toMatchObject({ net: 200_000, includedPercent: 100, contribution: 200_000, basis: 'full' });
    expect(byKind.huf).toMatchObject({ net: 80_000, contribution: 80_000 });
    expect(set.family.totals.net).toBe(874_441 + 200_000 + 200_000 + 80_000);
    expect(set.family.contributionSum).toBe(1_354_441);
    expect(set.family.contributions.map((c) => c.net)).toEqual([874_441, 200_000, 200_000, 80_000]);
    expect(set.parity.ok).toBe(true);
  });

  it('the family page lists personal + each entity line by line (Company labelled with its share)', () => {
    const { set } = build(poPersonalRows(), { entities: [company] });
    expect(set.family.levels.map((l) => l.basisText)).toEqual(['Your own and joint items; excludes every entity', '40% ownership share']);
    expect(set.family.contributions[1].label).toMatch(/Company .* \(40% share\)/);
  });

  it('a registered entity whose value was never entered is "Not provided", not zero, and adds nothing to the family total', () => {
    const { set } = build(poPersonalRows(), { entities: [{ ...company, netAssetValue: 0 }], registryValueNotProvided: ['entity:co1'] });
    expect(set.entities[0].net).toBeNull();
    expect(set.entities[0].contribution).toBeNull();
    expect(set.family.contributions[1].net).toBeNull();
    expect(set.family.totals.net).toBe(874_441);
  });

  it('Detailed-mode entity: assets and liabilities totals are shown (line items are not named in the model)', () => {
    const detailed: NetWorthEntityInput = { id: 'co2', name: 'Detailed Co', kind: 'company', ownershipPercent: 50, netAssetValue: 300_000, detail: { assets: 700_000, liabilities: 400_000 } };
    const { set } = build([], { entities: [detailed] });
    expect(set.entities[0]).toMatchObject({ itemisation: 'totals_only', assetsTotal: 700_000, liabilitiesTotal: 400_000, net: 300_000, contribution: 150_000 });
  });
});

describe('missing values, unconverted currencies, FX and the D-05 note', () => {
  it('a value that was not provided is "Not provided" (never zero) and is left out of every total', () => {
    const rows = [row('assets', 'Savings', 'self', 1_000, { group: 'cash' }), row('assets', 'Boat', 'self', null, { nativeAmount: null, group: 'other' })];
    const { set } = build(rows);
    const boat = set.personal.assetGroups.flatMap((g) => g.lines).find((l) => l.name === 'Boat')!;
    expect(boat).toMatchObject({ amount: null, status: 'not_provided' });
    expect(set.personal.totals.assets).toBe(1_000);
    expect(set.personal.notProvidedCount).toBe(1);
    expect(set.personal.notes.join(' ')).toMatch(/shown as "Not provided" have no value entered.*left out of every total/);
  });

  it('an item in a currency that cannot be converted is listed separately, outside the totals, with a note', () => {
    const rows = [row('assets', 'Savings', 'self', 1_000, { group: 'cash' }), row('assets', 'USD account', 'self', null, { nativeAmount: 5_000, nativeCurrency: 'USD', group: 'cash' })];
    const { set, levels } = build(rows);
    expect(levels.dataStatus.unconvertedCount).toBe(1);
    expect(set.personal.totals.assets).toBe(1_000);
    expect(set.personal.assetGroups.flatMap((g) => g.lines).map((l) => l.name)).toEqual(['Savings']);
    expect(set.personal.notIncluded).toHaveLength(1);
    expect(set.personal.notIncluded[0]).toMatchObject({ name: 'USD account', native: { amount: 5_000, currency: 'USD' }, status: 'not_converted' });
    expect(set.personal.notes.join(' ')).toMatch(/cannot be converted/);
    expect(set.parity.ok).toBe(true);
  });

  it('an INR item in an AUD statement shows the recorded INR amount and one FX note with the rate and the as-at date day-first', () => {
    const rows = [row('assets', 'Chennai flat', 'self', 100_000, { nativeAmount: 5_600_000, nativeCurrency: 'INR', group: 'property' })];
    const { set } = build(rows, { fx: { fxRateAudInr: 56, rateSource: 'forecast_global_assumptions' } });
    const line = set.personal.assetGroups[0].lines[0];
    expect(line.native).toEqual({ amount: 5_600_000, currency: 'INR' });
    expect(set.personal.fxNote).toMatch(/1 AUD = 56 INR/);
    expect(set.personal.fxNote).toMatch(/as at 16\/10\/2026/);
  });

  it('no FX note when every item is in the reporting currency', () => {
    expect(build(poPersonalRows(), { fx: { fxRateAudInr: 56, rateSource: 'default' } }).set.personal.fxNote).toBeNull();
  });

  it('holdings imported but not yet in Net Worth (D-05) are a one-line note with count and amount, outside the totals', () => {
    const { set } = build(poPersonalRows(), { importedNotInNetWorth: { count: 3, amount: 42_000 } });
    expect(set.personal.totals.net).toBe(874_441);
    expect(set.personal.importedNotInNetWorth).toEqual({ count: 3, amount: 42_000 });
    expect(set.personal.notes.join(' ')).toMatch(/3 imported holdings worth \$42,000 are not yet in Net Worth/);
  });
});

describe('dates are day-first, never ISO or US order', () => {
  it('AUD: 16/10/2026; INR: 16-10-2026', () => {
    expect(build([], { currency: 'AUD' }).set.asAtLabel).toBe('As at 16/10/2026');
    expect(build([], { currency: 'INR' }).set.asAtLabel).toBe('As at 16-10-2026');
  });

  it('no year-first or month-first date appears anywhere in the built statements', () => {
    const { set } = build([...poPersonalRows(), row('retirement', 'SMSF fund', 'smsf', 133_000)], { fx: { fxRateAudInr: 56, rateSource: 'default' } });
    // `asAt` is the machine field (ISO, read by code only); every string a person reads is day-first.
    const { asAt, ...visible } = set;
    expect(asAt).toBe('2026-10-16');
    expect(JSON.stringify(visible)).not.toMatch(/\b\d{4}-\d{2}-\d{2}\b/);
  });
});

describe('NEGATIVE CONTROLS: the parity check really fails when an entity amount leaks or is double counted', () => {
  const rows = () => [...poPersonalRows(), row('retirement', 'Other Retirement Assets', 'smsf', 133_000)];

  it('baseline: the honest statement passes', () => {
    expect(build(rows()).set.parity.ok).toBe(true);
  });

  it('LEAK: an SMSF amount counted in the personal totals is caught (personal level mismatch)', () => {
    const rs = rows();
    const honest = computeNetWorthLevels({ currency: 'AUD', rows: rs.map((r) => toModelRow(r)) });
    const leaked: NetWorthLevels = {
      ...honest,
      personal: { ...honest.personal, total: { ...honest.personal.total, retirement: 133_000, totalAssets: honest.personal.total.totalAssets + 133_000, net: honest.personal.total.net + 133_000 } },
    };
    const { set } = build(rs, { levels: leaked });
    expect(set.parity.ok).toBe(false);
    expect(set.parity.messages.join(' ')).toMatch(/Personal level: the itemised lines add to assets 2260298/);
  });

  it('LEAK the other way: an SMSF row classified as personal (owner changed) makes the itemised personal list disagree with the model', () => {
    const rs = rows();
    const honest = computeNetWorthLevels({ currency: 'AUD', rows: rs.map((r) => toModelRow(r)) });
    const tampered = rs.map((r) => (r.owner === 'smsf' ? { ...r, owner: 'self' } : r));
    const { set } = build(tampered, { levels: honest });
    // The statement classifies via the model, so the tampered row is now personal while the supplied model still says it is the SMSF's.
    expect(set.personal.totals.net).toBe(874_441);
    expect(set.parity.ok).toBe(false);
  });

  it('DOUBLE COUNT: family total that counts the entity twice is caught', () => {
    const rs = rows();
    const honest = computeNetWorthLevels({ currency: 'AUD', rows: rs.map((r) => toModelRow(r)) });
    const doubled: NetWorthLevels = { ...honest, family: { ...honest.family, net: honest.family.net + 133_000, totalAssets: honest.family.totalAssets + 133_000 } };
    const { set } = build(rs, { levels: doubled });
    expect(set.parity.ok).toBe(false);
    expect(set.parity.messages.join(' ')).toMatch(/Family level: personal net worth plus the entity contributions is 1007441, but the Dashboard model reports 1140441/);
  });

  it('a Dashboard headline that differs from the personal statement is caught', () => {
    const { set } = build(rows(), { dashboardHeadline: { label: 'Net Worth (personal)', value: 1_007_441 } });
    expect(set.parity.ok).toBe(false);
    expect(set.family.dashboard.headlineMatches).toBe(false);
    expect(build(rows(), { dashboardHeadline: { label: 'Net Worth (personal)', value: 874_441 } }).set.family.dashboard.headlineMatches).toBe(true);
  });

  it('structurally, personal lines never contain an entity-owned row', () => {
    const { set } = build(rows());
    const personalOwners = new Set([...set.personal.assetGroups.flatMap((g) => g.lines), ...set.personal.liabilities].map((l) => l.ownerKey));
    expect(personalOwners.has('smsf')).toBe(false);
    expect(set.entities.flatMap((e) => e.assets).every((l) => l.ownerKey === 'smsf')).toBe(true);
  });
});

describe('views', () => {
  const { set } = build([...poPersonalRows(), row('retirement', 'Other Retirement Assets', 'smsf', 133_000)]);

  it('parseStatementView accepts personal, family, all and a real entity id; anything else falls back to personal', () => {
    expect(parseStatementView(undefined, set)).toBe('personal');
    expect(parseStatementView('family', set)).toBe('family');
    expect(parseStatementView('all', set)).toBe('all');
    expect(parseStatementView('entity:tag:smsf', set)).toEqual({ entity: 'tag:smsf' });
    expect(parseStatementView('entity:nope', set)).toBe('personal');
    expect(parseStatementView('<script>', set)).toBe('personal');
  });

  it('"all" returns one statement per page in order: personal, each entity, family', () => {
    expect(statementsForView(set, 'all').map((s) => s.kind)).toEqual(['personal', 'entity', 'family']);
    expect(statementsForView(set, { entity: 'tag:smsf' }).map((s) => s.kind)).toEqual(['entity']);
  });
});

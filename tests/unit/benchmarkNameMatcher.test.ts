// Pure benchmark-name normaliser / matcher. EVIDENCE LABEL: code-level unit tests on name
// strings taken from the held-scheme matrix (docs/investment-intelligence/bench1_phase2).
// They prove matching rules, not that any catalogue entry is verified or any index licensed.
import { describe, it, expect } from 'vitest';
import { matchBenchmarkName, normaliseBenchmarkName, type CatalogueEntryLite } from '@/lib/services/investment-intelligence/benchmarkData/benchmarkNameMatcher';

const E = (key: string, name: string, variant: CatalogueEntryLite['returnVariant'] = 'total_return', over: Partial<CatalogueEntryLite> = {}): CatalogueEntryLite => ({
  benchmarkId: `id-${key}`,
  benchmarkKey: key,
  officialName: name,
  returnVariant: variant,
  verified: true,
  active: true,
  ...over,
});

const CATALOGUE: CatalogueEntryLite[] = [
  E('IN_NIFTY_100_TRI', 'NIFTY 100 TRI'),
  E('IN_NIFTY_100_PRI', 'NIFTY 100', 'price'),
  E('IN_BSE_100_TRI', 'BSE 100 TRI'),
  E('IN_NIFTY_500_TRI', 'Nifty 500 TRI'),
  E('IN_BSE_500_TRI', 'BSE 500 TRI'),
  E('IN_NIFTY_MIDCAP_150_TRI', 'Nifty Midcap 150 TRI'),
  E('IN_NIFTY_LARGEMIDCAP_250_TRI', 'Nifty LargeMidcap 250 TRI'),
  E('IN_NIFTY50_HYBRID_COMP_DEBT_5050_TRI', 'NIFTY 50 Hybrid Composite Debt 50:50 Index TRI'),
  E('IN_NIFTY_CORPORATE_BOND_A2_TRI', 'NIFTY Corporate Bond Index A-II TRI'),
];

const best = (raw: string, cat: CatalogueEntryLite[] = CATALOGUE, opts = {}) => matchBenchmarkName(raw, cat, opts);

describe('name variants that ARE the same index', () => {
  it.each([
    ['NIFTY 100 TRI', 'IN_NIFTY_100_TRI'],
    ['NIFTY 100 Total Returns Index (TRI)', 'IN_NIFTY_100_TRI'],
    ['Nifty 100 Index TRI', 'IN_NIFTY_100_TRI'],
    ['NIFTY 100 TRI (AMFI Tier I)', 'IN_NIFTY_100_TRI'],
    ['BSE 100 TRI', 'IN_BSE_100_TRI'],
    ['S&P BSE 100 TRI', 'IN_BSE_100_TRI'], // renamed family: same index
    ['S&P BSE 500 TRI Index', 'IN_BSE_500_TRI'],
    ['BSE 500 TRI Index (AMFI Tier I; \'S&P BSE 500 TRI Index\' in older documents)', 'IN_BSE_500_TRI'],
    ['NIFTY 500 Index (TRI)', 'IN_NIFTY_500_TRI'],
    ['Nifty500 TRI', 'IN_NIFTY_500_TRI'],
    ['NIFTY MIDCAP 150 (TRI)', 'IN_NIFTY_MIDCAP_150_TRI'],
    ['Nifty Mid Cap 150 TRI', 'IN_NIFTY_MIDCAP_150_TRI'],
    ['Nifty Large Midcap 250 Index (TRI)', 'IN_NIFTY_LARGEMIDCAP_250_TRI'],
    ['Nifty Large & Midcap 250 TRI', 'IN_NIFTY_LARGEMIDCAP_250_TRI'],
    ['NIFTY 50 Hybrid Composite Debt 50:50 Index (TRI)', 'IN_NIFTY50_HYBRID_COMP_DEBT_5050_TRI'],
    ['NIFTY Corporate Bond Index A-II', 'IN_NIFTY_CORPORATE_BOND_A2_TRI'],
  ])('%s -> %s', (raw, key) => {
    const r = best(raw);
    expect(r.best?.entry.benchmarkKey).toBe(key);
    expect(r.ambiguous).toBe(false);
  });

  it('a stated TRI variant on an exact name is HIGH confidence; an unstated variant is only MEDIUM and says why', () => {
    expect(best('NIFTY 100 TRI').best?.confidence).toBe('high');
    const unstated = best('Nifty 500').best;
    expect(unstated?.entry.benchmarkKey).toBe('IN_NIFTY_500_TRI');
    expect(unstated?.confidence).toBe('medium');
    expect(unstated?.notes.join(' ')).toMatch(/does not state the variant/);
  });

  it('a heading that says "Benchmark (Total Return Index)" can supply the variant, but only through an explicit hint', () => {
    expect(best('Nifty 500').best?.confidence).toBe('medium');
    expect(best('Nifty 500', CATALOGUE, { declaredVariantHint: 'total_return' }).best?.confidence).toBe('high');
  });
});

describe('RULE: a PRICE index never matches a total-return requirement (named negative controls)', () => {
  it('the price entry with the identical name is rejected for a TRI requirement, with the reason', () => {
    const r = best('NIFTY 100', [E('IN_NIFTY_100_PRI', 'NIFTY 100', 'price')]);
    expect(r.best).toBeNull();
    expect(r.rejected[0]).toMatchObject({ reason: 'PRICE_INDEX_NOT_TOTAL_RETURN' });
  });
  it('with both a PRICE and a TRI entry of the same family, only the TRI entry is ever returned', () => {
    const r = best('NIFTY 100 TRI');
    expect(r.matches.map((m) => m.entry.benchmarkKey)).toEqual(['IN_NIFTY_100_TRI']);
    expect(r.rejected.some((x) => x.entry.benchmarkKey === 'IN_NIFTY_100_PRI' && x.reason === 'PRICE_INDEX_NOT_TOTAL_RETURN')).toBe(true);
  });
  it('a document that names the PRICE variant ("Nifty 100 Price Return") matches nothing under a TRI requirement', () => {
    expect(best('Nifty 100 Price Return Index').best).toBeNull();
  });
  it('a net-total-return series is not the gross total-return benchmark', () => {
    const r = best('NIFTY 100 TRI', [E('IN_NIFTY_100_NTR', 'NIFTY 100 TRI', 'net_total_return')]);
    expect(r.best).toBeNull();
    expect(r.rejected[0].reason).toBe('VARIANT_MISMATCH');
  });
  it('an entry whose variant is unknown is never matched', () => {
    expect(best('NIFTY 100 TRI', [E('IN_NIFTY_100_X', 'NIFTY 100 TRI', null)]).best).toBeNull();
  });
  it('CONTROL: the same catalogue without the price entry still matches, so the rejection above is the price rule and nothing else', () => {
    expect(best('NIFTY 100 TRI', [E('IN_NIFTY_100_TRI', 'NIFTY 100 TRI')]).best?.entry.benchmarkKey).toBe('IN_NIFTY_100_TRI');
  });
});

describe('RULE: the index owner is part of its identity', () => {
  it('NIFTY 100 (NSE) never matches BSE 100 (BSE) and vice versa', () => {
    expect(best('NIFTY 100 TRI', [E('IN_BSE_100_TRI', 'BSE 100 TRI')]).best).toBeNull();
    expect(best('BSE 100 TRI', [E('IN_NIFTY_100_TRI', 'NIFTY 100 TRI')]).best).toBeNull();
    expect(best('NIFTY 100 TRI', [E('IN_BSE_100_TRI', 'BSE 100 TRI')]).rejected[0].reason).toBe('OWNER_MISMATCH');
  });
  it('the same family under the same owner matches (CONTROL for the above)', () => {
    expect(best('BSE 100 TRI', [E('IN_BSE_100_TRI', 'BSE 100 TRI')]).best?.confidence).toBe('high');
  });
  it('a name with no owner word matches on family alone but only at reduced confidence', () => {
    const r = best('500 TRI', [E('IN_NIFTY_500_TRI', 'Nifty 500 TRI')]);
    expect(r.best?.confidence).toBe('medium');
    expect(r.best?.notes.join(' ')).toMatch(/owner is not stated/);
  });
});

describe('RULE: numbers must be identical; only a one-character word typo is tolerated, at LOW confidence', () => {
  it('500 never matches 250, 100 never matches 150', () => {
    expect(best('NIFTY 500 TRI', [E('A', 'NIFTY 250 TRI')]).best).toBeNull();
    expect(best('Nifty Midcap 150 TRI', [E('B', 'Nifty Midcap 100 TRI')]).best).toBeNull();
  });
  it('a different family never matches (Midcap 150 vs Smallcap 250 vs Largemidcap 250)', () => {
    expect(best('Nifty Smallcap 250 TRI').best).toBeNull();
    expect(best('Nifty Midcap 150 TRI', [E('C', 'Nifty LargeMidcap 250 TRI')]).best).toBeNull();
  });
  it('a one-letter typo in a word is LOW confidence with a note', () => {
    const r = best('Nifty Midcapp 150 TRI');
    expect(r.best?.entry.benchmarkKey).toBe('IN_NIFTY_MIDCAP_150_TRI');
    expect(r.best?.confidence).toBe('low');
    expect(r.best?.notes.join(' ')).toMatch(/typo/);
  });
});

describe('RULE: composites and commodity prices are unsupported, never reduced to one leg', () => {
  it('a weighted composite matches nothing and is reported as unsupported', () => {
    const r = best('45% BSE 500 TRI + 40% CRISIL Composite Bond Fund Index + 10% domestic gold + 5% domestic silver');
    expect(r.unsupported).toBe('composite');
    expect(r.matches).toEqual([]);
  });
  it('"domestic price of physical gold" is a commodity price, not an index', () => {
    expect(best('Domestic price of physical gold').unsupported).toBe('commodity_price');
  });
  it('CONTROL: a plain single index name is not flagged unsupported', () => {
    expect(best('BSE 500 TRI').unsupported).toBeNull();
  });
});

describe('catalogue hygiene', () => {
  it('an inactive entry is never matched', () => {
    expect(best('NIFTY 100 TRI', [E('IN_NIFTY_100_TRI', 'NIFTY 100 TRI', 'total_return', { active: false })]).best).toBeNull();
  });
  it('an UNVERIFIED entry is matched but flagged so a proposal cannot be mistaken for a usable mapping', () => {
    const r = best('NIFTY 100 TRI', [E('IN_NIFTY_100_TRI', 'NIFTY 100 TRI', 'total_return', { verified: false })]);
    expect(r.best?.entryVerified).toBe(false);
  });
  it('two entries equally good => ambiguous, so a human must choose', () => {
    const r = best('NIFTY 100 TRI', [E('A', 'NIFTY 100 TRI'), E('B', 'Nifty 100 TRI')]);
    expect(r.ambiguous).toBe(true);
  });
  it('aliases (a pre-rename name) match the same entry', () => {
    const r = best('S&P BSE 250 SmallCap TRI', [E('IN_BSE_250_SMALLCAP_TRI', 'BSE 250 SmallCap TRI', 'total_return', { aliases: ['S&P BSE 250 SmallCap TRI'] })]);
    expect(r.best?.entry.benchmarkKey).toBe('IN_BSE_250_SMALLCAP_TRI');
  });
});

describe('normaliser', () => {
  it('splits owner, variant and family', () => {
    expect(normaliseBenchmarkName('S&P BSE 100 TRI')).toMatchObject({ owner: 'bse', variant: 'total_return', familyKey: '100' });
    expect(normaliseBenchmarkName('NIFTY Midcap 150 Index')).toMatchObject({ owner: 'nse', variant: 'unspecified', familyKey: 'midcap 150' });
    expect(normaliseBenchmarkName('CRISIL Composite Bond Fund Index')).toMatchObject({ owner: 'crisil', familyKey: 'composite bond' });
  });
});

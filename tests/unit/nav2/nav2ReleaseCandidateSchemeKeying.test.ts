// NAV2 release candidate, D-6 (Product Owner decision 16-10-2026): two statement sections with the same name, plan, option and AMC but DIFFERENT ISINs are two
// funds. Before this change the import keyed schemes by name|plan|option|amc only, merged them, kept the first ISIN and opened no case (seen on DEV: a 30-line
// statement became 22 instruments).
//   NC-K1  the old key merges two same-name sections with different ISINs (the defect, shown on the old rule so the control means something); the new keys keep them apart
//   NC-K2  an ordinary statement is keyed exactly as before: ISIN in the transaction section and none in the holdings section is ONE scheme; one ISIN under several folios is one scheme
//   NC-K3  a record without an ISIN next to two different ISINs is never attached to either fund (its own "no identifier" key, and the funds it could be are listed)
//   NC-K4  the AMFI code splits the same way when the ISINs do not disagree
//   NC-K5  different plans or options never share a key; the result does not depend on the order of the records (a re-process gives the same keys)
//   NC-K6  the import really uses the keying for the grouping, for every lookup, and opens ONE review case per unattributable key
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { baseSchemeKey, createSchemeKeying } from '@/lib/services/investment-intelligence/schemeKeying';
import { mergeSchemeRecords } from '@/lib/services/investment-intelligence/documentProcessing';
import type { ParsedInstrumentRecord } from '@/lib/services/investment-intelligence/parsers/types';

const rec = (over: Partial<ParsedInstrumentRecord> = {}): ParsedInstrumentRecord => ({
  rawSchemeName: 'BANK OF INDIA LARGE CAP FUND', normalisedSchemeName: 'bank of india large cap fund', amcName: 'Bank of India Mutual Fund', planType: 'direct', optionType: 'growth', isin: null, amfiSchemeCode: null, ...over,
});
const A = rec({ isin: 'INF761K01FL3', amfiSchemeCode: '148980' });
const B = rec({ isin: 'INF761K01FK5', amfiSchemeCode: '148981' });

// the rule the import used before: one map entry per name|plan|option|amc, the first non-null identifier wins
function oldGrouping(records: ParsedInstrumentRecord[]): Map<string, ParsedInstrumentRecord> {
  const m = new Map<string, ParsedInstrumentRecord>();
  for (const r of records) { const k = baseSchemeKey(r); const e = m.get(k); m.set(k, e ? mergeSchemeRecords(e, r) : r); }
  return m;
}
function newGrouping(records: ParsedInstrumentRecord[]): Map<string, ParsedInstrumentRecord> {
  const keying = createSchemeKeying(records);
  const m = new Map<string, ParsedInstrumentRecord>();
  for (const r of records) { const k = keying.keyOf(r); const e = m.get(k); m.set(k, e ? mergeSchemeRecords(e, r) : r); }
  return m;
}

describe('NC-K1: same name, different ISIN', () => {
  it('the old rule merges them into ONE scheme and drops the second ISIN (the defect)', () => {
    const g = oldGrouping([A, B]);
    expect(g.size).toBe(1);
    expect([...g.values()][0].isin).toBe('INF761K01FL3');
  });
  it('the new rule keeps TWO schemes, each with its own ISIN and AMFI code', () => {
    const g = newGrouping([A, B]);
    expect(g.size).toBe(2);
    expect([...g.values()].map((s) => s.isin).sort()).toEqual(['INF761K01FK5', 'INF761K01FL3']);
    expect([...g.values()].map((s) => s.amfiSchemeCode).sort()).toEqual(['148980', '148981']);
  });
  it('with ISINs only (no AMFI code printed) the ISIN alone keeps them apart', () => {
    const g = newGrouping([rec({ isin: 'INF761K01FL3' }), rec({ isin: 'INF761K01FK5' })]);
    expect(g.size).toBe(2);
    expect(oldGrouping([rec({ isin: 'INF761K01FL3' }), rec({ isin: 'INF761K01FK5' })]).size).toBe(1);
  });
  it('a transaction and a holding of the SAME fund (same ISIN) still merge into one of the two', () => {
    const g = newGrouping([A, B, { ...A }, { ...B }]);
    expect(g.size).toBe(2);
  });
});

describe('NC-K2: ordinary statements are keyed exactly as before', () => {
  it('ISIN printed in the transaction section, none in the holdings section: one scheme, with the ISIN kept', () => {
    const keying = createSchemeKeying([A, rec()]);
    expect(keying.keyOf(A)).toBe(baseSchemeKey(A));
    expect(keying.keyOf(rec())).toBe(baseSchemeKey(A));
    const g = newGrouping([A, rec()]);
    expect(g.size).toBe(1);
    expect([...g.values()][0].isin).toBe('INF761K01FL3');
  });
  it('several folios of one fund (one ISIN) and a statement with no ISIN at all: the key is the old key', () => {
    for (const set of [[A, { ...A }, { ...A }], [rec(), rec()]]) {
      const keying = createSchemeKeying(set);
      for (const r of set) expect(keying.keyOf(r)).toBe(baseSchemeKey(r));
      expect(keying.noIdentifierKeys.size).toBe(0);
    }
  });
  it('the same ISIN in a different case or with spaces is the same ISIN', () => {
    const keying = createSchemeKeying([A, { ...A, isin: ' inf761k01fl3 ' }]);
    expect(keying.keyOf(A)).toBe(baseSchemeKey(A));
    expect(newGrouping([A, { ...A, isin: ' inf761k01fl3 ' }]).size).toBe(1);
  });
});

describe('NC-K3: a record without an identifier is never attached to one of several funds', () => {
  const none = rec();
  it('gets its own key, listed as unattributable, with the funds it could be', () => {
    const keying = createSchemeKeying([A, B, none]);
    const k = keying.keyOf(none);
    expect(k).toBe(`${baseSchemeKey(none)}|isin:none`);
    expect(keying.noIdentifierKeys.has(k)).toBe(true);
    expect(keying.siblingKeysOf(k)).toEqual([keying.keyOf(A), keying.keyOf(B)].sort());
    expect(newGrouping([A, B, none]).size).toBe(3);
  });
  it('the identified records are not touched by it', () => {
    const keying = createSchemeKeying([A, B, none]);
    expect(keying.keyOf(A)).not.toBe(keying.keyOf(B));
    expect(keying.noIdentifierKeys.has(keying.keyOf(A))).toBe(false);
  });
});

describe('NC-K4: the AMFI code splits when the ISINs do not disagree', () => {
  const a = rec({ amfiSchemeCode: '100001' });
  const b = rec({ amfiSchemeCode: '100002' });
  it('two AMFI codes, no ISIN: two schemes; one AMFI code: one scheme', () => {
    expect(newGrouping([a, b]).size).toBe(2);
    expect(newGrouping([a, { ...a }]).size).toBe(1);
  });
  it('an ISIN conflict wins: the ISIN decides the split', () => {
    const keying = createSchemeKeying([A, B]);
    expect(keying.keyOf(A)).toContain('|isin:');
  });
});

describe('NC-K5: plans, options and order', () => {
  it('different plans or options never share a key, whatever the identifiers', () => {
    const regular = rec({ planType: 'regular', isin: 'INF761K01FL3' });
    const keys = [A, regular, rec({ optionType: 'idcw', isin: 'INF761K01FL3' })].map((r) => createSchemeKeying([A, regular, B]).keyOf(r));
    expect(new Set(keys).size).toBe(3);
  });
  it('the keys do not depend on the order of the records, and asking twice gives the same keys', () => {
    const forward = createSchemeKeying([A, B, rec()]);
    const reverse = createSchemeKeying([rec(), B, A]);
    for (const r of [A, B, rec()]) expect(reverse.keyOf(r)).toBe(forward.keyOf(r));
    for (const r of [A, B, rec()]) expect(createSchemeKeying([A, B, rec()]).keyOf(r)).toBe(forward.keyOf(r));
    expect([...newGrouping([A, B, rec()]).keys()].sort()).toEqual([...newGrouping([rec(), B, A]).keys()].sort());
  });
  it('another fund of the same house with a different name is unaffected by the split', () => {
    const other = rec({ rawSchemeName: 'BANK OF INDIA FLEXI CAP FUND', normalisedSchemeName: 'bank of india flexi cap fund', isin: 'INF761K01FF5' });
    const keying = createSchemeKeying([A, B, other]);
    expect(keying.keyOf(other)).toBe(baseSchemeKey(other));
  });
});

describe('NC-K6: the import uses it', () => {
  const src = readFileSync(path.join(__dirname, '..', '..', '..', 'lib', 'services', 'investment-intelligence', 'documentProcessing.ts'), 'utf8');
  it('groups, and looks up, by the statement keying; the old key function is no longer called for a lookup', () => {
    expect(src).toContain("from './schemeKeying'");
    expect(src).toContain('createSchemeKeying(');
    expect(src).not.toMatch(/instrumentIdByKey\.get\(schemeKey\(/);
    expect(src).not.toMatch(/uniqueSchemes\.get\(schemeKey\(/);
    expect((src.match(/instrumentIdByKey\.get\(keying\.keyOf\(/g) ?? []).length).toBe(3);
  });
  it('a record that cannot be attributed is not resolved by name: it opens ONE ambiguous_instrument case and creates no instrument', () => {
    expect(src).toContain('keying.noIdentifierKeys.has(key)');
    expect(src).toMatch(/noIdentifierKeys\.has\(key\)[\s\S]{0,1800}discrepancyType: 'ambiguous_instrument'[\s\S]{0,1800}continue;/);
  });
});

// Statement import: which parsed scheme records are the SAME scheme (NAV2 release candidate, D-6, Product Owner decision 16-10-2026).
//
// THE GAP. The import grouped every parsed transaction and holding by `name|plan|option|amc`. That key leaves out the ISIN on purpose: the transaction
// section of a real folio statement prints the ISIN and the summary-of-holdings section does not, and they must still be ONE scheme (see
// mergeSchemeRecords in documentProcessing.ts). But two sections that print the same name, plan, option and AMC with DIFFERENT ISINs (two plans or
// options of one fund whose printed name does not tell them apart, or the same fund's two ISINs) were merged as well: the second ISIN was dropped
// silently, its units were added to the first fund, and no review case was opened.
//
// THE RULE. The key stays name|plan|option|amc unless the statement itself shows that the key is not enough:
//   * two or more DIFFERENT non-empty ISINs under one key: every record is keyed by its own ISIN; a record that carries NO ISIN cannot be said to belong
//     to either fund, so it gets its own "no identifier" key and is NEVER attached to one of them (the import opens one review case for it);
//   * else two or more DIFFERENT non-empty AMFI codes under one key: the same, by AMFI code;
//   * otherwise the key is exactly what it was, so an ordinary statement (one ISIN, or none, per name) is keyed and merged byte for byte as before.
// The decision depends only on the set of identifiers in the statement, never on the order of the sections, so a re-process of the same document
// gives the same keys (idempotent), and records of different plans or options never share a key, because the key still holds the plan and option.
import type { ParsedInstrumentRecord } from './parsers/types';

export function baseSchemeKey(s: ParsedInstrumentRecord): string {
  return `${s.normalisedSchemeName}|${s.planType}|${s.optionType}|${s.amcName}`;
}

const norm = (v: string | null | undefined): string | null => {
  const t = (v ?? '').trim().toUpperCase();
  return t === '' ? null : t;
};

export interface SchemeKeying {
  /** The key one parsed scheme record belongs to. */
  keyOf: (s: ParsedInstrumentRecord) => string;
  /** Keys of records that carry no identifier although their name is shared by several different identifiers: they must not be attached to any fund. */
  noIdentifierKeys: ReadonlySet<string>;
  /** For such a key: the keys of the identified records that share its name (the funds it could be). */
  siblingKeysOf: (noIdentifierKey: string) => string[];
}

export function createSchemeKeying(records: readonly ParsedInstrumentRecord[]): SchemeKeying {
  const isins = new Map<string, Set<string>>();
  const amfis = new Map<string, Set<string>>();
  for (const r of records) {
    const base = baseSchemeKey(r);
    const i = norm(r.isin);
    const a = norm(r.amfiSchemeCode);
    if (i) (isins.get(base) ?? isins.set(base, new Set()).get(base)!).add(i);
    if (a) (amfis.get(base) ?? amfis.set(base, new Set()).get(base)!).add(a);
  }
  const noId = new Set<string>();
  const siblings = new Map<string, Set<string>>();
  const keyOf = (s: ParsedInstrumentRecord): string => {
    const base = baseSchemeKey(s);
    if ((isins.get(base)?.size ?? 0) > 1) {
      const i = norm(s.isin);
      if (i) return `${base}|isin:${i}`;
      return `${base}|isin:none`;
    }
    if ((amfis.get(base)?.size ?? 0) > 1) {
      const a = norm(s.amfiSchemeCode);
      if (a) return `${base}|amfi:${a}`;
      return `${base}|amfi:none`;
    }
    return base;
  };
  // register the no-identifier keys and their siblings once, from the records themselves
  for (const r of records) {
    const k = keyOf(r);
    if (k.endsWith('|isin:none') || k.endsWith('|amfi:none')) {
      noId.add(k);
      continue;
    }
    if (k !== baseSchemeKey(r)) {
      const base = baseSchemeKey(r);
      const none = k.includes('|isin:') ? `${base}|isin:none` : `${base}|amfi:none`;
      (siblings.get(none) ?? siblings.set(none, new Set()).get(none)!).add(k);
    }
  }
  return { keyOf, noIdentifierKeys: noId, siblingKeysOf: (k) => [...(siblings.get(k) ?? [])].sort() };
}

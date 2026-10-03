// Scheme-benchmark mapping: PURE normaliser and matcher from a benchmark NAME
// as a scheme document states it ("NIFTY 100 Total Returns Index (TRI)",
// "S&P BSE 100 TRI", "Nifty Midcap 150 Index") to catalogue entries.
//
// Rules this module guarantees (each has a named negative control in
// tests/unit/benchmarkNameMatcher.test.ts):
//   1. OWNER IS PART OF IDENTITY. "NIFTY 100" (NSE) and "BSE 100" (BSE) are
//      different indices and never match each other. A BSE rename ("S&P BSE
//      100" -> "BSE 100") is the same index and does match.
//   2. A PRICE index NEVER satisfies a total-return requirement, whatever the
//      name similarity. A net-total-return series is a different series from a
//      (gross) total-return one and does not match either.
//   3. Numbers must be identical ("500" never matches "250"); only word
//      tokens may differ by a single typo, and then confidence is LOW.
//   4. A composite ("45% X + 40% Y ...") or a commodity price ("domestic price
//      of physical gold") is never reduced to one of its legs; it is reported
//      as unsupported.
//   5. When the document does not state the variant, SEBI's 2018 TRI mandate
//      is the only basis for assuming TRI: the match is MEDIUM at best and
//      carries a note; it is never HIGH.
//   6. Confidence describes the NAME MATCH only. Publication still needs the
//      database's own rules (verified catalogue entry, evidence, admin review).
//
// No I/O. No catalogue entry is ever invented.

export type NameVariant = 'total_return' | 'price' | 'net_total_return' | 'unspecified';
export type CatalogueVariant = 'total_return' | 'price' | 'net_total_return';
export type IndexOwner = 'nse' | 'bse' | 'crisil' | 'unknown';
export type MatchConfidence = 'high' | 'medium' | 'low';

export interface NormalisedBenchmarkName {
  raw: string;
  owner: IndexOwner;
  variant: NameVariant;
  /** Canonical family tokens, e.g. ['midcap150'] or ['50','hybrid','composite','debt','5050']. */
  family: string[];
  /** The family as one string; the identity (with owner) the matcher compares. */
  familyKey: string;
  unsupported: null | 'composite' | 'commodity_price';
}

const MERGE_PAIRS: Array<[string, string]> = [
  ['large', 'midcap'],
  ['large', 'cap'],
  ['mid', 'cap'],
  ['small', 'cap'],
  ['multi', 'cap'],
  ['flexi', 'cap'],
  ['mid', 'small'],
];

const FILLER = new Set(['index', 'indices', 'the', 'of', 'total', 'returns', 'return', 'tri', 'ntr', 'net', 'price', 'pri', 'amfi', 'as', 'per', 'tier', 'in', 'a', 'and', 'fund', 'benchmark', 'for']);

function wordsToTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/(\d+)\s*:\s*(\d+)(?:\s*:\s*(\d+))?/g, (_m, a, b, c) => `${a}${b}${c ?? ''}`)
    .replace(/([a-z])(\d)/g, '$1 $2')
    .replace(/(\d)([a-z])/g, '$1 $2')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function detectVariant(whole: string): NameVariant {
  const s = whole.toLowerCase();
  if (/\b(ntr|net total return)/.test(s)) return 'net_total_return';
  if (/\b(price return|price index|pri)\b/.test(s)) return 'price';
  if (/\b(tri|total returns?)\b/.test(s)) return 'total_return';
  return 'unspecified';
}

function detectOwner(whole: string): IndexOwner {
  // "Nifty500" / "BSE500" have no word boundary before the digits; split letters from digits first.
  const s = whole.toLowerCase().replace(/([a-z])(\d)/g, '$1 $2');
  if (/\bcrisil\b/.test(s)) return 'crisil';
  if (/\b(bse|sensex)\b/.test(s)) return 'bse';
  if (/\b(nifty|nse)\b/.test(s)) return 'nse';
  return 'unknown';
}

/** Strip every (possibly nested) parenthetical, keeping the text for variant detection only. */
function stripParentheses(s: string): string {
  let prev = '';
  let cur = s;
  while (prev !== cur) {
    prev = cur;
    cur = cur.replace(/\([^()]*\)/g, ' ');
  }
  return cur.replace(/[()]/g, ' ');
}

export function normaliseBenchmarkName(raw: string): NormalisedBenchmarkName {
  const whole = raw ?? '';
  const lower = whole.toLowerCase();
  const variant = detectVariant(whole);
  const owner = detectOwner(whole);

  let unsupported: NormalisedBenchmarkName['unsupported'] = null;
  const percentCount = (lower.match(/\d+(\.\d+)?\s*%/g) ?? []).length;
  if (percentCount >= 2 || /\d\s*%[^+]*\+/.test(lower) || /\bcomposite of\b/.test(lower)) unsupported = 'composite';
  else if (/\b(domestic )?price of (physical )?(gold|silver)\b/.test(lower)) unsupported = 'commodity_price';

  // The family comes from the text outside parentheses, with tier markers and
  // owner words removed; parentheticals only informed the variant above.
  let body = stripParentheses(whole)
    .toLowerCase()
    .replace(/\btier\s*(?:ii|i|1|2|one|two)\b/g, ' ')
    .replace(/\b([abc])\s*-?\s*(iii|ii|i)\b/g, (_m, l, r) => `${l}${r === 'iii' ? 3 : r === 'ii' ? 2 : 1}`)
    .replace(/\bs\s*&\s*p\b/g, ' ');
  // Owner words and filler words carry no family identity (the owner is compared
  // separately). "sensex" is kept: it is BSE's own family name.
  const tokens = wordsToTokens(body).filter((t) => !FILLER.has(t) && !['nifty', 'nse', 'bse', 'crisil'].includes(t));
  // Merge split compound words ("Large Midcap", "Small Cap") into one canonical token.
  for (let i = 0; i < tokens.length - 1; i++) {
    for (const [a, b] of MERGE_PAIRS) {
      if (tokens[i] === a && tokens[i + 1] === b) {
        tokens.splice(i, 2, a + b);
        break;
      }
    }
  }
  body = tokens.join(' ');
  return { raw: whole, owner, variant, family: tokens, familyKey: body, unsupported };
}

export interface CatalogueEntryLite {
  benchmarkId: string | null;
  benchmarkKey: string;
  officialName: string;
  returnVariant: CatalogueVariant | null;
  /** ii_benchmarks.catalogue_status === 'verified' */
  verified: boolean;
  /** ii_benchmarks.lifecycle_status === 'active' */
  active: boolean;
  /** Optional extra names this entry is known by (e.g. a pre-rename label). */
  aliases?: string[];
}

export type RejectionReason =
  | 'PRICE_INDEX_NOT_TOTAL_RETURN'
  | 'VARIANT_MISMATCH'
  | 'OWNER_MISMATCH'
  | 'FAMILY_MISMATCH'
  | 'UNKNOWN_ENTRY_VARIANT'
  | 'INACTIVE_ENTRY';

export interface BenchmarkNameMatch {
  entry: CatalogueEntryLite;
  confidence: MatchConfidence;
  /** 0..1, for ordering only. */
  score: number;
  reason: string;
  notes: string[];
  entryVerified: boolean;
}

export interface RejectedCandidate {
  entry: CatalogueEntryLite;
  reason: RejectionReason;
  detail: string;
}

export interface BenchmarkMatchResult {
  normalised: NormalisedBenchmarkName;
  matches: BenchmarkNameMatch[];
  best: BenchmarkNameMatch | null;
  rejected: RejectedCandidate[];
  unsupported: NormalisedBenchmarkName['unsupported'];
  /** True when more than one distinct entry matches at the best score (a human must choose). */
  ambiguous: boolean;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const dp: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

const isNumeric = (t: string) => /^\d+$/.test(t);

/** 'exact' | 'typo' | 'none': numbers must be identical; word tokens may differ by one edit (length >= 5). */
function compareFamilies(a: string[], b: string[]): 'exact' | 'typo' | 'none' {
  if (a.length !== b.length || a.length === 0) return 'none';
  let typo = false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    if (isNumeric(a[i]) || isNumeric(b[i])) return 'none';
    if (a[i].length >= 5 && b[i].length >= 5 && levenshtein(a[i], b[i]) <= 1) {
      typo = true;
      continue;
    }
    return 'none';
  }
  return typo ? 'typo' : 'exact';
}

export interface MatchOptions {
  /** What the comparison needs. Total return is the only value the product uses today. */
  required?: 'total_return';
  /** Variant the document states for the benchmark in a nearby heading (e.g. "Benchmark (Total Return Index)"). */
  declaredVariantHint?: NameVariant;
}

/**
 * Match a declared benchmark name to catalogue entries. Never invents an
 * entry; returns an empty match list (and reasons) when nothing is safe.
 */
export function matchBenchmarkName(raw: string, catalogue: readonly CatalogueEntryLite[], opts: MatchOptions = {}): BenchmarkMatchResult {
  const required = opts.required ?? 'total_return';
  const n = normaliseBenchmarkName(raw);
  const matches: BenchmarkNameMatch[] = [];
  const rejected: RejectedCandidate[] = [];

  if (n.unsupported) {
    return { normalised: n, matches, best: null, rejected, unsupported: n.unsupported, ambiguous: false };
  }

  // The variant the DOCUMENT states, with an explicit heading hint filling a gap only.
  const statedVariant: NameVariant = n.variant !== 'unspecified' ? n.variant : (opts.declaredVariantHint ?? 'unspecified');

  for (const entry of catalogue) {
    const names = [entry.officialName, ...(entry.aliases ?? [])];
    let bestCmp: 'exact' | 'typo' | 'none' = 'none';
    let entryNorm: NormalisedBenchmarkName | null = null;
    for (const nm of names) {
      const en = normaliseBenchmarkName(nm);
      const cmp = compareFamilies(n.family, en.family);
      const ownerOk = n.owner === en.owner || n.owner === 'unknown' || en.owner === 'unknown';
      if (cmp !== 'none' && ownerOk && (bestCmp === 'none' || (bestCmp === 'typo' && cmp === 'exact'))) {
        bestCmp = cmp;
        entryNorm = en;
      }
    }
    if (bestCmp === 'none' || !entryNorm) {
      // Report WHY, for the reviewer: same family under another owner is the dangerous near-miss.
      const sameFamilyOtherOwner = names.some((nm) => {
        const en = normaliseBenchmarkName(nm);
        return compareFamilies(n.family, en.family) !== 'none' && n.owner !== en.owner && n.owner !== 'unknown' && en.owner !== 'unknown';
      });
      rejected.push({
        entry,
        reason: sameFamilyOtherOwner ? 'OWNER_MISMATCH' : 'FAMILY_MISMATCH',
        detail: sameFamilyOtherOwner ? 'Same index family but published by a different owner: a different index.' : 'The index family differs.',
      });
      continue;
    }
    if (!entry.active) {
      rejected.push({ entry, reason: 'INACTIVE_ENTRY', detail: 'The catalogue entry is not active.' });
      continue;
    }
    if (entry.returnVariant === null) {
      rejected.push({ entry, reason: 'UNKNOWN_ENTRY_VARIANT', detail: 'The catalogue entry does not state whether it is a price, total-return or net-total-return series.' });
      continue;
    }
    // RULE 2: a price index never satisfies a total-return requirement.
    if (required === 'total_return' && entry.returnVariant === 'price') {
      rejected.push({ entry, reason: 'PRICE_INDEX_NOT_TOTAL_RETURN', detail: 'The catalogue series is a PRICE index; it excludes dividends and cannot stand in for a total-return benchmark.' });
      continue;
    }
    if (required === 'total_return' && entry.returnVariant !== 'total_return') {
      rejected.push({ entry, reason: 'VARIANT_MISMATCH', detail: `The catalogue series is ${entry.returnVariant}, not total return.` });
      continue;
    }
    if (statedVariant === 'price' || statedVariant === 'net_total_return') {
      rejected.push({
        entry,
        reason: statedVariant === 'price' ? 'PRICE_INDEX_NOT_TOTAL_RETURN' : 'VARIANT_MISMATCH',
        detail: statedVariant === 'price' ? 'The document names the PRICE variant; a total-return series is not the same benchmark.' : 'The document names the net-total-return variant; the catalogue series is gross total return.',
      });
      continue;
    }

    const notes: string[] = [];
    let confidence: MatchConfidence;
    let score: number;
    if (bestCmp === 'typo') {
      confidence = 'low';
      score = 0.5;
      notes.push('A word in the name differs by one character from the catalogue name (possible typo); a human must confirm.');
    } else if (statedVariant === 'unspecified') {
      confidence = 'medium';
      score = 0.75;
      notes.push('The document does not state the variant. SEBI requires scheme benchmarks to be total-return indices (circular of 4 Jan 2018), which is the only basis for assuming TRI here.');
    } else {
      confidence = 'high';
      score = 1;
    }
    if (n.owner === 'unknown' || entryNorm.owner === 'unknown') {
      confidence = confidence === 'high' ? 'medium' : 'low';
      score -= 0.1;
      notes.push('The index owner is not stated in the name, so the match rests on the family name alone.');
    }
    if (n.owner === 'bse' && /s\s*&\s*p/i.test(raw)) notes.push('"S&P BSE" is the former brand of the BSE index family; it is treated as the same index as "BSE".');
    matches.push({ entry, confidence, score, reason: bestCmp === 'exact' ? 'Exact normalised match on owner, index family and variant.' : 'Near match (single-character difference).', notes, entryVerified: entry.verified });
  }

  matches.sort((a, b) => b.score - a.score || a.entry.benchmarkKey.localeCompare(b.entry.benchmarkKey));
  const best = matches[0] ?? null;
  const ambiguous = best !== null && matches.filter((m) => m.score === best.score).length > 1;
  return { normalised: n, matches, best, rejected, unsupported: null, ambiguous };
}

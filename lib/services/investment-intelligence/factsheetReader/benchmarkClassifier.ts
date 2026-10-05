// Classify a declared benchmark string and compare two declarations. PURE: no I/O.
//
// Reuses the repository's own name normaliser/matcher (benchmarkNameMatcher.ts) for identity and for the
// composite / commodity-price detection, so this module can never disagree with the matcher the mapping
// governance already relies on: a composite or a commodity price is never reduced to one of its legs and a
// price index never stands in for a total-return one.

import { matchBenchmarkName, normaliseBenchmarkName, type BenchmarkMatchResult, type CatalogueEntryLite } from '../benchmarkData/benchmarkNameMatcher';
import type { BenchmarkKind, CatalogueState, CompositionLeg, DeclaredBenchmarkVersion, ExtractedBenchmark } from './types';

export interface ClassifiedBenchmark {
  raw: string;
  kind: BenchmarkKind;
  composition: CompositionLeg[];
  /** Stable key for "is this the same benchmark?" (owner + family + variant, or the sorted weighted legs). */
  identityKey: string;
}

const MAX_NAME_CHARS = 200;

function clean(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Split a composite statement into weighted legs: "45% BSE 500 TRI + 40% Crisil Composite Bond Fund Index + 10% Domestic prices of Gold". */
export function parseComposition(raw: string): CompositionLeg[] {
  const parts = raw.split(/\s\+\s|\s*\+\s(?=\d)/).map(clean).filter(Boolean);
  const legs: CompositionLeg[] = [];
  for (const part of parts) {
    const w = /^(\d+(?:\.\d+)?)\s*%\s*(?:of\s+)?(.+)$/i.exec(part);
    if (w) legs.push({ weightPct: Number(w[1]), name: clean(w[2]).replace(/[.;,]+$/, '') });
    else legs.push({ weightPct: null, name: part.replace(/[.;,]+$/, '') });
  }
  return legs;
}

function legKey(l: CompositionLeg): string {
  const n = normaliseBenchmarkName(l.name);
  const body = n.unsupported === 'commodity_price' || n.family.length === 0 ? l.name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() : `${n.owner}|${n.familyKey}|${n.variant}`;
  return `${l.weightPct ?? '-'}%${body}`;
}

export function classifyBenchmark(raw: string): ClassifiedBenchmark {
  const text = clean(raw).slice(0, MAX_NAME_CHARS * 2);
  const n = normaliseBenchmarkName(text);
  if (n.unsupported === 'composite') {
    const composition = parseComposition(text);
    return { raw: text, kind: 'composite', composition, identityKey: `composite:${composition.map(legKey).sort().join('+')}` };
  }
  // The shared matcher flags "price of gold"; a plural or reordered wording ("domestic prices of gold", "gold price")
  // is the same thing and must not slip through as a single index.
  const commodity = n.unsupported === 'commodity_price' || /\b(domestic\s+)?prices?\s+of\s+(physical\s+)?(gold|silver)\b|\b(gold|silver)\s+prices?\b/i.test(text);
  if (commodity) {
    return { raw: text, kind: 'commodity_price', composition: [{ weightPct: null, name: text }], identityKey: `commodity:${text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}` };
  }
  return { raw: text, kind: 'single_index', composition: [{ weightPct: null, name: text }], identityKey: `index:${n.owner}|${n.familyKey}|${n.variant}` };
}

/** Variant is part of identity only when the name states one on BOTH sides; a bare name vs "(TRI)" counts as the same index. */
export function sameBenchmark(a: ClassifiedBenchmark, b: ClassifiedBenchmark): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind !== 'single_index') return a.identityKey === b.identityKey;
  const [, ak] = a.identityKey.split(':');
  const [, bk] = b.identityKey.split(':');
  const [ao, af, av] = ak.split('|');
  const [bo, bf, bv] = bk.split('|');
  if (ao !== bo || af !== bf) return false;
  return av === bv || av === 'unspecified' || bv === 'unspecified';
}

// ---------------------------------------------------------------------------
// Catalogue state
// ---------------------------------------------------------------------------

export interface CatalogueDecision {
  state: CatalogueState;
  benchmarkId: string | null;
  confidence: 'high' | 'medium' | 'low' | null;
  match: BenchmarkMatchResult | null;
  notes: string[];
}

/**
 * Decide the catalogue state of a declared benchmark using the existing matcher. 'matched_verified' requires a
 * unique best match at HIGH confidence against a VERIFIED, ACTIVE, TOTAL-RETURN entry; anything softer is
 * 'matched_other' (a human decides). A composite / commodity price is never matched at all.
 */
export function decideCatalogueState(b: ExtractedBenchmark, classified: ClassifiedBenchmark, catalogue: readonly CatalogueEntryLite[]): CatalogueDecision {
  if (classified.kind === 'composite') return { state: 'unsupported_composite', benchmarkId: null, confidence: null, match: null, notes: ['Several indices are combined; one catalogue series cannot represent this. The composition is stored.'] };
  if (classified.kind === 'commodity_price') return { state: 'unsupported_commodity', benchmarkId: null, confidence: null, match: null, notes: ['A commodity price is not an index series; it is not in the catalogue.'] };
  const match = matchBenchmarkName(classified.raw, catalogue, { declaredVariantHint: b.variantHint ?? undefined });
  const best = match.best;
  if (!best) return { state: 'no_catalogue_match', benchmarkId: null, confidence: null, match, notes: match.rejected.slice(0, 3).map((r) => `${r.entry.benchmarkKey}: ${r.detail}`) };
  const clean = best.confidence === 'high' && !match.ambiguous && best.entry.verified && best.entry.active && best.entry.returnVariant === 'total_return' && best.entry.benchmarkId !== null;
  const notes = [...best.notes];
  if (match.ambiguous) notes.push('More than one catalogue entry matches equally well.');
  if (!best.entry.verified) notes.push('The matching catalogue entry is not verified yet.');
  return { state: clean ? 'matched_verified' : 'matched_other', benchmarkId: match.ambiguous ? null : best.entry.benchmarkId, confidence: best.confidence, match, notes };
}

// ---------------------------------------------------------------------------
// Version identity helpers
// ---------------------------------------------------------------------------

export function classifiedFromVersion(v: Pick<DeclaredBenchmarkVersion, 'tier1Name' | 'benchmarkKind' | 'composition'>): ClassifiedBenchmark {
  return classifyBenchmark(v.tier1Name);
}

/** Additional benchmarks compared as a set of identities. */
export function additionalSetKey(names: readonly string[]): string {
  return names.map((n) => classifyBenchmark(n).identityKey).sort().join('||');
}

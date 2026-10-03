// Scheme -> benchmark mapping PROPOSALS, ranked by source authority. PURE: no I/O.
//
// This EXTENDS the BENCH-1 Phase 2 governance (migration 0241:
// ii_benchmark_mapping_proposals / propose_benchmark_mapping /
// review_benchmark_mapping / auto_publish_benchmark_mapping). It produces
// payloads the existing POST .../benchmark-data/mappings route already accepts
// (MappingBody), so no new table, RPC or migration is needed and the database
// keeps every one of its own refusals.
//
// AUTHORITY ORDER (highest first):
//   1. scheme_document   the benchmark the scheme's OWN document declares
//                        (SID / KIM / factsheet / addendum). Evidence (URL,
//                        document date, retrieval date) is REQUIRED.
//   2. amfi_per_scheme   AMFI's per-scheme benchmark name, ONLY when the caller
//                        states it was verified usable. As of 2026-10-03 AMFI's
//                        website was unreachable from the research environment,
//                        so this source is UNVERIFIED and is skipped by default.
//   3. category_default  the SEBI category's permitted Tier-1 indices. ALWAYS
//                        LOW confidence, ALWAYS resolution 'admin_judgement',
//                        ALWAYS evidence_source 'other': the database's
//                        auto-publish function refuses all three, so a category
//                        default can never publish without a named reviewer.
//                        It is emitted ONLY when no higher-authority draft exists.
//
// A fund's benchmark can change. Declared benchmarks are effective-dated; a
// later declaration closes the earlier one the day before (so two primary
// mappings never overlap), and a gap or overlap is reported, never papered over.

import { matchBenchmarkName, type BenchmarkMatchResult, type BenchmarkNameMatch, type CatalogueEntryLite, type NameVariant } from './benchmarkNameMatcher';

export const MAPPING_PROPOSAL_RULES_VERSION = 'scheme-benchmark-proposals-v1';

export type EvidenceSource = 'amc_sid' | 'amc_kim' | 'amc_factsheet' | 'amc_addendum' | 'amfi_disclosure' | 'other';
export type ProposalAuthority = 'scheme_document' | 'amfi_per_scheme' | 'category_default';
export const AUTHORITY_RANK: Record<ProposalAuthority, 1 | 2 | 3> = { scheme_document: 1, amfi_per_scheme: 2, category_default: 3 };

/** Payload accepted by POST /api/admin/investment-intelligence/benchmark-data/mappings (MappingBody). */
export interface MappingProposalPayload {
  instrument_id: string;
  benchmark_id: string | null;
  proposed_benchmark_name: string;
  relationship_type: 'primary';
  effective_from: string;
  effective_to: string | null;
  evidence_source: EvidenceSource;
  evidence_url: string;
  evidence_title: string | null;
  evidence_document_date: string;
  evidence_retrieved_at: string;
  evidence_excerpt: string | null;
  resolution_method: 'deterministic_exact' | 'identifier_match' | 'admin_judgement';
  confidence: 'high' | 'medium' | 'low';
  ambiguity_reason: string | null;
}

export interface SchemeForMapping {
  instrumentId: string;
  schemeName: string;
  amcName: string | null;
  amfiCode: string | null;
  /** AMFI sub-category as ii_scheme_master stores it, e.g. "Large Cap Fund". */
  subCategory: string | null;
}

export interface DeclaredBenchmarkEvidence {
  benchmarkName: string;
  effectiveFrom: string;
  effectiveTo?: string | null;
  evidenceSource: EvidenceSource;
  evidenceUrl: string;
  evidenceTitle?: string | null;
  evidenceDocumentDate: string;
  evidenceRetrievedAt: string;
  evidenceExcerpt?: string | null;
  declaredVariantHint?: NameVariant;
}

export interface AmfiSchemeBenchmark {
  benchmarkName: string;
  url: string;
  documentDate: string;
  retrievedAt: string;
  effectiveFrom: string;
  /** Must be true only when someone has read AMFI's page and confirmed the field is usable. Default: not verified. */
  verifiedUsable: boolean;
}

// ---------------------------------------------------------------------------
// Category defaults (authority 3)
// ---------------------------------------------------------------------------

export type CategoryKey =
  | 'large_cap'
  | 'mid_cap'
  | 'small_cap'
  | 'large_mid_cap'
  | 'multi_cap'
  | 'flexi_cap'
  | 'elss'
  | 'focused'
  | 'value_contra'
  | 'dividend_yield'
  | 'balanced_advantage'
  | 'aggressive_hybrid';

export interface CategoryDefaultRule {
  key: CategoryKey;
  label: string;
  /** Tier-1 index names the category permits. More than one means the scheme's own document decides; we never pick. */
  candidates: string[];
  /** Honest status of the list. Nothing here was read from AMFI's own list (unreachable on 2026-10-03). */
  listStatus: 'UNVERIFIED_SECONDARY';
}

export const CATEGORY_DEFAULT_RULES: readonly CategoryDefaultRule[] = [
  { key: 'large_cap', label: 'Large Cap', candidates: ['NIFTY 100 TRI', 'BSE 100 TRI'], listStatus: 'UNVERIFIED_SECONDARY' },
  { key: 'mid_cap', label: 'Mid Cap', candidates: ['Nifty Midcap 150 TRI', 'BSE 150 MidCap TRI'], listStatus: 'UNVERIFIED_SECONDARY' },
  { key: 'small_cap', label: 'Small Cap', candidates: ['Nifty Smallcap 250 TRI', 'BSE 250 SmallCap TRI'], listStatus: 'UNVERIFIED_SECONDARY' },
  { key: 'large_mid_cap', label: 'Large and Mid Cap', candidates: ['Nifty LargeMidcap 250 TRI', 'BSE 250 LargeMidCap TRI'], listStatus: 'UNVERIFIED_SECONDARY' },
  { key: 'multi_cap', label: 'Multi Cap', candidates: ['Nifty500 Multicap 50:25:25 TRI', 'BSE 500 TRI'], listStatus: 'UNVERIFIED_SECONDARY' },
  { key: 'flexi_cap', label: 'Flexi Cap', candidates: ['Nifty 500 TRI', 'BSE 500 TRI'], listStatus: 'UNVERIFIED_SECONDARY' },
  { key: 'elss', label: 'ELSS', candidates: ['Nifty 500 TRI', 'BSE 500 TRI'], listStatus: 'UNVERIFIED_SECONDARY' },
  { key: 'focused', label: 'Focused', candidates: ['Nifty 500 TRI', 'BSE 500 TRI'], listStatus: 'UNVERIFIED_SECONDARY' },
  { key: 'value_contra', label: 'Value / Contra', candidates: ['Nifty 500 TRI', 'BSE 500 TRI'], listStatus: 'UNVERIFIED_SECONDARY' },
  { key: 'dividend_yield', label: 'Dividend Yield', candidates: ['Nifty 500 TRI', 'BSE 500 TRI'], listStatus: 'UNVERIFIED_SECONDARY' },
  { key: 'balanced_advantage', label: 'Balanced Advantage', candidates: ['NIFTY 50 Hybrid Composite Debt 50:50 Index TRI'], listStatus: 'UNVERIFIED_SECONDARY' },
  { key: 'aggressive_hybrid', label: 'Aggressive Hybrid', candidates: ['NIFTY 50 Hybrid Composite Debt 65:35 Index TRI', 'CRISIL Hybrid 35+65 Aggressive Index'], listStatus: 'UNVERIFIED_SECONDARY' },
];

/**
 * Debt, gold/silver, international, index-fund, FoF, sectoral/thematic and
 * solution categories have NO default here on purpose: their Tier-1 choice
 * depends on a list that was not readable (AMFI PRC list) or on the scheme's
 * own replicated index / theme, and guessing one is exactly what the PC6
 * governance forbids. They are "no category default available".
 */
export function categoryKeyOf(subCategory: string | null | undefined): CategoryKey | null {
  const s = (subCategory ?? '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  if (/\bindex\b|\betf\b|\bfof\b|fund of fund|\bsectoral\b|\bthematic\b|\bdebt\b|duration|liquid|overnight|money market|gilt|bond|credit|floater|solution|retirement|children|gold|silver|overseas|international/.test(s)) return null;
  if (/large and mid/.test(s)) return 'large_mid_cap';
  if (/\bmulti cap\b/.test(s)) return 'multi_cap';
  if (/\bflexi cap\b/.test(s)) return 'flexi_cap';
  if (/\blarge cap\b/.test(s)) return 'large_cap';
  if (/\bmid cap\b/.test(s)) return 'mid_cap';
  if (/\bsmall cap\b/.test(s)) return 'small_cap';
  if (/\belss\b|tax saver|tax saving/.test(s)) return 'elss';
  if (/\bfocused\b/.test(s)) return 'focused';
  if (/\bvalue\b|\bcontra\b/.test(s)) return 'value_contra';
  if (/dividend yield/.test(s)) return 'dividend_yield';
  if (/dynamic asset allocation|balanced advantage/.test(s)) return 'balanced_advantage';
  if (/aggressive hybrid/.test(s)) return 'aggressive_hybrid';
  return null;
}

// The only first-hand regulatory source for the category rule (read 2026-10-01).
export const CATEGORY_RULE_EVIDENCE = {
  url: 'https://www.sebi.gov.in/legal/circulars/oct-2021/guiding-principles-for-bringing-uniformity-in-benchmarks-of-mutual-fund-schemes_53539.html',
  title: 'SEBI circular 27 Oct 2021: Tier-1 benchmark reflects the scheme category (list published by AMFI). Category rule only, not a scheme document.',
  documentDate: '2021-10-27',
  retrievedAt: '2026-10-01',
  /** First date the AMFI Tier-1 list applied (general case), per the same circular. */
  defaultEffectiveFrom: '2021-12-01',
} as const;

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

export interface ProposalDraft {
  authority: ProposalAuthority;
  rank: 1 | 2 | 3;
  /** Ready to POST. null when nothing may be proposed (unsupported benchmark, no catalogue entry for a category candidate is NOT null: see needsCatalogueEntry). */
  payload: MappingProposalPayload | null;
  declaredName: string;
  match: BenchmarkMatchResult | null;
  matchedEntry: BenchmarkNameMatch | null;
  needsCatalogueEntry: boolean;
  /** Pure replica of the database rule for auto-publish. The DATABASE decides; this only labels the draft. */
  autoPublishEligible: boolean;
  /** True for every draft that is not auto-publishable: it waits for a named reviewer. */
  requiresAdminReview: boolean;
  warnings: string[];
}

export interface SchemeProposalSet {
  scheme: SchemeForMapping;
  drafts: ProposalDraft[];
  /** Category default candidates, one low-confidence draft each; empty when a higher authority exists or none is available. */
  categoryOptions: ProposalDraft[];
  skipped: Array<{ source: ProposalAuthority; reason: string }>;
  warnings: string[];
  rulesVersion: typeof MAPPING_PROPOSAL_RULES_VERSION;
}

/** Pure replica of auto_publish_benchmark_mapping()'s eligibility test (0241), for labelling only. */
export function isAutoPublishEligible(p: MappingProposalPayload, entry: CatalogueEntryLite | null): boolean {
  return (
    p.resolution_method !== 'admin_judgement' &&
    p.confidence === 'high' &&
    p.ambiguity_reason === null &&
    p.benchmark_id !== null &&
    p.relationship_type === 'primary' &&
    p.evidence_source !== 'other' &&
    entry !== null &&
    entry.verified &&
    entry.active &&
    entry.returnVariant === 'total_return'
  );
}

function clip(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

function dayBefore(iso: string): string {
  const t = Date.parse(`${iso}T00:00:00.000Z`) - 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

function buildDeclaredDraft(scheme: SchemeForMapping, ev: DeclaredBenchmarkEvidence, catalogue: readonly CatalogueEntryLite[], authority: ProposalAuthority): ProposalDraft {
  const warnings: string[] = [];
  const match = matchBenchmarkName(ev.benchmarkName, catalogue, { declaredVariantHint: ev.declaredVariantHint });
  const rank = AUTHORITY_RANK[authority];

  if (match.unsupported) {
    return {
      authority, rank, payload: null, declaredName: ev.benchmarkName, match, matchedEntry: null, needsCatalogueEntry: false, autoPublishEligible: false, requiresAdminReview: true,
      warnings: [match.unsupported === 'composite' ? 'The declared benchmark is a composite of several indices; one catalogue series cannot represent it, so no proposal is made and it is never approximated by one leg.' : 'The declared benchmark is a commodity price, not an index; no proposal is made until a permitted price series is decided.'],
    };
  }
  const best = match.best;
  const ambiguityBits: string[] = [];
  if (match.ambiguous) ambiguityBits.push('More than one catalogue entry matches equally well; a reviewer must choose.');
  if (best) ambiguityBits.push(...best.notes);
  if (!best) {
    for (const r of match.rejected.filter((x) => x.reason === 'PRICE_INDEX_NOT_TOTAL_RETURN' || x.reason === 'VARIANT_MISMATCH' || x.reason === 'OWNER_MISMATCH').slice(0, 3)) {
      warnings.push(`${r.entry.benchmarkKey}: ${r.detail}`);
    }
    ambiguityBits.push('No catalogue entry matches this name safely; the entry has to be created and verified first.');
  }
  const confidence = best ? best.confidence : 'low';
  const highAndClean = best?.confidence === 'high' && !match.ambiguous;
  const payload: MappingProposalPayload = {
    instrument_id: scheme.instrumentId,
    benchmark_id: best && !match.ambiguous ? best.entry.benchmarkId : null,
    proposed_benchmark_name: clip(ev.benchmarkName.trim(), 200),
    relationship_type: 'primary',
    effective_from: ev.effectiveFrom,
    effective_to: ev.effectiveTo ?? null,
    evidence_source: ev.evidenceSource,
    evidence_url: ev.evidenceUrl,
    evidence_title: ev.evidenceTitle ?? null,
    evidence_document_date: ev.evidenceDocumentDate,
    evidence_retrieved_at: ev.evidenceRetrievedAt,
    evidence_excerpt: ev.evidenceExcerpt ? clip(ev.evidenceExcerpt, 400) : null,
    resolution_method: highAndClean ? 'deterministic_exact' : 'admin_judgement',
    confidence,
    ambiguity_reason: highAndClean || ambiguityBits.length === 0 ? null : clip(ambiguityBits.join(' '), 400),
  };
  if (authority === 'amfi_per_scheme') payload.evidence_source = 'amfi_disclosure';
  return {
    authority,
    rank,
    payload,
    declaredName: ev.benchmarkName,
    match,
    matchedEntry: best,
    needsCatalogueEntry: !best,
    autoPublishEligible: isAutoPublishEligible(payload, best && !match.ambiguous ? best.entry : null),
    requiresAdminReview: !isAutoPublishEligible(payload, best && !match.ambiguous ? best.entry : null),
    warnings,
  };
}

function buildCategoryOptions(scheme: SchemeForMapping, catalogue: readonly CatalogueEntryLite[], effectiveFrom: string): { options: ProposalDraft[]; skip: string | null } {
  const key = categoryKeyOf(scheme.subCategory);
  if (!key) return { options: [], skip: `No category default is available for "${scheme.subCategory ?? 'an unknown category'}": its benchmark depends on a list that was not readable or on the scheme's own index or theme, and guessing one is not allowed.` };
  const rule = CATEGORY_DEFAULT_RULES.find((r) => r.key === key)!;
  const options: ProposalDraft[] = rule.candidates.map((name) => {
    const match = matchBenchmarkName(name, catalogue);
    const best = match.best;
    const ambiguity = `CATEGORY DEFAULT, not this scheme's own document: the ${rule.label} category permits ${rule.candidates.join(' or ')} (list ${rule.listStatus}: AMFI's own list was not read). The scheme's SID or factsheet decides which, if either, applies.`;
    const payload: MappingProposalPayload = {
      instrument_id: scheme.instrumentId,
      benchmark_id: best && !match.ambiguous ? best.entry.benchmarkId : null,
      proposed_benchmark_name: name,
      relationship_type: 'primary',
      effective_from: effectiveFrom,
      effective_to: null,
      evidence_source: 'other',
      evidence_url: CATEGORY_RULE_EVIDENCE.url,
      evidence_title: CATEGORY_RULE_EVIDENCE.title,
      evidence_document_date: CATEGORY_RULE_EVIDENCE.documentDate,
      evidence_retrieved_at: CATEGORY_RULE_EVIDENCE.retrievedAt,
      evidence_excerpt: null,
      resolution_method: 'admin_judgement',
      confidence: 'low',
      ambiguity_reason: clip(ambiguity, 400),
    };
    return {
      authority: 'category_default' as const,
      rank: 3 as const,
      payload,
      declaredName: name,
      match,
      matchedEntry: best,
      needsCatalogueEntry: !best,
      autoPublishEligible: isAutoPublishEligible(payload, best?.entry ?? null), // always false: low / admin_judgement / 'other'
      requiresAdminReview: true,
      warnings: rule.candidates.length > 1 ? [`The category permits ${rule.candidates.length} indices; these options are alternatives, not a ranking.`] : [],
    };
  });
  return { options, skip: null };
}

export interface BuildProposalsInput {
  scheme: SchemeForMapping;
  catalogue: readonly CatalogueEntryLite[];
  /** Authority 1. Several entries = the benchmark changed over time. */
  declared?: readonly DeclaredBenchmarkEvidence[];
  /** Authority 2. Skipped unless verifiedUsable is true. */
  amfi?: AmfiSchemeBenchmark | null;
  categoryDefaultEffectiveFrom?: string;
}

export function buildMappingProposals(input: BuildProposalsInput): SchemeProposalSet {
  const { scheme, catalogue } = input;
  const skipped: SchemeProposalSet['skipped'] = [];
  const warnings: string[] = [];
  const drafts: ProposalDraft[] = [];

  // 1. Declared in the scheme's own document.
  const declared = [...(input.declared ?? [])].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  // Close each declaration the day before the next one starts unless it carries its own end date.
  const closed = declared.map((d, i) => {
    const next = declared[i + 1];
    const effectiveTo = d.effectiveTo ?? (next ? dayBefore(next.effectiveFrom) : null);
    return { ...d, effectiveTo };
  });
  for (const d of closed) {
    if (d.effectiveTo && d.effectiveTo < d.effectiveFrom) warnings.push(`Declared benchmark "${d.benchmarkName}" ends before it starts; the dates need a human check.`);
    drafts.push(buildDeclaredDraft(scheme, d, catalogue, 'scheme_document'));
  }
  for (let i = 0; i + 1 < closed.length; i++) {
    const a = closed[i];
    const b = closed[i + 1];
    if (a.effectiveTo && a.effectiveTo >= b.effectiveFrom) warnings.push(`Declared periods overlap ("${a.benchmarkName}" and "${b.benchmarkName}"): two primary mappings cannot overlap.`);
    if (a.effectiveTo && dayBefore(b.effectiveFrom) > a.effectiveTo) warnings.push(`There is a gap between "${a.benchmarkName}" and "${b.benchmarkName}": a holding spanning it has no benchmark for that part.`);
  }

  // 2. AMFI per-scheme name: only when somebody verified the page is usable.
  if (input.amfi) {
    if (!input.amfi.verifiedUsable) {
      skipped.push({ source: 'amfi_per_scheme', reason: 'AMFI per-scheme benchmark data has not been verified as usable (the AMFI site was unreachable from the research environment), so it is not used.' });
    } else {
      drafts.push(
        buildDeclaredDraft(
          scheme,
          { benchmarkName: input.amfi.benchmarkName, effectiveFrom: input.amfi.effectiveFrom, evidenceSource: 'amfi_disclosure', evidenceUrl: input.amfi.url, evidenceDocumentDate: input.amfi.documentDate, evidenceRetrievedAt: input.amfi.retrievedAt },
          catalogue,
          'amfi_per_scheme'
        )
      );
    }
  }

  drafts.sort((a, b) => a.rank - b.rank || (a.payload?.effective_from ?? '').localeCompare(b.payload?.effective_from ?? ''));

  // 3. Category default: only as a fallback when nothing better exists.
  let categoryOptions: ProposalDraft[] = [];
  if (drafts.some((d) => d.payload !== null)) {
    skipped.push({ source: 'category_default', reason: 'A higher-authority proposal exists, so no category default is offered.' });
  } else {
    const cat = buildCategoryOptions(scheme, catalogue, input.categoryDefaultEffectiveFrom ?? CATEGORY_RULE_EVIDENCE.defaultEffectiveFrom);
    categoryOptions = cat.options;
    if (cat.skip) skipped.push({ source: 'category_default', reason: cat.skip });
  }

  return { scheme, drafts, categoryOptions, skipped, warnings, rulesVersion: MAPPING_PROPOSAL_RULES_VERSION };
}

// ---------------------------------------------------------------------------
// Unmapped-scheme summary (admin list: counts by category)
// ---------------------------------------------------------------------------

export interface SchemeMasterLite {
  instrumentId: string;
  subCategory: string | null;
  schemeName: string;
  amcName: string | null;
}

export interface UnmappedCategoryRow {
  category: string;
  schemeRows: number;
  mappedRows: number;
  unmappedRows: number;
  openProposalRows: number;
  /** True when this category has a (low-confidence, review-only) default available. */
  hasCategoryDefault: boolean;
  categoryDefaultCandidates: string[];
}

export interface UnmappedSummary {
  totalSchemeRows: number;
  mappedRows: number;
  unmappedRows: number;
  byCategory: UnmappedCategoryRow[];
}

/** Counts, by AMFI sub-category, of scheme rows with no APPROVED mapping, plus how many already wait for review. */
export function summariseUnmappedSchemes(schemes: readonly SchemeMasterLite[], mappedInstrumentIds: ReadonlySet<string>, openProposalInstrumentIds: ReadonlySet<string>): UnmappedSummary {
  const by = new Map<string, UnmappedCategoryRow>();
  for (const s of schemes) {
    const category = (s.subCategory ?? '').trim() || 'Category not recorded';
    const key = categoryKeyOf(s.subCategory);
    const rule = key ? CATEGORY_DEFAULT_RULES.find((r) => r.key === key) : undefined;
    const row = by.get(category) ?? { category, schemeRows: 0, mappedRows: 0, unmappedRows: 0, openProposalRows: 0, hasCategoryDefault: Boolean(rule), categoryDefaultCandidates: rule?.candidates ?? [] };
    row.schemeRows += 1;
    if (mappedInstrumentIds.has(s.instrumentId)) row.mappedRows += 1;
    else {
      row.unmappedRows += 1;
      if (openProposalInstrumentIds.has(s.instrumentId)) row.openProposalRows += 1;
    }
    by.set(category, row);
  }
  const byCategory = [...by.values()].sort((a, b) => b.unmappedRows - a.unmappedRows || a.category.localeCompare(b.category));
  const mapped = byCategory.reduce((s, r) => s + r.mappedRows, 0);
  return { totalSchemeRows: schemes.length, mappedRows: mapped, unmappedRows: schemes.length - mapped, byCategory };
}

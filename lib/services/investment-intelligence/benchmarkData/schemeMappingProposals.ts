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
//   (There is deliberately NO third rung. A fund's CATEGORY benchmark is not a proposal: since the PO
//    decision of 2026-10-03 it is a READ-TIME reference, see categoryReference.ts. It is never stored, never
//    a stored 'primary' mapping, and never reaches auto_publish_benchmark_mapping.)
//
// A fund's benchmark can change. Declared benchmarks are effective-dated; a
// later declaration closes the earlier one the day before (so two primary
// mappings never overlap), and a gap or overlap is reported, never papered over.

import { categoryReferenceFor } from './categoryReference';
import { matchBenchmarkName, type BenchmarkMatchResult, type BenchmarkNameMatch, type CatalogueEntryLite, type NameVariant } from './benchmarkNameMatcher';

export const MAPPING_PROPOSAL_RULES_VERSION = 'scheme-benchmark-proposals-v1';

export type EvidenceSource = 'amc_sid' | 'amc_kim' | 'amc_factsheet' | 'amc_addendum' | 'amfi_disclosure' | 'other';
export type ProposalAuthority = 'scheme_document' | 'amfi_per_scheme';
export const AUTHORITY_RANK: Record<ProposalAuthority, 1 | 2> = { scheme_document: 1, amfi_per_scheme: 2 };

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
// Drafts
// ---------------------------------------------------------------------------

export interface ProposalDraft {
  authority: ProposalAuthority;
  rank: 1 | 2;
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

export interface BuildProposalsInput {
  scheme: SchemeForMapping;
  catalogue: readonly CatalogueEntryLite[];
  /** Authority 1. Several entries = the benchmark changed over time. */
  declared?: readonly DeclaredBenchmarkEvidence[];
  /** Authority 2. Skipped unless verifiedUsable is true. */
  amfi?: AmfiSchemeBenchmark | null;
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

  // (A fund's category benchmark is NOT a proposal: it is a read-time reference, see categoryReference.ts.)

  return { scheme, drafts, skipped, warnings, rulesVersion: MAPPING_PROPOSAL_RULES_VERSION };
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
  /**
   * The usual benchmark (read-time category reference) that applies to funds in this category that have no
   * declared benchmark, or null where the category has no honest benchmark. UNVERIFIED table: see categoryReference.ts.
   */
  categoryReferenceBenchmark: string | null;
  categoryReferenceLabel: string | null;
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
    const ref = categoryReferenceFor({ subCategory: s.subCategory });
    const row = by.get(category) ?? {
      category,
      schemeRows: 0,
      mappedRows: 0,
      unmappedRows: 0,
      openProposalRows: 0,
      categoryReferenceBenchmark: ref.state === 'available' ? ref.benchmarkLabel : null,
      categoryReferenceLabel: ref.state === 'available' ? ref.basisLabel : null,
    };
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

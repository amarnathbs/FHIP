// The decision core of the factsheet benchmark reader: given what was extracted this month and what is already on
// record, decide what to RECORD and whether anything may be published. PURE: no I/O.
//
// THE RULES (each has a named negative control in tests/unit/factsheetReaderDecision.test.ts):
//   1. History is append-only. A changed benchmark is a NEW effective-dated version; the previous one stays.
//      An unchanged benchmark is only "confirmed on <month>".
//   2. AUTO-PUBLISH happens only when ALL of: a single index series; a VERIFIED, ACTIVE, TOTAL-RETURN catalogue
//      entry matched at HIGH confidence by the existing matcher (a price index never matches total return);
//      complete evidence (https URL, document date, retrieval date, a document type other than 'other', an
//      excerpt); the deterministic pattern pass produced the answer (an AI-only answer never auto-publishes,
//      and a pattern/AI disagreement never does); AND it equals the previous month's record. A scheme's FIRST
//      sighting therefore waits one more month: it can never auto-publish on a single reading.
//   3. Everything else goes to the admin review queue, never published: changes, composites, commodity
//      prices, indices not in the catalogue, low confidence, extraction disagreements, a conflict with an
//      admin-entered mapping. Composites and gold/silver prices are recorded as 'unsupported' with their
//      composition stored for the future.
//   4. An older document never supersedes a newer one.
//   5. An effective date is the date the document states; otherwise the document month's first day, flagged
//      'estimated'. A change's effective date is always after the previous version's.

import type { CatalogueEntryLite } from '../benchmarkData/benchmarkNameMatcher';
import type { MappingProposalPayload, EvidenceSource } from '../benchmarkData/schemeMappingProposals';
import { additionalSetKey, classifyBenchmark, decideCatalogueState, sameBenchmark, type CatalogueDecision } from './benchmarkClassifier';
import type { AiOutcome } from './aiExtractor';
import {
  FACTSHEET_AI_EXTRACTOR_VERSION,
  FACTSHEET_PATTERN_EXTRACTOR_VERSION,
  type AttemptOutcome,
  type DeclaredBenchmarkVersion,
  type DeclaredExtraction,
  type ExtractionConfidence,
  type ExtractionMethod,
  type FactsheetSource,
  type PatternOutcome,
  type VersionEventType,
  type VersionReviewState,
} from './types';

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** A stored version plus what has happened to it since (the events are append-only; the version itself is immutable). */
export interface StoredVersion extends DeclaredBenchmarkVersion {
  id: string;
  events: VersionEventType[];
}

export interface ExistingMapping {
  benchmarkId: string;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export interface ObservationInput {
  instrumentId: string;
  source: FactsheetSource;
  sourceTitle: string | null;
  retrievedAt: string; // full ISO timestamp
  documentChecksum: string;
  pattern: PatternOutcome;
  /** null when the AI pass was not run (it only runs when the pattern pass fails). */
  ai: AiOutcome | null;
  aiModel: string | null;
  catalogue: readonly CatalogueEntryLite[];
  previous: StoredVersion | null;
  /** Primary mappings an admin (or an earlier auto-publish) already holds for this instrument. */
  existingMappings: readonly ExistingMapping[];
  /** Set when a 304 Not Modified is treated as "the same document again": the extraction is rebuilt from `previous`. */
  rebuiltFromPrevious?: boolean;
}

export type ProposalPlan = { payload: MappingProposalPayload; autoPublish: boolean };

export type ObservationDecision =
  | { action: 'no_record'; outcome: AttemptOutcome; detail: string }
  | { action: 'confirm'; outcome: 'confirmed_unchanged'; detail: string; previousVersionId: string; autoPublish: ProposalPlan | null; routeToReview: string | null }
  | { action: 'new_version'; outcome: 'recorded_first_observation' | 'recorded_change' | 'recorded_additional_change'; detail: string; version: DeclaredBenchmarkVersion; reviewRequired: boolean; proposal: ProposalPlan | null };

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

export function monthStart(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

export function dayAfter(iso: string): string {
  return new Date(Date.parse(`${iso}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10);
}

const EVIDENCE_SOURCE: Record<FactsheetSource['documentType'], EvidenceSource> = {
  amc_factsheet: 'amc_factsheet',
  amc_sid: 'amc_sid',
  amc_kim: 'amc_kim',
  amc_addendum: 'amc_addendum',
  amfi_disclosure: 'amfi_disclosure',
  other: 'other',
};

interface ChosenExtraction {
  extraction: DeclaredExtraction;
  method: ExtractionMethod;
  extractorVersion: string;
  agree: boolean | null;
  /** True only when the answer is the deterministic pattern pass's (alone, or confirmed by the AI). */
  deterministic: boolean;
  disagreement: string | null;
}

function chooseExtraction(i: ObservationInput): { ok: true; chosen: ChosenExtraction } | { ok: false; outcome: AttemptOutcome; detail: string } {
  const { pattern, ai } = i;
  if (pattern.status === 'found') {
    const base: ChosenExtraction = { extraction: pattern.extraction, method: 'text_pattern', extractorVersion: FACTSHEET_PATTERN_EXTRACTOR_VERSION, agree: null, deterministic: true, disagreement: null };
    if (ai && ai.status === 'found') {
      const a = classifyBenchmark(ai.extraction.tier1?.raw ?? '');
      const p = classifyBenchmark(pattern.extraction.tier1?.raw ?? '');
      const agree = sameBenchmark(a, p);
      return {
        ok: true,
        chosen: {
          ...base,
          method: 'text_pattern_and_ai',
          extractorVersion: `${FACTSHEET_PATTERN_EXTRACTOR_VERSION}+${FACTSHEET_AI_EXTRACTOR_VERSION}`,
          agree,
          deterministic: agree,
          disagreement: agree ? null : `The text-pattern pass read "${pattern.extraction.tier1?.raw}" but the AI pass read "${ai.extraction.tier1?.raw}".`,
        },
      };
    }
    return { ok: true, chosen: base };
  }
  if (!pattern.schemeNamePresent) return { ok: false, outcome: 'scheme_not_in_document', detail: 'The document does not name the scheme, so nothing was recorded.' };
  if (ai && ai.status === 'found') {
    return { ok: true, chosen: { extraction: ai.extraction, method: 'ai', extractorVersion: FACTSHEET_AI_EXTRACTOR_VERSION, agree: null, deterministic: false, disagreement: null } };
  }
  if (ai && ai.status === 'rejected') return { ok: false, outcome: 'ai_rejected', detail: ai.reason };
  if (pattern.status === 'ambiguous') return { ok: false, outcome: 'extraction_ambiguous', detail: pattern.reason };
  return { ok: false, outcome: 'benchmark_not_found', detail: pattern.reason };
}

/** The date the evidence is dated: the document's own date, else (flagged) none. */
function documentMonthOf(ex: DeclaredExtraction, retrievedAt: string): string {
  return ex.documentDate ? monthStart(ex.documentDate.iso) : monthStart(retrievedAt.slice(0, 10));
}

function evidenceComplete(v: Pick<DeclaredBenchmarkVersion, 'sourceUrl' | 'documentDate' | 'retrievedAt' | 'sourceDocumentType' | 'evidenceExcerpt'>): boolean {
  return /^https:\/\/.{4,}/.test(v.sourceUrl) && v.documentDate !== null && Boolean(v.retrievedAt) && v.sourceDocumentType !== 'other' && Boolean(v.evidenceExcerpt && v.evidenceExcerpt.length >= 3);
}

function proposalPayload(v: DeclaredBenchmarkVersion, match: CatalogueDecision, o: { deterministic: boolean; reason: string | null; effectiveFrom: string }): MappingProposalPayload | null {
  if (!match.benchmarkId || v.benchmarkKind !== 'single_index') return null;
  const docDate = v.documentDate ?? v.documentMonth;
  const auto = o.deterministic && o.reason === null && match.state === 'matched_verified' && match.confidence === 'high' && evidenceComplete(v);
  return {
    instrument_id: v.instrumentId,
    benchmark_id: match.benchmarkId,
    proposed_benchmark_name: v.tier1Name.slice(0, 200),
    relationship_type: 'primary',
    effective_from: o.effectiveFrom,
    effective_to: null,
    evidence_source: EVIDENCE_SOURCE[v.sourceDocumentType],
    evidence_url: v.sourceUrl,
    evidence_title: v.sourceTitle,
    evidence_document_date: docDate,
    evidence_retrieved_at: v.retrievedAt.slice(0, 10),
    evidence_excerpt: v.evidenceExcerpt ? v.evidenceExcerpt.slice(0, 400) : null,
    resolution_method: auto ? 'deterministic_exact' : 'admin_judgement',
    confidence: match.confidence ?? 'low',
    ambiguity_reason: auto ? null : (o.reason ?? 'Needs a reviewer: not eligible for automatic publication.').slice(0, 400),
  };
}

function conflictWithMappings(mappings: readonly ExistingMapping[], matchedId: string | null): { state: 'none' | 'same' | 'different'; detail: string } {
  const open = mappings.filter((m) => m.effectiveTo === null);
  if (mappings.length === 0) return { state: 'none', detail: '' };
  if (matchedId && open.some((m) => m.benchmarkId === matchedId)) return { state: 'same', detail: 'An existing mapping already uses this benchmark.' };
  return { state: 'different', detail: 'An existing primary mapping uses a different benchmark (or is closed): the factsheet and the mapping disagree.' };
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

export function decideObservation(i: ObservationInput): ObservationDecision {
  const picked = chooseExtraction(i);
  if (!picked.ok) return { action: 'no_record', outcome: picked.outcome, detail: picked.detail };
  const { chosen } = picked;
  const ex = chosen.extraction;
  if (!ex.tier1) return { action: 'no_record', outcome: 'benchmark_not_found', detail: 'No Tier-1 benchmark was extracted.' };

  const tier1 = classifyBenchmark(ex.tier1.raw);
  const cat = decideCatalogueState(ex.tier1, tier1, i.catalogue);
  const docMonth = documentMonthOf(ex, i.retrievedAt);
  const prev = i.previous;

  // Rule 4: an older document never supersedes a newer one.
  if (prev && docMonth < prev.documentMonth) {
    return { action: 'no_record', outcome: 'older_document_ignored', detail: `This document (${docMonth.slice(0, 7)}) is older than the one already on record (${prev.documentMonth.slice(0, 7)}), so it was not used.` };
  }

  // Rule 5: effective date.
  const stated = ex.effectiveFromStated;
  let effectiveFrom = stated ? stated.iso : docMonth;
  let basis: DeclaredBenchmarkVersion['effectiveFromBasis'] = stated ? 'document_stated' : 'estimated_document_month';

  const confidence: ExtractionConfidence = !chosen.deterministic || chosen.disagreement ? 'low' : ex.documentDate ? 'high' : 'medium';

  const same = prev ? sameBenchmark(classifyBenchmark(prev.tier1Name), tier1) : false;
  const additionalNow = ex.additional.map((a) => a.raw);

  // ---- UNCHANGED: just confirm, and possibly auto-publish what is waiting ----------------------------------------
  if (prev && same && !chosen.disagreement) {
    const additionalChanged = additionalNow.length > 0 && additionalSetKey(additionalNow) !== additionalSetKey(prev.additionalNames);
    if (additionalChanged) {
      const version = buildVersion(i, chosen, tier1, cat, effectiveFrom, basis, docMonth, confidence, 'recorded_only', 'Only the additional benchmark changed; the Tier-1 benchmark is unchanged.', prev);
      // The Tier-1 identity and its effective date are carried forward: only the additional benchmark is new.
      version.effectiveFrom = prev.effectiveFrom;
      version.effectiveFromBasis = prev.effectiveFromBasis;
      return { action: 'new_version', outcome: 'recorded_additional_change', detail: 'The additional benchmark changed; the Tier-1 benchmark is unchanged.', version, reviewRequired: false, proposal: null };
    }
    return confirmDecision(i, chosen, tier1, cat, prev, docMonth, confidence);
  }

  // ---- NEW VERSION: first sighting, a change, or an extraction disagreement ------------------------------------
  if (prev && effectiveFrom <= prev.effectiveFrom) {
    effectiveFrom = dayAfter(prev.effectiveFrom);
    basis = 'estimated_document_month';
  }

  let reviewState: VersionReviewState;
  let reason: string | null = null;
  if (chosen.disagreement) {
    reviewState = 'pending_review';
    reason = chosen.disagreement;
  } else if (prev && !same) {
    reviewState = 'pending_review';
    reason = `The declared benchmark changed from "${prev.tier1Name}" to "${ex.tier1.raw}".`;
  } else {
    reviewState = 'awaiting_confirmation';
  }

  // First sightings that are not clean single-index matches go straight to a reviewer.
  if (reviewState === 'awaiting_confirmation') {
    const firstSightingReason = (): string | null => {
      if (cat.state === 'unsupported_composite') return 'Unsupported composite benchmark: several indices are combined and the catalogue cannot represent it. The composition is recorded.';
      if (cat.state === 'unsupported_commodity') return 'Unsupported benchmark: a commodity price, not an index series. Recorded for the future.';
      if (cat.state === 'no_catalogue_match') return 'The benchmark is a single index that is not in the catalogue (or matches none of its entries safely).';
      if (cat.state === 'matched_other') return `Low-confidence or unverified catalogue match. ${cat.notes.join(' ')}`.trim();
      if (!chosen.deterministic) return 'Read by the AI pass only (the text-pattern pass found nothing); a human must confirm.';
      if (!ex.documentDate) return "The document's own date could not be found, so the evidence is incomplete.";
      return null;
    };
    const why = firstSightingReason();
    if (why) {
      reviewState = 'pending_review';
      reason = why;
    }
  } else if (reviewState === 'pending_review' && !reason) {
    reason = 'Needs a reviewer.';
  }
  if (prev && !same && reviewState === 'pending_review') {
    // Composite / unsupported notes are appended to a change reason so the reviewer sees both.
    if (cat.state === 'unsupported_composite') reason += ' The new benchmark is an unsupported composite.';
    else if (cat.state === 'unsupported_commodity') reason += ' The new benchmark is a commodity price.';
    else if (cat.state === 'no_catalogue_match') reason += ' The new benchmark is not in the catalogue.';
  }

  // An admin-entered mapping may already say the same thing, or something else.
  const conflict = conflictWithMappings(i.existingMappings, cat.benchmarkId);
  if (conflict.state === 'same' && cat.state === 'matched_verified' && reviewState === 'awaiting_confirmation') {
    reviewState = 'consistent_with_mapping';
    reason = 'An existing mapping already uses this benchmark.';
  } else if (conflict.state === 'different' && reviewState === 'awaiting_confirmation') {
    reviewState = 'pending_review';
    reason = conflict.detail;
  } else if (conflict.state === 'different' && reviewState === 'pending_review') {
    reason = `${reason ?? ''} ${conflict.detail}`.trim();
  }

  const version = buildVersion(i, chosen, tier1, cat, effectiveFrom, basis, docMonth, confidence, reviewState, reason, prev);
  // A proposal exists now only when a reviewer must decide on a matched series (so Approve can create the mapping).
  let proposal: ProposalPlan | null = null;
  if (reviewState === 'pending_review' && cat.benchmarkId && version.benchmarkKind === 'single_index' && version.documentDate !== null) {
    const payload = proposalPayload(version, cat, { deterministic: false, reason: reason ?? 'Needs a reviewer.', effectiveFrom });
    if (payload) proposal = { payload, autoPublish: false };
  }
  const outcome = prev ? 'recorded_change' : 'recorded_first_observation';
  return {
    action: 'new_version',
    outcome,
    detail: reviewState === 'pending_review' ? `Recorded and sent to the review queue: ${reason}` : reviewState === 'consistent_with_mapping' ? 'Recorded; it matches the existing mapping.' : 'Recorded. It will be published automatically only if next month\'s reading is the same.',
    version,
    reviewRequired: reviewState === 'pending_review',
    proposal,
  };
}

function confirmDecision(i: ObservationInput, chosen: ChosenExtraction, tier1: ReturnType<typeof classifyBenchmark>, cat: CatalogueDecision, prev: StoredVersion, docMonth: string, confidence: ExtractionConfidence): ObservationDecision {
  const ex = chosen.extraction;
  const waiting = prev.reviewState === 'awaiting_confirmation' && prev.events.length === 0;
  if (!waiting) {
    return { action: 'confirm', outcome: 'confirmed_unchanged', detail: `Confirmed unchanged on ${docMonth.slice(0, 7)}.`, previousVersionId: prev.id, autoPublish: null, routeToReview: null };
  }
  // A scheme's first reading is waiting for a second, agreeing reading IN A LATER MONTH. A second document read in the
  // same month (for example a SID after a factsheet) is a confirmation, but not "the previous month's" reading.
  if (monthStart(prev.retrievedAt.slice(0, 10)) >= monthStart(i.retrievedAt.slice(0, 10))) {
    return { action: 'confirm', outcome: 'confirmed_unchanged', detail: 'Confirmed unchanged; the first reading was made this month, so automatic publication waits for next month.', previousVersionId: prev.id, autoPublish: null, routeToReview: null };
  }
  const conflict = conflictWithMappings(i.existingMappings, cat.benchmarkId);
  if (conflict.state === 'same') {
    return { action: 'confirm', outcome: 'confirmed_unchanged', detail: 'Confirmed unchanged; the existing mapping already uses this benchmark, so nothing needs publishing.', previousVersionId: prev.id, autoPublish: null, routeToReview: null };
  }
  if (conflict.state === 'different') {
    return { action: 'confirm', outcome: 'confirmed_unchanged', detail: 'Confirmed unchanged, but not published: it conflicts with an existing mapping.', previousVersionId: prev.id, autoPublish: null, routeToReview: conflict.detail };
  }
  const stillClean = cat.state === 'matched_verified' && cat.confidence === 'high' && !!cat.benchmarkId;
  // The candidate evidence is THIS month's document (the most recent sighting) with the first sighting's effective date.
  const candidate: DeclaredBenchmarkVersion = {
    ...prev,
    sourceId: i.source.id,
    sourceUrl: i.source.url,
    sourceTitle: i.sourceTitle,
    sourceDocumentType: i.source.documentType,
    documentDate: ex.documentDate ? ex.documentDate.iso : prev.documentDate,
    retrievedAt: i.retrievedAt,
    evidenceExcerpt: ex.excerpt ?? prev.evidenceExcerpt,
  };
  const eligible = chosen.deterministic && !chosen.disagreement && prev.extractionMethod !== 'ai' && stillClean && prev.catalogueState === 'matched_verified' && evidenceComplete(candidate) && confidence !== 'low';
  if (!eligible) {
    const why = !chosen.deterministic || prev.extractionMethod === 'ai' ? 'the deterministic text-pattern pass did not produce this answer' : !stillClean ? 'the catalogue match is no longer verified and high-confidence' : 'the evidence is incomplete';
    return { action: 'confirm', outcome: 'confirmed_unchanged', detail: `Confirmed unchanged, but not published automatically: ${why}.`, previousVersionId: prev.id, autoPublish: null, routeToReview: `Not eligible for automatic publication: ${why}.` };
  }
  const payload = proposalPayload(candidate, cat, { deterministic: true, reason: null, effectiveFrom: prev.effectiveFrom });
  if (!payload) return { action: 'confirm', outcome: 'confirmed_unchanged', detail: 'Confirmed unchanged.', previousVersionId: prev.id, autoPublish: null, routeToReview: null };
  return { action: 'confirm', outcome: 'confirmed_unchanged', detail: 'Confirmed unchanged for a second month; proposed for automatic publication.', previousVersionId: prev.id, autoPublish: { payload, autoPublish: true }, routeToReview: null };
}

function buildVersion(
  i: ObservationInput,
  chosen: ChosenExtraction,
  tier1: ReturnType<typeof classifyBenchmark>,
  cat: CatalogueDecision,
  effectiveFrom: string,
  basis: DeclaredBenchmarkVersion['effectiveFromBasis'],
  docMonth: string,
  confidence: ExtractionConfidence,
  reviewState: VersionReviewState,
  reviewReason: string | null,
  prev: StoredVersion | null
): DeclaredBenchmarkVersion {
  const ex = chosen.extraction;
  return {
    id: null,
    instrumentId: i.instrumentId,
    versionNo: (prev?.versionNo ?? 0) + 1,
    supersedesVersionId: prev?.id ?? null,
    tier1Name: tier1.raw.slice(0, 400),
    tier1VariantHint: ex.tier1?.variantHint ?? null,
    additionalNames: ex.additional.map((a) => a.raw.slice(0, 260)).slice(0, 3),
    benchmarkKind: tier1.kind,
    composition: tier1.composition.slice(0, 12),
    catalogueState: cat.state,
    matchedBenchmarkId: cat.benchmarkId,
    matchConfidence: cat.confidence,
    effectiveFrom,
    effectiveFromBasis: basis,
    sourceId: i.source.id,
    sourceUrl: i.source.url,
    sourceTitle: i.sourceTitle ? i.sourceTitle.slice(0, 300) : null,
    sourceDocumentType: i.source.documentType,
    documentDate: ex.documentDate ? ex.documentDate.iso : null,
    documentDatePrecision: ex.documentDate ? ex.documentDate.precision : null,
    documentMonth: docMonth,
    retrievedAt: i.retrievedAt,
    documentChecksum: i.documentChecksum,
    extractionMethod: chosen.method,
    extractorVersion: chosen.extractorVersion,
    aiModel: chosen.method === 'text_pattern' ? null : i.aiModel,
    extractionConfidence: confidence,
    extractorsAgree: chosen.agree,
    evidenceExcerpt: ex.excerpt ? ex.excerpt.slice(0, 400) : null,
    reviewState,
    reviewReason: reviewReason ? reviewReason.slice(0, 600) : null,
  };
}

// ---------------------------------------------------------------------------
// Holding-period timeline (the benchmark in force for each portion)
// ---------------------------------------------------------------------------

export interface TimelineEntry {
  versionNo: number;
  tier1Name: string;
  benchmarkKind: DeclaredBenchmarkVersion['benchmarkKind'];
  catalogueState: DeclaredBenchmarkVersion['catalogueState'];
  from: string;
  /** Inclusive; null = still in force. Derived from the NEXT version's start, never stored (history is never rewritten). */
  to: string | null;
  effectiveFromBasis: DeclaredBenchmarkVersion['effectiveFromBasis'];
}

/** Build the timeline from the versions on record (rejected versions excluded by the caller). A version that only changed the additional benchmark does not start a new period. */
export function buildTimeline(versions: ReadonlyArray<Pick<DeclaredBenchmarkVersion, 'versionNo' | 'tier1Name' | 'benchmarkKind' | 'catalogueState' | 'effectiveFrom' | 'effectiveFromBasis'>>): TimelineEntry[] {
  const sorted = [...versions].sort((a, b) => a.versionNo - b.versionNo);
  const periods: TimelineEntry[] = [];
  for (const v of sorted) {
    const last = periods[periods.length - 1];
    if (last && sameBenchmark(classifyBenchmark(last.tier1Name), classifyBenchmark(v.tier1Name))) continue;
    if (last) last.to = new Date(Date.parse(`${v.effectiveFrom}T00:00:00.000Z`) - 86_400_000).toISOString().slice(0, 10);
    periods.push({ versionNo: v.versionNo, tier1Name: v.tier1Name, benchmarkKind: v.benchmarkKind, catalogueState: v.catalogueState, from: v.effectiveFrom, to: null, effectiveFromBasis: v.effectiveFromBasis });
  }
  return periods;
}

export function benchmarkInForceOn(timeline: readonly TimelineEntry[], dateIso: string): TimelineEntry | null {
  return timeline.find((p) => p.from <= dateIso && (p.to === null || dateIso <= p.to)) ?? null;
}

/** The portions of a holding period [from, to] and the benchmark in force for each (null = no declared record covers it). */
export function portionsForHolding(timeline: readonly TimelineEntry[], holdFrom: string, holdTo: string): Array<{ from: string; to: string; period: TimelineEntry | null }> {
  const cuts = [...new Set(timeline.map((p) => p.from).filter((d) => d > holdFrom && d <= holdTo))].sort();
  const out: Array<{ from: string; to: string; period: TimelineEntry | null }> = [];
  let start = holdFrom;
  for (const cut of cuts) {
    out.push({ from: start, to: new Date(Date.parse(`${cut}T00:00:00.000Z`) - 86_400_000).toISOString().slice(0, 10), period: benchmarkInForceOn(timeline, start) });
    start = cut;
  }
  out.push({ from: start, to: holdTo, period: benchmarkInForceOn(timeline, start) });
  return out;
}

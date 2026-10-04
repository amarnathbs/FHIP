// The admin-facing shapes of the factsheet reader, and the PURE functions that build them from table rows.
// Client-safe: no I/O, no secrets. Imported as TYPES by the browser components and at runtime by the API routes.
//
// No personal data appears anywhere in these shapes: a scheme's name, the benchmark a fund house declares, the
// document that says so, and dates. Never a user, account, holding or amount; and no holder COUNT at all.

import { DECISIVE_EVENTS, type AttemptOutcome, type CatalogueState, type VersionEventType } from './types';

export interface FactsheetChangeView {
  versionId: string;
  instrumentId: string;
  instrumentName: string | null;
  /** 'changed': a previous version exists; 'first_reading': a scheme's first sighting that needs a human (unsupported, low confidence, conflict). */
  kind: 'changed' | 'first_reading';
  previousBenchmark: string | null;
  newBenchmark: string;
  additionalBenchmarks: string[];
  benchmarkKind: 'single_index' | 'composite' | 'commodity_price';
  composition: Array<{ weightPct: number | null; name: string }>;
  catalogueState: CatalogueState;
  matchedBenchmarkKey: string | null;
  matchConfidence: 'high' | 'medium' | 'low' | null;
  effectiveFrom: string;
  effectiveFromBasis: 'document_stated' | 'estimated_document_month';
  documentUrl: string;
  documentTitle: string | null;
  documentDate: string | null;
  documentMonth: string;
  documentType: string;
  retrievedAt: string;
  extractionMethod: string;
  extractionConfidence: 'high' | 'medium' | 'low';
  evidenceExcerpt: string | null;
  reviewReason: string | null;
  proposalId: string | null;
  /** Approve is offered only when a mapping proposal exists (a matched catalogue series). Otherwise: acknowledge, reject or enter manually. */
  canApprove: boolean;
  /** An unsupported / unmatched benchmark can be acknowledged (it stays recorded and is shown as "cannot be compared"). */
  canAcknowledge: boolean;
}

export interface FactsheetChangesResponse {
  state: 'ok' | 'unavailable';
  reason?: string;
  items: FactsheetChangeView[];
  /** null = the switch could not be read by this caller (never "on" by assumption). */
  readerSwitchedOn: boolean | null;
}

/** The last factsheet check of one scheme, for the held-schemes list. */
export interface FactsheetCheckView {
  /** ISO timestamp of the latest attempt. */
  checkedAt: string;
  outcome: AttemptOutcome;
  /** Plain words for the outcome (what an admin reads). */
  result: string;
  documentDate: string | null;
}

export const OUTCOME_WORDS: Record<AttemptOutcome, string> = {
  refused_terms_not_approved: 'Not checked: the fund house terms are not approved yet',
  refused_robots: 'Not checked: the site asks automated readers to stay away',
  document_too_large: 'Document too large, skipped',
  source_blocked: 'The site refused the request',
  fetch_failed: 'Could not fetch the document',
  text_extraction_failed: 'Could not read the document',
  scheme_not_in_document: 'The document does not name the scheme',
  benchmark_not_found: 'No benchmark found in the document',
  extraction_ambiguous: 'The document states more than one benchmark',
  ai_rejected: 'The AI reading was rejected',
  older_document_ignored: 'Document older than the one on record',
  recorded_first_observation: 'Benchmark recorded (first reading)',
  confirmed_unchanged: 'Confirmed unchanged',
  recorded_change: 'Benchmark change recorded, waiting for review',
  recorded_additional_change: 'Additional benchmark change recorded',
  auto_published: 'Confirmed and published',
  error: 'Unexpected error',
};

export function checkViewFromAttempt(a: { attempted_at: string; outcome: string; document_date: string | null }): FactsheetCheckView | null {
  if (!(a.outcome in OUTCOME_WORDS)) return null;
  const outcome = a.outcome as AttemptOutcome;
  return { checkedAt: a.attempted_at, outcome, result: OUTCOME_WORDS[outcome], documentDate: a.document_date ? String(a.document_date).slice(0, 10) : null };
}

/** The latest attempt per instrument from rows that may be in any order. */
export function latestCheckByInstrument(rows: ReadonlyArray<{ instrument_id: string; attempted_at: string; outcome: string; document_date: string | null }>): Map<string, FactsheetCheckView> {
  const out = new Map<string, FactsheetCheckView>();
  const sorted = [...rows].sort((a, b) => b.attempted_at.localeCompare(a.attempted_at));
  for (const r of sorted) {
    if (out.has(r.instrument_id)) continue;
    const v = checkViewFromAttempt(r);
    if (v) out.set(r.instrument_id, v);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The review queue
// ---------------------------------------------------------------------------

export interface VersionRow {
  id: string;
  instrument_id: string;
  version_no: number;
  supersedes_version_id: string | null;
  tier1_name: string;
  additional_names: string[] | null;
  benchmark_kind: FactsheetChangeView['benchmarkKind'];
  composition: Array<{ weight_pct: number | null; name: string }> | null;
  catalogue_state: CatalogueState;
  match_confidence: FactsheetChangeView['matchConfidence'];
  effective_from: string;
  effective_from_basis: FactsheetChangeView['effectiveFromBasis'];
  source_url: string;
  source_title: string | null;
  source_document_type: string;
  document_date: string | null;
  document_month: string;
  retrieved_at: string;
  extraction_method: string;
  extraction_confidence: FactsheetChangeView['extractionConfidence'];
  evidence_excerpt: string | null;
  review_state: string;
  review_reason: string | null;
  ii_instruments?: { instrument_name: string } | { instrument_name: string }[] | null;
  ii_benchmarks?: { benchmark_key: string } | { benchmark_key: string }[] | null;
}

export interface EventRow {
  version_id: string;
  event_type: VersionEventType;
  proposal_id: string | null;
  created_at?: string;
}

const first = <T,>(x: T | T[] | null | undefined): T | null => (Array.isArray(x) ? (x[0] ?? null) : (x ?? null));

/**
 * Items waiting for a human: versions in 'pending_review', plus any version whose automatic publication was refused,
 * minus everything already decided (approved, rejected, entered manually, acknowledged, auto-published).
 */
export function buildFactsheetChangeViews(versions: readonly VersionRow[], events: readonly EventRow[], previousNames: ReadonlyMap<string, string>): FactsheetChangeView[] {
  const eventsBy = new Map<string, EventRow[]>();
  for (const e of events) {
    const list = eventsBy.get(e.version_id) ?? [];
    list.push(e);
    eventsBy.set(e.version_id, list);
  }
  const out: FactsheetChangeView[] = [];
  for (const v of versions) {
    const evs = eventsBy.get(v.id) ?? [];
    if (evs.some((e) => (DECISIVE_EVENTS as readonly string[]).includes(e.event_type))) continue;
    const refused = evs.some((e) => e.event_type === 'auto_publish_refused');
    if (v.review_state !== 'pending_review' && !refused) continue;
    const proposalId = [...evs].reverse().find((e) => e.proposal_id)?.proposal_id ?? null;
    const unsupported = v.catalogue_state === 'unsupported_composite' || v.catalogue_state === 'unsupported_commodity' || v.catalogue_state === 'no_catalogue_match';
    out.push({
      versionId: v.id,
      instrumentId: v.instrument_id,
      instrumentName: first(v.ii_instruments)?.instrument_name ?? null,
      kind: v.supersedes_version_id ? 'changed' : 'first_reading',
      previousBenchmark: v.supersedes_version_id ? (previousNames.get(v.supersedes_version_id) ?? null) : null,
      newBenchmark: v.tier1_name,
      additionalBenchmarks: v.additional_names ?? [],
      benchmarkKind: v.benchmark_kind,
      composition: (v.composition ?? []).map((l) => ({ weightPct: l.weight_pct, name: l.name })),
      catalogueState: v.catalogue_state,
      matchedBenchmarkKey: first(v.ii_benchmarks)?.benchmark_key ?? null,
      matchConfidence: v.match_confidence,
      effectiveFrom: String(v.effective_from).slice(0, 10),
      effectiveFromBasis: v.effective_from_basis,
      documentUrl: v.source_url,
      documentTitle: v.source_title,
      documentDate: v.document_date ? String(v.document_date).slice(0, 10) : null,
      documentMonth: String(v.document_month).slice(0, 10),
      documentType: v.source_document_type,
      retrievedAt: v.retrieved_at,
      extractionMethod: v.extraction_method,
      extractionConfidence: v.extraction_confidence,
      evidenceExcerpt: v.evidence_excerpt,
      reviewReason: v.review_reason,
      proposalId,
      canApprove: proposalId !== null && !unsupported,
      canAcknowledge: true,
    });
  }
  return out.sort((a, b) => b.retrievedAt.localeCompare(a.retrievedAt) || a.versionId.localeCompare(b.versionId));
}

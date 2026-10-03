// Factsheet benchmark reader: shared types and constants. PURE: no I/O.
//
// WHAT THIS PROGRAMME IS. A monthly, background job that records, for each scheme users actually hold, the
// benchmark the FUND HOUSE DECLARES in its own latest factsheet (or SID / addendum when that is the available
// official document). It stores FACTS ONLY: benchmark names and composition as stated, the source document
// (URL, title, document date), when it was read, a checksum, how it was extracted and how sure we are. It never
// stores or displays the factsheet's performance figures or any index data.
//
// WHAT IT NEVER DOES. It never overwrites history (every month is a dated, append-only record; a changed
// benchmark is a NEW effective-dated version and the old one stays on record), never publishes a change, a
// composite, a commodity price, a low-confidence match or an extraction disagreement without a human, and never
// fetches from a source whose terms review is not 'approved'. It ships SWITCHED OFF.

/** ii_reference_job_control.job_key (the shipped-OFF kill switch row, created by migration 0252). */
export const FACTSHEET_JOB_KEY = 'factsheet_benchmark_reader' as const;

export const FACTSHEET_READER_VERSION = 'factsheet-benchmark-reader-v1' as const;
export const FACTSHEET_PATTERN_EXTRACTOR_VERSION = 'factsheet-pattern-v1' as const;
export const FACTSHEET_AI_EXTRACTOR_VERSION = 'factsheet-ai-v1' as const;

/** Descriptive, honest User-Agent. The product token is what robots.txt groups are matched against. */
export const FACTSHEET_ROBOTS_PRODUCT_TOKEN = 'FHIP-FactsheetReader' as const;
export const FACTSHEET_USER_AGENT =
  `${FACTSHEET_ROBOTS_PRODUCT_TOKEN}/1.0 (+https://app.financialhealthplatform.com; monthly read of a fund house's own public benchmark disclosure; one request per registered document)` as const;

/** Environment switch for the OPTIONAL AI extraction pass (ships off; the pattern pass never needs it). */
export const FACTSHEET_AI_ENV_FLAG = 'FACTSHEET_READER_AI_ENABLED' as const;

export const FACTSHEET_DEFAULTS = Object.freeze({
  /** A document larger than this is SKIPPED with 'document_too_large'; it is never truncated. */
  maxDocumentBytes: 15 * 1024 * 1024,
  requestTimeoutMs: 45_000,
  /** Minimum gap between two requests to the SAME host (one request at a time overall). */
  perHostDelayMs: 3_000,
  maxSourcesPerRun: 8,
  maxAiCallsPerRun: 5,
  /** Only the first pages are read: a benchmark is always stated near the front of a factsheet or SID. */
  maxPdfPages: 40,
  pdfTimeoutMs: 30_000,
  /** Stop picking up new sources once a run has used this much wall-clock time. */
  runBudgetMs: 240_000,
  /** Failed fetches are retried on a later run in the same month, at most this many times per source. */
  maxAttemptsPerSourcePerMonth: 3,
  maxRedirects: 3,
  /** The cap on text handed to the AI pass (only the benchmark-bearing excerpts, never the whole document). */
  maxAiExcerptChars: 6_000,
});

/** The tunable limits (every value is a plain number, so a caller or a test can override any of them). */
export type FactsheetConfig = { -readonly [K in keyof typeof FACTSHEET_DEFAULTS]: number };

export type FactsheetDocumentType = 'amc_factsheet' | 'amc_sid' | 'amc_kim' | 'amc_addendum' | 'amfi_disclosure' | 'other';

export type TermsReviewStatus = 'not_reviewed' | 'under_review' | 'approved' | 'declined';
export const TERMS_REVIEW_STATUSES: readonly TermsReviewStatus[] = ['not_reviewed', 'under_review', 'approved', 'declined'];

/** How far one document goes: a per-scheme document names one scheme; a complete factsheet names many. */
export type DocumentScope = 'single_scheme' | 'multi_scheme';

/** ii_factsheet_sources, camel-cased. */
export interface FactsheetSource {
  id: string;
  sourceKey: string;
  amcKey: string;
  amcName: string;
  documentType: FactsheetDocumentType;
  /** A fixed document URL, or a template with {YYYY} {MM} {MONTH} tokens (none is seeded: month-specific tokens cannot be predicted). */
  urlKind: 'fixed' | 'monthly_template';
  url: string;
  host: string;
  /** AMFI scheme codes this document covers. Matching a held instrument is by exact code only, never by name. */
  amfiSchemeCodes: readonly string[];
  /** The scheme name as the document prints it; the document must contain it or nothing is recorded. */
  documentSchemeName: string;
  documentScope: DocumentScope;
  priority: number;
  enabled: boolean;
  termsReviewStatus: TermsReviewStatus;
  // Conditional-request state (operational, updated by the job).
  lastEtag: string | null;
  lastModified: string | null;
  lastChecksum: string | null;
  lastFetchedAt: string | null;
}

/** One held instrument as the job sees it: identity only. No user, no count, no amount. */
export interface HeldInstrumentLite {
  instrumentId: string;
  instrumentName: string;
  amcName: string | null;
  amfiSchemeCode: string | null;
}

// ---------------------------------------------------------------------------
// Extraction results
// ---------------------------------------------------------------------------

export type DatePrecision = 'day' | 'month';

export interface ExtractedDate {
  /** ISO date; for a month-only statement the first day of that month. */
  iso: string;
  precision: DatePrecision;
}

export interface ExtractedBenchmark {
  /** Exactly as printed (trailing effective-date remark removed). */
  raw: string;
  /** A heading hint such as "Benchmark (Total Return Index)" that states the variant for a bare name. */
  variantHint: 'total_return' | 'price' | 'net_total_return' | null;
}

export interface DeclaredExtraction {
  schemeNamePresent: boolean;
  tier1: ExtractedBenchmark | null;
  additional: ExtractedBenchmark[];
  /** The date the document states the benchmark took effect (e.g. "w.e.f. 31 October 2023"), if any. */
  effectiveFromStated: ExtractedDate | null;
  /** The date the document itself is dated ("Report as on", "dated"), if any. */
  documentDate: ExtractedDate | null;
  /** The sentence the benchmark came from (<= 400 chars), kept as evidence. */
  excerpt: string | null;
}

export type PatternOutcome =
  | { status: 'found'; extraction: DeclaredExtraction }
  | { status: 'not_found'; reason: string; schemeNamePresent: boolean }
  | { status: 'ambiguous'; reason: string; candidates: string[]; schemeNamePresent: boolean };

export type ExtractionMethod = 'text_pattern' | 'ai' | 'text_pattern_and_ai' | 'manual';
export type ExtractionConfidence = 'high' | 'medium' | 'low';

// ---------------------------------------------------------------------------
// Classification of a declared benchmark
// ---------------------------------------------------------------------------

export type BenchmarkKind = 'single_index' | 'composite' | 'commodity_price';

export interface CompositionLeg {
  /** null when the document states no weight for this leg (a single index, or an unweighted list). */
  weightPct: number | null;
  name: string;
}

export type CatalogueState =
  | 'matched_verified' // one verified, active, total-return catalogue series matches by name at HIGH confidence
  | 'matched_other' // a catalogue match exists but not at high confidence / not verified: a human decides
  | 'unsupported_composite' // several indices combined: the catalogue cannot represent it; composition stored for the future
  | 'unsupported_commodity' // a commodity price (gold, silver): not an index series
  | 'no_catalogue_match'; // single index but nothing in the catalogue matches it safely

// ---------------------------------------------------------------------------
// Persisted rows (ii_scheme_declared_benchmark_versions is APPEND-ONLY)
// ---------------------------------------------------------------------------

export type VersionReviewState =
  | 'awaiting_confirmation' // first sighting of a clean single index: needs the same answer next month before it may auto-publish
  | 'pending_review' // a human must look (change, composite, commodity price, low confidence, disagreement, conflict)
  | 'recorded_only' // history kept, nothing to decide (only the additional benchmark changed)
  | 'consistent_with_mapping'; // an admin-entered mapping already says the same thing

export type EffectiveFromBasis = 'document_stated' | 'estimated_document_month';

export interface DeclaredBenchmarkVersion {
  id: string | null;
  instrumentId: string;
  versionNo: number;
  supersedesVersionId: string | null;
  tier1Name: string;
  tier1VariantHint: ExtractedBenchmark['variantHint'];
  additionalNames: string[];
  benchmarkKind: BenchmarkKind;
  composition: CompositionLeg[];
  catalogueState: CatalogueState;
  matchedBenchmarkId: string | null;
  matchConfidence: 'high' | 'medium' | 'low' | null;
  effectiveFrom: string;
  effectiveFromBasis: EffectiveFromBasis;
  sourceId: string;
  sourceUrl: string;
  sourceTitle: string | null;
  sourceDocumentType: FactsheetDocumentType;
  documentDate: string | null;
  documentDatePrecision: DatePrecision | null;
  /** First day of the document's month: the key the idempotent monthly record is dated by. */
  documentMonth: string;
  retrievedAt: string;
  documentChecksum: string;
  extractionMethod: ExtractionMethod;
  extractorVersion: string;
  aiModel: string | null;
  extractionConfidence: ExtractionConfidence;
  extractorsAgree: boolean | null;
  evidenceExcerpt: string | null;
  reviewState: VersionReviewState;
  reviewReason: string | null;
}

export type AttemptOutcome =
  | 'refused_terms_not_approved'
  | 'refused_robots'
  | 'document_too_large'
  | 'source_blocked'
  | 'fetch_failed'
  | 'text_extraction_failed'
  | 'scheme_not_in_document'
  | 'benchmark_not_found'
  | 'extraction_ambiguous'
  | 'ai_rejected'
  | 'older_document_ignored'
  | 'recorded_first_observation'
  | 'confirmed_unchanged'
  | 'recorded_change'
  | 'recorded_additional_change'
  | 'auto_published'
  | 'error';

/** Outcomes after which the same source is NOT touched again in the same month (a re-run is a no-op for it). */
export const TERMINAL_OUTCOMES: readonly AttemptOutcome[] = [
  'refused_robots',
  'document_too_large',
  'source_blocked',
  'text_extraction_failed',
  'scheme_not_in_document',
  'benchmark_not_found',
  'extraction_ambiguous',
  'ai_rejected',
  'older_document_ignored',
  'recorded_first_observation',
  'confirmed_unchanged',
  'recorded_change',
  'recorded_additional_change',
  'auto_published',
];

export interface AttemptRow {
  runId: string;
  /** First day of the calendar month of the run. */
  runMonth: string;
  sourceId: string;
  instrumentId: string;
  attemptedAt: string;
  outcome: AttemptOutcome;
  detail: string | null;
  httpStatus: number | null;
  bytes: number | null;
  documentChecksum: string | null;
  documentDate: string | null;
  versionId: string | null;
  reviewRequired: boolean;
}

export type VersionEventType = 'proposal_created' | 'auto_published' | 'auto_publish_refused' | 'approved' | 'rejected' | 'manual_entry' | 'acknowledged';
export const DECISIVE_EVENTS: readonly VersionEventType[] = ['auto_published', 'approved', 'rejected', 'manual_entry', 'acknowledged'];

export interface VersionEventRow {
  versionId: string;
  eventType: VersionEventType;
  proposalId: string | null;
  mappingId: string | null;
  note: string | null;
}

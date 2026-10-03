// Persistence port of the factsheet benchmark reader, and its Supabase (service-role) implementation.
//
// The runner talks ONLY to this interface, so every rule in runner.ts is unit-tested offline against an in-memory
// fake. The Supabase implementation below is deliberately thin: reads are plain selects, and every write goes
// through a SECURITY DEFINER function created by migration 0252 (which re-checks the append-only rules inside the
// database). It is NOT exercised against a real database in this repository's unit tests.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { CatalogueEntryLite } from '../benchmarkData/benchmarkNameMatcher';
import type { MappingProposalPayload } from '../benchmarkData/schemeMappingProposals';
import type { JobControlRow } from '../pc6/referenceImportRunner';
import { nextAttemptAfter } from '../pc6/referenceImportRunner';
import type { ExistingMapping, StoredVersion } from './decision';
import {
  FACTSHEET_JOB_KEY,
  type AttemptOutcome,
  type AttemptRow,
  type DeclaredBenchmarkVersion,
  type FactsheetSource,
  type HeldInstrumentLite,
  type VersionEventRow,
  type VersionEventType,
} from './types';

export interface SourceHttpState {
  etag: string | null;
  lastModified: string | null;
  checksum: string | null;
  fetchedAt: string;
}

export interface MonthAttempt {
  sourceId: string;
  instrumentId: string;
  outcome: AttemptOutcome;
  attemptedAt: string;
}

export interface FactsheetStore {
  readControl(): Promise<JobControlRow | null>;
  recordJobOutcome(control: JobControlRow, success: boolean, nowIso: string): Promise<void>;
  listSources(): Promise<FactsheetSource[]>;
  listHeldInstruments(): Promise<HeldInstrumentLite[]>;
  loadCatalogue(): Promise<CatalogueEntryLite[]>;
  attemptsForMonth(runMonth: string): Promise<MonthAttempt[]>;
  lastAttemptAtBySource(): Promise<Map<string, string>>;
  latestVersions(instrumentIds: readonly string[]): Promise<Map<string, StoredVersion>>;
  primaryMappings(instrumentIds: readonly string[]): Promise<Map<string, ExistingMapping[]>>;
  recordAttempt(row: AttemptRow): Promise<void>;
  /** Appends a version. `expectedPreviousVersionId` must equal the instrument's current latest version (else the write is refused). */
  recordVersion(v: DeclaredBenchmarkVersion, expectedPreviousVersionId: string | null): Promise<string>;
  recordEvent(e: VersionEventRow): Promise<void>;
  createProposal(p: MappingProposalPayload): Promise<string>;
  autoPublish(proposalId: string): Promise<{ autoPublished: boolean; mappingId: string | null; reason: string | null }>;
  touchSource(sourceId: string, state: SourceHttpState): Promise<void>;
}

// ---------------------------------------------------------------------------
// Supabase implementation (service-role client; server-side only)
// ---------------------------------------------------------------------------

const CHUNK = 150;

function chunks<T>(xs: readonly T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

function must<T>(res: { data: T | null; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  return (res.data ?? ([] as unknown as T)) as T;
}

export function versionToRpc(v: DeclaredBenchmarkVersion): Record<string, unknown> {
  return {
    instrument_id: v.instrumentId,
    supersedes_version_id: v.supersedesVersionId,
    tier1_name: v.tier1Name,
    tier1_variant_hint: v.tier1VariantHint,
    additional_names: v.additionalNames,
    benchmark_kind: v.benchmarkKind,
    composition: v.composition.map((l) => ({ weight_pct: l.weightPct, name: l.name })),
    catalogue_state: v.catalogueState,
    matched_benchmark_id: v.matchedBenchmarkId,
    match_confidence: v.matchConfidence,
    effective_from: v.effectiveFrom,
    effective_from_basis: v.effectiveFromBasis,
    source_id: v.sourceId,
    source_url: v.sourceUrl,
    source_title: v.sourceTitle,
    source_document_type: v.sourceDocumentType,
    document_date: v.documentDate,
    document_date_precision: v.documentDatePrecision,
    document_month: v.documentMonth,
    retrieved_at: v.retrievedAt,
    document_checksum: v.documentChecksum,
    extraction_method: v.extractionMethod,
    extractor_version: v.extractorVersion,
    ai_model: v.aiModel,
    extraction_confidence: v.extractionConfidence,
    extractors_agree: v.extractorsAgree,
    evidence_excerpt: v.evidenceExcerpt,
    review_state: v.reviewState,
    review_reason: v.reviewReason,
  };
}

interface VersionDbRow {
  id: string;
  instrument_id: string;
  version_no: number;
  supersedes_version_id: string | null;
  tier1_name: string;
  tier1_variant_hint: DeclaredBenchmarkVersion['tier1VariantHint'];
  additional_names: string[] | null;
  benchmark_kind: DeclaredBenchmarkVersion['benchmarkKind'];
  composition: Array<{ weight_pct: number | null; name: string }> | null;
  catalogue_state: DeclaredBenchmarkVersion['catalogueState'];
  matched_benchmark_id: string | null;
  match_confidence: DeclaredBenchmarkVersion['matchConfidence'];
  effective_from: string;
  effective_from_basis: DeclaredBenchmarkVersion['effectiveFromBasis'];
  source_id: string;
  source_url: string;
  source_title: string | null;
  source_document_type: DeclaredBenchmarkVersion['sourceDocumentType'];
  document_date: string | null;
  document_date_precision: DeclaredBenchmarkVersion['documentDatePrecision'];
  document_month: string;
  retrieved_at: string;
  document_checksum: string;
  extraction_method: DeclaredBenchmarkVersion['extractionMethod'];
  extractor_version: string;
  ai_model: string | null;
  extraction_confidence: DeclaredBenchmarkVersion['extractionConfidence'];
  extractors_agree: boolean | null;
  evidence_excerpt: string | null;
  review_state: DeclaredBenchmarkVersion['reviewState'];
  review_reason: string | null;
}

export function versionFromDb(r: VersionDbRow, events: VersionEventType[]): StoredVersion {
  return {
    id: r.id,
    events,
    instrumentId: r.instrument_id,
    versionNo: r.version_no,
    supersedesVersionId: r.supersedes_version_id,
    tier1Name: r.tier1_name,
    tier1VariantHint: r.tier1_variant_hint,
    additionalNames: r.additional_names ?? [],
    benchmarkKind: r.benchmark_kind,
    composition: (r.composition ?? []).map((l) => ({ weightPct: l.weight_pct, name: l.name })),
    catalogueState: r.catalogue_state,
    matchedBenchmarkId: r.matched_benchmark_id,
    matchConfidence: r.match_confidence,
    effectiveFrom: String(r.effective_from).slice(0, 10),
    effectiveFromBasis: r.effective_from_basis,
    sourceId: r.source_id,
    sourceUrl: r.source_url,
    sourceTitle: r.source_title,
    sourceDocumentType: r.source_document_type,
    documentDate: r.document_date ? String(r.document_date).slice(0, 10) : null,
    documentDatePrecision: r.document_date_precision,
    documentMonth: String(r.document_month).slice(0, 10),
    retrievedAt: r.retrieved_at,
    documentChecksum: r.document_checksum,
    extractionMethod: r.extraction_method,
    extractorVersion: r.extractor_version,
    aiModel: r.ai_model,
    extractionConfidence: r.extraction_confidence,
    extractorsAgree: r.extractors_agree,
    evidenceExcerpt: r.evidence_excerpt,
    reviewState: r.review_state,
    reviewReason: r.review_reason,
  };
}

export function createSupabaseFactsheetStore(supabase: SupabaseClient): FactsheetStore {
  return {
    async readControl() {
      const { data, error } = await supabase
        .from('ii_reference_job_control')
        .select('job_key, enabled, disabled_reason, consecutive_failures, next_attempt_not_before, last_success_at')
        .eq('job_key', FACTSHEET_JOB_KEY)
        .maybeSingle();
      if (error || !data) return null; // fail closed: a missing row or a read error means "not authorised"
      const r = data as { job_key: string; enabled: boolean; disabled_reason: string | null; consecutive_failures: number; next_attempt_not_before: string | null; last_success_at: string | null };
      return { jobKey: r.job_key, enabled: r.enabled === true, disabledReason: r.disabled_reason, consecutiveFailures: r.consecutive_failures, nextAttemptNotBefore: r.next_attempt_not_before, lastSuccessAt: r.last_success_at };
    },

    async recordJobOutcome(control, success, nowIso) {
      const failures = success ? 0 : control.consecutiveFailures + 1;
      await supabase
        .from('ii_reference_job_control')
        .update(success ? { consecutive_failures: 0, last_success_at: nowIso, next_attempt_not_before: null, updated_at: nowIso } : { consecutive_failures: failures, last_failure_at: nowIso, next_attempt_not_before: nextAttemptAfter(nowIso, failures), updated_at: nowIso })
        .eq('job_key', FACTSHEET_JOB_KEY);
    },

    async listSources() {
      const rows = must(
        await supabase
          .from('ii_factsheet_sources')
          .select('id, source_key, amc_key, amc_name, document_type, url_kind, url, host, amfi_scheme_codes, document_scheme_name, document_scope, priority, enabled, terms_review_status, last_etag, last_modified, last_checksum, last_fetched_at'),
        'list factsheet sources'
      ) as Array<Record<string, unknown>>;
      return rows.map((r) => ({
        id: r.id as string,
        sourceKey: r.source_key as string,
        amcKey: r.amc_key as string,
        amcName: r.amc_name as string,
        documentType: r.document_type as FactsheetSource['documentType'],
        urlKind: r.url_kind as FactsheetSource['urlKind'],
        url: r.url as string,
        host: r.host as string,
        amfiSchemeCodes: ((r.amfi_scheme_codes as string[] | null) ?? []).map(String),
        documentSchemeName: r.document_scheme_name as string,
        documentScope: r.document_scope as FactsheetSource['documentScope'],
        priority: Number(r.priority ?? 100),
        enabled: r.enabled === true,
        // Anything but the literal 'approved' is treated as not approved by the gate.
        termsReviewStatus: r.terms_review_status as FactsheetSource['termsReviewStatus'],
        lastEtag: (r.last_etag as string | null) ?? null,
        lastModified: (r.last_modified as string | null) ?? null,
        lastChecksum: (r.last_checksum as string | null) ?? null,
        lastFetchedAt: (r.last_fetched_at as string | null) ?? null,
      }));
    },

    async listHeldInstruments() {
      const rows = must(await supabase.rpc('factsheet_reader_held_instruments'), 'list held instruments') as Array<Record<string, unknown>>;
      return rows.map((r) => ({ instrumentId: r.instrument_id as string, instrumentName: r.instrument_name as string, amcName: (r.amc_name as string | null) ?? null, amfiSchemeCode: (r.amfi_scheme_code as string | null) ?? null }));
    },

    async loadCatalogue() {
      const rows = must(
        await supabase.from('ii_benchmarks').select('id, benchmark_key, benchmark_label, official_name, return_variant, catalogue_status, lifecycle_status'),
        'load benchmark catalogue'
      ) as Array<Record<string, unknown>>;
      return rows.map((r) => ({
        benchmarkId: r.id as string,
        benchmarkKey: r.benchmark_key as string,
        officialName: ((r.official_name as string | null) ?? (r.benchmark_label as string)) as string,
        returnVariant: (r.return_variant as CatalogueEntryLite['returnVariant']) ?? null,
        verified: r.catalogue_status === 'verified',
        active: r.lifecycle_status === 'active',
      }));
    },

    async attemptsForMonth(runMonth) {
      const rows = must(await supabase.from('ii_factsheet_attempts').select('source_id, instrument_id, outcome, attempted_at').eq('run_month', runMonth).limit(5000), 'read attempts') as Array<Record<string, unknown>>;
      return rows.map((r) => ({ sourceId: r.source_id as string, instrumentId: r.instrument_id as string, outcome: r.outcome as AttemptOutcome, attemptedAt: r.attempted_at as string }));
    },

    async lastAttemptAtBySource() {
      const rows = must(await supabase.from('ii_factsheet_attempts').select('source_id, attempted_at').order('attempted_at', { ascending: false }).limit(2000), 'read last attempts') as Array<{ source_id: string; attempted_at: string }>;
      const out = new Map<string, string>();
      for (const r of rows) if (!out.has(r.source_id)) out.set(r.source_id, r.attempted_at);
      return out;
    },

    async latestVersions(instrumentIds) {
      const out = new Map<string, StoredVersion>();
      for (const slice of chunks(instrumentIds, CHUNK)) {
        const rows = must(await supabase.from('ii_scheme_declared_benchmark_versions').select('*').in('instrument_id', slice).order('version_no', { ascending: false }), 'read versions') as VersionDbRow[];
        const latest = new Map<string, VersionDbRow>();
        for (const r of rows) if (!latest.has(r.instrument_id)) latest.set(r.instrument_id, r);
        const ids = [...latest.values()].map((r) => r.id);
        const events = ids.length
          ? (must(await supabase.from('ii_factsheet_version_events').select('version_id, event_type').in('version_id', ids), 'read version events') as Array<{ version_id: string; event_type: VersionEventType }>)
          : [];
        for (const r of latest.values()) out.set(r.instrument_id, versionFromDb(r, events.filter((e) => e.version_id === r.id).map((e) => e.event_type)));
      }
      return out;
    },

    async primaryMappings(instrumentIds) {
      const out = new Map<string, ExistingMapping[]>();
      for (const slice of chunks(instrumentIds, CHUNK)) {
        const rows = must(
          await supabase
            .from('ii_instrument_benchmarks')
            .select('instrument_id, benchmark_id, effective_from, effective_to, quality_status')
            .in('instrument_id', slice)
            .eq('relationship_type', 'primary'),
          'read primary mappings'
        ) as Array<{ instrument_id: string; benchmark_id: string; effective_from: string; effective_to: string | null; quality_status: string | null }>;
        for (const r of rows) {
          if (r.quality_status === 'superseded') continue;
          const list = out.get(r.instrument_id) ?? [];
          list.push({ benchmarkId: r.benchmark_id, effectiveFrom: String(r.effective_from).slice(0, 10), effectiveTo: r.effective_to ? String(r.effective_to).slice(0, 10) : null });
          out.set(r.instrument_id, list);
        }
      }
      return out;
    },

    async recordAttempt(row) {
      const { error } = await supabase.rpc('record_factsheet_attempt', {
        p: {
          run_id: row.runId,
          run_month: row.runMonth,
          source_id: row.sourceId,
          instrument_id: row.instrumentId,
          attempted_at: row.attemptedAt,
          outcome: row.outcome,
          detail: row.detail,
          http_status: row.httpStatus,
          bytes: row.bytes,
          document_checksum: row.documentChecksum,
          document_date: row.documentDate,
          version_id: row.versionId,
          review_required: row.reviewRequired,
        },
      });
      // A unique-violation here means another run already recorded this terminal result: that is the idempotency guard working.
      if (error && error.code !== '23505') throw new Error(`record attempt: ${error.message}`);
    },

    async recordVersion(v, expectedPreviousVersionId) {
      const { data, error } = await supabase.rpc('record_factsheet_version', { p: versionToRpc(v), p_expected_previous: expectedPreviousVersionId });
      if (error) throw new Error(`record version: ${error.message}`);
      return data as string;
    },

    async recordEvent(e) {
      const { error } = await supabase.rpc('record_factsheet_version_event', { p: { version_id: e.versionId, event_type: e.eventType, proposal_id: e.proposalId, mapping_id: e.mappingId, note: e.note } });
      if (error) throw new Error(`record version event: ${error.message}`);
    },

    async createProposal(p) {
      const { data, error } = await supabase.rpc('propose_benchmark_mapping', { p });
      if (error) throw new Error(`propose mapping: ${error.message}`);
      return data as string;
    },

    async autoPublish(proposalId) {
      const { data, error } = await supabase.rpc('auto_publish_benchmark_mapping', { p_proposal: proposalId });
      if (error) throw new Error(`auto publish: ${error.message}`);
      const d = data as { auto_published?: boolean; mapping_id?: string; reason?: string };
      return { autoPublished: d.auto_published === true, mappingId: d.mapping_id ?? null, reason: d.reason ?? null };
    },

    async touchSource(sourceId, state) {
      const { error } = await supabase.rpc('touch_factsheet_source', { p_source: sourceId, p: { etag: state.etag, last_modified: state.lastModified, checksum: state.checksum, fetched_at: state.fetchedAt } });
      if (error) throw new Error(`touch source: ${error.message}`);
    },
  };
}

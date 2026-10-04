// Test doubles for the factsheet benchmark reader: an in-memory FactsheetStore that ENFORCES the same rules the
// database functions enforce (append-only versions, stale-previous refusal, one terminal result per scheme per source
// per month, auto-publish refusing an overlapping mapping), and a scripted PoliteFetcher. Nothing here touches a
// network or a database. Not part of any production bundle.
import type { CatalogueEntryLite } from '@/lib/services/investment-intelligence/benchmarkData/benchmarkNameMatcher';
import type { MappingProposalPayload } from '@/lib/services/investment-intelligence/benchmarkData/schemeMappingProposals';
import type { ExistingMapping, StoredVersion } from '@/lib/services/investment-intelligence/factsheetReader/decision';
import type { FetchOptions, FetchOutcome, PoliteFetcher } from '@/lib/services/investment-intelligence/factsheetReader/politeFetch';
import type { FactsheetStore, MonthAttempt, SourceHttpState } from '@/lib/services/investment-intelligence/factsheetReader/store';
import { FACTSHEET_SOURCE_SEED, sourceFromSeed } from '@/lib/services/investment-intelligence/factsheetReader/sourceRegistry';
import { TERMINAL_OUTCOMES, type AttemptRow, type DeclaredBenchmarkVersion, type FactsheetSource, type HeldInstrumentLite, type VersionEventRow } from '@/lib/services/investment-intelligence/factsheetReader/types';
import type { JobControlRow } from '@/lib/services/investment-intelligence/pc6/referenceImportRunner';
import { SAMPLE_CATALOGUE } from '@/lib/services/investment-intelligence/factsheetReader/sampleDryRun';

export const HELD_BAF: HeldInstrumentLite = { instrumentId: '11111111-1111-4111-8111-111111111111', instrumentName: 'HGFG-HDFC Balanced Advantage Fund - Regular Plan - Growth (Non -Demat)', amcName: 'HDFC Mutual Fund', amfiSchemeCode: '100119' };
export const HELD_MULTI: HeldInstrumentLite = { instrumentId: '22222222-2222-4222-8222-222222222222', instrumentName: 'L101G-SBI Multi Asset Allocation Fund Regular Growth (Non-Demat)', amcName: 'SBI Mutual Fund', amfiSchemeCode: '103408' };
export const HELD_CONTRA: HeldInstrumentLite = { instrumentId: '33333333-3333-4333-8333-333333333333', instrumentName: 'L036G-SBI Contra Fund - Regular Plan - Growth (Non-Demat)', amcName: 'SBI Mutual Fund', amfiSchemeCode: '102414' };
export const HELD_NIPPON: HeldInstrumentLite = { instrumentId: '44444444-4444-4444-8444-444444444444', instrumentName: 'RMFPSGPG-NIPPON INDIA POWER & INFRA FUND - GROWTH PLAN - GROWTH OPTION (Non Demat)', amcName: 'Nippon India Mutual Fund', amfiSchemeCode: '101262' };

export const CONTROL_ON: JobControlRow = { jobKey: 'factsheet_benchmark_reader', enabled: true, disabledReason: null, consecutiveFailures: 0, nextAttemptNotBefore: null, lastSuccessAt: null };
export const CONTROL_OFF: JobControlRow = { jobKey: 'factsheet_benchmark_reader', enabled: false, disabledReason: 'Shipped disabled by migration 0252.', consecutiveFailures: 0, nextAttemptNotBefore: null, lastSuccessAt: null };

/** Registry sources by key, with ids, optionally approved. */
export function sourcesFor(keys: readonly string[], terms: FactsheetSource['termsReviewStatus'] = 'approved'): FactsheetSource[] {
  return keys.map((k) => {
    const seed = FACTSHEET_SOURCE_SEED.find((s) => s.sourceKey === k);
    if (!seed) throw new Error(`unknown seed ${k}`);
    return { ...sourceFromSeed(seed, `src-${k}`), termsReviewStatus: terms };
  });
}

export class FakeStore implements FactsheetStore {
  calls: string[] = [];
  writes = 0;
  control: JobControlRow | null = CONTROL_ON;
  sources: FactsheetSource[] = [];
  held: HeldInstrumentLite[] = [];
  catalogue: CatalogueEntryLite[] = [...SAMPLE_CATALOGUE];
  attempts: AttemptRow[] = [];
  versions: StoredVersion[] = [];
  events: VersionEventRow[] = [];
  mappings = new Map<string, ExistingMapping[]>();
  proposals: Array<{ id: string; payload: MappingProposalPayload; status: 'proposed' | 'approved' }> = [];
  autoPublishCalls = 0;
  duplicateTerminalBlocked = 0;
  jobOutcomes: boolean[] = [];
  /** Instrument ids for which recordVersion throws (to prove per-scheme isolation). */
  failVersionFor = new Set<string>();
  failProposals = false;
  private n = 0;

  private log(m: string) {
    this.calls.push(m);
  }
  private write() {
    this.writes += 1;
  }

  async readControl() {
    this.log('readControl');
    return this.control;
  }
  async recordJobOutcome(_c: JobControlRow, success: boolean) {
    this.log('recordJobOutcome');
    this.write();
    this.jobOutcomes.push(success);
  }
  async listSources() {
    this.log('listSources');
    return this.sources.map((s) => ({ ...s }));
  }
  async listHeldInstruments() {
    this.log('listHeldInstruments');
    return [...this.held];
  }
  async loadCatalogue() {
    this.log('loadCatalogue');
    return [...this.catalogue];
  }
  async attemptsForMonth(runMonth: string): Promise<MonthAttempt[]> {
    this.log('attemptsForMonth');
    return this.attempts.filter((a) => a.runMonth === runMonth).map((a) => ({ sourceId: a.sourceId, instrumentId: a.instrumentId, outcome: a.outcome, attemptedAt: a.attemptedAt }));
  }
  async lastAttemptAtBySource() {
    this.log('lastAttemptAtBySource');
    const out = new Map<string, string>();
    for (const a of this.attempts) if (!out.has(a.sourceId) || a.attemptedAt > (out.get(a.sourceId) as string)) out.set(a.sourceId, a.attemptedAt);
    return out;
  }
  async latestVersions(ids: readonly string[]) {
    this.log('latestVersions');
    const out = new Map<string, StoredVersion>();
    for (const id of ids) {
      const vs = this.versions.filter((v) => v.instrumentId === id).sort((a, b) => b.versionNo - a.versionNo);
      if (vs[0]) out.set(id, { ...vs[0], events: this.events.filter((e) => e.versionId === vs[0].id).map((e) => e.eventType) });
    }
    return out;
  }
  async primaryMappings(ids: readonly string[]) {
    this.log('primaryMappings');
    const out = new Map<string, ExistingMapping[]>();
    for (const id of ids) if (this.mappings.has(id)) out.set(id, [...(this.mappings.get(id) as ExistingMapping[])]);
    return out;
  }
  async recordAttempt(row: AttemptRow) {
    this.log('recordAttempt');
    if ((TERMINAL_OUTCOMES as readonly string[]).includes(row.outcome) && this.attempts.some((a) => a.sourceId === row.sourceId && a.instrumentId === row.instrumentId && a.runMonth === row.runMonth && (TERMINAL_OUTCOMES as readonly string[]).includes(a.outcome))) {
      this.duplicateTerminalBlocked += 1; // the database's unique index; the real store swallows the 23505
      return;
    }
    this.write();
    this.attempts.push(Object.freeze({ ...row }) as AttemptRow);
  }
  async recordVersion(v: DeclaredBenchmarkVersion, expectedPrev: string | null) {
    this.log('recordVersion');
    if (this.failVersionFor.has(v.instrumentId)) throw new Error('simulated database failure for this scheme');
    const latest = this.versions.filter((x) => x.instrumentId === v.instrumentId).sort((a, b) => b.versionNo - a.versionNo)[0];
    if ((latest?.id ?? null) !== expectedPrev) throw new Error('the current version changed since it was read');
    this.write();
    const id = `ver-${++this.n}`;
    this.versions.push(Object.freeze({ ...v, id, versionNo: (latest?.versionNo ?? 0) + 1, events: [] }) as StoredVersion);
    return id;
  }
  async recordEvent(e: VersionEventRow) {
    this.log('recordEvent');
    this.write();
    this.events.push(Object.freeze({ ...e }) as VersionEventRow);
  }
  async createProposal(p: MappingProposalPayload) {
    this.log('createProposal');
    if (this.failProposals) throw new Error('simulated proposal failure');
    this.write();
    const id = `prop-${++this.n}`;
    this.proposals.push({ id, payload: p, status: 'proposed' });
    return id;
  }
  async autoPublish(proposalId: string) {
    this.log('autoPublish');
    this.autoPublishCalls += 1;
    const p = this.proposals.find((x) => x.id === proposalId);
    if (!p) throw new Error('proposal not found');
    // the same refusals as auto_publish_benchmark_mapping(): deterministic, high confidence, no ambiguity, evidence, no overlap
    if (p.payload.resolution_method !== 'deterministic_exact' || p.payload.confidence !== 'high' || p.payload.ambiguity_reason !== null || p.payload.benchmark_id === null || p.payload.evidence_source === 'other') {
      return { autoPublished: false, mappingId: null, reason: 'routed to admin review: not a deterministic, high-confidence, unambiguous primary match with authoritative evidence' };
    }
    const open = (this.mappings.get(p.payload.instrument_id) ?? []).filter((m) => m.effectiveTo === null);
    if (open.length > 0) return { autoPublished: false, mappingId: null, reason: 'routed to admin review: it overlaps the existing primary mapping' };
    this.write();
    p.status = 'approved';
    this.mappings.set(p.payload.instrument_id, [{ benchmarkId: p.payload.benchmark_id, effectiveFrom: p.payload.effective_from, effectiveTo: null }]);
    return { autoPublished: true, mappingId: `map-${++this.n}`, reason: null };
  }
  async touchSource(sourceId: string, s: SourceHttpState) {
    this.log('touchSource');
    this.write();
    const src = this.sources.find((x) => x.id === sourceId);
    if (src) Object.assign(src, { lastEtag: s.etag, lastModified: s.lastModified, lastChecksum: s.checksum, lastFetchedAt: s.fetchedAt });
  }
}

export type Script = FetchOutcome | ((url: string, opts: FetchOptions) => FetchOutcome | Promise<FetchOutcome>) | { throws: string };

/** A scripted PoliteFetcher: records every URL it is asked for and the conditional validators it was given. */
export class FakeFetcher implements PoliteFetcher {
  urls: string[] = [];
  options: FetchOptions[] = [];
  blockedHosts: ReadonlySet<string> = new Set();
  constructor(public scripts: Record<string, Script>) {}
  get requestCount() {
    return this.urls.length;
  }
  async fetchDocument(url: string, opts: FetchOptions): Promise<FetchOutcome> {
    this.urls.push(url);
    this.options.push(opts);
    const s = this.scripts[url];
    if (!s) return { kind: 'failed', status: 404, detail: 'not scripted' };
    if (typeof s === 'function') return s(url, opts);
    if ('throws' in s) throw new Error(s.throws);
    return s;
  }
}

export const okDoc = (text: string, extra: { etag?: string | null; lastModified?: string | null } = {}): FetchOutcome => ({ kind: 'ok', status: 200, bytes: new TextEncoder().encode(text), contentType: 'text/plain', etag: extra.etag ?? null, lastModified: extra.lastModified ?? null });

/** Reads the bytes as UTF-8 text (the tests supply text, not PDFs: PDF reading is tested on its own). */
export const readAsText = async (bytes: Uint8Array) => ({ ok: true as const, text: Buffer.from(bytes).toString('utf8'), kind: 'text' as const, pagesRead: 1, totalPages: 1 });

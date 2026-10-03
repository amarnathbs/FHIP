// The monthly factsheet benchmark reader: orchestration. All I/O is injected (store, fetcher, document reader,
// AI adapter), so every rule below is unit-tested offline against an in-memory store and a fake transport.
//
// ORDER OF EVERY RUN (each step has a named negative control in tests/unit/factsheetReaderRunner.test.ts):
//   1. KILL SWITCH FIRST. ii_reference_job_control.factsheet_benchmark_reader must be enabled; a missing row,
//      a read problem or "off" means NO work: no fetch, no write (not even a ledger row). It ships OFF.
//   2. DRY RUN (dryRun: true) plans only: it reads the registry, the held instruments and this month's ledger and
//      REPORTS what it would fetch and extract. It makes no network request and writes nothing, whatever the
//      switch says (so an operator can preview before ever enabling it).
//   3. BOUNDED TO HELD SCHEMES: a source is fetched only when at least one held instrument's AMFI code is in its
//      registered list, and only the instruments not yet finished this month are processed (idempotent re-runs).
//   4. TERMS GATE: a source whose terms review is not 'approved' is REFUSED before any request is made.
//   5. FAIR ROTATION: due sources are picked oldest-last-attempt first up to the per-run cap, then read in
//      priority order (newer / better documents first) so an older document can never create a spurious change.
//   6. PER-SCHEME ISOLATION: one instrument or one source failing is recorded as such and never stops the rest.
//   7. Everything is recorded in the attempt ledger; versions and events are append-only.

import { randomUUID } from 'node:crypto';
import { decideStart } from '../pc6/referenceImportRunner';
import { runAiExtraction, type FactsheetAiExtractor } from './aiExtractor';
import { decideObservation, monthStart, type ObservationDecision, type StoredVersion } from './decision';
import { documentTextFromBytes, sha256Hex, type DocumentTextResult } from './documentText';
import { extractWithPatterns } from './patternExtractor';
import type { PoliteFetcher } from './politeFetch';
import { gateSourceFetch, hostOf, resolveSourceUrl } from './sourceRegistry';
import type { FactsheetStore } from './store';
import {
  FACTSHEET_AI_ENV_FLAG,
  FACTSHEET_DEFAULTS,
  FACTSHEET_JOB_KEY,
  FACTSHEET_READER_VERSION,
  TERMINAL_OUTCOMES,
  type FactsheetConfig,
  type AttemptOutcome,
  type AttemptRow,
  type DeclaredExtraction,
  type FactsheetSource,
  type HeldInstrumentLite,
  type PatternOutcome,
} from './types';
import type { AiOutcome } from './aiExtractor';

export interface RunnerOptions {
  dryRun?: boolean;
  /** Cap on sources fetched in this run (default FACTSHEET_DEFAULTS.maxSourcesPerRun). */
  maxSources?: number;
  /** ISO first-of-month to run for (default: the month of nowIso). */
  runMonth?: string;
}

export interface RunnerDeps {
  store: FactsheetStore;
  fetcher: PoliteFetcher;
  nowIso: string;
  env: Record<string, string | undefined>;
  /** Optional AI adapter; used only when the pattern pass fails AND FACTSHEET_READER_AI_ENABLED === 'true'. */
  ai?: FactsheetAiExtractor | null;
  aiModelLabel?: string | null;
  /** Injectable for tests; defaults to the real PDF/HTML reader. */
  readDocument?: (bytes: Uint8Array, contentType: string | null) => Promise<DocumentTextResult>;
  runId?: string;
  nowMs?: () => number;
  config?: Partial<FactsheetConfig>;
}

export type SourceAction =
  | 'fetched'
  | 'would_fetch'
  | 'refused_terms_not_approved'
  | 'refused_source_disabled'
  | 'no_held_scheme'
  | 'already_done_this_month'
  | 'attempt_cap_reached'
  | 'deferred_run_cap'
  | 'deferred_time_budget';

export interface SourceReport {
  sourceKey: string;
  host: string;
  action: SourceAction;
  /** Held instruments this source covers that are not finished this month (a number only). */
  instruments: number;
  outcomes: Partial<Record<AttemptOutcome, number>>;
  detail: string | null;
}

export type RunStatus = 'skipped_kill_switch' | 'skipped_backoff' | 'skipped_already_running' | 'dry_run' | 'completed' | 'completed_with_problems';

export interface RunResult {
  runnerVersion: typeof FACTSHEET_READER_VERSION;
  status: RunStatus;
  detail: string;
  killSwitch: 'on' | 'off' | 'missing';
  dryRun: boolean;
  runMonth: string;
  sources: SourceReport[];
  requestsMade: number;
  aiCalls: number;
  ledgerRowsWritten: number;
}

const isPdfUrl = (u: string) => /\.pdf(?:$|[?#])/i.test(u);

export async function runFactsheetReader(deps: RunnerDeps, opts: RunnerOptions = {}): Promise<RunResult> {
  const cfg = { ...FACTSHEET_DEFAULTS, ...deps.config };
  const nowMs = deps.nowMs ?? Date.now;
  const startedMs = nowMs();
  const dryRun = opts.dryRun === true;
  const runMonth = opts.runMonth ?? monthStart(deps.nowIso.slice(0, 10));
  const runId = deps.runId ?? randomUUID();
  const base = { runnerVersion: FACTSHEET_READER_VERSION, dryRun, runMonth, sources: [] as SourceReport[], requestsMade: 0, aiCalls: 0, ledgerRowsWritten: 0 };

  // ---- 1. kill switch (reads one row; nothing else is touched when it is off) ---------------------------------------
  const control = await deps.store.readControl();
  const killSwitch: RunResult['killSwitch'] = !control ? 'missing' : control.enabled ? 'on' : 'off';
  if (!dryRun) {
    const decision = decideStart(control, FACTSHEET_JOB_KEY, deps.nowIso);
    if (!decision.start || !control) {
      return { ...base, status: decision.start ? 'skipped_kill_switch' : decision.status, detail: decision.start ? 'No job-control row.' : decision.detail, killSwitch };
    }
  }

  // ---- 2. plan -----------------------------------------------------------------------------------------------------
  const [sources, held, attempts, lastAttempt] = await Promise.all([deps.store.listSources(), deps.store.listHeldInstruments(), deps.store.attemptsForMonth(runMonth), deps.store.lastAttemptAtBySource()]);
  const heldByCode = new Map<string, HeldInstrumentLite[]>();
  for (const h of held) {
    if (!h.amfiSchemeCode) continue;
    const list = heldByCode.get(h.amfiSchemeCode) ?? [];
    list.push(h);
    heldByCode.set(h.amfiSchemeCode, list);
  }
  const terminal = new Set(attempts.filter((a) => (TERMINAL_OUTCOMES as readonly string[]).includes(a.outcome)).map((a) => `${a.sourceId}|${a.instrumentId}`));
  const refusalLogged = new Set(attempts.filter((a) => a.outcome === 'refused_terms_not_approved').map((a) => `${a.sourceId}|${a.instrumentId}`));
  const nonTerminalCount = new Map<string, number>();
  for (const a of attempts) if (!(TERMINAL_OUTCOMES as readonly string[]).includes(a.outcome) && a.outcome !== 'refused_terms_not_approved') nonTerminalCount.set(a.sourceId, (nonTerminalCount.get(a.sourceId) ?? 0) + 1);

  interface Planned {
    source: FactsheetSource;
    pending: HeldInstrumentLite[];
  }
  const fetchable: Planned[] = [];
  const reports: SourceReport[] = [];
  const report = (source: FactsheetSource, action: SourceAction, instruments: number, detail: string | null = null): SourceReport => {
    const r: SourceReport = { sourceKey: source.sourceKey, host: hostOf(source.url) ?? source.host, action, instruments, outcomes: {}, detail };
    reports.push(r);
    return r;
  };

  for (const source of [...sources].sort((a, b) => a.sourceKey.localeCompare(b.sourceKey))) {
    const matched = [...new Set(source.amfiSchemeCodes)].flatMap((c) => heldByCode.get(c) ?? []);
    if (matched.length === 0) {
      report(source, 'no_held_scheme', 0, 'No held scheme uses this document, so it is not fetched.');
      continue;
    }
    const pending = matched.filter((m) => !terminal.has(`${source.id}|${m.instrumentId}`));
    if (pending.length === 0) {
      report(source, 'already_done_this_month', 0, 'Every covered held scheme already has its result for this month.');
      continue;
    }
    const gate = gateSourceFetch(source, resolveSourceUrl(source, runMonth));
    if (!gate.allowed) {
      const action: SourceAction = gate.reason === 'terms_not_approved' ? 'refused_terms_not_approved' : 'refused_source_disabled';
      report(source, action, pending.length, gate.detail);
      // A refusal is recorded once per month per scheme so "last check" is honest ("not checked: terms not approved"). Nothing is fetched.
      if (!dryRun && gate.reason === 'terms_not_approved') {
        for (const p of pending) {
          if (refusalLogged.has(`${source.id}|${p.instrumentId}`)) continue;
          await writeAttempt(deps, runId, runMonth, base, { source, instrumentId: p.instrumentId, outcome: 'refused_terms_not_approved', detail: gate.detail, httpStatus: null, bytes: null, checksum: null, documentDate: null, versionId: null, reviewRequired: false });
        }
      }
      continue;
    }
    if ((nonTerminalCount.get(source.id) ?? 0) >= cfg.maxAttemptsPerSourcePerMonth * Math.max(1, pending.length)) {
      report(source, 'attempt_cap_reached', pending.length, `Already tried ${cfg.maxAttemptsPerSourcePerMonth} times this month without a result; it waits for next month.`);
      continue;
    }
    fetchable.push({ source, pending });
  }

  // Fair rotation: the sources untouched longest are picked first, up to the cap; the chosen ones are then READ in priority order.
  const cap = Math.max(0, opts.maxSources ?? cfg.maxSourcesPerRun);
  const rotation = [...fetchable].sort((a, b) => (lastAttempt.get(a.source.id) ?? '').localeCompare(lastAttempt.get(b.source.id) ?? '') || a.source.priority - b.source.priority || a.source.sourceKey.localeCompare(b.source.sourceKey));
  const chosen = rotation.slice(0, cap);
  const deferred = rotation.slice(cap);
  for (const d of deferred) report(d.source, 'deferred_run_cap', d.pending.length, 'Left for the next run to keep each run small and fair.');
  const execution = [...chosen].sort((a, b) => a.source.priority - b.source.priority || a.source.sourceKey.localeCompare(b.source.sourceKey));

  if (dryRun) {
    for (const e of execution) report(e.source, 'would_fetch', e.pending.length, `Would fetch ${hostOf(resolveSourceUrl(e.source, runMonth)) ?? e.source.host} once and read ${e.pending.length} scheme(s). Nothing was fetched or written.`);
    return { ...base, status: 'dry_run', detail: 'Dry run: nothing was fetched and nothing was written.', killSwitch, sources: reports };
  }

  // ---- 3. execute --------------------------------------------------------------------------------------------------
  const catalogue = await deps.store.loadCatalogue();
  const aiOn = deps.env[FACTSHEET_AI_ENV_FLAG] === 'true' && Boolean(deps.ai);
  const ctx: Ctx = { deps, cfg, runId, runMonth, base, catalogue, aiOn, aiCalls: 0 };
  let problem = false;
  let executed = 0;

  for (const e of execution) {
    if (nowMs() - startedMs > cfg.runBudgetMs) {
      report(e.source, 'deferred_time_budget', e.pending.length, 'The run used up its time budget; this source waits for the next run.');
      continue;
    }
    const rep = report(e.source, 'fetched', e.pending.length);
    executed += 1;
    try {
      await processSource(ctx, e.source, e.pending, rep);
    } catch (err) {
      // Per-source isolation: whatever went wrong, every scheme of this source gets an 'error' row and the run goes on.
      problem = true;
      const detail = safeDetail(err);
      for (const p of e.pending) {
        if (terminal.has(`${e.source.id}|${p.instrumentId}`)) continue;
        await writeAttempt(deps, runId, runMonth, base, { source: e.source, instrumentId: p.instrumentId, outcome: 'error', detail, httpStatus: null, bytes: null, checksum: null, documentDate: null, versionId: null, reviewRequired: false }).catch(() => undefined);
      }
      rep.outcomes.error = (rep.outcomes.error ?? 0) + e.pending.length;
    }
    for (const k of ['error', 'fetch_failed', 'source_blocked'] as const) if ((rep.outcomes[k] ?? 0) > 0) problem = true;
  }

  base.requestsMade = deps.fetcher.requestCount;
  base.aiCalls = ctx.aiCalls;
  // A run with nothing to do (everything already done this month) touches nothing, not even the job-control row.
  if (control && executed > 0) await deps.store.recordJobOutcome(control, !problem, deps.nowIso).catch(() => undefined);
  return { ...base, status: problem ? 'completed_with_problems' : 'completed', detail: problem ? 'The run finished; at least one source or scheme had a problem (see the per-source results).' : 'The run finished.', killSwitch, sources: reports };
}

// ---------------------------------------------------------------------------
// One source
// ---------------------------------------------------------------------------

interface Ctx {
  deps: RunnerDeps;
  cfg: FactsheetConfig;
  runId: string;
  runMonth: string;
  base: { ledgerRowsWritten: number };
  catalogue: Awaited<ReturnType<FactsheetStore['loadCatalogue']>>;
  aiOn: boolean;
  aiCalls: number;
}

function safeDetail(err: unknown): string {
  const msg = err instanceof Error ? err.message : 'unexpected error';
  return `Unexpected error: ${msg}`.replace(/\s+/g, ' ').slice(0, 240);
}

interface AttemptInput {
  source: FactsheetSource;
  instrumentId: string;
  outcome: AttemptOutcome;
  detail: string | null;
  httpStatus: number | null;
  bytes: number | null;
  checksum: string | null;
  documentDate: string | null;
  versionId: string | null;
  reviewRequired: boolean;
}

async function writeAttempt(deps: RunnerDeps, runId: string, runMonth: string, counter: { ledgerRowsWritten: number }, a: AttemptInput): Promise<void> {
  const row: AttemptRow = {
    runId,
    runMonth,
    sourceId: a.source.id,
    instrumentId: a.instrumentId,
    attemptedAt: deps.nowIso,
    outcome: a.outcome,
    detail: a.detail ? a.detail.slice(0, 500) : null,
    httpStatus: a.httpStatus,
    bytes: a.bytes,
    documentChecksum: a.checksum,
    documentDate: a.documentDate,
    versionId: a.versionId,
    reviewRequired: a.reviewRequired,
  };
  await deps.store.recordAttempt(row);
  counter.ledgerRowsWritten += 1;
}

async function processSource(ctx: Ctx, source: FactsheetSource, pending: HeldInstrumentLite[], rep: SourceReport): Promise<void> {
  const { deps } = ctx;
  const url = resolveSourceUrl(source, ctx.runMonth);
  const gate = gateSourceFetch(source, url); // defence in depth: re-checked immediately before the request
  if (!gate.allowed) throw new Error(`gate refused: ${gate.reason}`);

  const ids = pending.map((p) => p.instrumentId);
  const prevMap = await deps.store.latestVersions(ids);
  const canConditional = Boolean(source.lastEtag || source.lastModified) && pending.every((p) => prevMap.get(p.instrumentId)?.sourceId === source.id);

  const tally = (o: AttemptOutcome) => {
    rep.outcomes[o] = (rep.outcomes[o] ?? 0) + 1;
  };
  const allInstruments = async (outcome: AttemptOutcome, detail: string, httpStatus: number | null = null, bytes: number | null = null) => {
    for (const p of pending) {
      await writeAttempt(deps, ctx.runId, ctx.runMonth, ctx.base, { source, instrumentId: p.instrumentId, outcome, detail, httpStatus, bytes, checksum: null, documentDate: null, versionId: null, reviewRequired: false });
      tally(outcome);
    }
  };

  const fetched = await deps.fetcher.fetchDocument(url, { etag: canConditional ? source.lastEtag : null, lastModified: canConditional ? source.lastModified : null, expectPdf: isPdfUrl(url) });
  rep.detail = fetched.kind === 'ok' ? null : 'detail' in fetched ? fetched.detail : fetched.kind;

  switch (fetched.kind) {
    case 'too_large':
      return allInstruments('document_too_large', `Document too large (limit ${Math.round(ctx.cfg.maxDocumentBytes / 1024 / 1024)} MB${fetched.contentLength ? `; the server reported ${Math.round(fetched.contentLength / 1024 / 1024)} MB` : ''}). It was skipped, not truncated.`, null, fetched.contentLength);
    case 'blocked':
      return allInstruments('source_blocked', fetched.detail, fetched.status);
    case 'robots_disallowed':
      return allInstruments('refused_robots', fetched.detail);
    case 'refused':
      return allInstruments('refused_robots', fetched.detail);
    case 'failed':
      return allInstruments('fetch_failed', fetched.detail, fetched.status);
    case 'not_modified': {
      for (const p of pending) await observeOne(ctx, source, p, prevMap.get(p.instrumentId) ?? null, { kind: 'unchanged', checksum: source.lastChecksum ?? '' }, tally);
      await deps.store.touchSource(source.id, { etag: source.lastEtag, lastModified: source.lastModified, checksum: source.lastChecksum, fetchedAt: deps.nowIso });
      return;
    }
    case 'ok': {
      const checksum = sha256Hex(fetched.bytes);
      const read = deps.readDocument ?? ((b: Uint8Array, ct: string | null) => documentTextFromBytes(b, ct, { maxPages: ctx.cfg.maxPdfPages, timeoutMs: ctx.cfg.pdfTimeoutMs }));
      const text = await read(fetched.bytes, fetched.contentType);
      if (!text.ok) {
        for (const p of pending) {
          await writeAttempt(deps, ctx.runId, ctx.runMonth, ctx.base, { source, instrumentId: p.instrumentId, outcome: 'text_extraction_failed', detail: text.message, httpStatus: fetched.status, bytes: fetched.bytes.length, checksum, documentDate: null, versionId: null, reviewRequired: false });
          tally('text_extraction_failed');
        }
        await deps.store.touchSource(source.id, { etag: fetched.etag, lastModified: fetched.lastModified, checksum, fetchedAt: deps.nowIso });
        return;
      }
      const pattern = extractWithPatterns({ text: text.text, schemeName: source.documentSchemeName, scope: source.documentScope });
      let ai: AiOutcome | null = null;
      if (pattern.status !== 'found' && pattern.schemeNamePresent && ctx.aiOn && deps.ai && ctx.aiCalls < ctx.cfg.maxAiCallsPerRun) {
        ctx.aiCalls += 1;
        ai = await runAiExtraction(deps.ai, { documentText: text.text, schemeName: source.documentSchemeName, scope: source.documentScope });
      }
      for (const p of pending) {
        await observeOne(ctx, source, p, prevMap.get(p.instrumentId) ?? null, { kind: 'read', checksum, pattern, ai, httpStatus: fetched.status, bytes: fetched.bytes.length }, tally);
      }
      await deps.store.touchSource(source.id, { etag: fetched.etag, lastModified: fetched.lastModified, checksum, fetchedAt: deps.nowIso });
      return;
    }
  }
}

type Observation =
  | { kind: 'read'; checksum: string; pattern: PatternOutcome; ai: AiOutcome | null; httpStatus: number; bytes: number }
  | { kind: 'unchanged'; checksum: string };

/** A 304 means "the same document again": rebuild what was read last time from the version on record (never re-trust an AI-only reading). */
function rebuildFromPrevious(prev: StoredVersion): PatternOutcome {
  const extraction: DeclaredExtraction = {
    schemeNamePresent: true,
    tier1: { raw: prev.tier1Name, variantHint: prev.tier1VariantHint },
    additional: prev.additionalNames.map((raw) => ({ raw, variantHint: null })),
    effectiveFromStated: prev.effectiveFromBasis === 'document_stated' ? { iso: prev.effectiveFrom, precision: 'day' } : null,
    documentDate: prev.documentDate ? { iso: prev.documentDate, precision: prev.documentDatePrecision ?? 'day' } : null,
    excerpt: prev.evidenceExcerpt,
  };
  return { status: 'found', extraction };
}

async function observeOne(ctx: Ctx, source: FactsheetSource, instrument: HeldInstrumentLite, prev: StoredVersion | null, obs: Observation, tally: (o: AttemptOutcome) => void): Promise<void> {
  const { deps } = ctx;
  const attempt = (outcome: AttemptOutcome, detail: string, extra: Partial<AttemptInput> = {}) =>
    writeAttempt(deps, ctx.runId, ctx.runMonth, ctx.base, { source, instrumentId: instrument.instrumentId, outcome, detail, httpStatus: null, bytes: null, checksum: obs.checksum || null, documentDate: null, versionId: null, reviewRequired: false, ...extra });
  try {
    if (obs.kind === 'unchanged' && !prev) {
      await attempt('fetch_failed', 'The document is unchanged but no earlier reading exists to confirm; it will be read in full next run.');
      tally('fetch_failed');
      return;
    }
    const mappings = (await deps.store.primaryMappings([instrument.instrumentId])).get(instrument.instrumentId) ?? [];
    const decision: ObservationDecision = decideObservation({
      instrumentId: instrument.instrumentId,
      source,
      sourceTitle: null,
      retrievedAt: deps.nowIso,
      documentChecksum: obs.checksum,
      pattern: obs.kind === 'read' ? obs.pattern : rebuildFromPrevious(prev as StoredVersion),
      ai: obs.kind === 'read' ? obs.ai : null,
      aiModel: obs.kind === 'read' && obs.ai && obs.ai.status === 'found' ? obs.ai.model : null,
      catalogue: ctx.catalogue,
      previous: prev,
      existingMappings: mappings,
      rebuiltFromPrevious: obs.kind === 'unchanged',
    });
    const http = obs.kind === 'read' ? { httpStatus: obs.httpStatus, bytes: obs.bytes } : { httpStatus: 304, bytes: null };

    if (decision.action === 'no_record') {
      await attempt(decision.outcome, decision.detail, http);
      tally(decision.outcome);
      return;
    }

    if (decision.action === 'new_version') {
      const versionId = await deps.store.recordVersion(decision.version, decision.version.supersedesVersionId);
      let detail = decision.detail;
      if (decision.proposal) {
        try {
          const proposalId = await deps.store.createProposal(decision.proposal.payload);
          await deps.store.recordEvent({ versionId, eventType: 'proposal_created', proposalId, mappingId: null, note: null });
        } catch (err) {
          detail += ` (A mapping proposal could not be created: ${safeDetail(err)}; the reviewer can enter it manually.)`;
        }
      }
      await attempt(decision.outcome, detail, { ...http, versionId, documentDate: decision.version.documentDate, reviewRequired: decision.reviewRequired });
      tally(decision.outcome);
      return;
    }

    // confirm
    let outcome: AttemptOutcome = 'confirmed_unchanged';
    let detail = decision.detail;
    let reviewRequired = false;
    if (decision.autoPublish) {
      try {
        const proposalId = await deps.store.createProposal(decision.autoPublish.payload);
        await deps.store.recordEvent({ versionId: decision.previousVersionId, eventType: 'proposal_created', proposalId, mappingId: null, note: null });
        const r = await deps.store.autoPublish(proposalId);
        if (r.autoPublished) {
          await deps.store.recordEvent({ versionId: decision.previousVersionId, eventType: 'auto_published', proposalId, mappingId: r.mappingId, note: null });
          outcome = 'auto_published';
          detail = 'Confirmed for a second month and published automatically (single verified series, high-confidence name match, complete evidence).';
        } else {
          await deps.store.recordEvent({ versionId: decision.previousVersionId, eventType: 'auto_publish_refused', proposalId, mappingId: null, note: (r.reason ?? 'routed to admin review').slice(0, 400) });
          detail = `Confirmed unchanged; the database routed it to admin review: ${r.reason ?? 'no reason given'}`;
          reviewRequired = true;
        }
      } catch (err) {
        detail = `Confirmed unchanged; automatic publication did not complete: ${safeDetail(err)}`;
        reviewRequired = true;
      }
    } else if (decision.routeToReview && prev && !prev.events.includes('auto_publish_refused')) {
      await deps.store.recordEvent({ versionId: decision.previousVersionId, eventType: 'auto_publish_refused', proposalId: null, mappingId: null, note: decision.routeToReview.slice(0, 400) });
      reviewRequired = true;
    }
    await attempt(outcome, detail, { ...http, versionId: decision.previousVersionId, documentDate: prev?.documentDate ?? null, reviewRequired });
    tally(outcome);
  } catch (err) {
    // Per-scheme isolation: this scheme's failure is its own 'error' row; the next scheme is processed regardless.
    await attempt('error', safeDetail(err)).catch(() => undefined);
    tally('error');
  }
}

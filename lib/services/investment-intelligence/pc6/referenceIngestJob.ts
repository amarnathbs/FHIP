// PC6 (M6) — the scheduled reference-ingest job (N.15).
//
// The whole job in one function, built out of the pure pieces in
// referenceImportRunner.ts. The HTTP route is a thin wrapper around this so
// the job can also be invoked from a script or a test without a server.
//
// BINDING OVERRIDE. This job is built and proven in DEV ONLY. Migration 0155
// deliberately registers no pg_cron schedule, and both job-control rows ship
// with enabled = false, so even a correctly-authenticated call returns
// `skipped_kill_switch` until a human turns it on. Activating the production
// schedule is a deferred human-present step, written up in
// docs/investment-intelligence/PC6_OPERATOR_RUNBOOK.md.
//
// TIME-BUDGETED AND RESUMABLE (2026-09-25). Production runs on AWS Amplify
// compute, which kills every request at 28 s. The first scheduled daily tick
// (25 Sep 03:30 UTC) and a manual server run (04:01) both died there, leaving
// the batch 'running' with 0 rows; the same job run from a workstation took
// 1,212 s. Two changes, together:
//   1. The "which rows already exist?" read now asks for EXACT (instrument,
//      date) pairs through migration 0204's function (exactPairLookup.ts)
//      instead of every instrument x every one of the file's 831 NAV dates.
//   2. Each invocation fetches, parses, resolves and looks up, then writes
//      until its wall-clock budget (default 18 s from invocation start,
//      ingestBudget.ts) is used, and closes ITS batch honestly:
//        * nothing left                 -> 'succeeded' (advances last_success_at)
//        * work left, progress made     -> result 'partial'; the batch row is
//          'failed' with error_code PARTIAL_BATCH_CONTINUING and the remaining
//          counts in notes. The failure streak and backoff are NOT touched
//          (the next tick must be allowed to continue) and last_success_at is
//          NOT advanced.
//        * work left, no progress at all -> 'failed', error_code
//          BUDGET_EXHAUSTED_NO_PROGRESS, normal failure bookkeeping.
//      Migration 0205 re-invokes the job every 2 minutes through a morning
//      window; every write is idempotent, so each call re-plans against the
//      database and continues where the last one stopped.
//   A call that finds the source byte-identical to the last complete run
//   (and no instrument added since) returns 'skipped_unchanged_source'
//   without opening a batch or touching job control -- so the rest of the
//   window's ticks cost a fetch and a handful of small reads.

import { createAdminClient } from '@/lib/supabase/admin';
import { parseNavAll, parseNavHistory, fingerprintBytes, type AmfiParseResult } from './amfiParser';
import {
  classifyFetch,
  decideStart,
  nextAttemptAfter,
  planImport,
  settleBatch,
  buildAlerts,
  reconcileStaleRunningBatches,
  MIN_PLAUSIBLE_FULL_UNIVERSE_BYTES,
  PC6_RUNNER_VERSION,
  type Alert,
  type ChunkOutcome,
  type FetchOutcome,
  type InstrumentResolutionIndex,
  type JobControlRow,
} from './referenceImportRunner';
import type { ExistingObservation } from './referenceDataQuality';
import { buildUrl, getReferenceSource } from '@/lib/config/investment-intelligence/pc6ReferenceSources';
import { writeSchemeMasterRows } from './schemeMasterWriter';
import { fetchAllRows } from '../pagination';
import { createWriteBudget, resolveBudgetMs, type WriteBudget } from './ingestBudget';
import { ExistingStateLookupError, loadExistingObservations, type NavPair } from './exactPairLookup';

/** How long a 'running' batch may sit with no terminal status before a later invocation treats it as abandoned rather than still in flight. */
export const STALE_RUNNING_BATCH_MINUTES = 15;

/** error_code of a batch that stopped at its time budget with work left; the next invocation continues it. */
export const PARTIAL_CONTINUING_ERROR_CODE = 'PARTIAL_BATCH_CONTINUING';
/** error_code of a batch whose budget ran out before a single write unit could start. */
export const BUDGET_NO_PROGRESS_ERROR_CODE = 'BUDGET_EXHAUSTED_NO_PROGRESS';

export interface IngestJobArgs {
  jobKey: string;
  /** A key in PC6_REFERENCE_SOURCES. */
  sourceConfigId: string;
  /** ISO yyyy-mm-dd. Required — never defaulted to the machine clock. */
  asOfDate: string;
  /** For backfill windows (N.4). */
  fromDate?: string;
  toDate?: string;
  /** Rows per committed chunk. Keeps a failure's blast radius bounded. */
  chunkSize?: number;
  /** When true, plan and report but write nothing. */
  dryRun?: boolean;
  /**
   * Wall-clock budget in ms from `startedAtMs` (default 18 s, or the
   * PC6_INGEST_BUDGET_MS environment variable). `Infinity` = unbounded, for
   * hand-run scripts only; never from the HTTP route.
   */
  budgetMs?: number;
  /** When the invocation began (epoch ms). The route passes the moment the request arrived. */
  startedAtMs?: number;
  /** Clock seam for tests. Defaults to Date.now. */
  now?: () => number;
  /**
   * Seam for tests and DEV harnesses ONLY: replaces the exact-pair lookup
   * (exactPairLookup.ts) with a caller-supplied one. Production never sets it.
   */
  existingLookup?: (pairs: NavPair[]) => Promise<Map<string, ExistingObservation>>;
}

export interface IngestJobResult {
  jobKey: string;
  status:
    | 'succeeded'
    | 'partial'
    | 'failed'
    | 'rolled_back'
    | 'skipped_kill_switch'
    | 'skipped_backoff'
    | 'skipped_source_outage'
    | 'skipped_already_running'
    | 'skipped_unchanged_source';
  batchId: string | null;
  detail: string;
  runnerVersion: string;
  counts: {
    sourceBytes: number;
    parsedAccepted: number;
    parsedRejected: number;
    resolved: number;
    unresolved: number;
    inserted: number;
    unchanged: number;
    superseded: number;
    /** Planned inserts not attempted in this invocation (budget). */
    remainingInserts: number;
    /** Planned corrections not attempted in this invocation (budget). */
    remainingCorrections: number;
  };
  sourceSha256: string | null;
  alerts: Alert[];
  /** Where the time went, in ms from invocation start; `steps` records when each phase ENDED. */
  timings: { readPhaseMs: number | null; totalMs: number; budgetMs: number; steps: Record<string, number> };
}

const EMPTY_COUNTS: IngestJobResult['counts'] = {
  sourceBytes: 0, parsedAccepted: 0, parsedRejected: 0, resolved: 0,
  unresolved: 0, inserted: 0, unchanged: 0, superseded: 0,
  remainingInserts: 0, remainingCorrections: 0,
};

/**
 * Pure decision: may this invocation skip because the source is byte-for-byte
 * what the last COMPLETE run already applied?
 *
 * Only a 'succeeded', non-dry-run batch for the same source config and window
 * counts (a 'partial' batch is 'failed' in the ledger, so a continuing run can
 * never skip itself). The prior run must have been at least as late an
 * as-of date (a later as-of admits more records past the future-date guard),
 * and no instrument or AMFI-code identifier may have been created or updated
 * since it started -- a newly resolvable scheme is new work even on an
 * unchanged file.
 */
export function decideUnchangedSourceSkip(input: {
  sha256: string;
  asOfDate: string;
  lastSucceeded: { id: string; source_sha256: string | null; as_of_date: string; started_at: string } | null;
  newestUniverseChangeAt: string | null;
}): { skip: boolean; detail: string } {
  const last = input.lastSucceeded;
  if (!last) return { skip: false, detail: 'No previous complete run for this source.' };
  if (last.source_sha256 !== input.sha256) return { skip: false, detail: 'The source differs from the last complete run.' };
  if (last.as_of_date < input.asOfDate) return { skip: false, detail: `The last complete run was as of ${last.as_of_date}, before ${input.asOfDate}.` };
  if (input.newestUniverseChangeAt && Date.parse(input.newestUniverseChangeAt) >= Date.parse(last.started_at)) {
    return { skip: false, detail: 'An instrument or identifier changed after the last complete run started.' };
  }
  return {
    skip: true,
    detail: `Source unchanged since complete batch ${last.id} (sha256 ${input.sha256.slice(0, 12)}, as of ${last.as_of_date}); nothing to do. No batch opened, job control untouched.`,
  };
}

function laterOf(...isos: (string | null | undefined)[]): string | null {
  let best: string | null = null;
  for (const v of isos) if (v && (best === null || Date.parse(v) > Date.parse(best))) best = v;
  return best;
}

export async function runReferenceIngest(args: IngestJobArgs): Promise<IngestJobResult> {
  const clock = args.now ?? Date.now;
  const startedAtMs = args.startedAtMs ?? clock();
  const budgetMs = resolveBudgetMs(args.budgetMs);
  const budget: WriteBudget = createWriteBudget({ startedAtMs, budgetMs, clock });
  let readPhaseMs: number | null = null;
  const steps: Record<string, number> = {};
  const mark = (step: string) => {
    steps[step] = clock() - startedAtMs;
  };
  const timings = () => ({ readPhaseMs, totalMs: clock() - startedAtMs, budgetMs, steps: { ...steps } });

  const db = createAdminClient();
  const nowIso = new Date().toISOString();
  const source = getReferenceSource(args.sourceConfigId);
  const chunkSize = args.chunkSize ?? 500;

  const base = { jobKey: args.jobKey, batchId: null as string | null, runnerVersion: PC6_RUNNER_VERSION, counts: { ...EMPTY_COUNTS }, sourceSha256: null as string | null, alerts: [] as Alert[] };

  // --- 1. Kill switch and backoff, BEFORE anything else --------------------
  const { data: controlRow } = await db
    .from('ii_reference_job_control')
    .select('job_key, enabled, disabled_reason, consecutive_failures, next_attempt_not_before, last_success_at')
    .eq('job_key', args.jobKey)
    .maybeSingle();

  const control: JobControlRow | null = controlRow
    ? {
        jobKey: controlRow.job_key,
        enabled: controlRow.enabled,
        disabledReason: controlRow.disabled_reason,
        consecutiveFailures: controlRow.consecutive_failures,
        nextAttemptNotBefore: controlRow.next_attempt_not_before,
        lastSuccessAt: controlRow.last_success_at,
      }
    : null;
  mark('control');

  const start = decideStart(control, args.jobKey, nowIso);
  if (!start.start) {
    return { ...base, status: start.status, detail: start.detail, timings: timings() };
  }

  // --- 1b. Stuck-batch reconciliation (found live in DEV, 2026-09-21: two
  // 'running' rows for this exact job_key, 35 seconds apart, neither ever
  // reaching a terminal status). Reconcile any abandoned run BEFORE opening
  // a new one, and refuse to overlap with one that is still genuinely
  // in flight.
  const { data: runningRows } = await db
    .from('ii_reference_import_batches')
    .select('id, started_at')
    .eq('source_key', source.sourceKey)
    .eq('batch_kind', source.kind)
    .eq('status', 'running');
  const reconciliation = reconcileStaleRunningBatches(
    (runningRows ?? []).map((r) => ({ id: r.id, started_at: r.started_at })),
    nowIso,
    STALE_RUNNING_BATCH_MINUTES
  );
  if (reconciliation.reconciledIds.length > 0) {
    await db
      .from('ii_reference_import_batches')
      .update({
        status: 'failed',
        finished_at: nowIso,
        error_code: 'STALE_RUNNING_RECONCILED',
        error_detail: `Reconciled by a later invocation after exceeding ${STALE_RUNNING_BATCH_MINUTES} minute(s) with no terminal status -- most likely an interrupted process (e.g. a function execution-time limit) rather than a real success or failure.`,
      })
      .in('id', reconciliation.reconciledIds);
  }
  mark('reconcile');
  if (reconciliation.stillRunning) {
    return { ...base, status: 'skipped_already_running', detail: reconciliation.detail, timings: timings() };
  }

  // --- Instrument-resolution reads (used at step 5). Started as soon as the
  // run is known NOT to be a no-op (step 2b), so they overlap opening the
  // batch, parsing and persisting rejections instead of following them; a
  // no-op tick never issues them. Settled into a value, so a failure is
  // handled at step 5 and never becomes an unhandled rejection.
  //
  // fetchAllRows(): a plain, unbounded select silently caps at PostgREST's
  // db-max-rows (1000) -- the exact same defect class R4/R5 already found
  // and built this helper for. Found here the same way: the full AMFI
  // universe now has 14,358 resolvable instruments, and an unpaged select
  // only ever resolved the first ~1,000-2,000 of them, silently leaving
  // most of a genuinely-complete instrument universe unresolved.
  const startResolutionReads = (): Promise<
    | { ok: true; idRows: { identifier_value: string; instrument_id: string }[]; instRows: { id: string; isin: string | null }[] }
    | { ok: false; detail: string }
  > => Promise.all([
    fetchAllRows<{ identifier_value: string; instrument_id: string }>(() =>
      db
        .from('ii_instrument_identifiers')
        .select('identifier_value, instrument_id')
        .eq('identifier_scheme', 'amfi_scheme_code')
        .eq('country_code', source.countryCode)
        .eq('is_active', true)
        .order('id')
    ),
    fetchAllRows<{ id: string; isin: string | null }>(() =>
      db.from('ii_instruments').select('id, isin').eq('instrument_class', 'mutual_fund').not('isin', 'is', null).order('id')
    ),
  ]).then(
    ([idRows, instRows]) => ({ ok: true as const, idRows, instRows }),
    (e) => ({ ok: false as const, detail: e instanceof Error ? e.message : String(e) })
  );

  // --- 2. Fetch, with outage classification --------------------------------
  // (Before the batch row is opened, so a no-op tick can return without
  // writing anything; an outage still opens and closes a batch, as before.)
  const url = buildUrl(args.sourceConfigId, { fromDate: args.fromDate, toDate: args.toDate });
  const retrievedAt = new Date().toISOString();
  let bytes: Uint8Array | null = null;
  let httpStatus: number | null = null;
  let networkError: string | undefined;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'FHIP-PC6/1.0' } });
    httpStatus = r.status;
    bytes = new Uint8Array(await r.arrayBuffer());
  } catch (e) {
    networkError = e instanceof Error ? e.message : String(e);
  }
  const fetched: FetchOutcome = classifyFetch(httpStatus, bytes, MIN_PLAUSIBLE_FULL_UNIVERSE_BYTES, retrievedAt, networkError);
  mark('fetch');

  // --- 2b. Nothing new? -----------------------------------------------------
  if (fetched.ok && !args.dryRun) {
    const sha = fingerprintBytes(fetched.bytes).sha256;
    let lastQuery = db
      .from('ii_reference_import_batches')
      .select('id, source_sha256, as_of_date, started_at')
      .eq('source_config_id', args.sourceConfigId)
      .eq('batch_kind', source.kind)
      .eq('status', 'succeeded')
      .is('notes->>dry_run', null);
    lastQuery = args.fromDate ? lastQuery.eq('window_from', args.fromDate) : lastQuery.is('window_from', null);
    lastQuery = args.toDate ? lastQuery.eq('window_to', args.toDate) : lastQuery.is('window_to', null);
    const [lastRes, idRes, instCreatedRes, instUpdatedRes] = await Promise.all([
      lastQuery.order('started_at', { ascending: false }).limit(1).maybeSingle(),
      db.from('ii_instrument_identifiers').select('created_at').eq('identifier_scheme', 'amfi_scheme_code').eq('country_code', source.countryCode)
        .not('created_at', 'is', null).order('created_at', { ascending: false }).limit(1).maybeSingle(),
      db.from('ii_instruments').select('created_at').eq('instrument_class', 'mutual_fund')
        .not('created_at', 'is', null).order('created_at', { ascending: false }).limit(1).maybeSingle(),
      db.from('ii_instruments').select('updated_at').eq('instrument_class', 'mutual_fund')
        .not('updated_at', 'is', null).order('updated_at', { ascending: false }).limit(1).maybeSingle(),
    ]);
    mark('unchangedCheck');
    // Any read error means "not provably unchanged": fall through and do the work.
    if (!lastRes.error && !idRes.error && !instCreatedRes.error && !instUpdatedRes.error) {
      const decision = decideUnchangedSourceSkip({
        sha256: sha,
        asOfDate: args.asOfDate,
        lastSucceeded: lastRes.data ?? null,
        newestUniverseChangeAt: laterOf(idRes.data?.created_at, instCreatedRes.data?.created_at, instUpdatedRes.data?.updated_at),
      });
      if (decision.skip) {
        return {
          ...base,
          status: 'skipped_unchanged_source',
          detail: decision.detail,
          counts: { ...EMPTY_COUNTS, sourceBytes: fetched.bytes.byteLength },
          sourceSha256: sha,
          timings: timings(),
        };
      }
    }
  }

  const resolutionReads = startResolutionReads();

  // --- 3. Open the batch ledger row ----------------------------------------
  const { data: batch, error: batchErr } = await db
    .from('ii_reference_import_batches')
    .insert({
      source_key: source.sourceKey,
      source_config_id: args.sourceConfigId,
      batch_kind: source.kind,
      window_from: args.fromDate ?? null,
      window_to: args.toDate ?? null,
      as_of_date: args.asOfDate,
      source_url: url,
      status: 'running',
      attempt: (control?.consecutiveFailures ?? 0) + 1,
    })
    .select('id')
    .single();
  if (batchErr || !batch) {
    return { ...base, status: 'failed', detail: `Could not open a batch ledger row: ${batchErr?.message ?? 'unknown'}`, timings: timings() };
  }
  const batchId = batch.id as string;
  mark('batchOpen');

  const finish = async (
    status: IngestJobResult['status'],
    detail: string,
    counts: IngestJobResult['counts'],
    sha: string | null,
    alerts: Alert[],
    extra: Record<string, unknown> = {}
  ): Promise<IngestJobResult> => {
    const t = timings();
    const extraNotes = (extra.notes as Record<string, unknown> | undefined) ?? {};
    await db.from('ii_reference_import_batches').update({
      // 'partial' is not a ledger status: it is recorded as 'failed' with
      // error_code PARTIAL_BATCH_CONTINUING (the table's existing CHECK
      // domain, unchanged), which keeps it off every "last success" surface.
      status: status === 'skipped_backoff' || status === 'partial' ? 'failed' : status,
      finished_at: new Date().toISOString(),
      rows_read: counts.parsedAccepted + counts.parsedRejected,
      rows_accepted: counts.parsedAccepted,
      rows_rejected: counts.parsedRejected,
      rows_inserted: counts.inserted,
      rows_unchanged: counts.unchanged,
      rows_superseded: counts.superseded,
      source_sha256: sha,
      source_byte_length: counts.sourceBytes || null,
      ...extra,
      notes: { ...extraNotes, timings_ms: t, remaining: { inserts: counts.remainingInserts, corrections: counts.remainingCorrections } },
    }).eq('id', batchId);

    // Job-control bookkeeping: success clears the failure streak, failure
    // extends the bounded backoff. A PARTIAL run is neither: it must not
    // advance last_success_at (the day is not complete) and must not start a
    // backoff (the next tick has to be allowed to continue the work).
    if (status === 'succeeded') {
      await db.from('ii_reference_job_control').update({
        last_success_at: new Date().toISOString(),
        last_success_batch_id: batchId,
        consecutive_failures: 0,
        next_attempt_not_before: null,
        updated_at: new Date().toISOString(),
      }).eq('job_key', args.jobKey);
    } else if (status !== 'partial') {
      const failures = (control?.consecutiveFailures ?? 0) + 1;
      await db.from('ii_reference_job_control').update({
        last_failure_at: new Date().toISOString(),
        consecutive_failures: failures,
        next_attempt_not_before: nextAttemptAfter(new Date().toISOString(), failures),
        updated_at: new Date().toISOString(),
      }).eq('job_key', args.jobKey);
    }

    return { ...base, batchId, status, detail, counts, sourceSha256: sha, alerts, timings: timings() };
  };

  if (!fetched.ok) {
    const alerts = buildAlerts({ jobKey: args.jobKey, settlement: null, fetchOutcome: fetched, consecutiveFailures: control?.consecutiveFailures ?? 0, parsedAccepted: 0, parsedRejected: 0, unresolvedCount: 0 });
    return finish('skipped_source_outage', fetched.detail, { ...EMPTY_COUNTS }, null, alerts, {
      error_code: `SOURCE_${fetched.kind.toUpperCase()}`,
      error_detail: fetched.detail,
      source_retrieved_at: retrievedAt,
    });
  }

  // --- 4. Parse ------------------------------------------------------------
  let parsed: AmfiParseResult;
  try {
    parsed = source.format === 'amfi_navhistory_txt'
      ? parseNavHistory(fetched.bytes, { asOfDate: args.asOfDate, retrievedAt })
      : parseNavAll(fetched.bytes, { asOfDate: args.asOfDate, retrievedAt });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return finish('failed', `Parse failed: ${detail}`, { ...EMPTY_COUNTS, sourceBytes: fetched.bytes.byteLength }, null, [], {
      error_code: 'PARSE_FAILED', error_detail: detail, source_retrieved_at: retrievedAt,
    });
  }

  await db.from('ii_reference_import_batches').update({
    parser_version: parsed.parserVersion,
    source_retrieved_at: retrievedAt,
    source_sha256: parsed.fingerprint.sha256,
    source_byte_length: parsed.fingerprint.byteLength,
  }).eq('id', batchId);

  // Every rejection is persisted, not merely counted (N.4).
  if (parsed.rejections.length > 0) {
    const rows = parsed.rejections.slice(0, 5000).map((r) => ({
      batch_id: batchId, source_line: r.sourceLine, reason: r.reason, detail: r.detail, raw_excerpt: r.rawExcerpt,
    }));
    for (let i = 0; i < rows.length; i += chunkSize) {
      await db.from('ii_reference_import_rejections').insert(rows.slice(i, i + chunkSize));
    }
  }

  const readCounts: IngestJobResult['counts'] = { ...EMPTY_COUNTS, sourceBytes: parsed.fingerprint.byteLength, parsedAccepted: parsed.counts.accepted, parsedRejected: parsed.counts.rejected };
  mark('parseAndRejections');

  // --- 5. Resolve and plan --------------------------------------------------
  // (The two resolution reads were started right after step 2b.)
  const resolved = await resolutionReads;
  mark('resolution');
  if (!resolved.ok) {
    return finish('failed', `Instrument resolution read failed: ${resolved.detail}`, readCounts, parsed.fingerprint.sha256, [], {
      error_code: 'RESOLUTION_READ_FAILED', error_detail: resolved.detail,
    });
  }
  const { idRows, instRows } = resolved;

  const index: InstrumentResolutionIndex = {
    byAmfiCode: new Map(idRows.map((r) => [r.identifier_value, r.instrument_id])),
    byIsin: new Map(instRows.filter((r) => r.isin).map((r) => [r.isin as string, r.id])),
  };

  // Scheme identity (a dimension table) and NAV price (a time series) have
  // genuinely different write shapes -- dispatched separately here rather
  // than forced through the NAV-shaped plan/write path below, which this
  // source kind was never actually compatible with (see schemeMasterWriter.ts
  // header for the real incident this fixes).
  if (source.kind === 'scheme_master') {
    readPhaseMs = clock() - startedAtMs;
    const schemeWrite = args.dryRun
      ? { counts: { resolved: 0, unresolved: 0, inserted: 0, unchanged: 0, superseded: 0 }, errors: [] as string[], remaining: 0 }
      : await writeSchemeMasterRows(
          db,
          parsed.records,
          index,
          { countryCode: source.countryCode, currencyCode: source.currencyCode, sourceId: null, importBatchId: batchId, asOfDate: args.asOfDate },
          chunkSize,
          budget
        );
    mark('schemeMasterLookupAndWrites');
    // A dry run still needs an honest resolved/unresolved count without
    // actually writing -- computed the same way writeSchemeMasterRows()
    // would resolve, just without the DB round trip for current rows.
    const dryResolved = args.dryRun
      ? [...new Set(parsed.records.map((r) => r.amfiSchemeCode))].filter((code) => {
          const r = parsed.records.find((x) => x.amfiSchemeCode === code)!;
          return index.byAmfiCode.has(code) || (r.isinGrowthOrPayout ? index.byIsin.has(r.isinGrowthOrPayout) : false);
        }).length
      : schemeWrite.counts.resolved;
    const schemeCounts: IngestJobResult['counts'] = {
      ...readCounts,
      resolved: dryResolved,
      unresolved: new Set(parsed.records.map((r) => r.amfiSchemeCode)).size - dryResolved,
      inserted: schemeWrite.counts.inserted,
      unchanged: schemeWrite.counts.unchanged,
      superseded: schemeWrite.counts.superseded,
      remainingInserts: schemeWrite.remaining,
    };
    if (args.dryRun) {
      return finish('succeeded', `Dry run: ${dryResolved} scheme(s) resolved to an existing instrument. Nothing written.`, schemeCounts, parsed.fingerprint.sha256, [], { notes: { dry_run: true } });
    }
    if (schemeWrite.errors.length > 0) {
      return finish('failed', `Scheme-master write failed: ${schemeWrite.errors[0]}`, schemeCounts, parsed.fingerprint.sha256, [], { error_code: 'SCHEME_MASTER_WRITE_FAILED', error_detail: schemeWrite.errors.join('; ') });
    }
    if (schemeWrite.remaining > 0) {
      return settleIncomplete(schemeCounts, budget.unitsDone(), `${schemeWrite.remaining} scheme-master change(s)`);
    }
    return finish(
      'succeeded',
      `${schemeCounts.inserted} scheme-master row(s) written (${schemeCounts.superseded} superseding a prior identity), ${schemeCounts.unchanged} unchanged.`,
      schemeCounts,
      parsed.fingerprint.sha256,
      []
    );
  }

  // Existing state for EXACTLY the (instrument, date) pairs this run could
  // touch, so idempotency is decided against the database rather than
  // assumed. See exactPairLookup.ts for why this is no longer
  // "instrument IN (...) AND date IN (every date in the file)".
  const pairs: NavPair[] = [];
  for (const r of parsed.records) {
    const instrumentId = index.byAmfiCode.get(r.amfiSchemeCode) ?? (r.isinGrowthOrPayout ? index.byIsin.get(r.isinGrowthOrPayout) : undefined);
    if (instrumentId) pairs.push({ instrumentId, priceDate: r.navDate });
  }
  let existing: Map<string, ExistingObservation>;
  try {
    existing = args.existingLookup ? await args.existingLookup(pairs) : await loadExistingObservations(db, pairs);
  } catch (e) {
    const code = e instanceof ExistingStateLookupError ? e.code : 'EXISTING_STATE_LOOKUP_FAILED';
    const detail = e instanceof Error ? e.message : String(e);
    return finish('failed', detail, readCounts, parsed.fingerprint.sha256, [], { error_code: code, error_detail: detail });
  }
  readPhaseMs = clock() - startedAtMs;
  mark('existingLookup');

  const plan = planImport({ parsed, index, existing, currencyCode: source.currencyCode });

  const counts: IngestJobResult['counts'] = {
    ...readCounts,
    resolved: plan.counts.resolved,
    unresolved: plan.counts.unresolved,
    inserted: 0,
    unchanged: plan.counts.unchanged,
    superseded: 0,
  };

  if (args.dryRun) {
    return finish('succeeded', `Dry run: ${plan.counts.toInsert} insert(s), ${plan.counts.unchanged} unchanged, ${plan.counts.toSupersede} correction(s) planned. Nothing written.`, counts, parsed.fingerprint.sha256, [], { notes: { dry_run: true, planned: plan.counts } });
  }

  // --- 6. Write, in bounded chunks, inside the budget ----------------------
  const inserts = plan.writes.filter((w) => w.action === 'insert');
  const supersedes = plan.writes.filter((w) => w.action === 'supersede');
  const chunks: ChunkOutcome[] = [];
  const dataVersion = `${parsed.parserVersion}:${parsed.fingerprint.sha256.slice(0, 12)}`;

  let insertsAttempted = 0;
  for (let i = 0; i < inserts.length; i += chunkSize) {
    if (!budget.canStart('insert_chunk')) break;
    const slice = inserts.slice(i, i + chunkSize);
    insertsAttempted = i + slice.length;
    // ignoreDuplicates: defense in depth alongside the existing-state check
    // above -- with the full AMFI universe resolved, a row this plan
    // believes is new but that in fact already exists (however that
    // divergence arises) now skips silently instead of failing the WHOLE
    // chunk and losing every other genuinely-new row alongside it. Never
    // masks a genuine correction: a row with DIFFERENT data for the same
    // (instrument, price_date) is planImport's 'supersede' action, a
    // completely separate code path below that this ignoreDuplicates never
    // touches. It is also what makes a rerun after a partial run safe.
    const { error } = await budget.time('insert_chunk', async () =>
      db.from('ii_prices_nav').upsert(
        slice.map((w) => ({
          instrument_id: w.instrumentId,
          currency_code: w.currencyCode,
          price_date: w.priceDate,
          price: w.price,
          source_timestamp: retrievedAt,
          data_version: dataVersion,
          record_checksum: w.recordChecksum,
          import_batch_id: batchId,
          quality_status: 'ok',
        })),
        { onConflict: 'instrument_id,price_date', ignoreDuplicates: true }
      )
    );
    chunks.push({ chunkIndex: chunks.length, attempted: slice.length, succeeded: error ? 0 : slice.length, error: error?.message ?? null });
    if (!error) counts.inserted += slice.length;
  }
  counts.remainingInserts = inserts.length - insertsAttempted;
  mark('inserts');

  // Corrections (FIXED 2026-09-21 -- see NAV1_PROGRESS_LEDGER.md).
  //
  // REAL DEFECT FOUND AND CONFIRMED LIVE THIS SESSION: this loop's original
  // form inserted a SECOND ii_prices_nav row for the SAME (instrument_id,
  // price_date) as the row it was correcting, then updated the first row to
  // 'superseded' -- but ii_prices_nav has a table-wide UNIQUE(instrument_id,
  // price_date) constraint (migration 0033) with no partial/WHERE clause
  // excluding superseded rows. The insert step therefore ALWAYS fails with
  // a 23505 duplicate-key violation the instant a real correction occurs --
  // confirmed live against DEV (scripts/nav1_correction_handling_live_test.mjs):
  // `duplicate key value violates unique constraint "ii_prices_nav_instrument_id_price_date_key"`.
  // This had never been caught because zero real corrections had ever
  // occurred in DEV or production to exercise it (confirmed: 0 rows with
  // quality_status='superseded' anywhere, before this fix).
  //
  // FIX: update the existing row IN PLACE with the corrected value, and
  // record the full before/after audit trail in ii_reference_corrections
  // (which already has previous_value/new_value jsonb columns for exactly
  // this). This changes the documented D.3 promise from "two physical rows,
  // one superseded" to "one current row, full audit trail in
  // ii_reference_corrections" -- a genuine invariant change, not a cosmetic
  // one, and it is called out explicitly here rather than silently
  // reinterpreted. Making BOTH rows coexist would require either (a) a
  // partial unique index excluding superseded rows, which breaks the
  // existing, already-proven-live fresh-insert path's
  // `.upsert(..., {onConflict:'instrument_id,price_date'})` call (PostgREST's
  // onConflict cannot target a partial index's WHERE-qualified arbiter), or
  // (b) a schema change (e.g. an is_current flag) with the same onConflict
  // consequence. Both are real options a schema owner could still choose
  // instead of this one; this fix was selected because it requires no
  // migration, does not touch the proven-live fresh-insert path at all, and
  // fully preserves the audit trail's information content.
  //
  // Corrections count against the budget too (2026-09-25), and only start
  // once every insert chunk has been attempted. A correction written by an
  // earlier invocation re-plans as 'skip' (its checksum now matches).
  let correctionsAttempted = 0;
  if (counts.remainingInserts === 0) {
    for (const w of supersedes) {
      if (!budget.canStart('correction')) break;
      correctionsAttempted++;
      await budget.time('correction', async () => {
        const { data: prior } = await db
          .from('ii_prices_nav')
          .select('id, price')
          .eq('instrument_id', w.instrumentId)
          .eq('price_date', w.priceDate)
          .maybeSingle();
        if (!prior) return;
        const { error } = await db.from('ii_prices_nav').update({
          price: w.price,
          source_timestamp: retrievedAt,
          data_version: dataVersion,
          record_checksum: w.recordChecksum,
          import_batch_id: batchId,
          quality_status: 'ok',
        }).eq('id', prior.id);
        if (error) {
          chunks.push({ chunkIndex: chunks.length, attempted: 1, succeeded: 0, error: error?.message ?? 'correction update failed' });
          return;
        }
        await db.from('ii_reference_corrections').insert({
          target_table: 'ii_prices_nav',
          target_row_id: prior.id,
          correction_kind: 'source_correction',
          previous_value: { price: prior.price },
          new_value: { price: w.price },
          actor_kind: 'system_import',
          reason: `Source ${source.sourceKey} republished a different NAV for ${w.priceDate}; the prior value is preserved in this audit record (previous_value) since ii_prices_nav's unique (instrument_id, price_date) constraint does not permit a second physical row for the same key -- see the code comment above this loop.`,
          batch_id: batchId,
        });
        counts.superseded += 1;
        chunks.push({ chunkIndex: chunks.length, attempted: 1, succeeded: 1, error: null });
      });
    }
  }
  counts.remainingCorrections = supersedes.length - correctionsAttempted;

  mark('corrections');

  // --- 7. Settle -----------------------------------------------------------
  const hadErrors = chunks.some((c) => c.error !== null);
  if (!hadErrors && counts.remainingInserts + counts.remainingCorrections > 0) {
    return settleIncomplete(counts, budget.unitsDone(), `${counts.remainingInserts} insert(s) and ${counts.remainingCorrections} correction(s)`);
  }

  const settlement = settleBatch(chunks.length ? chunks : [{ chunkIndex: 0, attempted: 0, succeeded: 0, error: null }], 'commit_chunks');
  const alerts = buildAlerts({
    jobKey: args.jobKey,
    settlement,
    fetchOutcome: fetched,
    consecutiveFailures: control?.consecutiveFailures ?? 0,
    parsedAccepted: counts.parsedAccepted,
    parsedRejected: counts.parsedRejected,
    unresolvedCount: counts.unresolved,
  });

  return finish(
    settlement.status,
    settlement.detail,
    counts,
    parsed.fingerprint.sha256,
    alerts,
    settlement.status === 'succeeded' ? {} : { error_code: settlement.partial ? 'PARTIAL_BATCH' : 'BATCH_FAILED', error_detail: settlement.detail }
  );

  /** The budget ran out with work left and no write error. */
  function settleIncomplete(c: IngestJobResult['counts'], unitsDone: number, what: string): Promise<IngestJobResult> {
    const elapsed = clock() - startedAtMs;
    if (unitsDone === 0) {
      const detail = `The ${budgetMs} ms budget was used before any write could start (read phase ${readPhaseMs ?? '?'} ms, ${elapsed} ms elapsed); ${what} remain. Recorded as a failure: a run that cannot make progress is a problem, not a continuation.`;
      return finish('failed', detail, c, parsed.fingerprint.sha256, [{ severity: 'critical', code: BUDGET_NO_PROGRESS_ERROR_CODE, detail: `${args.jobKey}: ${detail}` }], {
        error_code: BUDGET_NO_PROGRESS_ERROR_CODE, error_detail: detail,
      });
    }
    const detail = `Stopped at the ${budgetMs} ms time budget after ${elapsed} ms with ${what} remaining; the next invocation continues from here (every write is idempotent). Not a completed run: last_success_at is not advanced.`;
    return finish('partial', detail, c, parsed.fingerprint.sha256, [{ severity: 'info', code: 'CONTINUING_NEXT_INVOCATION', detail: `${args.jobKey}: ${detail}` }], {
      error_code: PARTIAL_CONTINUING_ERROR_CODE, error_detail: detail, notes: { continuing: true },
    });
  }
}

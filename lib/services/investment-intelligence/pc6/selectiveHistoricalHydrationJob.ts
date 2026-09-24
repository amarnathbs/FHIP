// PC6/NAV 1.26 — initial historical hydration: the selective replacement for
// scripts/pc6_historical_nav_backfill.mjs's brute-force full-universe fetch.
//
// Fetches pre-changeover NAV history ONLY for instruments a real dependency
// requires (accepted statements, benchmark mappings — see
// navRetentionPolicy.ts's determineHydrationRequirement), using the
// provider-neutral adapter contract (NAV 1.14/1.15). Never touches
// post-changeover data (that is the existing, separate
// pc6_amfi_daily_nav job's responsibility) and never overwrites an existing
// row — decideUpsert (referenceDataQuality.ts) governs every write exactly
// as the daily/backfill jobs already do.
//
// Orchestration is deliberately separated from I/O: every database/network
// effect is an injected `Deps` function, so the actual planning and
// decision logic (which instruments, which windows, what to write) is unit
// testable without a live database or network call. `runLive()` at the
// bottom wires the injected functions to the real Supabase admin client and
// the TIGZIG adapter for actual use.

import type { HistoricalNavAdapter } from './adapters/historicalNavAdapter';
import {
  determineHydrationRequirement,
  type AcceptedDependency,
  type BenchmarkDependency,
} from './navRetentionPolicy';
import { decideUpsert, type ExistingObservation } from './referenceDataQuality';

/** AMFI's own earliest published history, per this programme's own governing brief ("April 2006 to present"). Used only as a floor when a dependency asks for "from inception" and no more specific date is known. */
export const HISTORICAL_FLOOR_DATE = '2006-04-01';

/**
 * NAV 1.23/1.26 — bounded, resumable fetching (built after this dispatch's
 * own disclosed limitation: an inception-requiring dependency could compute
 * an ~18-20 year single window, untested at that size against TIGZIG).
 * MAX_FETCH_WINDOW_DAYS caps every SINGLE adapter request to roughly 2
 * years, regardless of how large the overall required window is. A large
 * requirement is walked in DESCENDING date order (newest chunk first, since
 * that is the boundary already-existing coverage abuts) and each chunk is
 * validated+written BEFORE the next, older chunk is even fetched — so an
 * interruption after chunk N leaves chunks 1..N genuinely committed, not
 * rolled back, and RESUMABLE: because `fetchEarliestExistingDate()` reflects
 * real DB state, the next invocation (whether seconds or days later) simply
 * sees a smaller remaining gap and continues from exactly where the last
 * one stopped, using the same "already_covered vs. gap to fetch" logic that
 * already existed — no separate checkpoint table was needed.
 */
export const MAX_FETCH_WINDOW_DAYS = 730;

/** Split [fromDate, toDate] into descending-order sub-windows of at most `maxDays` each. The FIRST element is the newest (closest to toDate) chunk. */
export function chunkDateWindow(fromDate: string, toDate: string, maxDays: number): Array<{ fromDate: string; toDate: string }> {
  const chunks: Array<{ fromDate: string; toDate: string }> = [];
  let currentTo = toDate;
  while (currentTo >= fromDate) {
    const candidateFrom = addDays(currentTo, -(maxDays - 1));
    const chunkFrom = candidateFrom < fromDate ? fromDate : candidateFrom;
    chunks.push({ fromDate: chunkFrom, toDate: currentTo });
    if (chunkFrom === fromDate) break;
    currentTo = addDays(chunkFrom, -1);
  }
  return chunks;
}

export interface HydrationDeps {
  /** True if the job may proceed at all (kill-switch check). */
  isEnabled(): Promise<{ enabled: boolean; reason: string | null }>;
  fetchAcceptedDependencies(): Promise<Map<string, AcceptedDependency>>;
  fetchBenchmarkDependencies(): Promise<Map<string, BenchmarkDependency>>;
  /** Earliest price_date already on file for this instrument, or null if none. */
  fetchEarliestExistingDate(instrumentId: string): Promise<string | null>;
  /** The identifier to hand the adapter (AMFI scheme code today), or null if unresolvable. */
  fetchAdapterIdentifier(instrumentId: string): Promise<string | null>;
  /** Existing (instrument, date) rows in the fetch window, for decideUpsert. */
  fetchExistingObservations(instrumentId: string, fromDate: string, toDate: string): Promise<Map<string, ExistingObservation>>;
  writeRows(rows: HydrationWriteRow[]): Promise<{ inserted: number; error: string | null }>;
  /**
   * NAV 1 Stage D (0192): claim the run before doing any work. Reconciles this
   * job's own abandoned 'running' batches, refuses while one is still genuinely
   * in flight (returns `blocked` with the reason), and otherwise opens a
   * 'running' batch and returns its id. A failure to open is returned as
   * `error`; the run then proceeds and is logged when it finishes.
   */
  claimBatch(startedAt: string): Promise<{ batchId: string | null; blocked: string | null; error: string | null }>;
  /**
   * Record progress on the open batch after each instrument, so a run the
   * platform kills still shows how far it got. Best effort: never fails a run.
   */
  updateBatchProgress(batchId: string, perInstrument: PerInstrumentOutcome[]): Promise<void>;
  /**
   * Close the run's batch (or, with no open batch, insert it). Returns the
   * error rather than throwing: a lost batch record must be visible, but must
   * not undo the run's work.
   */
  recordBatch(summary: HydrationJobResult, batchId: string | null): Promise<{ error: string | null }>;
  /** NAV 1 Stage D (0190): the confirmed earliest date with NAV data for this instrument, or null if none is recorded. */
  fetchHistoryFloor(instrumentId: string): Promise<string | null>;
  /**
   * NAV 1 Stage D (0190): record that no NAV exists before floorDate. Reports
   * failure as a value rather than throwing -- a floor that fails to save only
   * means the next run re-discovers it; it must never fail the instrument.
   */
  recordHistoryFloor(instrumentId: string, floorDate: string, detail: string): Promise<{ error: string | null }>;
}

export interface HydrationWriteRow {
  instrumentId: string;
  priceDate: string;
  price: string;
  currencyCode: string;
  recordChecksum: string;
  dataVersion: string;
  importBatchId: string;
}

export interface HydrationJobArgs {
  dryRun?: boolean;
  /** Bounds blast radius per invocation — mirrors the CHUNK_SIZE discipline used throughout PC6. */
  maxInstruments?: number;
  /** Explicit changeover date C; the job never fetches on/after this date (that is the daily job's job). */
  changeoverDate: string;
  adapter: HistoricalNavAdapter;
  deps: HydrationDeps;
}

export interface PerInstrumentOutcome {
  instrumentId: string;
  reasons: string[];
  requiredFromDate: string | null;
  outcome: 'already_covered' | 'hydrated' | 'partially_hydrated' | 'unresolvable_identifier' | 'fetch_failed' | 'planned_dry_run' | 'no_gap_to_fetch';
  /** Present when this run confirmed and recorded where the instrument's history starts (0190). */
  historyFloorRecorded?: string;
  /** Present when outcome is 'partially_hydrated': the earliest date successfully written before a later (older) chunk failed — the exact resume point for the next invocation. */
  resumeFromDate?: string;
  detail: string;
  rowsInserted: number;
}

export interface HydrationJobResult {
  status: 'succeeded' | 'skipped_kill_switch' | 'skipped_already_running' | 'partial';
  instrumentsConsidered: number;
  instrumentsNeedingHydration: number;
  instrumentsAlreadyCovered: number;
  instrumentsHydrated: number;
  instrumentsPartiallyHydrated: number;
  instrumentsFailed: number;
  totalRowsInserted: number;
  detail: string;
  perInstrument: PerInstrumentOutcome[];
  startedAt: string;
  finishedAt: string;
  /** Present when the batch record could not be saved -- the run's work still stands. */
  batchRecordError?: string;
}

/** error_code for a batch in which no instrument succeeded at all. */
export const HYDRATION_NOTHING_SUCCEEDED_ERROR_CODE = 'HYDRATION_NOTHING_SUCCEEDED';

/**
 * The ii_reference_import_batches row for a hydration run.
 *
 * Built here, as a pure function, because the version inlined in the live
 * deps VIOLATED BOTH of the table's check constraints and nobody could tell:
 *   - ii_reference_import_batches_terminal_has_finish -- a non-'running'
 *     status needs finished_at, which was never set;
 *   - ii_reference_import_batches_failed_has_error -- a 'failed' status needs
 *     error_code, which was never set;
 * and the insert's error was discarded. So no real hydration run was ever
 * recorded. Found 2026-09-24 by the first real production run (plan D.9),
 * which recorded three history floors and no batch at all.
 *
 * 'failed' now means NOTHING succeeded. The old rule ("any failure and no
 * instrument newly hydrated") logged a run that recorded floors for some
 * instruments and hit one error as a total failure.
 *
 * AMFI is the primary source since D.3; the provider behind each ROW is in
 * that row's data_version, which is the authoritative record.
 *
 * batch_kind 'nav_hydration' (0192), not 'nav_history': the PC6 ingest job
 * scopes its own "still running?" checks by source_key + batch_kind, and
 * 'amfi' + 'nav_history' is exactly its AMFI history backfill scope. Sharing
 * it would let each job block, or stale-reconcile, the other's live run.
 */
export const HYDRATION_BATCH_KIND = 'nav_hydration' as const;

/**
 * A 'running' hydration batch older than this is treated as abandoned (the
 * platform killed the process) and reconciled as failed; a younger one blocks
 * a new run. Generous on purpose: with per-request timeouts a real run is
 * bounded, and reconciling a live run would let two overlap.
 */
export const HYDRATION_STALE_RUNNING_MINUTES = 30;

export function buildHydrationBatchRow(summary: HydrationJobResult) {
  const succeededAny = summary.instrumentsHydrated + summary.instrumentsPartiallyHydrated + summary.instrumentsAlreadyCovered > 0;
  const failed = summary.instrumentsFailed > 0 && !succeededAny;
  return {
    source_key: 'amfi',
    source_config_id: 'amfi_nav_history',
    batch_kind: HYDRATION_BATCH_KIND,
    as_of_date: summary.finishedAt.slice(0, 10),
    status: failed ? ('failed' as const) : ('succeeded' as const),
    started_at: summary.startedAt,
    finished_at: summary.finishedAt,
    error_code: failed ? HYDRATION_NOTHING_SUCCEEDED_ERROR_CODE : null,
    error_detail: failed ? summary.detail.slice(0, 2000) : null,
    rows_read: summary.instrumentsConsidered,
    rows_accepted: summary.instrumentsNeedingHydration,
    rows_inserted: summary.totalRowsInserted,
    notes: {
      sources: { primary: 'amfi_nav_history', fallback: 'tigzig_nav_history', perRowProvider: 'data_version' },
      perInstrument: summary.perInstrument.slice(0, 200),
    },
  };
}

export async function runSelectiveHistoricalHydration(args: HydrationJobArgs): Promise<HydrationJobResult> {
  const { dryRun = false, maxInstruments = 50, changeoverDate, adapter, deps } = args;
  const startedAt = new Date().toISOString();

  const control = await deps.isEnabled();
  if (!control.enabled) {
    return {
      status: 'skipped_kill_switch',
      instrumentsConsidered: 0, instrumentsNeedingHydration: 0, instrumentsAlreadyCovered: 0,
      instrumentsHydrated: 0, instrumentsPartiallyHydrated: 0, instrumentsFailed: 0, totalRowsInserted: 0,
      detail: `pc6_selective_historical_hydration is disabled: ${control.reason ?? '(no reason recorded)'}`,
      perInstrument: [],
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }

  // Claim the run (0192) -- never for a dry run, which writes nothing. Refuse
  // to overlap a run that is still genuinely in flight; open a 'running' batch
  // so a run the platform kills still leaves a record of how far it got.
  let batchId: string | null = null;
  let claimError: string | null = null;
  if (!dryRun) {
    const claim = await deps.claimBatch(startedAt);
    if (claim.blocked) {
      return {
        status: 'skipped_already_running',
        instrumentsConsidered: 0, instrumentsNeedingHydration: 0, instrumentsAlreadyCovered: 0,
        instrumentsHydrated: 0, instrumentsPartiallyHydrated: 0, instrumentsFailed: 0, totalRowsInserted: 0,
        detail: claim.blocked,
        perInstrument: [],
        startedAt,
        finishedAt: new Date().toISOString(),
      };
    }
    batchId = claim.batchId;
    claimError = claim.error;
  }

  const accepted = await deps.fetchAcceptedDependencies();
  const benchmarked = await deps.fetchBenchmarkDependencies();
  const candidateIds = new Set<string>([...accepted.keys(), ...benchmarked.keys()]);

  const perInstrument: PerInstrumentOutcome[] = [];
  let hydrated = 0, partiallyHydrated = 0, failed = 0, alreadyCovered = 0, totalInserted = 0, needing = 0;
  let processed = 0;
  let progressReported = 0;

  for (const instrumentId of candidateIds) {
    // Report every outcome finished so far before starting the next
    // instrument: if this one is where the platform kills the run, the open
    // batch still shows everything before it.
    if (batchId !== null && perInstrument.length > progressReported) {
      // A snapshot, not the live array: this array keeps growing, and an
      // implementation that read it later would record the wrong progress.
      await deps.updateBatchProgress(batchId, [...perInstrument]);
      progressReported = perInstrument.length;
    }
    const req = determineHydrationRequirement(instrumentId, { acceptedDependencies: accepted, benchmarkDependencies: benchmarked }, changeoverDate);
    if (!req.required) continue;
    needing++;
    if (processed >= maxInstruments) continue; // still counted in `needing`, honestly reported as not processed this run
    processed++;

    // Never request before a confirmed history floor (0190): without it, a
    // fund launched after 2006 had its empty pre-launch window re-requested
    // on every run -- a fund-house download each time once AMFI became the
    // primary source.
    const baseRequiredFrom = req.fromDate ?? HISTORICAL_FLOOR_DATE;
    const historyFloor = await deps.fetchHistoryFloor(instrumentId);
    const requiredFrom = historyFloor !== null && historyFloor > baseRequiredFrom ? historyFloor : baseRequiredFrom;
    const existingEarliest = await deps.fetchEarliestExistingDate(instrumentId);

    if (existingEarliest !== null && existingEarliest <= requiredFrom) {
      alreadyCovered++;
      perInstrument.push({ instrumentId, reasons: req.reasons, requiredFromDate: req.fromDate, outcome: 'already_covered', detail: `existing coverage from ${existingEarliest} already satisfies required ${requiredFrom}${historyFloor !== null && requiredFrom === historyFloor ? ' (the recorded history floor)' : ''}`, rowsInserted: 0 });
      continue;
    }

    // The gap to fetch: [requiredFrom, existingEarliest - 1 day] if some
    // coverage already exists, else [requiredFrom, changeoverDate - 1 day]
    // (never fetch on/after C — that is the daily job's authority).
    // Clamped: for an instrument whose earliest row is itself after C (a fund
    // launched after the changeover), existingEarliest - 1 would otherwise
    // land on or after C and break the rule stated above.
    const lastPreChangeover = addDays(changeoverDate, -1);
    const dayBeforeExisting = existingEarliest !== null ? addDays(existingEarliest, -1) : null;
    const toDate = dayBeforeExisting !== null && dayBeforeExisting < lastPreChangeover ? dayBeforeExisting : lastPreChangeover;
    if (toDate < requiredFrom) {
      perInstrument.push({ instrumentId, reasons: req.reasons, requiredFromDate: req.fromDate, outcome: 'no_gap_to_fetch', detail: `computed window [${requiredFrom}, ${toDate}] is empty`, rowsInserted: 0 });
      continue;
    }

    if (dryRun) {
      perInstrument.push({ instrumentId, reasons: req.reasons, requiredFromDate: req.fromDate, outcome: 'planned_dry_run', detail: `would fetch [${requiredFrom}, ${toDate}]`, rowsInserted: 0 });
      continue;
    }

    const identifier = await deps.fetchAdapterIdentifier(instrumentId);
    if (!identifier) {
      failed++;
      perInstrument.push({ instrumentId, reasons: req.reasons, requiredFromDate: req.fromDate, outcome: 'unresolvable_identifier', detail: 'no AMFI scheme code on file for this instrument', rowsInserted: 0 });
      continue;
    }

    // Bounded, resumable fetching (NAV 1.23): the overall [requiredFrom,
    // toDate] window is walked in descending-date chunks of at most
    // MAX_FETCH_WINDOW_DAYS. Each chunk is fetched AND WRITTEN before the
    // next (older) chunk is even requested, so an interruption or failure
    // partway through leaves every already-completed chunk's rows genuinely
    // committed -- never rolled back -- and the failure point is reported
    // precisely enough that the next invocation resumes from there via the
    // ordinary already-covered/gap-to-fetch check (no separate checkpoint
    // state needed).
    const windowChunks = chunkDateWindow(requiredFrom, toDate, MAX_FETCH_WINDOW_DAYS);
    let instrumentRowsInserted = 0;
    let chunksCompleted = 0;
    let stoppedAt: string | null = null; // the requiredFrom of the chunk that failed, if any
    let stopDetail: string | null = null;
    // Earliest date any provider returned in this run, and -- if the walk
    // went past the start of the instrument's history -- where it starts.
    let earliestSeen: string | null = null;
    let floorReachedAt: string | null = null;
    let floorEvidence = '';

    for (const chunk of windowChunks) {
      const fetchResult = await adapter.fetchHistory({ schemeIdentifier: identifier, fromDate: chunk.fromDate, toDate: chunk.toDate });
      if (!fetchResult.ok) {
        // Only "no data here" (both providers, via the fallback adapter) AND
        // data already known NEWER than this window means the walk has gone
        // past the start of the instrument's history. A not_found with nothing
        // known at all is an unknown scheme, and any other failure is a real
        // error -- neither may be recorded as a floor.
        const earliestKnown = [existingEarliest, earliestSeen].filter((d): d is string => d !== null).sort()[0] ?? null;
        if (fetchResult.kind === 'not_found' && earliestKnown !== null) {
          floorReachedAt = earliestKnown;
          floorEvidence = `no data in [${chunk.fromDate}, ${chunk.toDate}]: ${fetchResult.detail}`;
          break;
        }
        stoppedAt = chunk.fromDate;
        stopDetail = `${fetchResult.kind}: ${fetchResult.detail} (chunk [${chunk.fromDate}, ${chunk.toDate}])`;
        break;
      }

      const existingObs = await deps.fetchExistingObservations(instrumentId, chunk.fromDate, chunk.toDate);
      const importBatchId = crypto.randomUUID();
      // Stamp the provider that ACTUALLY supplied these rows, not the adapter
      // object: with a fallback in the chain, adapter.providerKey names the
      // composite ('amfi+tigzig'), and a TIGZIG-sourced row labelled that way
      // could not be told apart from an AMFI one.
      const dataVersion = `${fetchResult.provider.key}:${fetchResult.provider.adapterVersion}:${fetchResult.provider.rawResponseChecksum.slice(0, 12)}`;
      const rowsToWrite: HydrationWriteRow[] = [];
      for (const obs of fetchResult.observations) {
        if (earliestSeen === null || obs.date < earliestSeen) earliestSeen = obs.date;
        const recordChecksum = simpleChecksum(`${instrumentId}|${obs.date}|${obs.nav}`);
        const decision = decideUpsert(existingObs.get(`${instrumentId}|${obs.date}`) ?? null, { value: obs.nav, recordChecksum });
        if (decision.action === 'insert') {
          rowsToWrite.push({ instrumentId, priceDate: obs.date, price: obs.nav, currencyCode: 'INR', recordChecksum, dataVersion, importBatchId });
        }
        // 'skip'/'supersede' handling for a hydration job intentionally does
        // not re-implement correction semantics here -- a hydration fetch
        // finding a DIFFERENT value for a date the daily/backfill job already
        // wrote is a cross-source discrepancy for a human to review (N.11
        // quality surface), not something this job silently overwrites.
      }

      if (rowsToWrite.length > 0) {
        const writeResult = await deps.writeRows(rowsToWrite);
        if (writeResult.error) {
          stoppedAt = chunk.fromDate;
          stopDetail = `write failed: ${writeResult.error} (chunk [${chunk.fromDate}, ${chunk.toDate}])`;
          break;
        }
        instrumentRowsInserted += writeResult.inserted;
      }
      chunksCompleted++;
    }

    if (stoppedAt !== null) {
      totalInserted += instrumentRowsInserted;
      if (chunksCompleted > 0) {
        partiallyHydrated++;
        // Partial progress is real and committed -- reported distinctly
        // from a total failure so an operator (and the next invocation)
        // knows exactly how far it got, not just that it didn't finish.
        perInstrument.push({
          instrumentId, reasons: req.reasons, requiredFromDate: req.fromDate, outcome: 'partially_hydrated',
          detail: `${chunksCompleted}/${windowChunks.length} chunk(s) completed (${instrumentRowsInserted} row(s) inserted) before stopping: ${stopDetail}`,
          rowsInserted: instrumentRowsInserted, resumeFromDate: stoppedAt,
        });
      } else {
        failed++;
        perInstrument.push({ instrumentId, reasons: req.reasons, requiredFromDate: req.fromDate, outcome: 'fetch_failed', detail: stopDetail ?? 'unknown failure', rowsInserted: 0 });
      }
      continue;
    }

    let floorNote = '';
    let historyFloorRecorded: string | undefined;
    if (floorReachedAt !== null) {
      const saved = await deps.recordHistoryFloor(instrumentId, floorReachedAt, floorEvidence);
      if (saved.error) {
        floorNote = ` -- history starts ${floorReachedAt}, but the floor could not be saved (${saved.error}); the next run will re-discover it`;
      } else {
        floorNote = ` -- history starts ${floorReachedAt}; recorded as the floor, earlier dates will not be requested again`;
        historyFloorRecorded = floorReachedAt;
      }
    }

    if (instrumentRowsInserted === 0) {
      perInstrument.push({ instrumentId, reasons: req.reasons, requiredFromDate: req.fromDate, outcome: 'already_covered', detail: `provider returned only already-on-file dates${floorNote}`, rowsInserted: 0, historyFloorRecorded });
      alreadyCovered++;
      continue;
    }

    hydrated++;
    totalInserted += instrumentRowsInserted;
    perInstrument.push({
      instrumentId, reasons: req.reasons, requiredFromDate: req.fromDate, outcome: 'hydrated',
      detail: `inserted ${instrumentRowsInserted} row(s) for [${requiredFrom}, ${toDate}] across ${windowChunks.length} chunk(s) of up to ${MAX_FETCH_WINDOW_DAYS} days each${floorNote}`,
      rowsInserted: instrumentRowsInserted,
      historyFloorRecorded,
    });
  }

  const result: HydrationJobResult = {
    status: 'succeeded',
    instrumentsConsidered: candidateIds.size,
    instrumentsNeedingHydration: needing,
    instrumentsAlreadyCovered: alreadyCovered,
    instrumentsHydrated: hydrated,
    instrumentsPartiallyHydrated: partiallyHydrated,
    instrumentsFailed: failed,
    totalRowsInserted: totalInserted,
    detail: dryRun
      ? `Dry run: ${needing} instrument(s) need hydration, ${processed} planned this invocation (max ${maxInstruments}).`
      : `${hydrated} hydrated, ${partiallyHydrated} partially hydrated (resumable), ${alreadyCovered} already covered, ${failed} failed, out of ${needing} needing hydration (${processed} processed this invocation, max ${maxInstruments}).`,
    perInstrument,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
  if (!dryRun) {
    if (claimError) result.detail += ` (no 'running' batch could be opened at the start: ${claimError})`;
    const saved = await deps.recordBatch(result, batchId);
    if (saved.error) {
      result.batchRecordError = saved.error;
      result.detail += ` BATCH RECORD NOT SAVED: ${saved.error}`;
    }
  }
  return result;
}

function addDays(iso: string, delta: number): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** Deliberately NOT cryptographic — matches this repository's existing convention (schemeMasterWriter.ts uses the same style of content fingerprint) of a short, stable content fingerprint for idempotency, not a security control. */
function simpleChecksum(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) hash = (hash * 31 + input.charCodeAt(i)) | 0;
  return Math.abs(hash).toString(16).padStart(8, '0');
}

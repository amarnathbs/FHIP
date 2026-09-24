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
  recordBatch(summary: HydrationJobResult): Promise<void>;
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
  /** Present when outcome is 'partially_hydrated': the earliest date successfully written before a later (older) chunk failed — the exact resume point for the next invocation. */
  resumeFromDate?: string;
  detail: string;
  rowsInserted: number;
}

export interface HydrationJobResult {
  status: 'succeeded' | 'skipped_kill_switch' | 'partial';
  instrumentsConsidered: number;
  instrumentsNeedingHydration: number;
  instrumentsAlreadyCovered: number;
  instrumentsHydrated: number;
  instrumentsPartiallyHydrated: number;
  instrumentsFailed: number;
  totalRowsInserted: number;
  detail: string;
  perInstrument: PerInstrumentOutcome[];
}

export async function runSelectiveHistoricalHydration(args: HydrationJobArgs): Promise<HydrationJobResult> {
  const { dryRun = false, maxInstruments = 50, changeoverDate, adapter, deps } = args;

  const control = await deps.isEnabled();
  if (!control.enabled) {
    return {
      status: 'skipped_kill_switch',
      instrumentsConsidered: 0, instrumentsNeedingHydration: 0, instrumentsAlreadyCovered: 0,
      instrumentsHydrated: 0, instrumentsPartiallyHydrated: 0, instrumentsFailed: 0, totalRowsInserted: 0,
      detail: `pc6_selective_historical_hydration is disabled: ${control.reason ?? '(no reason recorded)'}`,
      perInstrument: [],
    };
  }

  const accepted = await deps.fetchAcceptedDependencies();
  const benchmarked = await deps.fetchBenchmarkDependencies();
  const candidateIds = new Set<string>([...accepted.keys(), ...benchmarked.keys()]);

  const perInstrument: PerInstrumentOutcome[] = [];
  let hydrated = 0, partiallyHydrated = 0, failed = 0, alreadyCovered = 0, totalInserted = 0, needing = 0;
  let processed = 0;

  for (const instrumentId of candidateIds) {
    const req = determineHydrationRequirement(instrumentId, { acceptedDependencies: accepted, benchmarkDependencies: benchmarked }, changeoverDate);
    if (!req.required) continue;
    needing++;
    if (processed >= maxInstruments) continue; // still counted in `needing`, honestly reported as not processed this run
    processed++;

    const requiredFrom = req.fromDate ?? HISTORICAL_FLOOR_DATE;
    const existingEarliest = await deps.fetchEarliestExistingDate(instrumentId);

    if (existingEarliest !== null && existingEarliest <= requiredFrom) {
      alreadyCovered++;
      perInstrument.push({ instrumentId, reasons: req.reasons, requiredFromDate: req.fromDate, outcome: 'already_covered', detail: `existing coverage from ${existingEarliest} already satisfies required ${requiredFrom}`, rowsInserted: 0 });
      continue;
    }

    // The gap to fetch: [requiredFrom, existingEarliest - 1 day] if some
    // coverage already exists, else [requiredFrom, changeoverDate - 1 day]
    // (never fetch on/after C — that is the daily job's authority).
    const toDate = existingEarliest !== null ? addDays(existingEarliest, -1) : addDays(changeoverDate, -1);
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

    for (const chunk of windowChunks) {
      const fetchResult = await adapter.fetchHistory({ schemeIdentifier: identifier, fromDate: chunk.fromDate, toDate: chunk.toDate });
      if (!fetchResult.ok) {
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

    if (instrumentRowsInserted === 0) {
      perInstrument.push({ instrumentId, reasons: req.reasons, requiredFromDate: req.fromDate, outcome: 'already_covered', detail: 'provider returned only already-on-file dates', rowsInserted: 0 });
      alreadyCovered++;
      continue;
    }

    hydrated++;
    totalInserted += instrumentRowsInserted;
    perInstrument.push({
      instrumentId, reasons: req.reasons, requiredFromDate: req.fromDate, outcome: 'hydrated',
      detail: `inserted ${instrumentRowsInserted} row(s) for [${requiredFrom}, ${toDate}] across ${windowChunks.length} chunk(s) of up to ${MAX_FETCH_WINDOW_DAYS} days each`,
      rowsInserted: instrumentRowsInserted,
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
  };
  if (!dryRun) await deps.recordBatch(result);
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

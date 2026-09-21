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
  outcome: 'already_covered' | 'hydrated' | 'unresolvable_identifier' | 'fetch_failed' | 'planned_dry_run' | 'no_gap_to_fetch';
  detail: string;
  rowsInserted: number;
}

export interface HydrationJobResult {
  status: 'succeeded' | 'skipped_kill_switch' | 'partial';
  instrumentsConsidered: number;
  instrumentsNeedingHydration: number;
  instrumentsAlreadyCovered: number;
  instrumentsHydrated: number;
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
      instrumentsHydrated: 0, instrumentsFailed: 0, totalRowsInserted: 0,
      detail: `pc6_selective_historical_hydration is disabled: ${control.reason ?? '(no reason recorded)'}`,
      perInstrument: [],
    };
  }

  const accepted = await deps.fetchAcceptedDependencies();
  const benchmarked = await deps.fetchBenchmarkDependencies();
  const candidateIds = new Set<string>([...accepted.keys(), ...benchmarked.keys()]);

  const perInstrument: PerInstrumentOutcome[] = [];
  let hydrated = 0, failed = 0, alreadyCovered = 0, totalInserted = 0, needing = 0;
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

    const fetchResult = await adapter.fetchHistory({ schemeIdentifier: identifier, fromDate: requiredFrom, toDate });
    if (!fetchResult.ok) {
      failed++;
      perInstrument.push({ instrumentId, reasons: req.reasons, requiredFromDate: req.fromDate, outcome: 'fetch_failed', detail: `${fetchResult.kind}: ${fetchResult.detail}`, rowsInserted: 0 });
      continue;
    }

    const existingObs = await deps.fetchExistingObservations(instrumentId, requiredFrom, toDate);
    const importBatchId = crypto.randomUUID();
    const dataVersion = `${adapter.providerKey}:${adapter.adapterVersion}:${fetchResult.provider.rawResponseChecksum.slice(0, 12)}`;
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

    if (rowsToWrite.length === 0) {
      perInstrument.push({ instrumentId, reasons: req.reasons, requiredFromDate: req.fromDate, outcome: 'already_covered', detail: 'provider returned only already-on-file dates', rowsInserted: 0 });
      alreadyCovered++;
      continue;
    }

    const writeResult = await deps.writeRows(rowsToWrite);
    if (writeResult.error) {
      failed++;
      perInstrument.push({ instrumentId, reasons: req.reasons, requiredFromDate: req.fromDate, outcome: 'fetch_failed', detail: `write failed: ${writeResult.error}`, rowsInserted: 0 });
      continue;
    }
    hydrated++;
    totalInserted += writeResult.inserted;
    perInstrument.push({ instrumentId, reasons: req.reasons, requiredFromDate: req.fromDate, outcome: 'hydrated', detail: `inserted ${writeResult.inserted} row(s) for [${requiredFrom}, ${toDate}]`, rowsInserted: writeResult.inserted });
  }

  const result: HydrationJobResult = {
    status: 'succeeded',
    instrumentsConsidered: candidateIds.size,
    instrumentsNeedingHydration: needing,
    instrumentsAlreadyCovered: alreadyCovered,
    instrumentsHydrated: hydrated,
    instrumentsFailed: failed,
    totalRowsInserted: totalInserted,
    detail: dryRun
      ? `Dry run: ${needing} instrument(s) need hydration, ${processed} planned this invocation (max ${maxInstruments}).`
      : `${hydrated} hydrated, ${alreadyCovered} already covered, ${failed} failed, out of ${needing} needing hydration (${processed} processed this invocation, max ${maxInstruments}).`,
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

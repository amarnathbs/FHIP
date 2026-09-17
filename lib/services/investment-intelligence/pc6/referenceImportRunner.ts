// PC6 (M6) — the reference-data import runner.
//
// N.4  repeatable import jobs; raw source fingerprint/checksum; deterministic
//      parse; reject malformed records; idempotent; backfill windows; log
//      source as-of and ingestion time.
// N.15 idempotency; retry/backoff; alerting; kill switch; partial-batch
//      atomicity/rollback semantics; operator runbook; source outage handling.
//
// SHAPE. The runner is split into a PURE planner and a thin executor. The
// planner takes parsed records plus the current database state and returns an
// exact plan — what to insert, what to skip, what to supersede — with no I/O
// at all. Every N.15 control (kill switch, backoff, outage handling, partial-
// batch semantics) is therefore unit-testable without a database, and the
// executor is small enough to read in one sitting.
//
// BOUNDARY. The runner writes ONLY to PC6 reference tables. It has no code
// path that touches ii_transactions, ii_holding_snapshots, ii_fhip_publications
// or any user-owned table, and no code path that reads a user document. D.7 is
// preserved by construction: there is nothing here that could rewrite a
// statement fact, because statement facts live in tables this module never
// names.

import type { AmfiParseResult, AmfiSchemeNavRecord, Rejection } from './amfiParser';
import { decideUpsert, type ExistingObservation, type UpsertAction } from './referenceDataQuality';
import { getReferenceSource, type ReferenceSourceDefinition } from '@/lib/config/investment-intelligence/pc6ReferenceSources';

export const PC6_RUNNER_VERSION = 'pc6-import-runner-v1';

// ---------------------------------------------------------------------------
// Kill switch and backoff (N.15)
// ---------------------------------------------------------------------------

export interface JobControlRow {
  jobKey: string;
  enabled: boolean;
  disabledReason: string | null;
  consecutiveFailures: number;
  nextAttemptNotBefore: string | null;
  lastSuccessAt: string | null;
}

export type StartDecision =
  | { start: true }
  | { start: false; status: 'skipped_kill_switch'; detail: string }
  | { start: false; status: 'skipped_backoff'; detail: string };

/**
 * FAILS CLOSED. A missing job-control row means the job does not run — not
 * that it runs unconstrained. An operator who has never created the row has
 * never authorised the job.
 */
export function decideStart(control: JobControlRow | null, jobKey: string, nowIso: string): StartDecision {
  if (!control) {
    return {
      start: false,
      status: 'skipped_kill_switch',
      detail: `No ii_reference_job_control row exists for '${jobKey}'. The job is treated as NOT authorised (fail closed).`,
    };
  }
  if (!control.enabled) {
    return {
      start: false,
      status: 'skipped_kill_switch',
      detail: `Kill switch is engaged for '${jobKey}': ${control.disabledReason ?? '(no reason recorded)'}`,
    };
  }
  if (control.nextAttemptNotBefore && nowIso < control.nextAttemptNotBefore) {
    return {
      start: false,
      status: 'skipped_backoff',
      detail: `Backoff active after ${control.consecutiveFailures} consecutive failure(s); the next attempt is not permitted before ${control.nextAttemptNotBefore}.`,
    };
  }
  return { start: true };
}

export const BACKOFF_BASE_MINUTES = 15;
export const BACKOFF_MAX_MINUTES = 6 * 60;

/**
 * Exponential backoff with a ceiling: 15, 30, 60, 120, 240, 360, 360...
 *
 * Bounded rather than unbounded on purpose. A source outage that lasts a week
 * must not push the next attempt into next month; the job should keep probing
 * every six hours so that recovery is automatic and the operator surface keeps
 * showing a current failure rather than a stale one.
 */
export function backoffMinutes(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return 0;
  return Math.min(BACKOFF_MAX_MINUTES, BACKOFF_BASE_MINUTES * 2 ** (consecutiveFailures - 1));
}

export function nextAttemptAfter(nowIso: string, consecutiveFailures: number): string {
  return new Date(Date.parse(nowIso) + backoffMinutes(consecutiveFailures) * 60_000).toISOString();
}

// ---------------------------------------------------------------------------
// Source outage handling (N.15)
// ---------------------------------------------------------------------------

export type FetchOutcome =
  | { ok: true; bytes: Uint8Array; httpStatus: number; retrievedAt: string }
  | { ok: false; kind: 'network' | 'http_error' | 'empty_body' | 'implausibly_small'; httpStatus: number | null; detail: string };

/**
 * Minimum plausible size for an AMFI full-universe file. The real NAVAll.txt
 * is ~1.5 MB; a few-kilobyte response is an error page or a truncated
 * transfer, and parsing it would produce a "successful" batch that quietly
 * accepted almost nothing. A too-small body is an OUTAGE, not a small day.
 */
export const MIN_PLAUSIBLE_FULL_UNIVERSE_BYTES = 200_000;

export function classifyFetch(
  httpStatus: number | null,
  bytes: Uint8Array | null,
  minBytes: number,
  retrievedAt: string,
  networkError?: string
): FetchOutcome {
  if (networkError) return { ok: false, kind: 'network', httpStatus: null, detail: networkError };
  if (httpStatus === null) return { ok: false, kind: 'network', httpStatus: null, detail: 'No HTTP status returned.' };
  if (httpStatus < 200 || httpStatus >= 300) return { ok: false, kind: 'http_error', httpStatus, detail: `Source returned HTTP ${httpStatus}.` };
  if (!bytes || bytes.byteLength === 0) return { ok: false, kind: 'empty_body', httpStatus, detail: 'Source returned an empty body.' };
  if (bytes.byteLength < minBytes) {
    return {
      ok: false,
      kind: 'implausibly_small',
      httpStatus,
      detail: `Source returned ${bytes.byteLength} bytes, below the ${minBytes}-byte plausibility floor. Treated as an outage rather than parsed, so a truncated or error-page response cannot be recorded as a successful import.`,
    };
  }
  return { ok: true, bytes, httpStatus, retrievedAt };
}

// ---------------------------------------------------------------------------
// Scheme resolution
// ---------------------------------------------------------------------------

export interface InstrumentResolutionIndex {
  /** amfi_scheme_code (country-scoped) -> ii_instruments.id */
  byAmfiCode: Map<string, string>;
  /** ISIN -> ii_instruments.id */
  byIsin: Map<string, string>;
}

export type SchemeResolution =
  | { state: 'resolved'; instrumentId: string; via: 'amfi_scheme_code' | 'isin' }
  | { state: 'unresolved'; reason: 'NO_MATCHING_INSTRUMENT' | 'AMBIGUOUS_ISIN_CONFLICT'; detail: string };

/**
 * Resolve an AMFI record to a canonical instrument.
 *
 * PRECEDENCE IS EXACT-IDENTIFIER ONLY — AMFI scheme code first, then ISIN.
 * There is deliberately NO name-based fallback and no fuzzy matching here.
 * R2's schemeResolution.ts already owns fuzzy/alias resolution for STATEMENT
 * lines, where a human-entered name is all there is; a reference feed carries
 * exact codes, so guessing would only ever introduce errors that the exact
 * identifiers were there to prevent. An unresolved scheme is reported as a
 * mapping gap on the admin surface (N.11), not force-fitted.
 *
 * A code/ISIN disagreement is surfaced as AMBIGUOUS_ISIN_CONFLICT rather than
 * silently resolved by precedence: two identifiers pointing at two different
 * instruments means the instrument master itself is wrong, and a human needs
 * to see that.
 */
export function resolveScheme(record: AmfiSchemeNavRecord, index: InstrumentResolutionIndex): SchemeResolution {
  const byCode = index.byAmfiCode.get(record.amfiSchemeCode);
  const byIsin = record.isinGrowthOrPayout ? index.byIsin.get(record.isinGrowthOrPayout) : undefined;

  if (byCode && byIsin && byCode !== byIsin) {
    return {
      state: 'unresolved',
      reason: 'AMBIGUOUS_ISIN_CONFLICT',
      detail: `AMFI code ${record.amfiSchemeCode} resolves to instrument ${byCode} but ISIN ${record.isinGrowthOrPayout} resolves to ${byIsin}. The instrument master disagrees with itself; no NAV is written until a human resolves it.`,
    };
  }
  if (byCode) return { state: 'resolved', instrumentId: byCode, via: 'amfi_scheme_code' };
  if (byIsin) return { state: 'resolved', instrumentId: byIsin, via: 'isin' };
  return {
    state: 'unresolved',
    reason: 'NO_MATCHING_INSTRUMENT',
    detail: `No instrument carries AMFI code ${record.amfiSchemeCode}${record.isinGrowthOrPayout ? ` or ISIN ${record.isinGrowthOrPayout}` : ''}.`,
  };
}

// ---------------------------------------------------------------------------
// The plan (N.4 idempotency, N.15 partial-batch atomicity)
// ---------------------------------------------------------------------------

export interface PlannedNavWrite {
  instrumentId: string;
  amfiSchemeCode: string;
  priceDate: string;
  /** The exact source decimal string. Never a JS float on the way to Postgres. */
  price: string;
  currencyCode: string;
  recordChecksum: string;
  action: UpsertAction['action'];
  supersedesValue?: string;
}

export interface UnresolvedScheme {
  amfiSchemeCode: string;
  schemeName: string;
  isin: string | null;
  reason: string;
  detail: string;
}

export interface ImportPlan {
  writes: PlannedNavWrite[];
  unresolved: UnresolvedScheme[];
  rejections: Rejection[];
  counts: {
    parsedAccepted: number;
    parsedRejected: number;
    resolved: number;
    unresolved: number;
    toInsert: number;
    unchanged: number;
    toSupersede: number;
  };
}

export interface PlanInputs {
  parsed: AmfiParseResult;
  index: InstrumentResolutionIndex;
  /** Current DB state keyed `${instrumentId}|${priceDate}`. */
  existing: Map<string, ExistingObservation>;
  currencyCode: string;
}

/**
 * Turn parsed records into an exact, side-effect-free plan.
 *
 * IDEMPOTENCY IS BY CONTENT. Running this twice over the same file yields a
 * plan whose `toInsert` is zero on the second pass, because every record's
 * checksum already matches what is stored. Not "upsert and hope" — a genuine
 * no-op, provable by counting the plan rather than by inspecting the database
 * afterwards.
 */
export function planImport(inputs: PlanInputs): ImportPlan {
  const writes: PlannedNavWrite[] = [];
  const unresolved: UnresolvedScheme[] = [];
  let toInsert = 0;
  let unchanged = 0;
  let toSupersede = 0;

  for (const record of inputs.parsed.records) {
    const res = resolveScheme(record, inputs.index);
    if (res.state === 'unresolved') {
      unresolved.push({
        amfiSchemeCode: record.amfiSchemeCode,
        schemeName: record.schemeName,
        isin: record.isinGrowthOrPayout,
        reason: res.reason,
        detail: res.detail,
      });
      continue;
    }
    const key = `${res.instrumentId}|${record.navDate}`;
    const decision = decideUpsert(inputs.existing.get(key) ?? null, {
      value: record.navRaw,
      recordChecksum: record.recordChecksum,
    });
    if (decision.action === 'insert') toInsert++;
    else if (decision.action === 'skip') unchanged++;
    else toSupersede++;

    writes.push({
      instrumentId: res.instrumentId,
      amfiSchemeCode: record.amfiSchemeCode,
      priceDate: record.navDate,
      price: record.navRaw,
      currencyCode: inputs.currencyCode,
      recordChecksum: record.recordChecksum,
      action: decision.action,
      supersedesValue: decision.action === 'supersede' ? decision.previousValue : undefined,
    });
  }

  return {
    writes,
    unresolved,
    rejections: inputs.parsed.rejections,
    counts: {
      parsedAccepted: inputs.parsed.counts.accepted,
      parsedRejected: inputs.parsed.counts.rejected,
      resolved: writes.length,
      unresolved: unresolved.length,
      toInsert,
      unchanged,
      toSupersede,
    },
  };
}

// ---------------------------------------------------------------------------
// Partial-batch semantics (N.15)
// ---------------------------------------------------------------------------

export type BatchAtomicity = 'all_or_nothing' | 'commit_chunks';

export interface ChunkOutcome {
  chunkIndex: number;
  attempted: number;
  succeeded: number;
  error: string | null;
}

export interface BatchSettlement {
  status: 'succeeded' | 'failed' | 'rolled_back';
  rowsWritten: number;
  chunksCommitted: number;
  chunksFailed: number;
  /** True when some chunks committed and others did not. */
  partial: boolean;
  detail: string;
}

/**
 * Decide how a partially-failed batch settles.
 *
 * PC6's chosen semantics are COMMIT_CHUNKS with an HONEST PARTIAL STATUS, not
 * all-or-nothing, and the reasoning is worth stating because it is not the
 * obvious choice:
 *
 *   * A NAV row is an independent dated fact. 9,000 good prices are not made
 *     wrong by the 9,001st failing, and discarding them helps nobody.
 *   * Reference prices are append-only and content-idempotent here, so a
 *     re-run simply completes the missing tail. There is no "half-applied
 *     transfer" hazard of the kind that makes all-or-nothing necessary for
 *     financial postings.
 *   * The real risk is a partial batch being REPORTED as a success — a
 *     freshness check would then pass while a third of the universe silently
 *     went missing. So a partial batch is never 'succeeded': it settles as
 *     'failed' with the exact committed/failed counts, which keeps the job in
 *     backoff and keeps the operator surface showing a problem until a
 *     complete run happens.
 *
 * `all_or_nothing` remains available for callers that need it (a benchmark
 * series where a missing middle would corrupt a return chain), and returns
 * 'rolled_back' rather than pretending.
 */
export function settleBatch(chunks: ChunkOutcome[], atomicity: BatchAtomicity): BatchSettlement {
  const failed = chunks.filter((c) => c.error !== null);
  const rowsWritten = chunks.reduce((n, c) => n + c.succeeded, 0);
  const committed = chunks.filter((c) => c.error === null).length;

  if (failed.length === 0) {
    return { status: 'succeeded', rowsWritten, chunksCommitted: committed, chunksFailed: 0, partial: false, detail: `All ${committed} chunk(s) committed; ${rowsWritten} row(s) written.` };
  }
  if (atomicity === 'all_or_nothing') {
    return {
      status: 'rolled_back',
      rowsWritten: 0,
      chunksCommitted: 0,
      chunksFailed: failed.length,
      partial: false,
      detail: `${failed.length} chunk(s) failed under all-or-nothing semantics; the whole batch was rolled back. First error: ${failed[0].error}`,
    };
  }
  return {
    status: 'failed',
    rowsWritten,
    chunksCommitted: committed,
    chunksFailed: failed.length,
    partial: committed > 0,
    detail:
      `${committed} chunk(s) committed (${rowsWritten} row(s)) and ${failed.length} failed. ` +
      `Recorded as FAILED, not succeeded, so the job stays in backoff and the freshness surface keeps showing the gap. ` +
      `Re-running completes the tail: the committed rows are content-idempotent no-ops. First error: ${failed[0].error}`,
  };
}

// ---------------------------------------------------------------------------
// Alerting (N.15)
// ---------------------------------------------------------------------------

export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface Alert {
  severity: AlertSeverity;
  code: string;
  detail: string;
}

export const CRITICAL_CONSECUTIVE_FAILURES = 3;
export const HIGH_REJECTION_RATE = 0.05;

/**
 * What an operator must be told. Deliberately conservative about `critical`:
 * an alert channel that cries wolf on a single transient 503 gets muted, and a
 * muted channel is worse than none.
 */
export function buildAlerts(args: {
  jobKey: string;
  settlement: BatchSettlement | null;
  fetchOutcome: FetchOutcome | null;
  consecutiveFailures: number;
  parsedAccepted: number;
  parsedRejected: number;
  unresolvedCount: number;
}): Alert[] {
  const alerts: Alert[] = [];
  if (args.fetchOutcome && !args.fetchOutcome.ok) {
    alerts.push({
      severity: args.consecutiveFailures + 1 >= CRITICAL_CONSECUTIVE_FAILURES ? 'critical' : 'warning',
      code: `SOURCE_OUTAGE_${args.fetchOutcome.kind.toUpperCase()}`,
      detail: `${args.jobKey}: ${args.fetchOutcome.detail} (consecutive failures would become ${args.consecutiveFailures + 1})`,
    });
  }
  if (args.settlement && args.settlement.status !== 'succeeded') {
    alerts.push({
      severity: args.settlement.partial ? 'critical' : 'warning',
      code: args.settlement.partial ? 'PARTIAL_BATCH' : 'BATCH_FAILED',
      detail: `${args.jobKey}: ${args.settlement.detail}`,
    });
  }
  const total = args.parsedAccepted + args.parsedRejected;
  if (total > 0 && args.parsedRejected / total > HIGH_REJECTION_RATE) {
    alerts.push({
      severity: 'critical',
      code: 'HIGH_REJECTION_RATE',
      detail:
        `${args.jobKey}: ${args.parsedRejected}/${total} records rejected ` +
        `(${((args.parsedRejected / total) * 100).toFixed(1)}%, threshold ${(HIGH_REJECTION_RATE * 100).toFixed(0)}%). ` +
        'A rejection-rate spike usually means the source changed its format, not that the data went bad.',
    });
  }
  if (args.unresolvedCount > 0) {
    alerts.push({
      severity: 'info',
      code: 'UNRESOLVED_SCHEMES',
      detail: `${args.jobKey}: ${args.unresolvedCount} source scheme(s) matched no instrument. Expected while the instrument master is narrower than AMFI's full universe; reported as a mapping gap, never force-fitted.`,
    });
  }
  return alerts;
}

// ---------------------------------------------------------------------------
// Source helper
// ---------------------------------------------------------------------------

export function sourceFor(configId: string): ReferenceSourceDefinition {
  return getReferenceSource(configId);
}

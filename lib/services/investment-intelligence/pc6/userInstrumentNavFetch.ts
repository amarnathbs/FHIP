// PC6/NAV 1 -- a user-triggered, STRICTLY BOUNDED NAV fetch for ONE scheme
// (PO decisions 2026-10-03): when a user saves an investment date, or has
// uploaded and confirmed a statement, the price history of THEIR funds is
// fetched right away instead of waiting for the scheduled hydration job.
//
// WHAT THIS REUSES (nothing is a new scraper):
//   * the NAV 1 adapter chain, passed in by the caller exactly as the cron
//     route builds it (AMFI primary, TIGZIG fallback), through the same
//     HistoricalNavAdapter contract;
//   * chunkDateWindow() and MAX_FETCH_WINDOW_DAYS: no single request is wider
//     than the ~2 years NAV 1 already proved safe;
//   * buildHydrationWriteRows() -- the exact code the scheduled job uses to
//     turn a fetched chunk into rows: same provenance stamp (the provider that
//     ACTUALLY supplied the rows, so TIGZIG output stays candidate data
//     labelled as TIGZIG), same decideUpsert rule (a date already on file is
//     never overwritten; a different value is a discrepancy for a human);
//   * the job's own HydrationDeps functions for the kill switch, the AMFI
//     scheme code, the existing-observation read, writeRows (an
//     ignore-duplicates upsert into ii_prices_nav) and recordHistoryFloor (the
//     0190 "this fund's history starts here" record, so a fund younger than
//     the requested window is not asked for again and again).
//
// WHAT IT DELIBERATELY IS NOT:
//   * not the full-universe backfill and not the scheduled job's candidate
//     enumeration: it takes ONE instrument id (a string, never a list), never
//     calls fetchAcceptedDependencies / fetchBenchmarkDependencies, and the
//     window is the caller's [fromDate, toDate] for that scheme, at most
//     USER_NAV_FETCH_MAX_CHUNKS chunks per call. A test pins that no request
//     leaves that scheme and window.
//   * not a deleter: it only inserts rows that are not already on file, so the
//     retention / coverage-gap rules (which govern DELETION, migrations
//     0166-0223) are untouched.
//
// FAIL SOFT. Every outcome is a value, never a throw: a network error, a
// source with no data for the window, a disabled kill switch or a write error
// all return a status the caller turns into "we will keep trying".
//
// CONTIGUOUS WRITES, NEWEST FIRST. The scheduled job decides whether a scheme
// is covered from its EARLIEST stored date alone, so a fetch must never leave a
// hole behind an older chunk it did write. Chunks are therefore fetched and
// committed newest-first (the order the job itself uses): whatever has been
// committed is always contiguous with what was already on file, a stop part
// way (deadline, a failed older chunk) leaves the remainder cleanly resumable,
// and the next call or the scheduled job simply continues from there.

import type { HistoricalNavAdapter, HistoricalNavAdapterResult } from './adapters/historicalNavAdapter';
import { MAX_FETCH_WINDOW_DAYS, buildHydrationWriteRows, chunkDateWindow, type HydrationDeps } from './selectiveHistoricalHydrationJob';

/** Per request to the source: 2 attempts, 12s each (adapters honour HistoricalNavRequest.retryBudget). */
export const USER_NAV_FETCH_RETRY_BUDGET = { maxAttempts: 2, timeoutMs: 12_000 } as const;
/** The whole call must finish inside this, so a request never hangs on a slow source. */
export const USER_NAV_FETCH_DEADLINE_MS = 25_000;
/** Chunks (of up to MAX_FETCH_WINDOW_DAYS each) in ONE call (~8 years); a longer gap is resumed by the next call. */
export const USER_NAV_FETCH_MAX_CHUNKS = 4;
/** Scheme fetches one user may cause per hour (a handful of funds, with retries). */
export const USER_NAV_FETCH_MAX_PER_HOUR = 30;

export type UserNavFetchDeps = Pick<HydrationDeps, 'isEnabled' | 'fetchAdapterIdentifier' | 'fetchExistingObservations' | 'writeRows'> & Partial<Pick<HydrationDeps, 'recordHistoryFloor'>>;

export type UserNavFetchOutcome =
  | {
      status: 'fetched';
      rowsInserted: number;
      chunksCompleted: number;
      chunksPlanned: number;
      /** Stopped early (deadline, a failed older chunk): the remainder is resumed by the next call. */
      truncated: boolean;
      /** Set when the source has nothing older: the fund's history starts here (recorded as the 0190 floor). */
      historyStartsAt: string | null;
      detail: string;
    }
  | { status: 'no_data'; detail: string }
  | { status: 'failed'; rowsInserted: number; detail: string }
  | { status: 'disabled'; detail: string }
  | { status: 'unresolvable'; detail: string };

async function withDeadline<T>(promise: Promise<T>, ms: number): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), Math.max(1, ms));
  });
  try {
    return await Promise.race([promise.then((value) => ({ timedOut: false as const, value })), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Fetch and store NAV history for ONE instrument over [fromDate, toDate],
 * newest chunk first, at most USER_NAV_FETCH_MAX_CHUNKS chunks. Never throws.
 * `existingEarliest` is the earliest NAV already on file (the job's own
 * "earliest known" for the history-floor rule).
 */
export async function fetchNavForOneInstrument(args: {
  instrumentId: string;
  fromDate: string;
  toDate: string;
  existingEarliest?: string | null;
  adapter: HistoricalNavAdapter;
  deps: UserNavFetchDeps;
  deadlineMs?: number;
  /** The least time the FIRST (newest) chunk is given even when the deadline is nearly spent. Default: one retry-budget timeout. */
  firstChunkTimeoutMs?: number;
  clock?: () => number;
}): Promise<UserNavFetchOutcome> {
  const { instrumentId, fromDate, toDate, adapter, deps } = args;
  const clock = args.clock ?? (() => Date.now());
  const deadlineAt = clock() + (args.deadlineMs ?? USER_NAV_FETCH_DEADLINE_MS);
  try {
    const control = await deps.isEnabled();
    if (!control.enabled) return { status: 'disabled', detail: `NAV hydration is switched off: ${control.reason ?? '(no reason recorded)'}` };

    const identifier = await deps.fetchAdapterIdentifier(instrumentId);
    if (!identifier) return { status: 'unresolvable', detail: 'no AMFI scheme code on file for this instrument' };

    const allChunks = chunkDateWindow(fromDate, toDate, MAX_FETCH_WINDOW_DAYS); // descending: newest first
    const chunks = allChunks.slice(0, USER_NAV_FETCH_MAX_CHUNKS);
    let inserted = 0;
    let completed = 0;
    let earliestSeen: string | null = null;
    let historyStart: string | null = null;
    const earliestKnown = () => [args.existingEarliest ?? null, earliestSeen].filter((d): d is string => d !== null).sort()[0] ?? null;

    for (const chunk of chunks) {
      const remaining = deadlineAt - clock();
      if (completed > 0 && remaining <= 0) break; // the first (newest) chunk always gets its try; later ones only while time allows
      const attempt = await withDeadline(
        adapter.fetchHistory({ schemeIdentifier: identifier, fromDate: chunk.fromDate, toDate: chunk.toDate, retryBudget: { ...USER_NAV_FETCH_RETRY_BUDGET } }) as Promise<HistoricalNavAdapterResult>,
        completed === 0 ? Math.max(remaining, args.firstChunkTimeoutMs ?? USER_NAV_FETCH_RETRY_BUDGET.timeoutMs) : remaining,
      );
      if (attempt.timedOut) {
        if (completed === 0) return { status: 'failed', rowsInserted: 0, detail: `timed out fetching [${chunk.fromDate}, ${chunk.toDate}]` };
        break;
      }
      const fetched = attempt.value;
      const empty = fetched.ok && fetched.observations.length === 0;
      if (!fetched.ok || empty) {
        // Same rule as the scheduled job: "no data here" with data already known
        // NEWER means the walk has gone past the start of the fund's history.
        const noData = empty || (!fetched.ok && fetched.kind === 'not_found');
        const detail = fetched.ok ? 'the source returned no observations' : `${fetched.kind}: ${fetched.detail}`;
        if (noData && earliestKnown() !== null) {
          historyStart = earliestKnown();
          break;
        }
        if (completed === 0) {
          return noData ? { status: 'no_data', detail: `no data for [${chunk.fromDate}, ${chunk.toDate}]: ${detail}` } : { status: 'failed', rowsInserted: 0, detail };
        }
        break; // an older chunk failed: what is committed stands, the next call (or the scheduled job) resumes
      }

      const existing = await deps.fetchExistingObservations(instrumentId, chunk.fromDate, chunk.toDate);
      const built = buildHydrationWriteRows({ instrumentId, fetchResult: fetched, existingObs: existing });
      if (built.earliestSeen !== null && (earliestSeen === null || built.earliestSeen < earliestSeen)) earliestSeen = built.earliestSeen;
      if (built.rows.length > 0) {
        const written = await deps.writeRows(built.rows);
        if (written.error) return { status: 'failed', rowsInserted: inserted, detail: `write failed: ${written.error}` };
        inserted += written.inserted;
      }
      completed++;
    }

    if (historyStart !== null && deps.recordHistoryFloor) {
      // Best effort, as in the job: a floor that fails to save only means the next call re-discovers it.
      await deps.recordHistoryFloor(instrumentId, historyStart, `user-triggered fetch [${fromDate}, ${toDate}]: no data older than ${historyStart}`).catch(() => ({ error: 'floor not saved' }));
    }
    // Truncated = the window was NOT fully covered by this call (the per-call chunk cap, the deadline or an older chunk failing).
    const truncated = historyStart === null && completed < allChunks.length;
    return {
      status: 'fetched',
      rowsInserted: inserted,
      chunksCompleted: completed,
      chunksPlanned: chunks.length,
      truncated,
      historyStartsAt: historyStart,
      detail: `${inserted} row(s) for [${fromDate}, ${toDate}], ${completed}/${chunks.length} chunk(s)${truncated ? '; the rest is resumed later' : ''}${historyStart ? `; history starts ${historyStart}` : ''}`,
    };
  } catch (e) {
    return { status: 'failed', rowsInserted: 0, detail: `error thrown: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// ---------------------------------------------------------------------------
// Rate limit and single-flight
// ---------------------------------------------------------------------------
/** Same shape as FDH-5's password limiter: count the user's own audit events in the last hour. Pure. */
export function checkUserNavFetchRateLimit(recentEvents: ReadonlyArray<{ created_at: string }>, nowIso: string, max: number = USER_NAV_FETCH_MAX_PER_HOUR): { allowed: boolean; fetchesInWindow: number } {
  const since = new Date(nowIso).getTime() - 60 * 60 * 1000;
  const n = recentEvents.filter((e) => new Date(e.created_at).getTime() >= since).length;
  return { allowed: n < max, fetchesInWindow: n };
}

const inFlight = new Map<string, Promise<unknown>>();

/**
 * Concurrent callers with the same key share ONE run (the second awaits the
 * first one's result instead of calling the source again). Per server instance:
 * across instances the writes are idempotent (ignore-duplicates upsert) and the
 * per-user rate limit and per-instrument cooldown bound the cost.
 */
export function singleFlight<T>(key: string, run: () => Promise<T>): { promise: Promise<T>; shared: boolean } {
  const existing = inFlight.get(key) as Promise<T> | undefined;
  if (existing) return { promise: existing, shared: true };
  const promise = run().finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return { promise, shared: false };
}

/** Test helper: how many runs are in flight. */
export function inFlightCount(): number {
  return inFlight.size;
}

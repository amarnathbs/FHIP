// A user's OWN funds: which of them are missing NAV history, fetching it, and
// saying so in plain words (PO decisions 2026-10-03).
//
//   * after a statement is uploaded and confirmed, and whenever the user asks
//     ("check now"), the price history of THAT USER'S funds is filled in, each
//     from its own earliest transaction / investment date to the earliest NAV
//     already on file;
//   * strictly bounded: the candidates are the caller's own held instruments
//     (read with user_id = caller) and each one's own window. There is no
//     "every instrument" path in this module, and the disabled brute-force
//     backfill is not imported or reachable from it;
//   * it never runs long inside a request: runUserNavHistoryBatch() does a
//     small, time-boxed slice (a few funds, bounded concurrency) and reports
//     what is left; the caller kicks it after the response and the client
//     keeps calling it while there is work. The scheduled hydration job
//     (migration 0193, "every held instrument from inception") remains the
//     fallback and does the same thing on its own clock;
//   * idempotent and gap-only: a fund whose earliest stored NAV already reaches
//     what it needs is "loaded" and never fetched; a re-run fetches only the
//     remaining gap [needed, earliest stored - 1 day];
//   * fail soft per fund: one fund's failure is recorded for that fund and
//     never blocks the others or the confirm.
//
// There is NO request-queue table in the repository (checked: 0166-0241), and
// none is needed: the "queue" is the derived set of the user's funds with a
// gap, the per-fund state is ii_nav_hydration_attempts (0198/0199, the job's
// own fair-ordering ledger), so no migration is required.

import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllRows } from '../pagination';
import { emitAuditEvent } from '../audit';
import { isUserSuppliedInvestmentDateReference, isUsableTransactionStatus } from '@/lib/investment-intelligence/investmentDate';
import type { HistoricalNavAdapter } from './adapters/historicalNavAdapter';
import type { HydrationAttemptRecord, HydrationDeps } from './selectiveHistoricalHydrationJob';
import {
  USER_NAV_FETCH_DEADLINE_MS,
  USER_NAV_FETCH_MAX_PER_HOUR,
  checkUserNavFetchRateLimit,
  fetchNavForOneInstrument,
  singleFlight,
  type UserNavFetchDeps,
  type UserNavFetchOutcome,
} from './userInstrumentNavFetch';

type Db = Pick<SupabaseClient, 'from'>;

/** Days before the earliest needed date to include, to cover weekends and market holidays. */
export const NAV_HISTORY_LEAD_DAYS = 10;
/** After a failed or empty attempt a fund is left alone for this long (polling clients cannot hammer a source). */
export const NAV_FAILURE_COOLDOWN_MINUTES = 10;
/** Funds worked on in ONE batch call. */
export const NAV_BATCH_MAX_SCHEMES = 3;
/** Funds fetched at the same time inside one batch. */
export const NAV_BATCH_CONCURRENCY = 2;
/** The audit event kind that the rate limit counts. */
export const USER_NAV_FETCH_AUDIT_KIND = 'user_nav_history_fetch';

function addDays(iso: string, delta: number): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Pure: what a fund needs, whether it has a gap, and what to tell the user
// ---------------------------------------------------------------------------
export interface SchemeNeed {
  instrumentId: string;
  schemeName: string;
  /** ISO. The date the fund's price history must reach back to (already includes the lead days). */
  requiredFrom: string;
  reason: 'transactions' | 'investment_date' | 'holding_date';
}

export interface SchemeCoverage {
  /** Earliest ii_prices_nav date on file, or null if none. */
  earliestNav: string | null;
  /** The confirmed start of the fund's history (ii_nav_history_floors, 0190), or null. */
  historyFloor: string | null;
}

export type SchemeGap = { state: 'complete' } | { state: 'gap'; fromDate: string; toDate: string };

/**
 * The same coverage rule the scheduled job uses (selectiveHistoricalHydrationJob.ts):
 * covered when the earliest stored NAV reaches the required date, where the
 * required date is never earlier than the fund's confirmed history floor. The
 * gap to fetch is [required, earliest stored - 1 day], or [required, today]
 * when the fund has no NAV at all.
 */
export function planSchemeGap(need: Pick<SchemeNeed, 'requiredFrom'>, coverage: SchemeCoverage, today: string): SchemeGap {
  const required = coverage.historyFloor !== null && coverage.historyFloor > need.requiredFrom ? coverage.historyFloor : need.requiredFrom;
  if (coverage.earliestNav !== null && coverage.earliestNav <= required) return { state: 'complete' };
  const toDate = coverage.earliestNav !== null ? addDays(coverage.earliestNav, -1) : today;
  if (toDate < required) return { state: 'complete' };
  return { state: 'gap', fromDate: required, toDate };
}

export interface AttemptInfo {
  lastAttemptedAt: string;
  lastOutcome: string;
  consecutiveFailures: number;
}

/** loaded: nothing missing. pending: missing, not tried yet. loading: partly in. waiting: the source had nothing or failed; we keep trying. */
export type SchemeHistoryState = 'loaded' | 'pending' | 'loading' | 'waiting';

export function classifySchemeHistory(gap: SchemeGap, attempt: AttemptInfo | null): SchemeHistoryState {
  if (gap.state === 'complete') return 'loaded';
  if (attempt && (attempt.lastOutcome === 'fetch_failed' || attempt.lastOutcome === 'unresolvable_identifier') && attempt.consecutiveFailures > 0) return 'waiting';
  if (attempt && attempt.lastOutcome === 'partially_hydrated') return 'loading';
  return 'pending';
}

/** True while a failed / empty attempt is recent enough that the fund is left alone. */
export function inFailureCooldown(attempt: AttemptInfo | null, nowIso: string, minutes: number = NAV_FAILURE_COOLDOWN_MINUTES): boolean {
  if (!attempt || attempt.consecutiveFailures === 0) return false;
  if (attempt.lastOutcome !== 'fetch_failed' && attempt.lastOutcome !== 'unresolvable_identifier') return false;
  return new Date(nowIso).getTime() - new Date(attempt.lastAttemptedAt).getTime() < minutes * 60_000;
}

export interface SchemeHistoryView {
  instrumentId: string;
  schemeName: string;
  state: SchemeHistoryState;
  /** ISO. For a fund with a gap: the date its history is being loaded back to. */
  loadingFrom: string | null;
}

export interface NavHistorySummary {
  total: number;
  loaded: number;
  /** pending + loading */
  fetching: number;
  waiting: number;
  /** One short sentence for the headline, or null when the user holds no funds. Plain words, no ids. */
  headline: string | null;
  /** One line per fund still waiting for data. */
  waitingLines: string[];
}

export function summariseNavHistory(schemes: readonly SchemeHistoryView[]): NavHistorySummary {
  const total = schemes.length;
  const loaded = schemes.filter((s) => s.state === 'loaded').length;
  const waiting = schemes.filter((s) => s.state === 'waiting');
  const fetching = schemes.filter((s) => s.state === 'pending' || s.state === 'loading').length;
  const fundWord = (n: number) => (n === 1 ? 'fund' : 'funds');
  let headline: string | null;
  if (total === 0) headline = null;
  else if (loaded === total) headline = 'History loaded';
  else if (fetching > 0) headline = `Fetching price history for ${fetching} of ${total} ${fundWord(total)}`;
  else headline = `Price history is loaded for ${loaded} of ${total} ${fundWord(total)}; the rest is waiting for data`;
  return { total, loaded, fetching, waiting: waiting.length, headline, waitingLines: waiting.map((s) => `Waiting for data for ${s.schemeName}. We will keep trying.`) };
}

// ---------------------------------------------------------------------------
// Reads (every query filtered by user_id: the caller's own funds only)
// ---------------------------------------------------------------------------
export async function loadUserSchemeNeeds(db: Db, userId: string): Promise<SchemeNeed[]> {
  const snapshots = await fetchAllRows<{ instrument_id: string; as_of_date: string }>(() =>
    db.from('ii_holding_snapshots').select('instrument_id, as_of_date').eq('user_id', userId).order('id', { ascending: true }) as never
  );
  const txns = await fetchAllRows<{ instrument_id: string; transaction_date: string; status: string; source_reference: string | null }>(() =>
    db.from('ii_transactions').select('instrument_id, transaction_date, status, source_reference').eq('user_id', userId).order('id', { ascending: true }) as never
  );
  const { data: inputRows, error: inputError } = await db
    .from('ii_investment_date_inputs')
    .select('instrument_id, investment_date')
    .eq('user_id', userId)
    .in('status', ['awaiting_nav', 'applied']);
  // The table may not exist yet where the code ships before its migration: treat as "no answers", never as a failure.
  const answers = inputError ? [] : ((inputRows ?? []) as unknown as Array<{ instrument_id: string; investment_date: string }>);

  const held = new Set<string>([...snapshots.map((s) => s.instrument_id), ...txns.map((t) => t.instrument_id)]);
  if (held.size === 0) return [];
  const ids = [...held];
  const { data: instrumentData, error: instrumentError } = await db.from('ii_instruments').select('id, instrument_name, instrument_class').in('id', ids);
  if (instrumentError) throw new Error(`ii_instruments: ${instrumentError.message}`);
  const instruments = new Map(((instrumentData ?? []) as unknown as Array<{ id: string; instrument_name: string; instrument_class: string }>).map((i) => [i.id, i]));
  const { data: masterData } = await db.from('ii_scheme_master').select('instrument_id, scheme_name').in('instrument_id', ids).is('effective_to', null);
  const canonical = new Map(((masterData ?? []) as unknown as Array<{ instrument_id: string; scheme_name: string }>).map((r) => [r.instrument_id, r.scheme_name]));

  const needs: SchemeNeed[] = [];
  for (const id of ids) {
    const instrument = instruments.get(id);
    if (!instrument || instrument.instrument_class !== 'mutual_fund') continue;
    const txnDates = txns.filter((t) => t.instrument_id === id && isUsableTransactionStatus(t.status)).map((t) => t.transaction_date);
    const answerDate = answers.filter((a) => a.instrument_id === id).map((a) => a.investment_date).sort()[0];
    const snapDate = snapshots.filter((s) => s.instrument_id === id).map((s) => s.as_of_date).sort()[0];
    // A typed investment date has its derived purchase among the transactions already; either way it is the earliest date that counts.
    const candidates: Array<{ date: string; reason: SchemeNeed['reason'] }> = [];
    if (txnDates.length > 0) {
      const derivedOnly = txns.filter((t) => t.instrument_id === id && isUsableTransactionStatus(t.status)).every((t) => isUserSuppliedInvestmentDateReference(t.source_reference));
      candidates.push({ date: txnDates.sort()[0], reason: derivedOnly ? 'investment_date' : 'transactions' });
    }
    if (answerDate) candidates.push({ date: answerDate, reason: 'investment_date' });
    if (candidates.length === 0 && snapDate) candidates.push({ date: snapDate, reason: 'holding_date' });
    if (candidates.length === 0) continue;
    candidates.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    needs.push({
      instrumentId: id,
      schemeName: canonical.get(id) ?? instrument.instrument_name,
      requiredFrom: addDays(candidates[0].date, -NAV_HISTORY_LEAD_DAYS),
      reason: candidates[0].reason,
    });
  }
  return needs.sort((a, b) => a.schemeName.localeCompare(b.schemeName));
}

export async function loadCoverage(db: Db, instrumentIds: string[]): Promise<Map<string, SchemeCoverage>> {
  const out = new Map<string, SchemeCoverage>();
  const { data: floors } = instrumentIds.length ? await db.from('ii_nav_history_floors').select('instrument_id, floor_date').in('instrument_id', instrumentIds) : { data: [] };
  const floorBy = new Map(((floors ?? []) as unknown as Array<{ instrument_id: string; floor_date: string }>).map((f) => [f.instrument_id, f.floor_date]));
  for (const id of instrumentIds) {
    const { data, error } = await db.from('ii_prices_nav').select('price_date').eq('instrument_id', id).order('price_date', { ascending: true }).limit(1).maybeSingle();
    if (error) throw new Error(`ii_prices_nav: ${error.message}`);
    out.set(id, { earliestNav: (data as { price_date?: string } | null)?.price_date ?? null, historyFloor: floorBy.get(id) ?? null });
  }
  return out;
}

export async function loadAttempts(db: Db, instrumentIds: string[]): Promise<Map<string, AttemptInfo & { attemptsTotal: number; lastSuccessAt: string | null }>> {
  const out = new Map<string, AttemptInfo & { attemptsTotal: number; lastSuccessAt: string | null }>();
  if (instrumentIds.length === 0) return out;
  // The ledger (0198) may not exist yet: no table = never attempted, never a failure.
  const { data, error } = await db.from('ii_nav_hydration_attempts').select('instrument_id, last_attempted_at, last_outcome, consecutive_failures, attempts_total, last_success_at').in('instrument_id', instrumentIds);
  if (error) return out;
  for (const r of (data ?? []) as unknown as Array<{ instrument_id: string; last_attempted_at: string; last_outcome: string; consecutive_failures: number; attempts_total: number; last_success_at: string | null }>) {
    out.set(r.instrument_id, { lastAttemptedAt: r.last_attempted_at, lastOutcome: r.last_outcome, consecutiveFailures: r.consecutive_failures, attemptsTotal: r.attempts_total, lastSuccessAt: r.last_success_at });
  }
  return out;
}

export interface UserNavHistoryStatus {
  schemes: Array<SchemeHistoryView & { gap: SchemeGap }>;
  summary: NavHistorySummary;
}

/** Read-only: where each of the user's funds stands. Never fetches. */
export async function getUserNavHistoryStatus(db: Db, userId: string, today: string): Promise<UserNavHistoryStatus> {
  const needs = await loadUserSchemeNeeds(db, userId);
  const ids = needs.map((n) => n.instrumentId);
  const [coverage, attempts] = await Promise.all([loadCoverage(db, ids), loadAttempts(db, ids)]);
  const schemes = needs.map((n) => {
    const gap = planSchemeGap(n, coverage.get(n.instrumentId)!, today);
    return { instrumentId: n.instrumentId, schemeName: n.schemeName, state: classifySchemeHistory(gap, attempts.get(n.instrumentId) ?? null), loadingFrom: gap.state === 'gap' ? gap.fromDate : null, gap };
  });
  return { schemes, summary: summariseNavHistory(schemes) };
}

// ---------------------------------------------------------------------------
// The batch: a small, time-boxed slice of work
// ---------------------------------------------------------------------------
export interface UserNavHistoryRuntime {
  db: Db;
  adapter: HistoricalNavAdapter;
  deps: UserNavFetchDeps & Partial<Pick<HydrationDeps, 'recordAttempt'>>;
}

/** What a single-fund request reports back to the investment-date flow. */
export type NavFetchSummaryOutcome = UserNavFetchOutcome['status'] | 'rate_limited' | 'nothing_to_fetch';

export interface BatchSchemeResult {
  instrumentId: string;
  schemeName: string;
  outcome: UserNavFetchOutcome['status'];
  rowsInserted: number;
  /** True when another request was already fetching this fund and this one shared its result. */
  shared: boolean;
}

export interface UserNavHistoryBatchResult {
  attempted: BatchSchemeResult[];
  /** Funds with a gap that this call did not (yet) work on. */
  remaining: number;
  rateLimited: boolean;
  /** Another batch for this user was already running; its result is returned. */
  sharedBatch: boolean;
  status: UserNavHistoryStatus;
}

async function runPool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const item = items[next++];
      await worker(item);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, lane));
}

function ledgerOutcome(o: UserNavFetchOutcome): HydrationAttemptRecord['lastOutcome'] | null {
  switch (o.status) {
    case 'fetched':
      return o.truncated ? 'partially_hydrated' : o.rowsInserted > 0 ? 'hydrated' : 'already_covered';
    case 'no_data':
    case 'failed':
      return 'fetch_failed';
    case 'unresolvable':
      return 'unresolvable_identifier';
    case 'disabled':
      return null; // the switch being off is not the fund's failure
  }
}

async function runBatchInner(args: {
  userId: string;
  today: string;
  nowIso: string;
  runtime: UserNavHistoryRuntime;
  maxSchemes: number;
  concurrency: number;
  deadlineMs: number;
  onlyInstrumentIds?: readonly string[];
  maxPerHour: number;
}): Promise<UserNavHistoryBatchResult> {
  const { userId, today, nowIso, runtime } = args;
  const { db } = runtime;
  const needsAll = await loadUserSchemeNeeds(db, userId);
  // Bounded to the caller's own funds: a requested id that is not one of them is simply not in the candidate set.
  const only = args.onlyInstrumentIds ? new Set(args.onlyInstrumentIds) : null;
  const needs = needsAll.filter((n) => only === null || only.has(n.instrumentId));
  const ids = needsAll.map((n) => n.instrumentId);
  const [coverage, attempts] = await Promise.all([loadCoverage(db, ids), loadAttempts(db, ids)]);

  const withGap = needs
    .map((n) => ({ need: n, gap: planSchemeGap(n, coverage.get(n.instrumentId)!, today), attempt: attempts.get(n.instrumentId) ?? null }))
    .filter((x): x is { need: SchemeNeed; gap: Extract<SchemeGap, { state: 'gap' }>; attempt: (typeof x)['attempt'] } => x.gap.state === 'gap');
  // Never attempted first, then the longest ago; funds in a failure cooldown are left alone.
  const eligible = withGap
    .filter((x) => !inFailureCooldown(x.attempt, nowIso))
    .sort((a, b) => (a.attempt?.lastAttemptedAt ?? '') < (b.attempt?.lastAttemptedAt ?? '') ? -1 : (a.attempt?.lastAttemptedAt ?? '') > (b.attempt?.lastAttemptedAt ?? '') ? 1 : 0);

  // Per-user rate limit, counted from the user's own audit events (the FDH-5 password-limiter shape).
  const since = new Date(new Date(nowIso).getTime() - 60 * 60 * 1000).toISOString();
  const { data: events } = await db.from('ii_audit_events').select('created_at').eq('user_id', userId).eq('event_type', 'nav_price_update').contains('metadata', { kind: USER_NAV_FETCH_AUDIT_KIND }).gte('created_at', since);
  const limit = checkUserNavFetchRateLimit((events ?? []) as unknown as Array<{ created_at: string }>, nowIso, args.maxPerHour);
  const budget = limit.allowed ? Math.min(args.maxSchemes, args.maxPerHour - limit.fetchesInWindow) : 0;
  const selected = eligible.slice(0, Math.max(0, budget));

  const attempted: BatchSchemeResult[] = [];
  const startedAt = Date.now();
  await runPool(selected, args.concurrency, async (x) => {
    const { need, gap } = x;
    try {
      const run = singleFlight(`nav-fetch:${need.instrumentId}:${gap.fromDate}:${gap.toDate}`, async () => {
        const outcome = await fetchNavForOneInstrument({
          instrumentId: need.instrumentId,
          fromDate: gap.fromDate,
          toDate: gap.toDate,
          existingEarliest: coverage.get(need.instrumentId)?.earliestNav ?? null,
          adapter: runtime.adapter,
          deps: runtime.deps,
          deadlineMs: Math.max(1_000, args.deadlineMs - (Date.now() - startedAt)),
        });
        // Only the run that actually called the source records and audits it (a shared waiter does not).
        await recordFetch({ userId, need, gap, outcome, prior: x.attempt, nowIso, runtime });
        return outcome;
      });
      const outcome = await run.promise;
      attempted.push({ instrumentId: need.instrumentId, schemeName: need.schemeName, outcome: outcome.status, rowsInserted: 'rowsInserted' in outcome ? outcome.rowsInserted : 0, shared: run.shared });
    } catch (e) {
      // Failure isolation: whatever went wrong with this fund, the others carry on.
      attempted.push({ instrumentId: need.instrumentId, schemeName: need.schemeName, outcome: 'failed', rowsInserted: 0, shared: false });
      console.error('[investment-intelligence] user NAV history fetch failed for one fund', e instanceof Error ? e.message : e);
    }
  });

  const status = await getUserNavHistoryStatus(db, userId, today);
  return {
    attempted,
    remaining: status.schemes.filter((s) => s.gap.state === 'gap').length,
    rateLimited: !limit.allowed,
    sharedBatch: false,
    status,
  };
}

async function recordFetch(args: {
  userId: string;
  need: SchemeNeed;
  gap: Extract<SchemeGap, { state: 'gap' }>;
  outcome: UserNavFetchOutcome;
  prior: (AttemptInfo & { attemptsTotal?: number; lastSuccessAt?: string | null }) | null;
  nowIso: string;
  runtime: UserNavHistoryRuntime;
}): Promise<void> {
  const { userId, need, gap, outcome, prior, nowIso, runtime } = args;
  const ledger = ledgerOutcome(outcome);
  if (ledger !== null && runtime.deps.recordAttempt) {
    const ok = ledger === 'hydrated' || ledger === 'already_covered';
    const record: HydrationAttemptRecord = {
      instrumentId: need.instrumentId,
      lastAttemptedAt: nowIso,
      lastOutcome: ledger,
      consecutiveFailures: ok ? 0 : (prior?.consecutiveFailures ?? 0) + 1,
      attemptsTotal: (prior?.attemptsTotal ?? 0) + 1,
      lastSuccessAt: ok ? nowIso : prior?.lastSuccessAt ?? null,
    };
    try {
      await runtime.deps.recordAttempt(record, `user-triggered: ${outcome.detail}`);
    } catch {
      /* a lost ledger record only means the next run orders it as not attempted */
    }
  }
  try {
    await emitAuditEvent({
      userId,
      eventType: 'nav_price_update',
      subjectType: 'ii_instruments',
      subjectId: need.instrumentId,
      actorType: 'user',
      actorId: userId,
      metadata: {
        kind: USER_NAV_FETCH_AUDIT_KIND,
        outcome: outcome.status,
        window: { from: gap.fromDate, to: gap.toDate },
        rowsInserted: 'rowsInserted' in outcome ? outcome.rowsInserted : 0,
        reason: need.reason,
      },
    });
  } catch {
    /* the audit trail is best effort here; the rate limit then simply undercounts */
  }
}

/**
 * One time-boxed slice of the user's own missing history. Concurrent calls for
 * the same user share one batch. Never throws for a source problem.
 */
export async function runUserNavHistoryBatch(args: {
  userId: string;
  today: string;
  runtime: UserNavHistoryRuntime;
  nowIso?: string;
  maxSchemes?: number;
  concurrency?: number;
  deadlineMs?: number;
  onlyInstrumentIds?: readonly string[];
  maxPerHour?: number;
}): Promise<UserNavHistoryBatchResult> {
  const run = singleFlight(`nav-batch:${args.userId}`, () =>
    runBatchInner({
      userId: args.userId,
      today: args.today,
      nowIso: args.nowIso ?? new Date().toISOString(),
      runtime: args.runtime,
      maxSchemes: args.maxSchemes ?? NAV_BATCH_MAX_SCHEMES,
      concurrency: args.concurrency ?? NAV_BATCH_CONCURRENCY,
      deadlineMs: args.deadlineMs ?? USER_NAV_FETCH_DEADLINE_MS,
      onlyInstrumentIds: args.onlyInstrumentIds,
      maxPerHour: args.maxPerHour ?? USER_NAV_FETCH_MAX_PER_HOUR,
    })
  );
  const result = await run.promise;
  return run.shared ? { ...result, sharedBatch: true } : result;
}

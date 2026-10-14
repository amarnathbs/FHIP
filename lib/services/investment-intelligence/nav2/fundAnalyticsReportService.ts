// NAV2 Stage 2 -- generate, list and read the Fund analytics report (Premium only; a separate report under Reports).
//
// Order of checks in generateFundAnalyticsReport (each one fails CLOSED and stops):
//   1. the feature switch (job-control row nav2_fund_analytics; OFF unless the row exists and is enabled)  -> 'disabled'
//   2. Premium (getPlanTier on the service client, honouring the entitlement validity window)             -> 'forbidden'
//   2b. IDEMPOTENCY (release candidate B3): a request that carries a key already used by this person returns the report issued for that key
//      ('ready', replayed) and does nothing else; the same key with a DIFFERENT request is 'idempotency_conflict'. The key is stored with the
//      report (migration 0281, unique per person), so repeated clicks, a screen that asks again while a report is prepared in steps and a
//      retried request all end with ONE issued report.
//   3. the report NAV gate (price history still being prepared; starts the bounded retry + the user fetch) -> 'preparing'
//      SCOPE (B2): the gate and the planner look only at the funds THIS report covers. With a choice (fundIds) they look at exactly those
//      funds, so a fund the person holds but did not select can never keep the selected report in 'preparing'. With no choice a person who holds
//      more than one report covers is not gated yet (they must choose first); a person at or under the cap is gated on every fund held.
//   3b. ONLY when the nav2_trigger_planner switch is ON: the history the CHOSEN PERIOD needs (the NAV2 required window per
//      held scheme) is planned read-only; if some of it is missing and its fetch could be started, the answer is 'preparing'
//      (a failed attempt goes into the existing cooldown, so this cannot hold forever; a fetch that could not be scheduled
//      never holds, and neither does one the NAV fetch kill switch would refuse to run). Switch OFF: this step does not exist and generation behaves exactly as before.
//   3c. ONE REPORT COVERS AT MOST FUND_ANALYTICS_MAX_FUNDS (20) FUNDS (PO decision 07-10-2026; the platform kills a request at 28 s). A person who holds
//      more must choose which funds go in: without a choice the answer is 'select_funds' (the plain refusal, the funds with their values and the
//      suggested choice: the 20 largest holdings); a choice that is empty, longer than the cap, repeats a fund or names a fund the person does not hold
//      is 'invalid_selection' (one message for all of them, so another household's fund ids can never be probed). The choice is stored in the manifest.
//   4. the household holds at least one Indian mutual fund this report covers                              -> 'no_funds'
//   5. TIME BUDGET (one clock for the whole request, from route entry, see lib/config/nav2/reportLimits.ts): engine work that would not finish
//      inside GENERATION_BUDGET_MS is not started; the funds that fit are prepared into the shared cache and the answer is 'in_steps' (retry; the
//      next generation carries on where this one stopped). If the engine ends too late to persist inside REQUEST_DEADLINE_MS the finished
//      bundles are already cached and the answer is 'in_steps' with every fund ready, so the next call only persists. Nothing partial is ever issued.
//   6. build the report (pure), reuse the shared scheme-performance cache, persist the pinned row.
//
// The persisted row is IMMUTABLE (migration 0261): a regenerated report is a NEW version
// (version_number = previous + 1, supersedes_report_id = previous); an earlier version is never edited.
// Its NAV range per fund is pinned in nav2_report_nav_dependencies so the NAV retention job cannot delete the
// observations the report rests on.

import type { SupabaseClient } from '@supabase/supabase-js';
import { isReportPeriodChoice, type ReportPeriodChoice } from '@/lib/engines/nav2/analysisSpec';
import { buildFundAnalyticsReport, compactSchemeFamily, manifestChecksum, schemeBundleCacheKey, schemeBundleCacheParts, type FundAnalyticsInput, type FundAnalyticsManifest, type FundAnalyticsReport } from '@/lib/engines/nav2/fundAnalyticsReport';
import { createHash } from 'node:crypto';
import { CACHE_WRITE_RESERVE_MS, ENGINE_MS_PER_UNCACHED_FUND, FUND_ANALYTICS_MAX_FUNDS, GENERATION_BUDGET_MS, MIN_PERSIST_MS, REQUEST_DEADLINE_MS } from '@/lib/config/nav2/reportLimits';
import { invalidSelectionMessage, largeReportStepsMessage, tooManyFundsMessage } from '@/lib/engines/nav2/reportWording';
import { getPlanTier } from '@/lib/services/entitlements';
import type { SupabaseServerClient } from '@/lib/services/dashboardData';
import { checkReportNavHistoryGate, NAV_FETCH_KILL_SWITCH_JOB_KEY, REPORT_NAV_RETRY_WINDOW_MINUTES, waitingBody, type ReportNavGate } from '../pc6/reportNavHistoryGate';
import { kickUserNavHistory } from '../pc6/userNavHistoryKick';
import { loadFundAnalyticsInput, type FundAnalyticsLoadResult, type FundChoiceCandidate } from './fundAnalyticsLoader';
import { isNav2FlagOn, NAV2_JOB_KEYS } from './nav2Flags';
import { readCachedBundles, writeCachedBundles, type CacheWrite } from './nav2ResultCacheStore';
import { kickNav2ReportPeriod, planForReportPeriod } from './nav2TriggerRunner';
import type { Nav2WindowPlan } from './windowPlannerService';

export const FUND_ANALYTICS_DISABLED_MESSAGE = 'The Fund analytics report is not available yet.';
export const FUND_ANALYTICS_PREMIUM_MESSAGE = 'The Fund analytics report is part of the Premium plan.';
export const FUND_ANALYTICS_NO_FUNDS_MESSAGE = 'The Fund analytics report covers Indian mutual funds. Upload a mutual fund statement to see it.';

export interface StoredReportSummary {
  id: string;
  versionNumber: number;
  asOfDate: string;
  schemeCount: number;
  createdAt: string;
  periodChoice: ReportPeriodChoice | null;
}

export type GenerateResult =
  | { status: 'disabled'; message: string }
  | { status: 'forbidden'; message: string }
  | { status: 'preparing'; message: string; waiting: ReturnType<typeof waitingBody> }
  | { status: 'no_funds'; message: string }
  | { status: 'select_funds'; message: string; max: number; heldFundCount: number; candidates: FundChoiceCandidate[]; suggestedIds: string[] }
  | { status: 'invalid_selection'; message: string }
  | { status: 'in_steps'; message: string; ready: number; total: number; retryAfterSeconds: number }
  | { status: 'idempotency_conflict'; message: string }
  | { status: 'ready'; report: StoredReportSummary; cache: { hits: number; computed: number; stored: number }; replayed?: boolean };

/** The idempotency key a client may send (a UUID fits): 16 to 64 letters, digits, underscore or hyphen. Anything else is refused before any work. */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
export const IDEMPOTENCY_CONFLICT_MESSAGE = 'This request key was already used for a different report request. Start a new request.';

/** SHA-256 of what the person asked for: the period and the sorted fund choice (null = every fund held). Two requests with one key must have one fingerprint. */
export function requestFingerprint(period: ReportPeriodChoice, fundIds: readonly string[] | null): string {
  const ids = fundIds === null ? null : [...fundIds].sort();
  return createHash('sha256').update(JSON.stringify({ period, funds: ids }), 'utf8').digest('hex');
}

export interface FundAnalyticsDeps {
  isFlagOn: (admin: SupabaseClient) => Promise<boolean>;
  isPremium: (userId: string, admin: SupabaseClient) => Promise<boolean>;
  gate: (args: { admin: SupabaseClient; userId: string; today: string; period?: ReportPeriodChoice; onlyInstrumentIds?: readonly string[] | null; skipIfMoreHeldThan?: number }) => Promise<ReportNavGate>;
  load: (args: Parameters<typeof loadFundAnalyticsInput>[0]) => Promise<FundAnalyticsLoadResult>;
  nowIso: () => string;
  /** Milliseconds clock for the time budget (injectable so a test can make a generation slow). */
  nowMs: () => number;
  /** The nav2_trigger_planner switch (OFF unless its row exists and is enabled). */
  plannerOn: (admin: SupabaseClient) => Promise<boolean>;
  /** Read-only: the NAV2 window plan the chosen period needs for this user. */
  planPeriod: (args: { admin: SupabaseClient; userId: string; period: ReportPeriodChoice; today: string; onlyInstrumentIds?: readonly string[] | null }) => Promise<Nav2WindowPlan>;
  /** Start the planned fetch after the response (only for the funds the report covers when `onlyInstrumentIds` is given); false when it could not be scheduled. */
  kickPeriod: (userId: string, period: ReportPeriodChoice, onlyInstrumentIds?: readonly string[] | null) => boolean;
  /** The report already issued for this person and key, or null (idempotency). */
  findByKey: (admin: SupabaseClient, userId: string, key: string) => Promise<{ summary: StoredReportSummary; fingerprint: string | null } | null>;
  /**
   * Whether the NAV fetch kill switch (pc6_selective_historical_hydration) is ON. With it OFF the planned fetch can never run and leaves no attempt
   * record, so no cooldown would ever release the report: holding for it would hold FOREVER (found on DEV, Stage 3). Anything but a clean "ON" is OFF.
   */
  fetchingEnabled: (admin: SupabaseClient) => Promise<boolean>;
}

/**
 * What the gate starts when a fund the report needs is still missing history (B2). With a choice of funds the fetch is for THOSE funds only (through the NAV2 plan
 * when its switch is on, through the existing user-scoped fetch restricted to them otherwise); with no choice it is the previous behaviour for every fund held.
 * The background held-scheme planner (after a statement is accepted) is separate and still plans every fund held.
 */
export function gateKickFor(onlyInstrumentIds: readonly string[] | null | undefined, period: ReportPeriodChoice | undefined): (userId: string) => boolean {
  if (!onlyInstrumentIds || onlyInstrumentIds.length === 0) return kickUserNavHistory;
  return (userId) => kickNav2ReportPeriod(userId, period ?? 'since_first_held', {}, onlyInstrumentIds);
}

const defaultDeps: FundAnalyticsDeps = {
  isFlagOn: (admin) => isNav2FlagOn(admin, NAV2_JOB_KEYS.fundAnalytics),
  isPremium: async (userId, admin) => (await getPlanTier(userId, admin as unknown as SupabaseServerClient)) === 'premium',
  gate: ({ admin, userId, today, period, onlyInstrumentIds, skipIfMoreHeldThan }) => checkReportNavHistoryGate({ db: admin as never, userId, today, createAnchor: true, kick: gateKickFor(onlyInstrumentIds, period), onlyInstrumentIds, skipIfMoreHeldThan }),
  load: loadFundAnalyticsInput,
  nowIso: () => new Date().toISOString(),
  nowMs: () => Date.now(),
  plannerOn: (admin) => isNav2FlagOn(admin, NAV2_JOB_KEYS.triggerPlanner),
  planPeriod: ({ admin, userId, period, today, onlyInstrumentIds }) => planForReportPeriod(admin, userId, period, today, onlyInstrumentIds ?? null),
  kickPeriod: (userId, period, onlyInstrumentIds) => kickNav2ReportPeriod(userId, period, {}, onlyInstrumentIds ?? null),
  findByKey: findReportByIdempotencyKey,
  fetchingEnabled: async (admin) => {
    try {
      const { data, error } = await admin.from('ii_reference_job_control').select('enabled').eq('job_key', NAV_FETCH_KILL_SWITCH_JOB_KEY).maybeSingle();
      return !error && (data as { enabled?: boolean } | null)?.enabled === true;
    } catch {
      return false;
    }
  },
};

/** Parses the requested period; anything unrecognised is the default (never an error that leaks internals). */
export function parsePeriodChoice(raw: unknown): ReportPeriodChoice {
  return isReportPeriodChoice(raw) ? raw : 'since_first_held';
}

interface ReportRow {
  id: string;
  version_number: number;
  as_of_date: string;
  scheme_count: number;
  created_at: string;
  report_json?: { periodChoice?: string } | null;
}

const toSummary = (r: ReportRow): StoredReportSummary => ({
  id: r.id,
  versionNumber: r.version_number,
  asOfDate: String(r.as_of_date).slice(0, 10),
  schemeCount: r.scheme_count,
  createdAt: r.created_at,
  periodChoice: r.report_json?.periodChoice && isReportPeriodChoice(r.report_json.periodChoice) ? r.report_json.periodChoice : null,
});

export async function generateFundAnalyticsReport(args: {
  userId: string;
  sessionClient: SupabaseServerClient;
  adminClient: SupabaseClient;
  periodChoice?: unknown;
  /** The funds to cover (instrument ids), for a person who holds more than one report covers; null / absent = every fund held. */
  fundIds?: readonly string[] | null;
  /** ISO date; defaults to today (UTC). */
  asOfDate?: string;
  /**
   * The client's idempotency key for ONE intended report (already validated against IDEMPOTENCY_KEY_PATTERN by the route). Absent = no
   * replay protection, exactly the previous behaviour for an older client.
   */
  idempotencyKey?: string | null;
  /** When the REQUEST began (route entry, milliseconds). Defaults to now. Every time budget in this function is measured from it. */
  requestStartedMs?: number;
  deps?: Partial<FundAnalyticsDeps>;
}): Promise<GenerateResult> {
  const deps = { ...defaultDeps, ...(args.deps ?? {}) };
  const startedMs = args.requestStartedMs ?? deps.nowMs();
  const admin = args.adminClient;
  if (!(await deps.isFlagOn(admin))) return { status: 'disabled', message: FUND_ANALYTICS_DISABLED_MESSAGE };
  if (!(await deps.isPremium(args.userId, admin))) return { status: 'forbidden', message: FUND_ANALYTICS_PREMIUM_MESSAGE };

  // a choice that can never be valid is refused before any work (and after the Premium check, so a free user is told about Premium first)
  const requested = args.fundIds ?? null;
  if (requested !== null && (requested.length === 0 || requested.length > FUND_ANALYTICS_MAX_FUNDS || new Set(requested).size !== requested.length)) {
    return { status: 'invalid_selection', message: invalidSelectionMessage(FUND_ANALYTICS_MAX_FUNDS) };
  }

  const nowIso = deps.nowIso();
  const asOfDate = args.asOfDate ?? nowIso.slice(0, 10);
  const periodChoice = parsePeriodChoice(args.periodChoice);

  // ---- idempotency: one key, one issued report ---------------------------------------------------------------------
  const idem = args.idempotencyKey ? { key: args.idempotencyKey, fingerprint: requestFingerprint(periodChoice, requested) } : null;
  if (idem) {
    const prior = await deps.findByKey(admin, args.userId, idem.key);
    if (prior) {
      if (prior.fingerprint !== idem.fingerprint) return { status: 'idempotency_conflict', message: IDEMPOTENCY_CONFLICT_MESSAGE };
      return { status: 'ready', report: prior.summary, cache: { hits: 0, computed: 0, stored: 0 }, replayed: true };
    }
  }

  // ---- the price-history gate and the planner look ONLY at the funds this report covers (B2) -------------------------
  const gate = await deps.gate({ admin, userId: args.userId, today: asOfDate, period: periodChoice, onlyInstrumentIds: requested, skipIfMoreHeldThan: requested === null ? FUND_ANALYTICS_MAX_FUNDS : undefined });
  if (gate.hold) return { status: 'preparing', message: gate.headline ?? 'Price history is being prepared.', waiting: waitingBody(gate) };

  if (!gate.skippedForChoice && (await deps.plannerOn(admin))) {
    const preparing = await planCoveredFunds({ deps, admin, userId: args.userId, periodChoice, asOfDate, instrumentIds: requested, giveUpIds: (gate.unavailable ?? []).map((f) => f.instrumentId) });
    if (preparing) return preparing;
  }

  let loaded = await deps.load({ userId: args.userId, sessionClient: args.sessionClient, adminClient: admin, asOfDate, displayCurrency: 'INR', periodChoice, gate, selection: { max: FUND_ANALYTICS_MAX_FUNDS, chosen: requested } });
  if (loaded.selectionProblem === 'invalid') return { status: 'invalid_selection', message: invalidSelectionMessage(FUND_ANALYTICS_MAX_FUNDS) };
  if (loaded.selectionProblem === 'needed' && loaded.choice) {
    const held = loaded.choice.candidates.length;
    return { status: 'select_funds', message: tooManyFundsMessage(held, FUND_ANALYTICS_MAX_FUNDS), max: FUND_ANALYTICS_MAX_FUNDS, heldFundCount: held, candidates: loaded.choice.candidates, suggestedIds: loaded.choice.suggestedIds };
  }
  if (!loaded.input || loaded.input.schemes.length === 0) return { status: 'no_funds', message: FUND_ANALYTICS_NO_FUNDS_MESSAGE };

  // The gate was skipped because the person holds more funds than one report covers and had not chosen, but the report covers at most the
  // cap in the end (some holdings are not personal funds). Gate the funds the report really covers now, and only then build.
  if (gate.skippedForChoice) {
    const covered = loaded.input.schemes.map((h) => h.instrumentId);
    const scoped = await deps.gate({ admin, userId: args.userId, today: asOfDate, period: periodChoice, onlyInstrumentIds: covered });
    if (scoped.hold) return { status: 'preparing', message: scoped.headline ?? 'Price history is being prepared.', waiting: waitingBody(scoped) };
    if (await deps.plannerOn(admin)) {
      const preparing = await planCoveredFunds({ deps, admin, userId: args.userId, periodChoice, asOfDate, instrumentIds: covered, giveUpIds: (scoped.unavailable ?? []).map((f) => f.instrumentId) });
      if (preparing) return preparing;
    }
    loaded = await deps.load({ userId: args.userId, sessionClient: args.sessionClient, adminClient: admin, asOfDate, displayCurrency: 'INR', periodChoice, gate: scoped, selection: { max: FUND_ANALYTICS_MAX_FUNDS, chosen: covered } });
    if (!loaded.input || loaded.input.schemes.length === 0) return { status: 'no_funds', message: FUND_ANALYTICS_NO_FUNDS_MESSAGE };
  }

  // ---- reuse the shared per-scheme cache --------------------------------------------------------------------------
  const base: FundAnalyticsInput = loaded.input;
  const keyed = base.schemes.map((h) => ({ h, key: schemeBundleCacheKey(base, h) }));
  const cached = await readCachedBundles(admin, keyed.map((k) => k.key));
  // ---- time budget: never start engine work the platform would kill --------------------------------------------------
  const uncachedKeyed = keyed.filter((k) => !cached.has(k.key));
  const elapsedMs = deps.nowMs() - startedMs;
  const affordable = Math.max(0, Math.floor((GENERATION_BUDGET_MS - elapsedMs) / ENGINE_MS_PER_UNCACHED_FUND));
  if (uncachedKeyed.length > affordable) {
    // This call will NOT issue the report, so no 2 MB persist follows, only a small cache write: engine work may run until the deadline minus that write.
    // PROGRESS GUARANTEE: on a slow database the reads before the engine can use most of the budget (measured on DEV from a development machine: 17 to 19 s).
    // Without this a call would start nothing and the report would never converge; with it every call prepares at least one fund whenever one fits at all.
    const stepRoom = Math.max(0, Math.floor((REQUEST_DEADLINE_MS - CACHE_WRITE_RESERVE_MS - elapsedMs) / ENGINE_MS_PER_UNCACHED_FUND));
    const slice = uncachedKeyed.slice(0, Math.max(affordable, stepRoom));
    if (slice.length > 0) {
      // the engine's per-fund results do not depend on the other funds, so a report of just this slice yields exactly the entries a full report would
      const partial = buildFundAnalyticsReport({ ...base, selection: undefined, calculatedAt: deps.nowIso(), schemes: slice.map(({ h }) => ({ ...h, cachedScheme: null })) });
      const partialWrites: CacheWrite[] = [];
      for (const { h, key } of slice) {
        const block = partial.report.schemes.find((b) => b.instrumentId === h.instrumentId);
        if (block) partialWrites.push({ key, parts: schemeBundleCacheParts(base, h), payload: compactSchemeFamily(block.analytics.scheme) });
      }
      if (partialWrites.length) await writeCachedBundles(admin, partialWrites);
    }
    const ready = cached.size + slice.length;
    return { status: 'in_steps', message: largeReportStepsMessage(ready, keyed.length), ready, total: keyed.length, retryAfterSeconds: 60 };
  }
  const withCache: FundAnalyticsInput = { ...base, calculatedAt: deps.nowIso(), schemes: keyed.map(({ h, key }) => ({ ...h, cachedScheme: cached.get(key) ?? null })) };
  const { report, manifest } = buildFundAnalyticsReport(withCache);

  const writes: CacheWrite[] = [];
  for (const { h, key } of keyed) {
    if (cached.has(key)) continue;
    const block = report.schemes.find((b) => b.instrumentId === h.instrumentId);
    if (block) writes.push({ key, parts: schemeBundleCacheParts(base, h), payload: compactSchemeFamily(block.analytics.scheme) });
  }
  // the finished bundles are saved FIRST: whatever happens next, this work is never lost and the next call resumes from it
  const stored = writes.length ? await writeCachedBundles(admin, writes) : 0;

  // The engine ended too late to persist a 2 MB report before the deadline: do not start a write the platform may cut. Nothing is issued; every
  // fund is ready in the cache, so the next call (same key) only persists.
  if (deps.nowMs() - startedMs > REQUEST_DEADLINE_MS - MIN_PERSIST_MS) {
    return { status: 'in_steps', message: largeReportStepsMessage(keyed.length, keyed.length), ready: keyed.length, total: keyed.length, retryAfterSeconds: 2 };
  }

  const persisted = await persistReport({ admin, userId: args.userId, report, manifest, nowIso, idempotency: idem });
  return { status: 'ready', report: persisted.report, cache: { hits: cached.size, computed: writes.length, stored }, ...(persisted.replayed ? { replayed: true } : {}) };
}

/** Step 3b: when the planner switch is ON, plan the history the period needs for the funds this report covers; 'preparing' when a fetch was started. */
async function planCoveredFunds(a: { deps: FundAnalyticsDeps; admin: SupabaseClient; userId: string; periodChoice: ReportPeriodChoice; asOfDate: string; instrumentIds: readonly string[] | null; giveUpIds?: readonly string[] }): Promise<GenerateResult | null> {
  let plan: Nav2WindowPlan | null = null;
  try {
    plan = await a.deps.planPeriod({ admin: a.admin, userId: a.userId, period: a.periodChoice, today: a.asOfDate, onlyInstrumentIds: a.instrumentIds });
  } catch {
    plan = null; // a planning problem never blocks the report: it proceeds and says honestly what history it has
  }
  // LIVELOCK GUARD (found on DEV with a source that kept timing out): a fund the price-history gate has already given up on (retry window over, attempts used,
  // identifier unresolvable, known coverage gap) is not waited for here either. The report is issued and marks that fund's figures not available, exactly as the
  // gate says. Without this the planner kept asking for the same failing fetch and the person's report never came.
  const giveUp = new Set(a.giveUpIds ?? []);
  if (plan && giveUp.size > 0) plan = { ...plan, fetch: { ...plan.fetch, toFetch: plan.fetch.toFetch.filter((f) => !giveUp.has(f.instrumentId)), deferred: plan.fetch.deferred.filter((id) => !giveUp.has(id)) } };
  const kickIds = giveUp.size > 0 && plan ? (a.instrumentIds ?? plan.windows.map((w) => w.instrumentId)).filter((id) => !giveUp.has(id)) : a.instrumentIds;
  if (plan && plan.fetch.toFetch.length > 0 && (await a.deps.fetchingEnabled(a.admin)) && a.deps.kickPeriod(a.userId, a.periodChoice, kickIds)) {
    const ids = plan.fetch.toFetch.map((f) => f.instrumentId);
    const { data: named } = await a.admin.from('ii_instruments').select('id, instrument_name').in('id', ids);
    const names = new Map(((named ?? []) as Array<{ id: string; instrument_name: string }>).map((r) => [r.id, r.instrument_name]));
    const total = plan.windows.length;
    const loadedCount = total - plan.fetch.toFetch.length - plan.fetch.deferred.length - plan.fetch.inCooldown.length;
    const headline = `Price history for the period you chose is being prepared (${Math.max(0, loadedCount)} of ${total} ${total === 1 ? 'fund' : 'funds'} ready)`;
    return {
      status: 'preparing',
      message: headline,
      waiting: { waiting: true, headline, loaded: Math.max(0, loadedCount), total, waitingFunds: ids.map((id) => names.get(id) ?? 'A fund you hold'), unavailableFunds: [], retryWindowMinutes: REPORT_NAV_RETRY_WINDOW_MINUTES },
    };
  }
  return null;
}

/** The report already issued for this person and key (idempotency), with the fingerprint of the request it answered. Null when none. */
export async function findReportByIdempotencyKey(admin: SupabaseClient, userId: string, key: string): Promise<{ summary: StoredReportSummary; fingerprint: string | null } | null> {
  const { data, error } = await admin
    .from('nav2_fund_analytics_reports')
    .select('id, version_number, as_of_date, scheme_count, created_at, request_fingerprint, period_choice:report_json->>periodChoice')
    .eq('user_id', userId)
    .eq('idempotency_key', key)
    .maybeSingle();
  // An error (for example the column does not exist because migration 0281 is not applied) means no key can have been stored: no replay to find.
  if (error || !data) return null;
  const r = data as unknown as ReportRow & { request_fingerprint: string | null; period_choice: string | null };
  return { summary: toSummary({ ...r, report_json: { periodChoice: r.period_choice ?? undefined } }), fingerprint: r.request_fingerprint ?? null };
}

/** How many times a generation tries to take the next version number when other generations for the same user take it first. */
export const PERSIST_VERSION_ATTEMPTS = 10;

/**
 * Persists the next version of the pinned report and its NAV dependency manifest. Retries on a version race (several simultaneous generations).
 *
 * IDEMPOTENCY (migration 0281): with a key, a unique violation on (person, key) means another request with the same key already issued the
 * report: that report is returned (`replayed`) and no second one exists. NO PARTIAL ISSUE: if the NAV range of any fund cannot be pinned the
 * report row just inserted is deleted again (it is this call's own row, children cascade), so nothing that looks final but is unprotected stays.
 */
export async function persistReport(args: { admin: SupabaseClient; userId: string; report: FundAnalyticsReport; manifest: FundAnalyticsManifest; nowIso: string; idempotency?: { key: string; fingerprint: string } | null }): Promise<{ report: StoredReportSummary; replayed: boolean }> {
  const { admin, userId, report, manifest } = args;
  for (let attempt = 0; attempt < PERSIST_VERSION_ATTEMPTS; attempt++) {
    const { data: prev, error: perr } = await admin
      .from('nav2_fund_analytics_reports')
      .select('id, version_number')
      .eq('user_id', userId)
      .order('version_number', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (perr) throw new Error('Could not read earlier report versions.');
    const prevRow = prev as { id: string; version_number: number } | null;
    const row = {
      user_id: userId,
      version_number: (prevRow?.version_number ?? 0) + 1,
      supersedes_report_id: prevRow?.id ?? null,
      as_of_date: report.asOfDate,
      reporting_currency: report.displayCurrency,
      scheme_count: report.schemes.length,
      policy_version: report.policyVersion,
      engine_version: report.engineVersion,
      risk_free_dataset_version: manifest.riskFree?.datasetVersion ?? null,
      report_json: report,
      manifest_json: manifest,
      manifest_checksum: manifestChecksum(manifest),
      state_counts: report.stateCounts,
      ...(args.idempotency ? { idempotency_key: args.idempotency.key, request_fingerprint: args.idempotency.fingerprint } : {}),
    };
    let { data: ins, error: ierr } = await admin.from('nav2_fund_analytics_reports').insert(row).select('id, version_number, as_of_date, scheme_count, created_at').single();
    if (ierr && args.idempotency && ['42703', 'PGRST204'].includes(String((ierr as { code?: string }).code ?? ''))) {
      // DEPLOY ORDER: this code ran before migration 0281 (the key columns do not exist yet). The report is still issued, without replay protection,
      // exactly as an older client would get it; the release order (database first) means this is a transient state, never the intended one.
      console.warn('[fund-analytics] idempotency columns missing (migration 0281 not applied): issuing the report without a key');
      const plain: Record<string, unknown> = { ...row };
      delete plain.idempotency_key;
      delete plain.request_fingerprint;
      ({ data: ins, error: ierr } = await admin.from('nav2_fund_analytics_reports').insert(plain).select('id, version_number, as_of_date, scheme_count, created_at').single());
    }
    if (ierr) {
      // 23505 on the idempotency index: the same key already issued a report (a repeated click, a retry, a racing request). Return THAT report.
      if ((ierr as { code?: string }).code === '23505' && args.idempotency && /idempotency/i.test(String((ierr as { message?: string }).message ?? '') + String((ierr as { details?: string }).details ?? ''))) {
        const winner = await findReportByIdempotencyKey(admin, userId, args.idempotency.key);
        if (winner) return { report: winner.summary, replayed: true };
        throw new Error('The report could not be saved.');
      }
      // 23505 = another generation took this version number first: read again and take the next one.
      if ((ierr as { code?: string }).code === '23505' && attempt < PERSIST_VERSION_ATTEMPTS - 1) {
        await new Promise((r) => setTimeout(r, 15 + Math.floor(Math.random() * 60))); // a little jitter so the racers do not collide again in step
        continue;
      }
      throw new Error('The report could not be saved.');
    }
    const saved = ins as ReportRow;
    const deps = manifest.schemes
      .filter((s) => s.navRange.to)
      .map((s) => ({ report_id: saved.id, instrument_id: s.instrumentId, nav_date_from: s.navRange.from, nav_date_to: s.navRange.to as string, series_checksum: s.navSeries.checksum }));
    if (deps.length) {
      const { error: derr } = await admin.from('nav2_report_nav_dependencies').insert(deps);
      // A report whose NAV range could not be pinned must not be left looking final: remove the row this call just inserted (nothing can have read it
      // as a pinned report, and the dependency rows that did not insert cascade away with it).
      if (derr) {
        await admin.from('nav2_fund_analytics_reports').delete().eq('id', saved.id).eq('user_id', userId);
        throw new Error('The report could not be saved (price history could not be protected).');
      }
    }
    return { report: toSummary({ ...saved, report_json: { periodChoice: report.periodChoice } }), replayed: false };
  }
  throw new Error('The report could not be saved.');
}

export async function listFundAnalyticsReports(userClient: SupabaseServerClient, userId: string, limit = 20): Promise<StoredReportSummary[]> {
  const { data, error } = await (userClient as unknown as SupabaseClient)
    .from('nav2_fund_analytics_reports')
    .select('id, version_number, as_of_date, scheme_count, created_at')
    .eq('user_id', userId)
    .order('version_number', { ascending: false })
    .limit(limit);
  if (error) throw new Error('Could not list reports.');
  return ((data ?? []) as ReportRow[]).map(toSummary);
}

/** One of the caller's own reports (RLS + an explicit user filter); null when it does not exist or is not theirs. */
export async function getFundAnalyticsReport(userClient: SupabaseServerClient, userId: string, id: string): Promise<{ summary: StoredReportSummary; report: FundAnalyticsReport; manifestChecksum: string } | null> {
  const { data, error } = await (userClient as unknown as SupabaseClient)
    .from('nav2_fund_analytics_reports')
    .select('id, version_number, as_of_date, scheme_count, created_at, report_json, manifest_checksum')
    .eq('user_id', userId)
    .eq('id', id)
    .maybeSingle();
  if (error || !data) return null;
  const r = data as ReportRow & { report_json: FundAnalyticsReport; manifest_checksum: string };
  return { summary: toSummary(r), report: r.report_json, manifestChecksum: r.manifest_checksum };
}

// NAV2 Stage 2 -- generate, list and read the Fund analytics report (Premium only; a separate report under Reports).
//
// Order of checks in generateFundAnalyticsReport (each one fails CLOSED and stops):
//   1. the feature switch (job-control row nav2_fund_analytics; OFF unless the row exists and is enabled)  -> 'disabled'
//   2. Premium (getPlanTier on the service client, honouring the entitlement validity window)             -> 'forbidden'
//   3. the report NAV gate (price history still being prepared; starts the bounded retry + the user fetch) -> 'preparing'
//   3b. ONLY when the nav2_trigger_planner switch is ON: the history the CHOSEN PERIOD needs (the NAV2 required window per
//      held scheme) is planned read-only; if some of it is missing and its fetch could be started, the answer is 'preparing'
//      (a failed attempt goes into the existing cooldown, so this cannot hold forever; a fetch that could not be scheduled
//      never holds, and neither does one the NAV fetch kill switch would refuse to run). Switch OFF: this step does not exist and generation behaves exactly as before.
//   4. the household holds at least one Indian mutual fund this report covers                              -> 'no_funds'
//   5. build the report (pure), reuse the shared scheme-performance cache, persist the pinned row.
//
// The persisted row is IMMUTABLE (migration 0261): a regenerated report is a NEW version
// (version_number = previous + 1, supersedes_report_id = previous); an earlier version is never edited.
// Its NAV range per fund is pinned in nav2_report_nav_dependencies so the NAV retention job cannot delete the
// observations the report rests on.

import type { SupabaseClient } from '@supabase/supabase-js';
import { isReportPeriodChoice, type ReportPeriodChoice } from '@/lib/engines/nav2/analysisSpec';
import { buildFundAnalyticsReport, compactSchemeFamily, manifestChecksum, schemeBundleCacheKey, schemeBundleCacheParts, type FundAnalyticsInput, type FundAnalyticsManifest, type FundAnalyticsReport } from '@/lib/engines/nav2/fundAnalyticsReport';
import { getPlanTier } from '@/lib/services/entitlements';
import type { SupabaseServerClient } from '@/lib/services/dashboardData';
import { checkReportNavHistoryGate, NAV_FETCH_KILL_SWITCH_JOB_KEY, REPORT_NAV_RETRY_WINDOW_MINUTES, waitingBody, type ReportNavGate } from '../pc6/reportNavHistoryGate';
import { kickUserNavHistory } from '../pc6/userNavHistoryKick';
import { loadFundAnalyticsInput, type FundAnalyticsLoadResult } from './fundAnalyticsLoader';
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
  | { status: 'ready'; report: StoredReportSummary; cache: { hits: number; computed: number; stored: number } };

export interface FundAnalyticsDeps {
  isFlagOn: (admin: SupabaseClient) => Promise<boolean>;
  isPremium: (userId: string, admin: SupabaseClient) => Promise<boolean>;
  gate: (args: { admin: SupabaseClient; userId: string; today: string }) => Promise<ReportNavGate>;
  load: (args: Parameters<typeof loadFundAnalyticsInput>[0]) => Promise<FundAnalyticsLoadResult>;
  nowIso: () => string;
  /** The nav2_trigger_planner switch (OFF unless its row exists and is enabled). */
  plannerOn: (admin: SupabaseClient) => Promise<boolean>;
  /** Read-only: the NAV2 window plan the chosen period needs for this user. */
  planPeriod: (args: { admin: SupabaseClient; userId: string; period: ReportPeriodChoice; today: string }) => Promise<Nav2WindowPlan>;
  /** Start the planned fetch after the response; false when it could not be scheduled. */
  kickPeriod: (userId: string, period: ReportPeriodChoice) => boolean;
  /**
   * Whether the NAV fetch kill switch (pc6_selective_historical_hydration) is ON. With it OFF the planned fetch can never run and leaves no attempt
   * record, so no cooldown would ever release the report: holding for it would hold FOREVER (found on DEV, Stage 3). Anything but a clean "ON" is OFF.
   */
  fetchingEnabled: (admin: SupabaseClient) => Promise<boolean>;
}

const defaultDeps: FundAnalyticsDeps = {
  isFlagOn: (admin) => isNav2FlagOn(admin, NAV2_JOB_KEYS.fundAnalytics),
  isPremium: async (userId, admin) => (await getPlanTier(userId, admin as unknown as SupabaseServerClient)) === 'premium',
  gate: ({ admin, userId, today }) => checkReportNavHistoryGate({ db: admin as never, userId, today, createAnchor: true, kick: kickUserNavHistory }),
  load: loadFundAnalyticsInput,
  nowIso: () => new Date().toISOString(),
  plannerOn: (admin) => isNav2FlagOn(admin, NAV2_JOB_KEYS.triggerPlanner),
  planPeriod: ({ admin, userId, period, today }) => planForReportPeriod(admin, userId, period, today),
  kickPeriod: (userId, period) => kickNav2ReportPeriod(userId, period),
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
  /** ISO date; defaults to today (UTC). */
  asOfDate?: string;
  deps?: Partial<FundAnalyticsDeps>;
}): Promise<GenerateResult> {
  const deps = { ...defaultDeps, ...(args.deps ?? {}) };
  const admin = args.adminClient;
  if (!(await deps.isFlagOn(admin))) return { status: 'disabled', message: FUND_ANALYTICS_DISABLED_MESSAGE };
  if (!(await deps.isPremium(args.userId, admin))) return { status: 'forbidden', message: FUND_ANALYTICS_PREMIUM_MESSAGE };

  const nowIso = deps.nowIso();
  const asOfDate = args.asOfDate ?? nowIso.slice(0, 10);
  const periodChoice = parsePeriodChoice(args.periodChoice);

  const gate = await deps.gate({ admin, userId: args.userId, today: asOfDate });
  if (gate.hold) return { status: 'preparing', message: gate.headline ?? 'Price history is being prepared.', waiting: waitingBody(gate) };

  if (await deps.plannerOn(admin)) {
    let plan: Nav2WindowPlan | null = null;
    try {
      plan = await deps.planPeriod({ admin, userId: args.userId, period: periodChoice, today: asOfDate });
    } catch {
      plan = null; // a planning problem never blocks the report: it proceeds and says honestly what history it has
    }
    if (plan && plan.fetch.toFetch.length > 0 && (await deps.fetchingEnabled(admin)) && deps.kickPeriod(args.userId, periodChoice)) {
      const ids = plan.fetch.toFetch.map((f) => f.instrumentId);
      const { data: named } = await admin.from('ii_instruments').select('id, instrument_name').in('id', ids);
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
  }

  const loaded = await deps.load({ userId: args.userId, sessionClient: args.sessionClient, adminClient: admin, asOfDate, displayCurrency: 'INR', periodChoice, gate });
  if (!loaded.input || loaded.input.schemes.length === 0) return { status: 'no_funds', message: FUND_ANALYTICS_NO_FUNDS_MESSAGE };

  // ---- reuse the shared per-scheme cache --------------------------------------------------------------------------
  const base: FundAnalyticsInput = loaded.input;
  const keyed = base.schemes.map((h) => ({ h, key: schemeBundleCacheKey(base, h) }));
  const cached = await readCachedBundles(admin, keyed.map((k) => k.key));
  const withCache: FundAnalyticsInput = { ...base, calculatedAt: deps.nowIso(), schemes: keyed.map(({ h, key }) => ({ ...h, cachedScheme: cached.get(key) ?? null })) };
  const { report, manifest } = buildFundAnalyticsReport(withCache);

  const writes: CacheWrite[] = [];
  for (const { h, key } of keyed) {
    if (cached.has(key)) continue;
    const block = report.schemes.find((b) => b.instrumentId === h.instrumentId);
    if (block) writes.push({ key, parts: schemeBundleCacheParts(base, h), payload: compactSchemeFamily(block.analytics.scheme) });
  }
  const stored = writes.length ? await writeCachedBundles(admin, writes) : 0;

  const summary = await persistReport({ admin, userId: args.userId, report, manifest, nowIso });
  return { status: 'ready', report: summary, cache: { hits: cached.size, computed: writes.length, stored } };
}

/** How many times a generation tries to take the next version number when other generations for the same user take it first. */
export const PERSIST_VERSION_ATTEMPTS = 10;

/** Persists the next version of the pinned report and its NAV dependency manifest. Retries on a version race (several simultaneous generations). */
export async function persistReport(args: { admin: SupabaseClient; userId: string; report: FundAnalyticsReport; manifest: FundAnalyticsManifest; nowIso: string }): Promise<StoredReportSummary> {
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
    };
    const { data: ins, error: ierr } = await admin.from('nav2_fund_analytics_reports').insert(row).select('id, version_number, as_of_date, scheme_count, created_at').single();
    if (ierr) {
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
      // A report whose NAV range could not be pinned must not be left looking final.
      if (derr) throw new Error('The report could not be saved (price history could not be protected).');
    }
    return toSummary({ ...saved, report_json: { periodChoice: report.periodChoice } });
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

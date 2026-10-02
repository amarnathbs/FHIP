import { ok, bad } from '@/lib/api';
import { createAdminClient } from '@/lib/supabase/admin';
import { realFeedHttp, runMarketIndexDailyUpdate } from '@/lib/services/investment-intelligence/marketIndex/dailyFeed';

/**
 * Daily Nifty 50 / BSE Sensex closing-value updater.
 *
 * SHIPS DISABLED. NSE and BSE restrict automated scraping and redistribution of
 * their index data; the Product Owner must confirm NSE/BSE terms (or hold a
 * licence) before this is enabled. It runs only when BOTH
 * MARKET_INDEX_FEED_ENABLED=true in the environment AND the
 * ii_reference_job_control row 'market_index_daily_close' is enabled — both
 * ship off, and when off the handler makes no network request at all.
 * Migration 0232 creates NO pg_cron schedule; scheduling is a deliberate,
 * human-present step (see docs/investment-intelligence/INDIA_MF_INVESTMENT_REPORT_REPORT.md).
 *
 * Same authentication as every other scheduled job in this repository: the
 * shared `x-cron-secret` header compared with CRON_SECRET (see
 * app/api/investment-intelligence/cron/pc6-reference-ingest/route.ts). Output is
 * counts and alert codes only — never a URL, header or row content.
 */
export async function POST(req: Request) {
  const secret = req.headers.get('x-cron-secret');
  if (!secret || secret !== process.env.CRON_SECRET) return bad('Unauthorized', 401);

  try {
    const env = { ...process.env } as Record<string, string | undefined>;
    // Fail closed BEFORE building a service-role client: when off, nothing is touched.
    if (env.MARKET_INDEX_FEED_ENABLED !== 'true') {
      const off = await runMarketIndexDailyUpdate({ supabase: undefined as never, http: realFeedHttp(), env, nowIso: new Date().toISOString() });
      return ok({ status: off.status, detail: off.detail, requests_made: off.requestsMade, alerts: [] });
    }
    const result = await runMarketIndexDailyUpdate({ supabase: createAdminClient(), http: realFeedHttp(), env, nowIso: new Date().toISOString() });
    // Alerting: critical alerts are logged at error level so the platform's log alarms see them
    // (the same channel the PC6 ingest job's failures use), and are returned as codes only.
    for (const a of result.alerts) if (a.severity === 'critical') console.error(`market-index-daily ${a.code}: ${a.detail}`);
    return ok({
      runner_version: result.runnerVersion,
      status: result.status,
      detail: result.detail,
      requests_made: result.requestsMade,
      per_index: result.perIndex,
      alerts: result.alerts.map((a) => ({ severity: a.severity, code: a.code })),
    });
  } catch (err) {
    console.error('Market index daily update error:', err);
    return bad('Unexpected error', 500);
  }
}

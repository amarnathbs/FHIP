import { ok, bad } from '@/lib/api';
import { createAdminClient } from '@/lib/supabase/admin';
import { createAieFactsheetAiExtractor } from '@/lib/services/investment-intelligence/factsheetReader/aieAdapter';
import { createPoliteFetcher, realFactsheetHttp } from '@/lib/services/investment-intelligence/factsheetReader/politeFetch';
import { runFactsheetReader } from '@/lib/services/investment-intelligence/factsheetReader/runner';
import { createSupabaseFactsheetStore } from '@/lib/services/investment-intelligence/factsheetReader/store';
import { FACTSHEET_AI_ENV_FLAG } from '@/lib/services/investment-intelligence/factsheetReader/types';

export const dynamic = 'force-dynamic';
/** A run reads at most a handful of documents with a pause between requests; it stops itself well inside this. */
export const maxDuration = 300;

/**
 * BENCH-1 — the monthly FACTSHEET BENCHMARK READER.
 *
 * Records, for each scheme users actually hold, the benchmark the FUND HOUSE DECLARES in its own latest
 * factsheet (or SID / addendum), as an effective-dated, append-only history. Facts only; no performance or index
 * data is read or stored. See lib/services/investment-intelligence/factsheetReader/runner.ts for the rules.
 *
 * SHIPS OFF, AND REFUSES TO FETCH WITHOUT TERMS APPROVAL.
 *   * Kill switch: ii_reference_job_control.factsheet_benchmark_reader (created disabled by migration 0252). Off,
 *     missing or unreadable means no work at all: no fetch, no write.
 *   * Per source: ii_factsheet_sources.terms_review_status must be 'approved'. 'not_reviewed' (the default)
 *     refuses before any request is made.
 *   * { "dryRun": true } reports what the run WOULD fetch and extract. It makes no network request and writes nothing.
 *
 * NO SCHEDULE IS CREATED BY ANY MIGRATION. Scheduling is a deliberate, human-present step (see
 * docs/investment-intelligence/FACTSHEET_BENCHMARK_READER_RUNBOOK.md).
 *
 * Authentication: the repository's one scheduled-job shape, the shared `x-cron-secret` header compared with
 * CRON_SECRET (same as the other cron routes). Output is counts, per-source actions and outcome codes only: never
 * a document body, a header, a credential or a row of user data (the job never reads user data; its only
 * cross-user read returns instrument identities).
 *
 * Body (all optional): { dryRun, maxSources, runMonth (ISO first of month) }.
 */
export async function POST(req: Request) {
  const secret = req.headers.get('x-cron-secret');
  if (!secret || secret !== process.env.CRON_SECRET) return bad('Unauthorized', 401);

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    body = {}; // an empty body is the standard run
  }
  const runMonth = typeof body.runMonth === 'string' ? body.runMonth : undefined;
  if (runMonth !== undefined && !/^\d{4}-\d{2}-01$/.test(runMonth)) return bad('runMonth must be the first day of a month, ISO yyyy-mm-dd', 422);
  const maxSources = typeof body.maxSources === 'number' && Number.isInteger(body.maxSources) && body.maxSources >= 0 && body.maxSources <= 50 ? body.maxSources : undefined;

  try {
    const env = { ...process.env } as Record<string, string | undefined>;
    const supabase = createAdminClient();
    const result = await runFactsheetReader(
      {
        store: createSupabaseFactsheetStore(supabase),
        fetcher: createPoliteFetcher({ http: realFactsheetHttp(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)), nowMs: Date.now }),
        nowIso: new Date().toISOString(),
        env,
        // The AI adapter is only constructed when its own switch is on; the pattern pass never needs it.
        ai: env[FACTSHEET_AI_ENV_FLAG] === 'true' ? createAieFactsheetAiExtractor() : null,
      },
      { dryRun: body.dryRun === true, maxSources, runMonth }
    );
    for (const s of result.sources) {
      if ((s.outcomes.error ?? 0) > 0 || (s.outcomes.source_blocked ?? 0) > 0) console.error(`factsheet-benchmark-reader ${s.sourceKey}: ${JSON.stringify(s.outcomes)}`);
    }
    return ok({
      runner_version: result.runnerVersion,
      status: result.status,
      detail: result.detail,
      kill_switch: result.killSwitch,
      dry_run: result.dryRun,
      run_month: result.runMonth,
      requests_made: result.requestsMade,
      ai_calls: result.aiCalls,
      ledger_rows_written: result.ledgerRowsWritten,
      sources: result.sources.map((s) => ({ source_key: s.sourceKey, host: s.host, action: s.action, schemes: s.instruments, outcomes: s.outcomes, detail: s.detail })),
    });
  } catch (err) {
    console.error('Factsheet benchmark reader error:', err);
    return bad('Unexpected error', 500);
  }
}

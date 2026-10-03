import { createAdminClient } from '@/lib/supabase/admin';
import { generateReport } from '@/lib/services/reportsData';
import { ReportWaitingForPriceHistoryError } from '@/lib/services/investment-intelligence/pc6/reportNavHistoryGate';
import { ok, bad } from '@/lib/api';

// Triggered by the pg_cron + pg_net schedule created in
// 0010_module9_reports.sql. Authenticated via a shared secret (no user
// session exists in a scheduled context) rather than requireUser().
// NOTE: in local development (cloud Supabase, app running on localhost),
// Supabase cannot reach this endpoint automatically — see the migration's
// comment. This route is fully functional and can be triggered directly to
// verify the generation logic without waiting for the schedule.
export async function POST(req: Request) {
  const secret = req.headers.get('x-cron-secret');
  if (!secret || secret !== process.env.CRON_SECRET) {
    return bad('Unauthorized', 401);
  }

  const supabase = createAdminClient();
  const { data: users, error } = await supabase.from('user_entitlements').select('user_id');
  if (error) return bad(error.message);

  const results: { userId: string; status: string }[] = [];
  for (const row of users ?? []) {
    try {
      const result = await generateReport({ userId: row.user_id, triggerType: 'scheduled', client: supabase });
      results.push({ userId: row.user_id, status: result.report.status });
    } catch (e) {
      // Held for price history (PO 2026-10-03): not an error. The fetch was kicked; the next run, or the user, generates it.
      results.push({ userId: row.user_id, status: e instanceof ReportWaitingForPriceHistoryError ? 'waiting_for_price_history' : 'error' });
    }
  }

  return ok({ processed: results.length, results });
}

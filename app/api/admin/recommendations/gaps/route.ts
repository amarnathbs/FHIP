import { requireAdmin, adminClient, safeDbError } from '@/lib/services/adminAuth';
import { ok } from '@/lib/api';

// Gap review: evaluation runs where nothing in the library matched. Each row
// keeps the exact context_snapshot the matcher evaluated against, so an
// admin can see why (e.g. a value just outside every existing condition's
// threshold) without needing the user's live data to still be in that state.
export async function GET() {
  const { forbidden } = await requireAdmin();
  if (forbidden) return forbidden;
  const client = adminClient();
  const { data, error } = await client
    .from('user_recommendation_runs')
    .select('id, user_id, forecast_profile_id, scenario_id, run_at, matched_count, context_snapshot')
    .eq('matched_count', 0)
    .order('run_at', { ascending: false })
    .limit(200);
  return error ? safeDbError(error, 'Recommendation gaps list') : ok(data);
}

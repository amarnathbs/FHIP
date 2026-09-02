import { requireAdmin, adminClient, adminRoute, safeDbError } from '@/lib/services/adminAuth';
import { ok, bad } from '@/lib/api';

export const GET = adminRoute(async (req: Request) => {
  const { forbidden } = await requireAdmin();
  if (forbidden) return forbidden;
  const url = new URL(req.url);
  const metricCode = url.searchParams.get('metric_code');
  let query = adminClient()
    .from('benchmark_target_ranges')
    .select('*, benchmark_metric_definitions!inner(metric_code, metric_name)')
    .order('band_tier')
    .limit(300);
  if (metricCode) query = query.eq('benchmark_metric_definitions.metric_code', metricCode);
  const { data, error } = await query;
  return error ? safeDbError(error, 'Benchmark target-ranges list') : ok(data);
});

export const POST = adminRoute(async (req: Request) => {
  const { forbidden } = await requireAdmin();
  if (forbidden) return forbidden;
  const body = await req.json().catch(() => ({}));
  if (!body.metric_definition_id || !body.band_label || !body.band_tier) {
    return bad('metric_definition_id, band_label and band_tier are required', 422);
  }
  const { data, error } = await adminClient().from('benchmark_target_ranges').insert(body).select('*').single();
  return error ? safeDbError(error, 'Benchmark target-range create') : ok(data);
});

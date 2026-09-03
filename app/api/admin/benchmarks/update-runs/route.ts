import { requireAdmin, adminClient, adminRoute, safeDbError } from '@/lib/services/adminAuth';
import { ok } from '@/lib/api';

export const GET = adminRoute(async () => {
  const { forbidden } = await requireAdmin();
  if (forbidden) return forbidden;
  const { data, error } = await adminClient()
    .from('benchmark_update_runs')
    .select('*, benchmark_sources(source_name), benchmark_datasets(dataset_name, version)')
    .order('created_at', { ascending: false })
    .limit(100);
  return error ? safeDbError(error, 'Benchmark update-runs list') : ok(data);
});

import { requireAdmin, adminClient } from '@/lib/services/adminAuth';
import { ok, bad } from '@/lib/api';

export async function GET(req: Request) {
  const { forbidden } = await requireAdmin();
  if (forbidden) return forbidden;
  const url = new URL(req.url);
  const datasetId = url.searchParams.get('dataset_id');
  let query = adminClient()
    .from('benchmark_values')
    .select('*, benchmark_metric_definitions(metric_name), benchmark_datasets(dataset_name)')
    .order('created_at', { ascending: false })
    .limit(200);
  if (datasetId) query = query.eq('dataset_id', datasetId);
  const { data, error } = await query;
  return error ? bad(error.message) : ok(data);
}

// "Import" here means a direct structured insert (spec's admin import
// workflow) rather than a file-upload parser — rows are validated the same
// way a single manual entry would be.
export async function POST(req: Request) {
  const { forbidden } = await requireAdmin();
  if (forbidden) return forbidden;
  const body = await req.json().catch(() => ({}));
  const rows = Array.isArray(body.rows) ? body.rows : [body];
  for (const r of rows) {
    if (!r.dataset_id || !r.metric_definition_id || !r.statistic_type) {
      return bad('Each row requires dataset_id, metric_definition_id and statistic_type', 422);
    }
  }
  const { data, error } = await adminClient().from('benchmark_values').insert(rows).select('*');
  return error ? bad(error.message) : ok({ imported: data?.length ?? 0, rows: data });
}

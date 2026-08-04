import { requireAdmin, adminClient } from '@/lib/services/adminAuth';
import { ok, bad } from '@/lib/api';

export async function GET() {
  const { forbidden } = await requireAdmin();
  if (forbidden) return forbidden;
  const { data, error } = await adminClient()
    .from('benchmark_datasets')
    .select('*, benchmark_sources(source_name, publisher, citation_text)')
    .order('created_at', { ascending: false });
  return error ? bad(error.message) : ok(data);
}

export async function POST(req: Request) {
  const { forbidden } = await requireAdmin();
  if (forbidden) return forbidden;
  const body = await req.json().catch(() => ({}));
  if (!body.benchmark_source_id || !body.dataset_name || !body.version || !body.benchmark_class) {
    return bad('benchmark_source_id, dataset_name, version and benchmark_class are required', 422);
  }
  const { data, error } = await adminClient()
    .from('benchmark_datasets')
    .insert({ ...body, data_status: 'draft' })
    .select('*')
    .single();
  return error ? bad(error.message) : ok(data);
}

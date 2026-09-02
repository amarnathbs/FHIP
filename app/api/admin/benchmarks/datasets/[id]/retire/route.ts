import { requireAdmin, adminClient, adminRoute, safeDbError } from '@/lib/services/adminAuth';
import { ok } from '@/lib/api';

export const POST = adminRoute(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const { user, forbidden } = await requireAdmin();
  if (forbidden) return forbidden;
  const supabase = adminClient();
  const { data, error } = await supabase
    .from('benchmark_datasets')
    .update({ data_status: 'superseded', effective_to: new Date().toISOString().slice(0, 10), updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('*')
    .single();
  if (error) return safeDbError(error, 'Benchmark dataset retire');
  await supabase.from('benchmark_update_runs').insert({ dataset_id: id, approval_status: 'approved', previous_version: data.version, audit_user: user!.id });
  return ok(data);
});

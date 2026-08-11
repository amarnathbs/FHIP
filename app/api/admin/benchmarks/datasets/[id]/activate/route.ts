import { requireAdmin, adminClient, adminRoute } from '@/lib/services/adminAuth';
import { validateDatasetForActivation } from '@/lib/services/benchmarkGovernance';
import { ok, bad } from '@/lib/api';

export const POST = adminRoute(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const { user, forbidden } = await requireAdmin();
  if (forbidden) return forbidden;
  const supabase = adminClient();

  const validation = await validateDatasetForActivation(supabase, id);
  if (!validation.valid) {
    await supabase.from('benchmark_update_runs').insert({
      dataset_id: id,
      approval_status: 'rejected',
      validation_results: validation,
      audit_user: user!.id,
    });
    return bad(`Cannot activate: ${validation.errors.join(' ')}`, 422);
  }

  const reviewDue = new Date();
  reviewDue.setFullYear(reviewDue.getFullYear() + 1);
  const { data, error } = await supabase
    .from('benchmark_datasets')
    .update({
      data_status: 'active',
      effective_from: new Date().toISOString().slice(0, 10),
      review_due_at: reviewDue.toISOString().slice(0, 10),
      approved_by: user!.id,
      approved_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select('*')
    .single();
  if (error) return bad(error.message);

  await supabase.from('benchmark_update_runs').insert({
    dataset_id: id,
    approval_status: 'approved',
    validation_results: validation,
    new_version: data.version,
    effective_date: data.effective_from,
    audit_user: user!.id,
  });

  return ok(data);
});

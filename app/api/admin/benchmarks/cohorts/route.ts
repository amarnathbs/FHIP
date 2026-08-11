import { requireAdmin, adminClient, adminRoute } from '@/lib/services/adminAuth';
import { ok, bad } from '@/lib/api';

export const GET = adminRoute(async () => {
  const { forbidden } = await requireAdmin();
  if (forbidden) return forbidden;
  const { data, error } = await adminClient().from('benchmark_cohorts').select('*, benchmark_datasets(dataset_name)').order('cohort_tier').order('cohort_code');
  return error ? bad(error.message) : ok(data);
});

export const POST = adminRoute(async (req: Request) => {
  const { forbidden } = await requireAdmin();
  if (forbidden) return forbidden;
  const body = await req.json().catch(() => ({}));
  if (!body.cohort_code || !body.cohort_description || !body.cohort_tier) {
    return bad('cohort_code, cohort_description and cohort_tier are required', 422);
  }
  const { data, error } = await adminClient().from('benchmark_cohorts').insert(body).select('*').single();
  return error ? bad(error.message) : ok(data);
});

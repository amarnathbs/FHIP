import { requireAdmin, adminClient } from '@/lib/services/adminAuth';
import { validateDatasetForActivation } from '@/lib/services/benchmarkGovernance';
import { ok, bad } from '@/lib/api';

export async function POST(req: Request) {
  const { forbidden } = await requireAdmin();
  if (forbidden) return forbidden;
  const body = await req.json().catch(() => ({}));
  if (!body.dataset_id) return bad('dataset_id is required', 422);
  const result = await validateDatasetForActivation(adminClient(), body.dataset_id);
  return ok(result);
}

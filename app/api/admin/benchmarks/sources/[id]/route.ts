import { requireAdmin, adminClient, adminRoute } from '@/lib/services/adminAuth';
import { ok, bad } from '@/lib/api';

export const PUT = adminRoute(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const { user, forbidden } = await requireAdmin();
  if (forbidden) return forbidden;
  const body = await req.json().catch(() => ({}));
  const patch: Record<string, unknown> = { ...body, updated_at: new Date().toISOString() };
  if (body.status === 'approved') {
    patch.approved_by = user!.id;
    patch.approved_at = new Date().toISOString();
  }
  const { data, error } = await adminClient().from('benchmark_sources').update(patch).eq('id', id).select('*').single();
  return error ? bad(error.message) : ok(data);
});

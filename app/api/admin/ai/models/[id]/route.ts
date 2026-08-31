import { requireAdmin, adminRoute } from '@/lib/services/adminAuth';
import { ok, bad } from '@/lib/api';
import { updateModelRegistryEntry } from '@/lib/ai/modelRegistry';

export const PUT = adminRoute(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { user, forbidden } = await requireAdmin();
  if (forbidden) return forbidden;
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  try {
    const entry = await updateModelRegistryEntry(id, body, user!.id);
    return ok(entry);
  } catch (err) {
    return bad(err instanceof Error ? err.message : 'Failed to update model registry entry.', 500);
  }
});

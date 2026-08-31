import { requireAdmin, adminClient, adminRoute } from '@/lib/services/adminAuth';
import { ok, bad } from '@/lib/api';

export const GET = adminRoute(async (req: Request) => {
  const { forbidden } = await requireAdmin();
  if (forbidden) return forbidden;
  const { searchParams } = new URL(req.url);
  const severity = searchParams.get('severity');
  const client = adminClient();
  let query = client.from('ai_safety_events').select('*').order('created_at', { ascending: false }).limit(200);
  if (severity) query = query.eq('severity', severity);
  const { data, error } = await query;
  if (error) return bad(error.message);
  return ok(data);
});

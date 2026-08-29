import { requireAdmin, adminClient, adminRoute } from '@/lib/services/adminAuth';
import { ok, bad } from '@/lib/api';

export const GET = adminRoute(async (req: Request) => {
  const { forbidden } = await requireAdmin();
  if (forbidden) return forbidden;
  const { searchParams } = new URL(req.url);
  const limit = Math.min(Number(searchParams.get('limit') ?? 50), 200);
  const executionStatus = searchParams.get('execution_status');

  const client = adminClient();
  let query = client.from('ai_runs').select('*').order('created_at', { ascending: false }).limit(limit);
  if (executionStatus) query = query.eq('execution_status', executionStatus);
  const { data, error } = await query;
  if (error) return bad(error.message);
  return ok(data);
});

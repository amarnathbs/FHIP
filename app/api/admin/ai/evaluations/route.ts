import { requireAdmin, adminClient, adminRoute } from '@/lib/services/adminAuth';
import { ok, bad } from '@/lib/api';

export const GET = adminRoute(async () => {
  const { forbidden } = await requireAdmin();
  if (forbidden) return forbidden;
  const client = adminClient();
  const { data, error } = await client.from('ai_evaluations').select('*').order('created_at', { ascending: false }).limit(200);
  if (error) return bad(error.message);
  return ok(data);
});

export const POST = adminRoute(async (req: Request) => {
  const { user, forbidden } = await requireAdmin();
  if (forbidden) return forbidden;
  const body = await req.json().catch(() => ({}));
  const required = ['ai_run_id', 'evaluation_type', 'result', 'reviewer_type'];
  for (const field of required) {
    if (!body[field]) return bad(`${field} is required`, 422);
  }
  const client = adminClient();
  const { data, error } = await client
    .from('ai_evaluations')
    .insert({
      ai_run_id: body.ai_run_id,
      evaluation_type: body.evaluation_type,
      result: body.result,
      score: body.score ?? null,
      reviewer_type: body.reviewer_type,
      reviewer_id: body.reviewer_type === 'human' ? user!.id : null,
      notes: body.notes ?? null,
    })
    .select('*')
    .single();
  if (error) return bad(error.message);
  return ok(data);
});

import { createClient } from '@/lib/supabase/server';
import { requireUser, ok, bad } from '@/lib/api';
import { emitAuditEvent } from '@/lib/services/investment-intelligence/audit';
import { z } from 'zod';

const resolveSchema = z.object({
  resolution: z.enum(['accepted_new_value', 'kept_prior_value', 'manual_correction']),
  notes: z.string().optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const parsed = resolveSchema.safeParse(await req.json());
  if (!parsed.success) return bad(parsed.error.message, 422);

  const supabase = await createClient();
  const { data: existing } = await supabase.from('ii_reconciliation_cases').select('id, status').eq('id', id).eq('user_id', user.id).maybeSingle();
  if (!existing) return bad('Reconciliation case not found', 404);
  if (existing.status === 'resolved') return bad('This case is already resolved', 409);

  const { data, error } = await supabase
    .from('ii_reconciliation_cases')
    .update({ status: 'resolved', resolved_at: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', user.id)
    .select()
    .single();
  if (error) return bad(error.message);

  await emitAuditEvent({
    userId: user.id,
    eventType: 'reconciliation_resolved',
    subjectType: 'ii_reconciliation_cases',
    subjectId: id,
    actorType: 'user',
    actorId: user.id,
    metadata: { reconciliationCaseId: id, resolution: parsed.data.resolution },
  });

  return ok(data);
}

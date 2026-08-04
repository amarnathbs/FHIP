import { requireAdmin, adminClient } from '@/lib/services/adminAuth';
import { ok, bad } from '@/lib/api';

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { forbidden } = await requireAdmin();
  if (forbidden) return forbidden;
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const client = adminClient();

  const { conditions, ...masterFields } = body;
  const { data: master, error: masterError } = await client
    .from('action_recommendation_master')
    .update({ ...masterFields, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('*')
    .single();
  if (masterError) return bad(masterError.message);

  if (Array.isArray(conditions)) {
    const { error: deleteError } = await client.from('action_recommendation_conditions').delete().eq('recommendation_code', master.recommendation_code);
    if (deleteError) return bad(deleteError.message);
    if (conditions.length > 0) {
      const { error: insertError } = await client.from('action_recommendation_conditions').insert(
        conditions.map(
          (c: { condition_group?: number; field_name: string; operator?: string; comparison_value?: string | null; evaluation_order?: number }) => ({
            recommendation_code: master.recommendation_code,
            condition_group: c.condition_group ?? 1,
            field_name: c.field_name,
            operator: c.operator ?? 'equals',
            comparison_value: c.comparison_value ?? null,
            evaluation_order: c.evaluation_order ?? 1,
          })
        )
      );
      if (insertError) return bad(insertError.message);
    }
  }

  return ok(master);
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { forbidden } = await requireAdmin();
  if (forbidden) return forbidden;
  const { id } = await params;
  const client = adminClient();
  // Soft-delete only — matches already generated against this row keep
  // their history intact (user_recommendation_matches references master.id).
  const { data, error } = await client
    .from('action_recommendation_master')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('*')
    .single();
  return error ? bad(error.message) : ok(data);
}

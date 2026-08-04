import { requireAdmin, adminClient } from '@/lib/services/adminAuth';
import { ok, bad } from '@/lib/api';

export async function GET() {
  const { forbidden } = await requireAdmin();
  if (forbidden) return forbidden;
  const client = adminClient();
  const [master, conditions] = await Promise.all([
    client.from('action_recommendation_master').select('*').order('forecast_category').order('priority_score', { ascending: false }),
    client.from('action_recommendation_conditions').select('*'),
  ]);
  if (master.error) return bad(master.error.message);
  if (conditions.error) return bad(conditions.error.message);

  const conditionsByCode = new Map<string, unknown[]>();
  for (const row of conditions.data ?? []) {
    const list = conditionsByCode.get(row.recommendation_code) ?? [];
    list.push(row);
    conditionsByCode.set(row.recommendation_code, list);
  }
  const data = (master.data ?? []).map((row) => ({ ...row, conditions: conditionsByCode.get(row.recommendation_code) ?? [] }));
  return ok(data);
}

export async function POST(req: Request) {
  const { forbidden } = await requireAdmin();
  if (forbidden) return forbidden;
  const body = await req.json().catch(() => ({}));
  const required = ['recommendation_code', 'forecast_category', 'sub_category', 'scenario_name', 'forecast_status', 'severity', 'action_type', 'action_title_template', 'action_content_template'];
  for (const field of required) {
    if (!body[field]) return bad(`${field} is required`, 422);
  }
  const client = adminClient();
  const { conditions, ...masterFields } = body;
  const { data: master, error: masterError } = await client
    .from('action_recommendation_master')
    .insert({ ...masterFields, is_active: masterFields.is_active ?? false })
    .select('*')
    .single();
  if (masterError) return bad(masterError.message);

  if (Array.isArray(conditions) && conditions.length > 0) {
    const { error: conditionsError } = await client.from('action_recommendation_conditions').insert(
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
    if (conditionsError) return bad(conditionsError.message);
  }

  return ok(master);
}

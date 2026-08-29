import { requireAdmin, adminClient, adminRoute } from '@/lib/services/adminAuth';
import { ok, bad } from '@/lib/api';
import { createModelRegistryEntry, listModelRegistry, type UpsertModelInput } from '@/lib/ai/modelRegistry';

export const GET = adminRoute(async () => {
  const { forbidden } = await requireAdmin();
  if (forbidden) return forbidden;
  const rows = await listModelRegistry(adminClient());
  return ok(rows);
});

const REQUIRED_FIELDS: (keyof UpsertModelInput)[] = [
  'provider',
  'model_identifier',
  'internal_tier',
  'task_types',
  'max_input_tokens',
  'max_output_tokens',
];

export const POST = adminRoute(async (req: Request) => {
  const { user, forbidden } = await requireAdmin();
  if (forbidden) return forbidden;
  const body = await req.json().catch(() => ({}));
  for (const field of REQUIRED_FIELDS) {
    if (body[field] === undefined || body[field] === null) return bad(`${field} is required`, 422);
  }
  if (!['LOW_COST', 'STANDARD', 'ADVANCED'].includes(body.internal_tier)) {
    return bad('internal_tier must be one of LOW_COST, STANDARD, ADVANCED', 422);
  }
  const entry = await createModelRegistryEntry(
    {
      provider: body.provider,
      model_identifier: body.model_identifier,
      internal_tier: body.internal_tier,
      active: Boolean(body.active),
      approved: false, // new entries always start unapproved — see PUT to approve
      task_types: body.task_types,
      max_input_tokens: body.max_input_tokens,
      max_output_tokens: body.max_output_tokens,
      supports_structured_output: body.supports_structured_output ?? true,
      supports_streaming: body.supports_streaming ?? false,
      supports_batch: body.supports_batch ?? false,
      cost_input_per_1k_usd: body.cost_input_per_1k_usd ?? null,
      cost_output_per_1k_usd: body.cost_output_per_1k_usd ?? null,
      rollout_percentage: body.rollout_percentage ?? 100,
      fallback_model_id: body.fallback_model_id ?? null,
    },
    user!.id
  );
  return ok(entry);
});

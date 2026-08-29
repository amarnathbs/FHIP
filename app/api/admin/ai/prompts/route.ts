import { requireAdmin, adminClient, adminRoute } from '@/lib/services/adminAuth';
import { ok, bad } from '@/lib/api';
import { createPromptTemplate, listPromptTemplates, type CreatePromptInput } from '@/lib/ai/promptRegistry';

export const GET = adminRoute(async () => {
  const { forbidden } = await requireAdmin();
  if (forbidden) return forbidden;
  const rows = await listPromptTemplates(adminClient());
  return ok(rows);
});

const REQUIRED_FIELDS: (keyof CreatePromptInput)[] = [
  'prompt_code',
  'prompt_name',
  'task_type',
  'system_prompt',
  'developer_prompt',
  'context_schema_version',
  'output_schema_version',
  'safety_policy_version',
];

export const POST = adminRoute(async (req: Request) => {
  const { forbidden } = await requireAdmin();
  if (forbidden) return forbidden;
  const body = await req.json().catch(() => ({}));
  for (const field of REQUIRED_FIELDS) {
    if (!body[field]) return bad(`${field} is required`, 422);
  }
  const created = await createPromptTemplate(body as CreatePromptInput);
  return ok(created);
});

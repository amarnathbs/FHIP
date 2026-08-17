import { createClient } from '@/lib/supabase/server';
import { bad, ok } from '@/lib/api';
import { getCurrentResourceRoles, canCreateSpecialistContent } from '@/lib/resources/permissions';
import { createMoneyUpdateFromTemplate } from '@/lib/resources/money-update/mutations';

// POST { templateId } — "Create Update from Template" (spec §45): creates a
// new Draft Money Update, copies the template's structure, assigns a new
// id/slug, never modifies the template itself.
export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return bad('unauthenticated', 401);

  const current = await getCurrentResourceRoles();
  if (!canCreateSpecialistContent(current)) return bad("You don't have permission to create a Money Update.", 403);

  try {
    const body = await request.json().catch(() => ({}));
    const templateId = typeof body?.templateId === 'string' ? body.templateId : '';
    if (!templateId) return bad('A template is required.', 400);

    const result = await createMoneyUpdateFromTemplate(supabase, templateId, user.id);
    if (!result.ok) return bad(result.error, 404);
    return ok({ id: result.id });
  } catch (err) {
    console.error('Resources money update from-template error:', err);
    return bad('Could not create a Money Update from this template.', 500);
  }
}

import { createClient } from '@/lib/supabase/server';
import { bad, ok } from '@/lib/api';
import { getMoneyUpdateTemplateOptions } from '@/lib/resources/money-update/queries';
import { countryConfirmationBlockResponse } from '@/lib/services/countryGate';

// GET /api/admin/resources/money-updates/templates — template picker
// options for "Create Update from Template" (spec §45).
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return bad('unauthenticated', 401);

  const countryBlock = await countryConfirmationBlockResponse(supabase, user.id);
  if (countryBlock) return countryBlock;

  try {
    const templates = await getMoneyUpdateTemplateOptions(supabase);
    return ok(templates);
  } catch (err) {
    console.error('Resources money update templates list error:', err);
    return bad('Could not load Money Update templates.', 500);
  }
}

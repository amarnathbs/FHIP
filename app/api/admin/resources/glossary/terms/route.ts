import { createClient } from '@/lib/supabase/server';
import { bad, ok } from '@/lib/api';
import { getGlossaryTermOptions } from '@/lib/resources/glossary/queries';
import { countryConfirmationBlockResponse } from '@/lib/services/countryGate';

// GET /api/admin/resources/glossary/terms?excludeId=... — Related Terms
// picker options (spec §30). Standalone route so the Money Update/FAQ
// linking flows could reuse the same term list later without depending on
// the glossary/[id] editor payload.
export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return bad('unauthenticated', 401);

  const countryBlock = await countryConfirmationBlockResponse(supabase, user.id);
  if (countryBlock) return countryBlock;

  const { searchParams } = new URL(request.url);
  const excludeId = searchParams.get('excludeId') ?? undefined;

  try {
    const options = await getGlossaryTermOptions(supabase, excludeId);
    return ok(options);
  } catch (err) {
    console.error('Resources glossary term options error:', err);
    return bad('Could not load related terms.', 500);
  }
}

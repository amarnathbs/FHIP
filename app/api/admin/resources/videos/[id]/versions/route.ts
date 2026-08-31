import { createClient } from '@/lib/supabase/server';
import { bad, ok } from '@/lib/api';
import { getResourcePostVersions } from '@/lib/resources/editor/queries';
import { countryConfirmationBlockResponse } from '@/lib/services/countryGate';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return bad('unauthenticated', 401);

  const countryBlock = await countryConfirmationBlockResponse(supabase, user.id);
  if (countryBlock) return countryBlock;

  const { id } = await params;
  try {
    const versions = await getResourcePostVersions(supabase, id);
    return ok(versions);
  } catch (err) {
    console.error('Resources video versions list error:', err);
    return bad('Could not load revision history.', 500);
  }
}

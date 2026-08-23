import { createClient } from '@/lib/supabase/server';
import { bad, ok } from '@/lib/api';
import { getResourcePostVersions } from '@/lib/resources/editor/queries';

// GET /api/admin/resources/content/[id]/versions — read-only revision
// history list (spec §47). Refreshed independently of the main editor load
// after a save/workflow action creates a new version.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return bad('unauthenticated', 401);

  const { id } = await params;
  try {
    const versions = await getResourcePostVersions(supabase, id);
    return ok(versions);
  } catch (err) {
    console.error('Resources versions list error:', err);
    return bad('Could not load revision history.', 500);
  }
}

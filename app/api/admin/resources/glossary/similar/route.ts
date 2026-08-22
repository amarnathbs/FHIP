import { createClient } from '@/lib/supabase/server';
import { bad, ok } from '@/lib/api';
import { findSimilarGlossaryTerms } from '@/lib/resources/glossary/queries';

// GET /api/admin/resources/glossary/similar?term=...&excludeId=... — spec
// §29 check-as-you-type "a similar term already exists" warning.
export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return bad('unauthenticated', 401);

  const { searchParams } = new URL(request.url);
  const term = (searchParams.get('term') ?? '').slice(0, 200);
  const excludeId = searchParams.get('excludeId') ?? undefined;

  try {
    const matches = await findSimilarGlossaryTerms(supabase, term, excludeId);
    return ok(matches);
  } catch (err) {
    console.error('Resources glossary similar-term lookup error:', err);
    return bad('Could not check for similar terms.', 500);
  }
}

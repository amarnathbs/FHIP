import { requireUser, ok, bad } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';
import { unlinkSmsfPropertyLoan } from '@/lib/services/smsfData';

// Unlink an SMSF property loan (spec s.22-24: "No associated debt" is a
// valid state to return to). This only deactivates the relationship row —
// it never touches the liability itself (still fully owned/editable via the
// canonical Liability system) nor the property holding's own value.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string; linkId: string }> }) {
  const { linkId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const supabase = await createClient();
  const { error } = await unlinkSmsfPropertyLoan(linkId, user.id, supabase);
  return error ? bad(error.message) : ok({ unlinked: true });
}

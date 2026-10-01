import { createClient } from '@/lib/supabase/server';
import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { CONSOLIDATED_LABEL, CONSOLIDATED_NOTE, loadOwnerClassContext } from '@/lib/services/investment-intelligence/ownerClass';

// 2026-10-01 owner classes (PO decision): the owner classes this user's accounts fall into -- personal (one per
// household member), joint, each trust / HUF / company, shared-with-an-entity, unallocated -- for the class selector
// on the Overview / Performance / Tax / SIP / X-Ray / Holdings views. Read-only; every query is filtered by user_id.
// `consolidated` is the explicit macro option and is the default everywhere (never presented as a personal total).
export async function GET() {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  try {
    const supabase = await createClient();
    const ctx = await loadOwnerClassContext(supabase, user.id);
    return ok({
      consolidated: { key: 'all', label: CONSOLIDATED_LABEL, note: CONSOLIDATED_NOTE },
      classes: ctx.classes.map((c) => ({ ...c, accountCount: ctx.accountIdsByClass.get(c.key)?.length ?? 0 })),
    });
  } catch (e) {
    return bad(`Owner classes could not be loaded: ${e instanceof Error ? e.message : 'Unknown error'}`, 500);
  }
}

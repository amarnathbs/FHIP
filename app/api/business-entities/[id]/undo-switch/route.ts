import { requireCountryConfirmedUser as requireUser, ok, bad, badValidation } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';
import { smsfRpcError } from '@/lib/services/smsfErrors';
import { smsfConfirmSchema } from '@/lib/validation/smsf';

// Undo the most recent itemised or net value only switch of a Company, Family Trust or HUF (migration 0299), only while nothing newer was
// recorded. PREVIEW-FIRST like the switch itself: confirm false (the default) changes nothing and reports the net before and after and how many
// lines would be archived or brought back; confirm true applies it in one transaction and keeps the history. Another household answers 404.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const parsed = smsfConfirmSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return badValidation(parsed.error, 422);
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('business_entity_undo_last_switch', { p_entity_id: id, p_confirm: parsed.data.confirm });
  if (error) {
    const e = smsfRpcError(error);
    return bad(e.message, e.status, e.errorCode);
  }
  return ok(data);
}

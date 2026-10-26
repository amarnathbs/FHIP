import { requireCountryConfirmedUser as requireUser, ok, bad, badValidation } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';
import { retireSmsfTypedNet } from '@/lib/services/smsfData';
import { smsfRpcError } from '@/lib/services/smsfErrors';
import { smsfConfirmSchema } from '@/lib/validation/smsf';

// Legacy shape: an itemised fund that still carries a typed net value. Retires the typed value to the history (the counted net
// never moves, because only the itemised figure was ever counted). Preview-first.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const parsed = smsfConfirmSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return badValidation(parsed.error, 422);
  const supabase = await createClient();
  const { data, error } = await retireSmsfTypedNet(id, parsed.data.confirm, supabase);
  if (error) {
    const e = smsfRpcError(error);
    return bad(e.message, e.status, e.errorCode);
  }
  return ok(data);
}

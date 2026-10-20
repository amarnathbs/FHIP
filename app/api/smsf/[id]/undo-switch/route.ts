import { requireCountryConfirmedUser as requireUser, ok, bad, badValidation } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';
import { undoSmsfLastSwitch } from '@/lib/services/smsfData';
import { smsfRpcError } from '@/lib/services/smsfErrors';
import { smsfConfirmSchema } from '@/lib/validation/smsf';

// Undo the most recent switch (only while nothing newer was changed). Preview-first like the switch itself.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const parsed = smsfConfirmSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return badValidation(parsed.error, 422);
  const supabase = await createClient();
  const { data, error } = await undoSmsfLastSwitch(id, parsed.data.confirm, supabase);
  if (error) {
    const e = smsfRpcError(error);
    return bad(e.message, e.status, e.errorCode);
  }
  return ok(data);
}

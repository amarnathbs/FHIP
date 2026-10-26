import { requireCountryConfirmedUser as requireUser, ok, bad, badValidation } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';
import { moveSmsfLinkedLoan } from '@/lib/services/smsfData';
import { smsfRpcError } from '@/lib/services/smsfErrors';
import { smsfMoveLoanSchema } from '@/lib/validation/smsf';

// Move a personal liability that was linked to this fund as its property loan across to the fund's own liabilities. The fund net is
// the same before and after (the loan is counted once); the personal row and the link are retired. Preview-first.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const parsed = smsfMoveLoanSchema.safeParse(await req.json());
  if (!parsed.success) return badValidation(parsed.error, 422);
  const supabase = await createClient();
  const { data, error } = await moveSmsfLinkedLoan(id, parsed.data.liability_id, parsed.data.confirm, supabase);
  if (error) {
    const e = smsfRpcError(error);
    return bad(e.message, e.status, e.errorCode);
  }
  return ok(data);
}

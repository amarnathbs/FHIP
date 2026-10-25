import { requireCountryConfirmedUser as requireUser, ok, bad, badValidation } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';
import { adoptSmsfRegisterRows } from '@/lib/services/smsfData';
import { smsfRpcError } from '@/lib/services/smsfErrors';
import { smsfAdoptRowsSchema } from '@/lib/validation/smsf';

// Archive Retirement rows owned by the SMSF that duplicate this fund (never the fund record itself). Preview-first, logged.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const parsed = smsfAdoptRowsSchema.safeParse(await req.json());
  if (!parsed.success) return badValidation(parsed.error, 422);
  const supabase = await createClient();
  const { data, error } = await adoptSmsfRegisterRows(id, parsed.data.retirement_row_ids, parsed.data.confirm, supabase);
  if (error) {
    const e = smsfRpcError(error);
    return bad(e.message, e.status, e.errorCode);
  }
  return ok(data);
}

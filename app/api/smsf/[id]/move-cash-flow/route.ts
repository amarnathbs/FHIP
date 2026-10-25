import { requireCountryConfirmedUser as requireUser, ok, bad, badValidation } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';
import { entityCashFlowError, moveLegacySmsfCashFlow, resolveEntityScope } from '@/lib/services/entityCashFlowData';
import { smsfMoveCashFlowSchema } from '@/lib/validation/entityCashFlow';

// Move a legacy personal income or expense row tagged SMSF into the fund (migration 0296). PREVIEW-FIRST: with confirm false (the default)
// nothing changes and the response says what would move; with confirm true the personal row is retired and the fund record created in one
// transaction, so the flow is counted once. A loan repayment is refused (it is a cash flow, derived from the fund liabilities, not an expense).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const parsed = smsfMoveCashFlowSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badValidation(parsed.error, 422);
  const supabase = await createClient();
  if (!(await resolveEntityScope('smsf', id, user.id, supabase))) return bad('Not found', 404);
  const { data, error } = await moveLegacySmsfCashFlow(id, parsed.data.register, parsed.data.row_id, parsed.data.confirm, supabase);
  if (error) {
    const e = entityCashFlowError(error);
    return bad(e.message, e.status, e.errorCode);
  }
  return ok(data);
}

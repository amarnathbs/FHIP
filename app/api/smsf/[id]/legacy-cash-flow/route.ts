import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';
import { listLegacySmsfCashFlow, resolveEntityScope } from '@/lib/services/entityCashFlowData';

// Personal income and expense rows that were tagged SMSF the earlier way. Listed (never hidden, never silently counted twice) so each can be
// moved into the fund with POST move-cash-flow.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const supabase = await createClient();
  if (!(await resolveEntityScope('smsf', id, user.id, supabase))) return bad('Not found', 404);
  const { income, expenses } = await listLegacySmsfCashFlow(user.id, supabase);
  if (income.error || expenses.error) return bad((income.error ?? expenses.error)!.message);
  return ok({ income: income.data ?? [], expenses: expenses.data ?? [] });
}

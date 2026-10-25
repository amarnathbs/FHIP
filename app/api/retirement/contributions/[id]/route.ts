import { requireCountryConfirmedUser as requireUser, ok, bad, badValidation } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';
import { chooseDestinationSchema } from '@/lib/validation/retirementContribution';
import { chooseDestination, removeContribution } from '@/lib/retirement-contributions/service';

// PATCH: the person chooses where a payslip contribution goes (a waiting one, or a change). Another person's row or account is a 404.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const parsed = chooseDestinationSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badValidation(parsed.error, 422);
  const supabase = await createClient();
  const result = await chooseDestination(user.id, id, parsed.data.retirement_account_id, supabase);
  if (!result.ok) {
    const status = result.code === 'NOT_FOUND' || result.code === 'ACCOUNT_NOT_FOUND' ? 404 : result.code === 'CURRENCY_MISMATCH' ? 409 : 500;
    return bad(result.message, status, result.code);
  }
  return ok({ updated: true });
}

// DELETE: remove a contribution. The row is kept as history (status removed); the account's rate is recomputed.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const supabase = await createClient();
  const result = await removeContribution(user.id, id, supabase);
  return result.ok ? ok({ removed: true }) : bad('That contribution was not found.', 404, 'NOT_FOUND');
}

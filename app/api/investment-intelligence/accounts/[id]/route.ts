import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { archiveIiAccount } from '@/lib/services/investment-intelligence/accounts';

// Archive-only (soft delete), matching registry.ts's archive() convention.
// No PATCH/update in R1 — account edits beyond archive aren't required by
// the R1 acceptance gate and would widen the API surface unnecessarily.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const { data, error } = await archiveIiAccount(user.id, id);
  return error ? bad(error.message) : ok(data);
}

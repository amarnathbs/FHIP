import { requireUser, ok } from '@/lib/api';
import { listReadyIncomeProposals } from '@/lib/import-bridge/incomeProposalService';

// GET /api/financial-data-hub/income-proposals — every 'ready' Income
// proposal awaiting a user decision (spec section 59: do not keep
// re-forcing an already-decided proposal — only 'ready' ones are listed).
export async function GET() {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const proposals = await listReadyIncomeProposals(user.id);
  return ok({ proposals });
}

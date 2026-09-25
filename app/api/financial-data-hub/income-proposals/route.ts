import { requireCountryConfirmedUser as requireUser, ok } from '@/lib/api';
import { listReadyIncomeProposalsWithSource } from '@/lib/import-bridge/incomeProposalService';

// GET /api/financial-data-hub/income-proposals — every 'ready' Income
// proposal awaiting a user decision (spec section 59: do not keep
// re-forcing an already-decided proposal — only 'ready' ones are listed).
export async function GET() {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  // With the source upload and a payslip summary, so the panel can resume one.
  const proposals = await listReadyIncomeProposalsWithSource(user.id);
  return ok({ proposals });
}

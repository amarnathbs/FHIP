import { requireCountryConfirmedUser as requireUser, ok, bad, badValidation } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';
import { manualContributionSchema } from '@/lib/validation/retirementContribution';
import { loadContributionHistory, recordManualContribution } from '@/lib/retirement-contributions/service';

// GET: the contribution history (manual and payslip, with provenance), the payslip contributions waiting for a destination,
// and the destinations the person may choose from. Own rows only (row level security + user_id filter).
export async function GET() {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  try {
    const supabase = await createClient();
    return ok(await loadContributionHistory(user.id, supabase));
  } catch (e) {
    return bad(e instanceof Error ? e.message : 'Could not load contributions', 500);
  }
}

// POST: a manual CONTRIBUTION (a flow). Never a balance: there is no balance field, and current_balance is never touched.
export async function POST(req: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const parsed = manualContributionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badValidation(parsed.error, 422);
  const supabase = await createClient();
  const d = parsed.data;
  const result = await recordManualContribution(
    user.id,
    {
      accountId: d.retirement_account_id,
      type: d.contribution_type,
      amount: d.amount,
      frequency: d.frequency ?? null,
      contributionDate: d.contribution_date ?? null,
      notes: d.notes ?? null,
    },
    supabase,
  );
  if (!result.ok) return bad(result.message, result.code === 'ACCOUNT_NOT_FOUND' ? 404 : 500, result.code);
  return ok({ id: result.id, adopted_legacy: result.adoptedLegacy });
}

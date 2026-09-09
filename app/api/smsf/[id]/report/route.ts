import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';
import { loadSmsfFundReportBundle } from '@/lib/services/smsfReportData';
import { currentSmsfFinancialYear, recentSmsfFinancialYears, periodLengthMonths } from '@/lib/engines/smsf/smsfReportingPeriod';

// GET /api/smsf/[id]/report?period=FY2025-26
//
// LR-6 (WP-01/02/03/04/06/08) — read-only P&L, cash flow, contribution and
// balance-reconciliation bundle for one SMSF fund. Ownership is enforced in
// loadSmsfFundReportBundle exactly like every sibling smsf/[id]/* route (a
// forged fund id from another tenant behaves identically to "not found").
//
// The `period` selects which financial year's LABEL and period-length the
// response is framed in (see smsfReportingPeriod.ts) — it does not, and
// cannot, retroactively filter which income/expense rows are included: those
// rows carry only a current recurring amount + frequency (no transaction
// date), the same "currently recorded, ongoing" data every other engine in
// this codebase already treats as a monthly rate. The response says so
// explicitly (`basis: 'current_recurring_rate'`) rather than implying a
// historical query it cannot actually perform.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const supabase = await createClient();
  const { data: bundle, error } = await loadSmsfFundReportBundle(id, user.id, supabase);
  if (error || !bundle) return bad(error?.message ?? 'not found', 404);

  const url = new URL(req.url);
  const requestedLabel = url.searchParams.get('period');
  const available = recentSmsfFinancialYears(5);
  const period = available.find((p) => p.label === requestedLabel) ?? currentSmsfFinancialYear();

  return ok({
    ...bundle,
    period,
    periodLengthMonths: periodLengthMonths(period),
    availablePeriods: available.map((p) => p.label),
    basis: 'current_recurring_rate',
  });
}

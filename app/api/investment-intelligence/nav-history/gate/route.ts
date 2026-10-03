import { requireCountryConfirmedUser as requireUser, ok } from '@/lib/api';
import { createAdminClient } from '@/lib/supabase/admin';
import { checkReportNavHistoryGate, waitingBody } from '@/lib/services/investment-intelligence/pc6/reportNavHistoryGate';
import { kickUserNavHistory } from '@/lib/services/investment-intelligence/pc6/userNavHistoryKick';

// Should the Performance page / the Monthly Report wait for price history?
// (PO 2026-10-03: wait for the data, but a permanently missing source never
// traps the user.) The same decision generateReport() makes, exposed for the
// screens that show a waiting state and poll. Scoped to the caller; it takes no
// input. Like generating, it starts the bounded retry window on the first hold
// and kicks the user-scoped fetch (idempotent, rate limited, time-boxed).
export async function GET() {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  try {
    const gate = await checkReportNavHistoryGate({ db: createAdminClient(), userId: user.id, today: new Date().toISOString().slice(0, 10), createAnchor: true, kick: kickUserNavHistory });
    return ok({ hold: gate.hold, ...waitingBody(gate), disclosures: gate.disclosures });
  } catch (err) {
    console.error('[investment-intelligence] price-history gate failed', err instanceof Error ? err.message : err);
    // Fail OPEN: a broken check must never trap the user behind a waiting screen.
    return ok({ hold: false, waiting: false, headline: null, loaded: 0, total: 0, waitingFunds: [], unavailableFunds: [], retryWindowMinutes: 0, disclosures: [], checkFailed: true });
  }
}

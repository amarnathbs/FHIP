import { createClient } from '@/lib/supabase/server';
import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { loadAnalyticsDataset, persistAnalyticsRows } from '@/lib/services/investment-intelligence/analyticsRepository';
import { runAnalytics, toPersistableRows } from '@/lib/engines/investment-intelligence/analyticsOrchestrator';

// R4 — Recalculation endpoint (spec sections 57, 96, 103-105).
//
// CANONICAL-ID RESOLUTION (spec section 96): this endpoint accepts NO
// identifying parameters at all. The scope is resolved server-side from
// the authenticated session, so a client cannot request recalculation for
// another household, instrument or benchmark by supplying an id. Any body
// sent is ignored entirely rather than merged into the query.
//
// Persistence goes to ii_analytics_results only — a derived table that is
// never read back into net worth and has no authenticated-role insert
// policy, so rows can only originate from this server path.

export async function POST() {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  try {
    const supabase = await createClient();
    const { dataset, warnings, empty } = await loadAnalyticsDataset(supabase, user.id);

    if (empty || !dataset) {
      return ok({
        recalculated: false,
        persisted: 0,
        warnings,
        message: 'No investment positions are available yet, so there is nothing to recalculate.',
      });
    }

    const results = runAnalytics(dataset);
    const rows = toPersistableRows(user.id, results, dataset);
    const { persisted } = await persistAnalyticsRows(user.id, rows);

    return ok({
      recalculated: true,
      persisted,
      engineVersion: results.engineVersion,
      asOfDate: results.asOfDate,
      warnings,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown error';
    return bad(`Recalculation failed: ${message}`, 500);
  }
}

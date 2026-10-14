import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { ownerClassField, resolveOwnerClassScope } from '@/lib/services/investment-intelligence/ownerClassScope';
import { loadAnalyticsDataset } from '@/lib/services/investment-intelligence/analyticsRepository';
import { runAnalytics } from '@/lib/engines/investment-intelligence/analyticsOrchestrator';
import { attachUnrecoverableHistoryDisclosure, type CoverageGapSummary } from '@/lib/engines/investment-intelligence/navCoverageDisclosure';

// R4 — Performance & benchmark analytics for the authenticated user
// (spec sections 67, 103-105).
//
// This route RETRIEVES derived results. It does not re-implement a single
// formula: every number comes from the certified engines via
// AnalyticsOrchestrator. It is strictly read-only with respect to every
// FHIP financial register.
//
// Parameter-spoofing defence (spec section 96): the ONLY identity used is
// `user.id` from the authenticated session. `from`/`to` are pure date
// bounds — there is deliberately no household/account/instrument id
// parameter, so there is nothing for a caller to spoof.

export async function GET(request: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const url = new URL(request.url);
  const periodStart = parseDateParam(url.searchParams.get('from'));
  const asOfDate = parseDateParam(url.searchParams.get('to'));
  if (periodStart === 'invalid' || asOfDate === 'invalid') {
    return bad('Invalid date parameter: expected a valid calendar date.');
  }
  if (periodStart && asOfDate && periodStart.getTime() > asOfDate.getTime()) {
    return bad('Invalid period: "from" must not be after "to".');
  }

  try {
    const rootClient = await createClient();
    const scope = await resolveOwnerClassScope(request, rootClient, user.id);
    if (!scope.ok) return scope.response;
    const supabase = scope.client;
    const { dataset, warnings, empty } = await loadAnalyticsDataset(supabase, user.id, {
      periodStart: periodStart ?? undefined,
      asOfDate: asOfDate ?? undefined,
    });

    if (empty || !dataset) {
      return ok({
        empty: true,
        ownerClass: ownerClassField(scope),
        warnings,
        message: 'No investment positions are available yet, so performance analytics cannot be calculated.',
      });
    }

    const results = runAnalytics(dataset);
    const disclosedResults = await withUnrecoverableHistoryDisclosure(results);
    return ok({ empty: false, ownerClass: ownerClassField(scope), warnings, results: disclosedResults });
  } catch (e) {
    // Clean error handling (spec section 105): a failure surfaces as an
    // explicit error, never as a zero-valued or partially-populated result
    // that a caller could mistake for a real calculation.
    const message = e instanceof Error ? e.message : 'Unknown error';
    return bad(`Analytics could not be calculated: ${message}`, 500);
  }
}

/** Returns a Date, null when absent, or the literal 'invalid' sentinel. */
function parseDateParam(raw: string | null): Date | null | 'invalid' {
  if (!raw) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return 'invalid';
  const d = new Date(`${raw}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? 'invalid' : d;
}

/**
 * NAV 1 — PO decision #5.6 (2026-09-27). Looks up any unresolved
 * ii_nav_source_coverage_gaps (migration 0219) for the instruments this
 * request's results actually contain, and appends a plain-language
 * disclosure to each affected scheme via
 * attachUnrecoverableHistoryDisclosure() (pure, unit-tested separately).
 * Uses the admin client because that table is admin-read-only by RLS
 * (0219) -- the ordinary per-user client used for the rest of this route
 * cannot read it.
 *
 * Deliberately fails OPEN on this ancillary lookup (logs and returns the
 * original, undisclosed results) rather than failing the whole analytics
 * response: a real performance calculation that already succeeded must not
 * become a 500 because a disclosure enrichment step could not run. This is
 * the one place in this route that does not follow its own header's "a
 * failure surfaces as an explicit error" rule, and it is scoped narrowly
 * and commented for exactly that reason.
 */
async function withUnrecoverableHistoryDisclosure(
  results: ReturnType<typeof runAnalytics>
): Promise<ReturnType<typeof runAnalytics>> {
  const instrumentIds = results.schemes.map((s) => s.instrumentId);
  if (instrumentIds.length === 0) return results;
  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from('ii_nav_source_coverage_gaps')
      .select('instrument_id, gap_from, gap_to, reason_code')
      .in('instrument_id', instrumentIds)
      .is('resolved_at', null);
    if (error) throw new Error(error.message);
    const gapsByInstrumentId: Record<string, CoverageGapSummary[]> = {};
    for (const row of data ?? []) {
      const id = row.instrument_id as string;
      (gapsByInstrumentId[id] ??= []).push({
        gapFrom: row.gap_from as string,
        gapTo: row.gap_to as string,
        reasonCode: row.reason_code as string,
      });
    }
    return attachUnrecoverableHistoryDisclosure(results, gapsByInstrumentId);
  } catch (e) {
    console.error('NAV1 unrecoverable-history disclosure lookup failed (returning undisclosed results):', e instanceof Error ? e.message : e);
    return results;
  }
}

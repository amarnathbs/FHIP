import { createClient } from '@/lib/supabase/server';
import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { loadAnalyticsDataset } from '@/lib/services/investment-intelligence/analyticsRepository';
import { runAnalytics } from '@/lib/engines/investment-intelligence/analyticsOrchestrator';

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
    return bad('Invalid date parameter: expected YYYY-MM-DD.');
  }
  if (periodStart && asOfDate && periodStart.getTime() > asOfDate.getTime()) {
    return bad('Invalid period: "from" must not be after "to".');
  }

  try {
    const supabase = await createClient();
    const { dataset, warnings, empty } = await loadAnalyticsDataset(supabase, user.id, {
      periodStart: periodStart ?? undefined,
      asOfDate: asOfDate ?? undefined,
    });

    if (empty || !dataset) {
      return ok({
        empty: true,
        warnings,
        message: 'No investment positions are available yet, so performance analytics cannot be calculated.',
      });
    }

    const results = runAnalytics(dataset);
    return ok({ empty: false, warnings, results });
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

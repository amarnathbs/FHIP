import { createClient } from '@/lib/supabase/server';
import { requireUser, ok, bad } from '@/lib/api';
import { loadSipDataset } from '@/lib/services/investment-intelligence/r5Repository';
import { runSipSimulations } from '@/lib/engines/investment-intelligence/sip/sipOrchestrator';
import { detectSipSeries } from '@/lib/engines/investment-intelligence/sip/sipDetection';
import { sortSeries } from '@/lib/engines/investment-intelligence/sip/dateAlignment';

// R5 — historical SIP simulation (spec sections 45-47).
//
// EVERYTHING THIS ROUTE RETURNS IS A SIMULATION over historical prices,
// clearly labelled as such. It is never a forecast and never a
// recommendation, and nothing it returns is fed into Forecasting as a future
// contribution assumption (that is R7 scope, requiring explicit user
// confirmation).
//
// PARAMETER-SPOOFING DEFENCE: the caller may choose the SHAPE of the
// simulation (which of their own series, the starting contribution, the
// interval) but NEVER the authoritative market data. The NAV series is
// resolved server-side from the instrument that the caller's own series
// belongs to; a caller cannot inject prices to manufacture a flattering
// result.

interface SimulationRequestBody {
  seriesKey?: unknown;
  startingContribution?: unknown;
  contributionIntervalMonths?: unknown;
  startDate?: unknown;
  endDate?: unknown;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export async function POST(request: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  let body: SimulationRequestBody;
  try {
    body = (await request.json()) as SimulationRequestBody;
  } catch {
    return bad('Request body must be valid JSON.');
  }

  const seriesKey = typeof body.seriesKey === 'string' ? body.seriesKey : null;
  if (!seriesKey) return bad('seriesKey is required.');

  const startingContribution = typeof body.startingContribution === 'number' ? body.startingContribution : null;
  if (startingContribution !== null && (!Number.isFinite(startingContribution) || startingContribution <= 0 || startingContribution > 1e9)) {
    return bad('startingContribution must be a positive number.');
  }
  const intervalMonths = typeof body.contributionIntervalMonths === 'number' ? body.contributionIntervalMonths : 1;
  if (!Number.isInteger(intervalMonths) || intervalMonths < 1 || intervalMonths > 12) {
    return bad('contributionIntervalMonths must be a whole number between 1 and 12.');
  }
  for (const [name, v] of [['startDate', body.startDate], ['endDate', body.endDate]] as const) {
    if (v !== undefined && (typeof v !== 'string' || !ISO.test(v))) return bad(`Invalid ${name}: expected YYYY-MM-DD.`);
  }

  try {
    const supabase = await createClient();
    const { dataset, empty } = await loadSipDataset(supabase, user.id);
    if (empty || !dataset) {
      return ok({ empty: true, message: 'No investment transactions are available yet, so a simulation cannot be run.' });
    }

    // The series must belong to THIS user's own data. Because the dataset was
    // loaded strictly under the authenticated user id, a seriesKey naming
    // another user's account simply will not be found — there is no path by
    // which a caller can simulate against someone else's series.
    const series = detectSipSeries(dataset.transactions).find((s) => s.seriesKey === seriesKey);
    if (!series) return bad('No recurring-contribution series with that identifier exists for this account.', 404);

    const navSeries = sortSeries(dataset.navByInstrument.get(series.instrumentId) ?? []);
    if (navSeries.length === 0) {
      return ok({
        empty: false,
        available: false,
        message: 'No price history is available for this scheme, so a historical simulation cannot be produced. No figures are shown.',
      });
    }

    const startDate = (typeof body.startDate === 'string' ? body.startDate : null) ?? series.firstContributionDate;
    const endDate = (typeof body.endDate === 'string' ? body.endDate : null) ?? dataset.asOfDate;
    if (startDate > endDate) return bad('startDate must not be after endDate.');

    const amounts = series.contributions.map((c) => Math.abs(c.grossAmount));
    const defaultContribution = amounts.length > 0 ? Math.round(amounts.reduce((s, a) => s + a, 0) / amounts.length) : 0;

    const simulations = runSipSimulations({
      series: navSeries,
      startDate,
      endDate,
      startingContribution: startingContribution ?? defaultContribution,
      contributionIntervalMonths: intervalMonths,
      // NAV series are price series unless a total-return series is supplied;
      // this is declared rather than assumed, and displayed with the results.
      seriesIncludesDistributions: false,
      seriesLabel: dataset.instrumentNames?.get(series.instrumentId) ?? series.instrumentId,
    });

    return ok({
      empty: false,
      available: true,
      classification: simulations.classification,
      disclaimer: simulations.disclaimer,
      seriesKey,
      instrumentName: dataset.instrumentNames?.get(series.instrumentId) ?? null,
      currencyCode: series.currencyCode,
      variants: simulations.variants,
      engineVersion: simulations.engineVersion,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown error';
    return bad(`Simulation could not be run: ${message}`, 500);
  }
}

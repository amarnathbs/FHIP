import { requireUser, ok, bad } from '@/lib/api';
import { runReviewCentreRefresh } from '@/lib/services/investment-intelligence/reviewCentreData';

// R9 spec section 74: POST /investment-intelligence/forecast/refresh.
//
// IMPORTANT — what this endpoint deliberately does NOT do (spec section 27,
// "Forecasting remains authoritative"): it does not run a second forecast
// engine. The canonical Module 10 Forecasting Engine
// (lib/engines/forecast/engine.ts, POST /api/forecast/run) already
// recomputes automatically whenever its resolved input changes, because its
// cache key is a content hash of that input (computeForecastInputHash) —
// an investment value change (e.g. from an II publish/refresh) or a goal
// change is already, structurally, a cache miss on the next
// /api/forecast/run call; there is nothing for R9 to "invalidate". The
// Module 7 Goals forecast (lib/engines/goalForecast.ts) is even simpler:
// computeGoalsPagePayload() recomputes it live on every read, so it is
// never stale in the first place.
//
// What R9's own forecast/refresh endpoint IS responsible for: re-running
// the Review Centre's deterministic rules (which read the CURRENT state of
// goal_funding_sources, investments, and the live Goals forecast) so that
// review items reflect the latest data. This is the one genuinely new
// "integration recompute" R9 owns.
export async function POST() {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  try {
    const result = await runReviewCentreRefresh(user.id);
    return ok({ ...result, note: 'Forecasting recomputes automatically on next read via input-hash cache invalidation; this endpoint refreshed Review Centre observations only.' });
  } catch (e) {
    return bad(e instanceof Error ? e.message : 'Forecast integration refresh failed', 500);
  }
}

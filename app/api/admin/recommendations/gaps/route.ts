import { requireAdmin } from '@/lib/services/adminAuth';

// Recommendation Gap Review — WITHHELD PENDING PRIVACY-SAFE REIMPLEMENTATION.
//
// Product Owner decision (Admin A0.2 Wave 5 privacy closure): no Admin role
// may hold standing access to identifiable individual financial figures
// through this endpoint.
//
// What this endpoint used to return, and why that was the problem
// ---------------------------------------------------------------
// It selected, for up to 200 evaluation runs where nothing matched:
//
//   user_id, forecast_profile_id, scenario_id, run_at, matched_count,
//   context_snapshot
//
// `context_snapshot` is `{ signals: EvaluationContext[] }` as written by
// lib/services/recommendationsData.ts, and each signal carries EXACT
// per-person financial values — `monthly_surplus`, `emergency_fund_months`,
// `variance_amount`, `actual_till_date`, `forecast_till_date`,
// `revised_forecast_value`, `estimated_future_impact` — alongside
// `country_code` and, for pillar signals, the person's Health Score band.
// Combined with `user_id`, that is a directly identified financial profile,
// browsable one person at a time by any standing Super Admin session. The
// Admin Architecture Standard §9 names `user_id` and raw `context_snapshot`
// payloads as data an Admin surface must not expose.
//
// The disposition implemented here
// --------------------------------
// The data is stopped at the SERVER boundary. This handler performs no query
// at all — it does not fetch the rows and then filter them, because a
// response that never contained the values cannot leak them through a log, a
// cache, an error path or a future refactor.
//
// Authorization is deliberately evaluated FIRST and unchanged, so the
// existing 401 (unauthenticated) and 403 (authenticated, not Super Admin)
// precedence is preserved exactly: an unauthorised caller must still learn
// nothing about whether this feature exists or what state it is in. Only a
// caller who would previously have received the sensitive payload now
// receives the stable unavailable contract below.
//
// This is an interim disposition, not the destination. The replacement is a
// privacy-safe AGGREGATE capability — counts, gap-reason categories,
// affected recommendation families, broad bands — behind the canonical
// suppression engine (minimum cell size 5, minimum distinct people 10). It
// belongs to the canonical Admin Analytics/Privacy phase and is deliberately
// NOT built here. See docs/admin/A02_WAVE5_GAP_REVIEW_PRIVACY_CLOSURE.md.
//
// Do not "restore" this endpoint by re-adding the query. Restoring it means
// implementing the aggregate contract.

/** Stable machine code for the withheld-feature contract. */
export const GAP_REVIEW_UNAVAILABLE_CODE = 'FEATURE_WITHHELD_PENDING_PRIVACY_REVIEW';

/** Operator-facing explanation. Contains no person-level data by construction. */
export const GAP_REVIEW_UNAVAILABLE_MESSAGE =
  'Recommendation gap review is unavailable. It previously showed one identified person’s exact financial figures, which no Admin role may hold standing access to. It will return as an aggregated, privacy-protected report.';

export async function GET() {
  // Authorization first, and unchanged — 401/403 precedence is preserved for
  // every caller who is not entitled to this surface at all.
  const { forbidden } = await requireAdmin();
  if (forbidden) return forbidden;

  // Authorized Super Admin: an honest, stable "withheld" response. No query
  // is issued, so no individual-level row is ever read, serialized, logged
  // or cached.
  return Response.json(
    { error: GAP_REVIEW_UNAVAILABLE_MESSAGE, code: GAP_REVIEW_UNAVAILABLE_CODE },
    { status: 503 }
  );
}

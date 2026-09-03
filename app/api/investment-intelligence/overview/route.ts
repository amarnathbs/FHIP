import { createClient } from '@/lib/supabase/server';
import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { buildOverviewSummary } from '@/lib/services/investment-intelligence/overviewSummary';
import { buildAnalysisCards, nextStep } from '@/lib/investment-intelligence/analysisAvailability';

// II-PC2 — the workspace Overview's single lightweight summary endpoint
// (spec sections 39-42).
//
// WHY ONE ENDPOINT RATHER THAN SIX CLIENT FETCHES
// -----------------------------------------------
// Spec section 39 requires checking whether existing APIs suffice before
// adding one. They do not, and not merely for tidiness: the five analytics
// routes that would otherwise have to be called to know each card's status
// (`/analytics`, `/sip`, `/xray`, `/tax/summary`, plus `/xray/data-quality`)
// all RUN THEIR ENGINE on GET, and three of them PERSIST derived rows as a
// side effect. Fanning out to them from the Overview would violate spec
// section 40 outright and would make simply opening the page rewrite the
// user's tax lots. This endpoint reads plain tables and counts instead.
//
// SECURITY (spec sections 39, 48): RLS-respecting request client only — no
// service-role client is constructed on this path — and every underlying
// query additionally filters `user_id` explicitly. It aggregates only rows
// the caller can already read, and creates no new disclosure surface.
//
// ERROR ISOLATION (spec section 42): a failure here degrades the Overview's
// summary only. Each analysis route remains independently reachable from the
// sub-navigation, so a broken Overview never makes the workspace unusable.
export async function GET() {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const supabase = await createClient();
  try {
    const summary = await buildOverviewSummary(supabase, user.id);
    return ok({
      portfolio: summary.portfolio,
      dataQuality: summary.dataQuality,
      signals: summary.signals,
      cards: buildAnalysisCards(summary.signals),
      nextStep: nextStep(summary.signals, summary.dataQuality.publishedPositionCount),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return bad(`Investment overview could not be assembled: ${message}`, 500);
  }
}

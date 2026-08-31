// Module 11.1 — GET /api/admin/ai/usage  (spec sections 37, 38, 40).
//
// The AI usage/operations dashboard data. Section 37 is explicit that
// "functional and accurate beats decorative", so this returns the metrics it
// names rather than a bespoke visual surface, and every figure is derived from
// the tables the enforcement path itself writes — so a number here cannot
// drift from what the gate actually did.
//
// Admin-only, via the existing requireAdmin() + adminRoute() convention
// (spec section 34: integrate with the existing Admin architecture, do not
// build a parallel admin-security model).

import { requireAdmin, adminRoute } from '@/lib/services/adminAuth';
import { ok, bad } from '@/lib/api';
import { buildUsageDashboard, listOperationalEvents } from '@/lib/ai/entitlement/platformControls';
import { currentBillingPeriod } from '@/lib/ai/billingPeriod';

export const GET = adminRoute(async (req: Request) => {
  const { forbidden } = await requireAdmin();
  if (forbidden) return forbidden;

  const url = new URL(req.url);
  const period = url.searchParams.get('billing_period') ?? currentBillingPeriod();
  if (!/^\d{4}-\d{2}$/.test(period)) return bad('billing_period must be in YYYY-MM form', 422);

  const minSeverity = url.searchParams.get('min_severity') ?? undefined;

  const [dashboard, events] = await Promise.all([
    buildUsageDashboard(period),
    listOperationalEvents(100, minSeverity),
  ]);

  return ok({ dashboard, operational_events: events });
});

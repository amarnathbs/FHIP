// Module 11 remediation R4 — GET /api/admin/ai/operations: the ONE aggregate
// read behind the Admin AI Operations screen (brief sections 36-39).
//
// Admin Standard: §2/§4 — gated on the separately named
// can_view_ai_operations capability (never bare requireAdmin()); a caller
// without it receives 401/403, never a 200 with empty panels. §8/§13 —
// every panel carries an explicit state; a failed source is `unavailable`
// with its reason. §9 — no identifiers, records or context payloads leave
// this route (see lib/ai/admin/aiOperationsOverview.ts). §14 — read-only;
// every write still goes through the pre-existing audited routes.
import { adminRoute } from '@/lib/services/adminAuth';
import { requireAiOperationsViewer } from '@/lib/services/aiOperationsAdmin';
import { ok, bad } from '@/lib/api';
import { buildAiOperationsOverview } from '@/lib/ai/admin/aiOperationsOverview';

export const GET = adminRoute(async (req: Request) => {
  const { forbidden } = await requireAiOperationsViewer();
  if (forbidden) return forbidden;
  const period = new URL(req.url).searchParams.get('billing_period');
  if (period && !/^\d{4}-\d{2}$/.test(period)) return bad('billing_period must be YYYY-MM', 422);
  return ok(await buildAiOperationsOverview(period ?? undefined));
});

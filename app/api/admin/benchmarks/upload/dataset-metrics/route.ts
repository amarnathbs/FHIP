// Planning Benchmarks - the dataset to metric mapping (which metrics each dataset may receive), maintained without SQL.
//   GET   (capability `view`)      the datasets with their mapped metrics, the registered metrics and the latest audit rows
//   POST  (capability `activate`)  add or change a pair (action set), or take a pair away (action remove)
//
// ADMIN ARCHITECTURE STANDARD - applicability, stated:
//   Capability : the EXISTING `activate` capability (admin_users.can_activate_planning_benchmarks, migration 0275) for
//                writes, and `view` (upload or activate) for reads. Changing which metrics a dataset may receive is a
//                governance act of the same weight as making a file live, so it is gated by the same permission. No
//                new capability (section 14, no shared privilege created for convenience; a holder of upload only is
//                refused with 403 here and by the database function).
//   Four layers: (1) DB   - set_ and remove_planning_benchmark_dataset_metric check auth.uid() and the capability
//                           themselves, RLS on both tables, no insert, update or delete grant for API roles;
//                (2) API  - requireAdmin() then the capability guard on EVERY verb, before the body is read;
//                (3) page - the section lives inside the capability-gated Upload tab;
//                (4) UI   - the controls are shown from the capability flags (UX only).
//   Audit      : every change writes one append-only row (benchmark_dataset_metric_events). A pair that still has live
//                figures is refused unless the caller confirms it explicitly, and live figures are never deleted.
//   Section 9  : global reference data only. The audit rows returned carry no actor identifier.
//   Section 13 : a missing migration is 503 "not installed", an unreadable list is `unavailable`, never an empty list.
//   The service-role client is not imported here.
import { z } from 'zod';
import { bad, ok } from '@/lib/api';
import { adminRoute } from '@/lib/services/adminAuth';
import { guarded, parseBody, failClosed } from '@/lib/planning-benchmarks/routeSupport';
import { loadAllowedValues } from '@/lib/planning-benchmarks/allowedValues';
import { todayIsoUtc } from '@/lib/planning-benchmarks/dates';
import { loadMappingEvents, removeDatasetMetric, setDatasetMetric } from '@/lib/planning-benchmarks/datasetMetricService';

export const dynamic = 'force-dynamic';

export const GET = adminRoute(async () => {
  const g = await guarded('view');
  if (!g.ok) return g.response;
  const allowed = await loadAllowedValues(g.supabase, todayIsoUtc());
  const events = await loadMappingEvents(g.supabase);
  const res = ok({ allowed, events, capabilities: { activate: g.flags.activate } });
  res.headers.set('Cache-Control', 'no-store');
  return res;
});

const Common = {
  datasetId: z.string().uuid(),
  metricCode: z.string().regex(/^[a-z0-9_]{1,80}$/),
  reason: z.string().trim().min(3).max(500),
  confirmed: z.literal(true),
  confirmLiveFigures: z.boolean().optional(),
};
const Body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('set'), ...Common, appliesToValues: z.boolean(), appliesToTargetRanges: z.boolean() }),
  z.object({ action: z.literal('remove'), ...Common }),
]);

export const POST = adminRoute(async (req: Request) => {
  const g = await guarded('activate');
  if (!g.ok) return g.response;
  const body = await parseBody(req, Body);
  if (!body.ok) return body.response;
  const b = body.data;
  if (b.action === 'set' && !b.appliesToValues && !b.appliesToTargetRanges) return bad('Choose at least one kind of file. To take a metric away use remove.', 422);
  return failClosed(
    () =>
      b.action === 'set'
        ? setDatasetMetric(g.supabase, { datasetId: b.datasetId, metricCode: b.metricCode, appliesToValues: b.appliesToValues, appliesToTargetRanges: b.appliesToTargetRanges, reason: b.reason, confirmLiveFigures: b.confirmLiveFigures === true })
        : removeDatasetMetric(g.supabase, { datasetId: b.datasetId, metricCode: b.metricCode, reason: b.reason, confirmLiveFigures: b.confirmLiveFigures === true }),
    (data) => ok(data)
  );
});

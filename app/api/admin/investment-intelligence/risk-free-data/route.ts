// Risk-free Rate Data -- admin status and CSV upload (preview, then attested commit) for the NAV2 Fund analytics report.
//
// ADMIN ARCHITECTURE STANDARD -- applicability, stated:
//   Capabilities: riskFreeDataUpload (admin_users.can_upload_risk_free_data) for upload / review / correction, and the
//                 SEPARATE riskFreeSeriesSwitch (can_switch_risk_free_series) for switching a series, migration 0260.
//                 Neither is implied by isAdmin, by each other, or by market-index / PC6 / benchmark capabilities (s2, s3).
//   Four layers : (1) DB   -- is_risk_free_data_admin() / is_risk_free_series_switch_admin(), each RPC's own auth.uid()
//                            check, RLS; (2) API -- requireRiskFreeCapability() on EVERY verb; (3) page --
//                            requireRiskFreePage(); (4) nav -- lib/admin/adminNav.ts.
//   Denial      : explicit 401 / 403 (country-gate 403 as everywhere), never a 200 with an empty body (s4).
//   s7/s9       : global reference data, no user data; another admin's identifier is never returned.
//   s11         : no export. s13: a missing column / read error / RPC error fails closed with an explicit error.
//
// GET needs either capability and returns only the panels that caller's capabilities cover. POST (preview or commit)
// needs `upload` and runs under the CALLER'S OWN session client, so the database function authorises with auth.uid();
// the service-role client is deliberately not used anywhere in this file.
import { createClient } from '@/lib/supabase/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ok, bad, badValidation } from '@/lib/api';
import { adminRoute } from '@/lib/services/adminAuth';
import { requireRiskFreeCapability } from '@/lib/services/investment-intelligence/nav2/riskFreeAdmin';
import { buildRiskFreeAdminStatus, rpcFailure, uploadBodySchema } from '@/lib/services/investment-intelligence/nav2/riskFreeAdminService';
import { indiaTodayIso } from '@/lib/services/investment-intelligence/nav2/riskFreeToday';
import { commitRiskFreeUpload, planRiskFreeUpload, RISK_FREE_ATTESTATION_TEXT } from '@/lib/services/investment-intelligence/nav2/riskFreeUploadService';

export const dynamic = 'force-dynamic';

export const GET = adminRoute(async () => {
  const { user, flags, forbidden } = await requireRiskFreeCapability('any');
  if (forbidden || !user) return forbidden ?? bad('unauthenticated', 401);
  const supabase = (await createClient()) as unknown as SupabaseClient;
  // The calendar day in India (not UTC): see riskFreeToday.ts.
  const today = indiaTodayIso();
  return ok(await buildRiskFreeAdminStatus(supabase, user.id, flags, today));
});

export const POST = adminRoute(async (req: Request) => {
  const { user, forbidden } = await requireRiskFreeCapability('upload');
  if (forbidden || !user) return forbidden ?? bad('unauthenticated', 401);

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return bad('The request body is not valid JSON.', 400);
  }
  const parsed = uploadBodySchema.safeParse(json);
  if (!parsed.success) return badValidation(parsed.error);
  const body = parsed.data;

  const supabase = (await createClient()) as unknown as SupabaseClient;
  const todayIso = indiaTodayIso();
  const input = { seriesId: body.seriesId, csvText: body.csvText, todayIso, verifiedThrough: body.verifiedThrough || null };

  if (body.action === 'preview') {
    const plan = await planRiskFreeUpload(supabase, input);
    const a = plan.analysis;
    return ok({
      fileSha256: plan.fileSha256,
      fileBytes: plan.fileBytes,
      totalDataRows: a.totalDataRows,
      acceptedRows: a.accepted.length,
      rejectedRows: a.rejected.length,
      rejectedSample: a.rejected.slice(0, 20),
      dateFrom: a.dateFrom,
      dateTo: a.dateTo,
      firstRows: a.accepted.slice(0, 5),
      lastRows: a.accepted.slice(-5),
      gapRows: a.accepted.filter((r) => r.kind === 'gap').length,
      willInsert: plan.newRows.length,
      identicalToPublished: plan.identicalExisting,
      conflictCount: plan.conflicts.length,
      conflicts: plan.conflicts.slice(0, 20),
      blockers: plan.blockers,
      warnings: plan.warnings,
      canCommit: plan.blockers.length === 0,
      attestationText: RISK_FREE_ATTESTATION_TEXT,
    });
  }

  try {
    const outcome = await commitRiskFreeUpload(supabase, {
      ...input,
      fileName: body.fileName,
      attested: body.attested === true,
      attestationText: body.attestationText ?? '',
      expectedSha256: body.expectedSha256,
      firstLoad: body.firstLoad === true,
    });
    if (outcome.status === 'refused') return Response.json({ error: outcome.blockers.join(' '), blockers: outcome.blockers }, { status: 422 });
    return ok(outcome);
  } catch (e) {
    // The database function's own refusal (42501 not authorised, 22023 validation) or a connection problem.
    return rpcFailure(e as { code?: string; message?: string }, 'risk-free upload commit');
  }
});

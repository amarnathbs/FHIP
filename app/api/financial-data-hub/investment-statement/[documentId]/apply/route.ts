import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';
import { getAuInvestmentStatementIdForDocument, reclassifyCorroboratedAuBankLegs } from '@/lib/financial-data-hub/services/investmentStatementProcessingService';
import { applyAuStatementActivity } from '@/lib/investment-import-bridge/applyAuStatementActivity';
import { applyAuStatementPosition } from '@/lib/investment-import-bridge/applyAuStatementPosition';
import { certifyAuPosition } from '@/lib/investment-import-bridge/certifyAuPosition';
import { recordDocumentAuditEvent } from '@/lib/financial-data-hub/services/auditLog';
import { fetchAllRows } from '@/lib/financial-data-hub/bank-csv/pagination';

// POST /api/financial-data-hub/investment-statement/{documentId}/apply
// spec sections 63-65, 108, 121-124. The ONLY route that can change
// canonical Investment Intelligence records. Applies every matched,
// pending activity/position on this statement — each one individually
// atomic and idempotent (see applyAuStatementActivity.ts/
// applyAuStatementPosition.ts headers). A statement that is not yet
// approved, or a row that is not yet matched, is skipped with its own
// per-row reason rather than failing the whole request.
//
// Canonical-upload WP-12 (2026-09-27):
//  - INV-G2: positions now reach this route (they are created 'pending');
//  - INV-G9: every row comes back with its outcome AND its reason, so the
//    panel can show what was added and why anything was not;
//  - INV-G4: bank legs the approved statement corroborates are re-typed
//    (funding -> investment, sale proceeds -> asset_sale, withdrawal ->
//    transfer) through the 0207 helper; dividends are left as the one income
//    leg;
//  - INV-G1: each touched holding is certified (Portfolio Truth), ready for
//    the explicit "Add to Net Worth" step (PO D-05) -- nothing here publishes.
export async function POST(_req: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const statementId = await getAuInvestmentStatementIdForDocument(user.id, documentId);
  if (!statementId) return bad('No statement evidence has been extracted from this document yet.', 404);

  // PAGINATION (spec section 93): a statement with more than 1000 pending
  // rows would otherwise be silently truncated by PostgREST's row cap,
  // applying only the first 1000 and reporting success — `fetchAllRows`
  // pages past it with a deterministic `id` ordering.
  const supabase = await createClient();
  const [activities, positions, statementRow] = await Promise.all([
    fetchAllRows<{ id: string; activity_type: string; trade_date: string | null; amount: number }>(() =>
      supabase.from('fdh_investment_statement_activities').select('id, activity_type, trade_date, amount').eq('statement_id', statementId).eq('user_id', user.id).eq('apply_status', 'pending').order('id', { ascending: true }),
    ),
    fetchAllRows<{ id: string; security_name_raw: string; matched_instrument_id: string | null }>(() =>
      supabase.from('fdh_investment_statement_positions').select('id, security_name_raw, matched_instrument_id').eq('statement_id', statementId).eq('user_id', user.id).eq('apply_status', 'pending').order('id', { ascending: true }),
    ),
    supabase.from('fdh_investment_statements').select('canonical_account_id, approval_status').eq('id', statementId).eq('user_id', user.id).maybeSingle(),
  ]);
  const activityResults = [];
  for (const a of activities) {
    activityResults.push({ row: a, result: await applyAuStatementActivity({ userId: user.id, activityId: a.id }) });
  }
  const positionResults = [];
  for (const p of positions) {
    positionResults.push({ row: p, result: await applyAuStatementPosition({ userId: user.id, positionId: p.id }) });
  }

  // INV-G4: re-type corroborated bank legs. A failure here never undoes the
  // Apply (it already committed row by row); it is reported and audited.
  let bankLegs: { reclassified: number; unchanged: number; skippedUserOverride: number; notVerified: number } | null = null;
  let bankLegError: string | null = null;
  try {
    bankLegs = await reclassifyCorroboratedAuBankLegs(user.id, statementId);
  } catch (e) {
    bankLegError = e instanceof Error ? e.message : String(e);
  }

  // INV-G1: certify every holding this statement touched (idempotent).
  const accountId = (statementRow.data?.canonical_account_id as string | null) ?? null;
  const instrumentIds = new Set<string>();
  for (const p of positionResults) if (p.result.ok && p.row.matched_instrument_id) instrumentIds.add(p.row.matched_instrument_id);
  const certifications = [];
  if (accountId) {
    for (const instrumentId of instrumentIds) certifications.push(await certifyAuPosition(user.id, accountId, instrumentId));
  }

  const appliedCount = activityResults.filter((r) => r.result.ok).length + positionResults.filter((r) => r.result.ok).length;
  const skippedCount = activityResults.filter((r) => r.result.code === 'CANONICAL_TYPE_UNSUPPORTED').length + positionResults.filter((r) => r.result.code === 'CANONICAL_TYPE_UNSUPPORTED').length;

  await recordDocumentAuditEvent({
    userId: user.id,
    documentId,
    eventType: 'investment_statement_applied',
    actorType: 'user',
    actorId: user.id,
    metadata: {
      statementId,
      appliedCount,
      skippedCount,
      activitiesAttempted: activityResults.length,
      positionsAttempted: positionResults.length,
      bankLegsReclassified: bankLegs?.reclassified ?? 0,
      bankLegError: bankLegError ? 'failed' : null,
      certified: certifications.filter((c) => c.status === 'certified' || c.status === 'certified_with_warnings').length,
    },
  });

  return ok({
    statement_id: statementId,
    applied_count: appliedCount,
    skipped_count: skippedCount,
    activities: activityResults.map((r) => ({
      id: r.row.id,
      activity_type: r.row.activity_type,
      trade_date: r.row.trade_date,
      amount: r.row.amount,
      ok: r.result.ok,
      code: r.result.code,
      canonical_transaction_id: r.result.canonicalTransactionId,
      reason: r.result.ok ? null : r.result.error,
    })),
    positions: positionResults.map((r) => ({
      id: r.row.id,
      security_name: r.row.security_name_raw,
      ok: r.result.ok,
      code: r.result.code,
      canonical_holding_snapshot_id: r.result.canonicalTransactionId,
      reason: r.result.ok ? null : r.result.error,
    })),
    bank_legs: bankLegs ? { reclassified: bankLegs.reclassified, unchanged: bankLegs.unchanged, skipped_user_override: bankLegs.skippedUserOverride, not_verified: bankLegs.notVerified } : null,
    bank_leg_error: bankLegError ? 'We could not update the matching bank transactions this time. Your investments were still applied.' : null,
    certification: certifications.map((c) => ({ instrument_id: c.instrumentId, status: c.status, blocking: c.blockingReasons.map((b) => b.message), warnings: c.warningReasons.map((w) => w.message) })),
  });
}

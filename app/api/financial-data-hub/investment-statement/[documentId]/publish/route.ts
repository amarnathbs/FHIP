import { z } from 'zod';
import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import { getAuInvestmentStatementIdForDocument } from '@/lib/financial-data-hub/services/investmentStatementProcessingService';
import { recordDocumentAuditEvent } from '@/lib/financial-data-hub/services/auditLog';
import { previewAuStatementPublication, publishAuStatementPositions } from '@/lib/investment-import-bridge/publishAuPositions';

const bodySchema = z.union([
  z.object({ action: z.literal('preview') }),
  z.object({
    action: z.literal('publish'),
    decisions: z
      .array(
        z.object({
          snapshot_id: z.string().uuid(),
          link_to_existing_investment_id: z.string().uuid().nullish(),
          acknowledged_no_duplicate: z.boolean().optional(),
        }),
      )
      .min(1)
      .max(500),
  }),
]);

// POST /api/financial-data-hub/investment-statement/{documentId}/publish
// Canonical-upload WP-12 (INV-G1 / DC-08, PO D-05): the explicit "Add to Net
// Worth" step for an APPLIED AU broker statement.
//   { action: 'preview' }  -> each holding the statement produced, certified
//                             and previewed by Investment Intelligence
//                             (eligibility, possible duplicate manual rows,
//                             already in Net Worth or not). Writes Portfolio
//                             Truth status only; never an investments row.
//   { action: 'publish', decisions } -> publishes exactly the holdings the
//                             user confirmed, through Investment
//                             Intelligence's own publishPosition (the India
//                             CAS publisher -- no second publisher).
// POST for both because the preview re-certifies (a write), which a GET must
// not do.
export async function POST(req: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const statementId = await getAuInvestmentStatementIdForDocument(user.id, documentId);
  if (!statementId) return bad('No statement evidence has been extracted from this document yet.', 404);

  const body = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!body.success) return bad(body.error.issues[0]?.message ?? 'Invalid request', 422);

  if (body.data.action === 'preview') {
    const candidates = await previewAuStatementPublication(user.id, statementId);
    return ok({
      statement_id: statementId,
      holdings: candidates.map((c) => ({
        snapshot_id: c.snapshotId,
        name: c.instrumentName,
        as_of_date: c.asOfDate,
        value: c.value,
        currency_code: c.currencyCode,
        certification_status: c.certificationStatus,
        eligibility_status: c.eligibility?.status ?? null,
        blocking_reasons: (c.eligibility?.blockingReasons ?? []).map((r) => r.message),
        warning_reasons: (c.eligibility?.warningReasons ?? []).map((r) => r.message),
        duplicate_candidates: c.duplicateCandidates.map((d) => ({ investment_id: d.investmentId, existing_value: d.existingValue, existing_currency: d.existingCurrency, existing_institution: d.existingInstitution, matched_on: d.matchedOn })),
        published: c.published,
        refreshes_existing: c.refreshesExisting,
        error: c.error,
      })),
    });
  }

  const outcomes = await publishAuStatementPositions(
    user.id,
    statementId,
    body.data.decisions.map((d) => ({ snapshotId: d.snapshot_id, linkToExistingInvestmentId: d.link_to_existing_investment_id ?? null, acknowledgedNoDuplicate: d.acknowledged_no_duplicate ?? false })),
  );
  const published = outcomes.filter((o) => o.ok).length;
  await recordDocumentAuditEvent({
    userId: user.id,
    documentId,
    eventType: 'investment_positions_published',
    actorType: 'user',
    actorId: user.id,
    // Ids, codes and counts only -- never document figures.
    metadata: { statementId, requested: outcomes.length, published, errorCodes: outcomes.filter((o) => !o.ok).map((o) => o.errorCode) },
  });
  return ok({
    statement_id: statementId,
    published_count: published,
    results: outcomes.map((o) => ({ snapshot_id: o.snapshotId, ok: o.ok, action: o.action, code: o.errorCode, reason: o.error })),
  });
}

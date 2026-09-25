import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import { isFdhDocumentUploadEnabled } from '@/lib/financial-data-hub/constants/featureFlags';
import {
  continueAuInvestmentStatementProcessing,
  AuInvestmentStatementProcessingError,
  AU_INVESTMENT_STATEMENT_FAILURE_MESSAGES,
} from '@/lib/financial-data-hub/services/investmentStatementProcessingService';
import { auInvestmentStatementUploadMetadataSchema } from '@/lib/financial-data-hub/validation/auInvestmentStatement';

// POST /api/financial-data-hub/investment-statement/{documentId}/process
//
// 2026-09-21 (real-malware-gate async fix) — the resumption half of
// `POST .../investment-statement/upload`. That route now returns
// `pipeline_status: 'pending_scan'` (never extracting immediately) whenever
// the real S3+GuardDuty malware gate has not yet resolved this upload — see
// `investmentStatementProcessingService.ts`'s `resolveAuInvestmentStatement
// Document()`. `AuInvestmentStatementImportPanel.tsx` polls
// `GET /financial-data-hub/documents/{documentId}` until the document
// leaves `validating`, then calls this route — with the SAME metadata it
// originally submitted at upload time — to run the CSV detection/extraction
// step the upload route deferred. A document that never needed to wait
// (flag off, or a scan that resolved inline) never reaches this route at
// all — the upload route already finished it in one call, exactly as
// before.
export async function POST(req: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  if (!isFdhDocumentUploadEnabled()) {
    return bad('Statement uploads are not currently enabled in this environment.', 403);
  }

  const body = await req.json().catch(() => ({}));
  const parsed = auInvestmentStatementUploadMetadataSchema.safeParse(body);
  if (!parsed.success) return bad(parsed.error.issues[0]?.message ?? 'Invalid request', 422);

  try {
    const result = await continueAuInvestmentStatementProcessing(
      user.id,
      documentId,
      {
        csvKind: parsed.data.csv_kind,
        currencyCode: parsed.data.currency_code,
        institutionName: parsed.data.institution_name ?? undefined,
        maskedAccountIdentifier: parsed.data.masked_account_identifier ?? undefined,
        statementDate: parsed.data.statement_date ?? undefined,
        statementPeriodStart: parsed.data.statement_period_start ?? undefined,
        statementPeriodEnd: parsed.data.statement_period_end ?? undefined,
      },
    );
    const reviewDocumentId =
      // 2026-09-25: the original upload the service carried on with (evidence
      // OR an AI draft awaiting review), found by the shared identical-upload
      // rule -- never the copy, which has nothing of its own to review.
      result.duplicateOfDocumentId ?? result.document.id;
    return ok({
      document_id: reviewDocumentId,
      duplicate_of_document_id: result.duplicateOfDocumentId ?? null,
      processing_status: result.document.processing_status,
      pipeline_status: result.pipelineStatus,
      statement_id: result.statementId,
      positions_extracted: result.positionsExtracted,
      activities_extracted: result.activitiesExtracted,
      duplicate: result.pipelineStatus === 'duplicate_statement',
      error_message: result.failureKind ? (AU_INVESTMENT_STATEMENT_FAILURE_MESSAGES[result.failureKind] ?? null) : null,
      // AIE AU investment-statement AI fallback (2026-09-23) — identical to
      // the upload route's own field, and present on BOTH because a document
      // that waited for the malware scan reaches the failure branch through
      // this route instead. Populated only alongside
      // `pipeline_status: 'ai_fallback_available'`, and nothing is written
      // until the user confirms the draft.
      ai_fallback_draft: result.aiFallbackDraft ?? null,
    });
  } catch (e) {
    if (e instanceof AuInvestmentStatementProcessingError) {
      const status = e.code === 'not_found' ? 404 : e.code === 'invalid_state' ? 409 : 500;
      return bad(e.message, status);
    }
    return bad('We could not read this statement upload. Please try again.', 500);
  }
}

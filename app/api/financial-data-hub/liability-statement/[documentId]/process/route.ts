import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import { isFdhDocumentUploadEnabled } from '@/lib/financial-data-hub/constants/featureFlags';
import {
  continueLiabilityStatementProcessing,
  LiabilityStatementProcessingError,
  LIABILITY_STATEMENT_FAILURE_MESSAGES,
} from '@/lib/financial-data-hub/services/liabilityStatementProcessingService';
import { liabilityStatementUploadMetadataSchema } from '@/lib/financial-data-hub/validation/liabilityStatement';

// POST /api/financial-data-hub/liability-statement/{documentId}/process
//
// 2026-09-21 (real-malware-gate async fix) — the resumption half of
// `POST .../liability-statement/upload`. See the identical-purpose
// investment-statement sibling route for the full rationale:
// `LiabilityImportPanel.tsx` polls the document out of `validating`, then
// re-submits the SAME metadata it used at upload time here to finish the
// extraction the upload route deferred.
export async function POST(req: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  if (!isFdhDocumentUploadEnabled()) {
    return bad('Statement uploads are not currently enabled in this environment.', 403);
  }

  const body = await req.json().catch(() => ({}));
  const parsed = liabilityStatementUploadMetadataSchema.safeParse(body);
  if (!parsed.success) return bad(parsed.error.issues[0]?.message ?? 'Invalid request', 422);

  try {
    const result = await continueLiabilityStatementProcessing(
      user.id,
      documentId,
      {
        statementType: parsed.data.statement_type,
        countryCode: parsed.data.country_code,
        currencyCode: parsed.data.currency_code,
        institutionName: parsed.data.institution_name ?? undefined,
        maskedIdentifier: parsed.data.masked_identifier ?? undefined,
        statementPeriodStart: parsed.data.statement_period_start ?? undefined,
        statementPeriodEnd: parsed.data.statement_period_end ?? undefined,
        statementDate: parsed.data.statement_date ?? undefined,
        dueDate: parsed.data.due_date ?? undefined,
        openingBalance: parsed.data.opening_balance ?? undefined,
        closingBalance: parsed.data.closing_balance ?? undefined,
        creditLimit: parsed.data.credit_limit ?? undefined,
        minimumPayment: parsed.data.minimum_payment ?? undefined,
        interestRate: parsed.data.interest_rate ?? undefined,
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
      duplicate: result.pipelineStatus === 'duplicate_statement',
      error_message: result.failureKind ? (LIABILITY_STATEMENT_FAILURE_MESSAGES[result.failureKind] ?? null) : null,
      // AIE liability AI-fallback (2026-09-23) — the same addition as the
      // upload route's own response, because both routes funnel through
      // `resolveLiabilityStatementDocument()` and must return the identical
      // envelope. A draft returned here (after a malware scan cleared) is no
      // different from one returned at upload time.
      ai_fallback_draft: result.aiFallbackDraft ?? null,
    });
  } catch (e) {
    if (e instanceof LiabilityStatementProcessingError) {
      const status = e.code === 'not_found' ? 404 : e.code === 'wrong_document_type' ? 422 : e.code === 'invalid_state' ? 409 : 500;
      return bad(e.message, status);
    }
    // AIE-1 final completion (2026-09-25): an unexpected failure here was
    // swallowed with no server-side trace at all. Log the message (never the
    // document content) so an operator can diagnose it.
    console.error(`liability-statement process failed for ${documentId}: ${e instanceof Error ? e.message.slice(0, 300) : 'unknown'}`);
    return bad('We could not read this statement upload. Please try again.', 500);
  }
}

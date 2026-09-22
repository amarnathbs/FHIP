import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import { isFdhDocumentUploadEnabled } from '@/lib/financial-data-hub/constants/featureFlags';
import {
  continueRetirementStatementProcessing,
  RetirementStatementProcessingError,
  RETIREMENT_STATEMENT_FAILURE_MESSAGES,
} from '@/lib/financial-data-hub/services/retirementStatementProcessingService';
import {
  retirementStatementUploadMetadataSchema as metadataSchema,
  currencyMatchesJurisdiction,
} from '@/lib/financial-data-hub/validation/retirementStatement';

// POST /api/financial-data-hub/retirement-statement/{documentId}/process
//
// 2026-09-21 (real-malware-gate async fix) — the resumption half of
// `POST .../retirement-statement/upload`. See the identical-purpose
// investment-statement sibling route for the full rationale:
// `RetirementStatementImportPanel.tsx` polls the document out of
// `validating`, then re-submits the SAME metadata it used at upload time
// here to finish the extraction the upload route deferred. Reuses the
// upload route's own `metadataSchema`/`currencyMatchesJurisdiction` so a
// re-submitted body is validated identically at both steps.
export async function POST(req: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  if (!isFdhDocumentUploadEnabled()) {
    return bad('Statement uploads are not currently enabled in this environment.', 403);
  }

  const body = await req.json().catch(() => ({}));
  const parsed = metadataSchema.safeParse(body);
  if (!parsed.success) {
    return bad(parsed.error.issues[0]?.message ?? 'Check the statement details and try again.', 400);
  }
  const meta = parsed.data;
  if (!currencyMatchesJurisdiction(meta.jurisdiction, meta.currency_code)) {
    return bad(
      meta.jurisdiction === 'AU'
        ? 'Australian superannuation statements are recorded in AUD.'
        : 'Indian retirement statements are recorded in INR.',
      400,
    );
  }

  try {
    const result = await continueRetirementStatementProcessing(
      user.id,
      documentId,
      {
        jurisdiction: meta.jurisdiction,
        currencyCode: meta.currency_code,
        fundName: meta.fund_name,
        maskedAccountIdentifier: meta.masked_account_identifier,
        statementDate: meta.statement_date,
        statementPeriodStart: meta.statement_period_start,
        statementPeriodEnd: meta.statement_period_end,
        statementTextSample: meta.fund_name,
      },
    );

    return ok({
      document_id: result.document.id,
      statement_id: result.statementId,
      pipeline_status: result.pipelineStatus,
      failure_kind: result.failureKind ?? null,
      failure_message: result.failureKind
        ? RETIREMENT_STATEMENT_FAILURE_MESSAGES[result.failureKind]
          ?? RETIREMENT_STATEMENT_FAILURE_MESSAGES.unknown_error
        : null,
      activities_extracted: result.activitiesExtracted,
      activities_deduplicated: result.activitiesDeduplicated,
      positions_extracted: result.positionsExtracted,
    });
  } catch (e) {
    if (e instanceof RetirementStatementProcessingError) {
      return bad(e.message, e.code === 'not_found' ? 404 : 400);
    }
    throw e;
  }
}

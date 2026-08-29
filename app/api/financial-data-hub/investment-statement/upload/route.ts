import { requireUser, bad, ok } from '@/lib/api';
import { isFdhDocumentUploadEnabled } from '@/lib/financial-data-hub/constants/featureFlags';
import { FDH_MAX_FILE_SIZE_BYTES } from '@/lib/financial-data-hub/domain/fileValidation';
import {
  uploadAndProcessAuInvestmentStatement,
  AuInvestmentStatementProcessingError,
  AU_INVESTMENT_STATEMENT_FAILURE_MESSAGES,
} from '@/lib/financial-data-hub/services/investmentStatementProcessingService';
import { FdhUploadLifecycleError } from '@/lib/financial-data-hub/services/uploadLifecycle';
import { auInvestmentStatementUploadMetadataSchema } from '@/lib/financial-data-hub/validation/auInvestmentStatement';

const HARD_MAX_BYTES = FDH_MAX_FILE_SIZE_BYTES['text/csv'];

// POST /api/financial-data-hub/investment-statement/upload?csv_kind=transaction&currency_code=AUD&...
// FDH-11 spec sections 2-3, 15-20, 23, 76. The request body IS the CSV
// bytes (same server-mediated pattern as FDH-3's upload-sessions/complete
// and FDH-10's liability-statement/upload); metadata travels as query
// parameters. Ownership comes ONLY from the authenticated session. This
// single call performs upload AND extraction but NEVER touches canonical
// Investment Intelligence (spec sections 63-65) — only
// `fdh_investment_statements`/`_positions`/`_activities` evidence.
export async function POST(req: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  if (!isFdhDocumentUploadEnabled()) {
    return bad('Statement uploads are not currently enabled in this environment.', 403);
  }

  const url = new URL(req.url);
  const metadataInput = {
    csv_kind: url.searchParams.get('csv_kind') || undefined,
    currency_code: url.searchParams.get('currency_code') || undefined,
    original_filename_sanitised: url.searchParams.get('filename') || undefined,
    institution_name: url.searchParams.get('institution_name') || undefined,
    masked_account_identifier: url.searchParams.get('masked_account_identifier') || undefined,
    statement_date: url.searchParams.get('statement_date') || undefined,
    statement_period_start: url.searchParams.get('statement_period_start') || undefined,
    statement_period_end: url.searchParams.get('statement_period_end') || undefined,
  };
  const parsed = auInvestmentStatementUploadMetadataSchema.safeParse(metadataInput);
  if (!parsed.success) return bad(parsed.error.issues[0]?.message ?? 'Invalid request', 422);

  const contentLength = Number(req.headers.get('content-length') ?? '0');
  if (!contentLength || contentLength <= 0) return bad('File upload incomplete.', 422);
  if (contentLength > HARD_MAX_BYTES) return bad('File too large.', 413);

  const arrayBuffer = await req.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  if (bytes.byteLength === 0) return bad('File upload incomplete.', 422);

  try {
    const result = await uploadAndProcessAuInvestmentStatement(
      user.id,
      {
        csvKind: parsed.data.csv_kind,
        currencyCode: parsed.data.currency_code,
        institutionName: parsed.data.institution_name ?? undefined,
        maskedAccountIdentifier: parsed.data.masked_account_identifier ?? undefined,
        statementDate: parsed.data.statement_date ?? undefined,
        statementPeriodStart: parsed.data.statement_period_start ?? undefined,
        statementPeriodEnd: parsed.data.statement_period_end ?? undefined,
      },
      bytes,
    );
    const reviewDocumentId =
      result.pipelineStatus === 'duplicate_statement' && result.document.duplicate_of_document_id
        ? result.document.duplicate_of_document_id
        : result.document.id;
    return ok({
      document_id: reviewDocumentId,
      processing_status: result.document.processing_status,
      pipeline_status: result.pipelineStatus,
      statement_id: result.statementId,
      positions_extracted: result.positionsExtracted,
      activities_extracted: result.activitiesExtracted,
      duplicate: result.pipelineStatus === 'duplicate_statement',
      error_message: result.failureKind ? (AU_INVESTMENT_STATEMENT_FAILURE_MESSAGES[result.failureKind] ?? null) : null,
    });
  } catch (e) {
    if (e instanceof AuInvestmentStatementProcessingError) {
      const status = e.code === 'not_found' ? 404 : e.code === 'invalid_state' ? 409 : 500;
      return bad(e.message, status);
    }
    if (e instanceof FdhUploadLifecycleError) {
      const status = e.code === 'not_found' ? 404 : e.code === 'rate_limited' ? 429 : e.code === 'upload_incomplete' ? 422 : 400;
      return bad(e.message, status);
    }
    return bad('We could not read this statement upload. Please try again.', 500);
  }
}

import { requireUser, bad, ok } from '@/lib/api';
import { isFdhDocumentUploadEnabled } from '@/lib/financial-data-hub/constants/featureFlags';
import { FDH_MAX_FILE_SIZE_BYTES } from '@/lib/financial-data-hub/domain/fileValidation';
import {
  uploadAndProcessLiabilityStatement,
  LiabilityStatementProcessingError,
  LIABILITY_STATEMENT_FAILURE_MESSAGES,
} from '@/lib/financial-data-hub/services/liabilityStatementProcessingService';
import { FdhUploadLifecycleError } from '@/lib/financial-data-hub/services/uploadLifecycle';
import { liabilityStatementUploadMetadataSchema } from '@/lib/financial-data-hub/validation/liabilityStatement';

const HARD_MAX_BYTES = FDH_MAX_FILE_SIZE_BYTES['text/csv'];

// POST /api/financial-data-hub/liability-statement/upload?statement_type=credit_card&country_code=AU&currency_code=AUD&...
// FDH-10 spec sections 2, 15-21, 28. The request body IS the CSV bytes (same
// server-mediated pattern as FDH-3's upload-sessions/complete and R7's
// bank-csv/upload); metadata travels as query parameters since the body is
// fully occupied by the file. Ownership comes ONLY from the authenticated
// session — the request never carries a user/household/owner id (spec
// section 20). This single call performs upload AND extraction (see
// `liabilityStatementProcessingService.ts`'s header for why) but NEVER
// touches canonical Liability (spec section 21) — only
// `fdh_liability_statements`/`fdh_liability_statement_activities` evidence.
export async function POST(req: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  if (!isFdhDocumentUploadEnabled()) {
    return bad('Statement uploads are not currently enabled in this environment.', 403);
  }

  const url = new URL(req.url);
  const metadataInput = {
    statement_type: url.searchParams.get('statement_type') || undefined,
    country_code: url.searchParams.get('country_code') || undefined,
    currency_code: url.searchParams.get('currency_code') || undefined,
    original_filename_sanitised: url.searchParams.get('filename') || undefined,
    institution_name: url.searchParams.get('institution_name') || undefined,
    masked_identifier: url.searchParams.get('masked_identifier') || undefined,
    statement_period_start: url.searchParams.get('statement_period_start') || undefined,
    statement_period_end: url.searchParams.get('statement_period_end') || undefined,
    statement_date: url.searchParams.get('statement_date') || undefined,
    due_date: url.searchParams.get('due_date') || undefined,
    opening_balance: url.searchParams.get('opening_balance') || undefined,
    closing_balance: url.searchParams.get('closing_balance') || undefined,
    credit_limit: url.searchParams.get('credit_limit') || undefined,
    minimum_payment: url.searchParams.get('minimum_payment') || undefined,
    interest_rate: url.searchParams.get('interest_rate') || undefined,
  };
  const parsed = liabilityStatementUploadMetadataSchema.safeParse(metadataInput);
  if (!parsed.success) return bad(parsed.error.issues[0]?.message ?? 'Invalid request', 422);

  const contentLength = Number(req.headers.get('content-length') ?? '0');
  if (!contentLength || contentLength <= 0) return bad('File upload incomplete.', 422);
  if (contentLength > HARD_MAX_BYTES) return bad('File too large.', 413);

  const arrayBuffer = await req.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  if (bytes.byteLength === 0) return bad('File upload incomplete.', 422);

  try {
    const result = await uploadAndProcessLiabilityStatement(
      user.id,
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
      bytes,
    );
    return ok({
      document_id: result.document.id,
      processing_status: result.document.processing_status,
      pipeline_status: result.pipelineStatus,
      statement_id: result.statementId,
      duplicate: result.pipelineStatus === 'duplicate_statement',
      error_message: result.failureKind ? (LIABILITY_STATEMENT_FAILURE_MESSAGES[result.failureKind] ?? null) : null,
    });
  } catch (e) {
    if (e instanceof LiabilityStatementProcessingError) {
      const status = e.code === 'not_found' ? 404 : e.code === 'wrong_document_type' ? 422 : e.code === 'invalid_state' ? 409 : 500;
      return bad(e.message, status);
    }
    if (e instanceof FdhUploadLifecycleError) {
      const status = e.code === 'not_found' ? 404 : e.code === 'rate_limited' ? 429 : e.code === 'upload_incomplete' ? 422 : 400;
      return bad(e.message, status);
    }
    return bad('We could not read this statement upload. Please try again.', 500);
  }
}

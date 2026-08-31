import { z } from 'zod';
import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import { isFdhDocumentUploadEnabled } from '@/lib/financial-data-hub/constants/featureFlags';
import { processBankPdfDocument, BankPdfProcessingError } from '@/lib/financial-data-hub/services/bankPdfProcessingService';

const bodySchema = z.object({ password: z.string().max(200).optional() }).optional();

// POST /api/financial-data-hub/bank-pdf/{documentId}/process — spec sections
// 6, 13-46, 55-56, 89-90. Idempotent/retry-safe (see the service module's
// header comment). `password`, when the document is awaiting one, travels
// ONLY in this request's JSON body — never a query string (spec 23: a
// password must never appear in a URL) — and is used exactly once, in
// memory, then discarded; see `bankPdfProcessingService.ts`'s own header
// comment for the complete non-persistence discipline this route relies on.
export async function POST(req: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  if (!isFdhDocumentUploadEnabled()) {
    return bad('Bank PDF processing is not currently enabled in this environment.', 403);
  }

  let password: string | undefined;
  const contentLength = Number(req.headers.get('content-length') ?? '0');
  if (contentLength > 0) {
    const rawBody = await req.json().catch(() => null);
    const parsedBody = bodySchema.safeParse(rawBody);
    if (!parsedBody.success) return bad('Invalid request body.', 422);
    password = parsedBody.data?.password;
  }

  try {
    const result = await processBankPdfDocument(user.id, documentId, password);
    return ok({
      document_id: result.document.id,
      pipeline_status: result.pipelineStatus,
      certification_status: result.certificationStatus,
      processing_status: result.document.processing_status,
      error_code: result.document.error_code,
      reconciliation_status: result.reconciliationStatus,
      transactions_created: result.transactionsCreated,
      duplicates_skipped: result.duplicatesSkipped,
      duplicate_candidates: result.duplicateCandidates,
      rejected_rows: result.rejectedRows,
      page_count: result.document.page_count,
      declared_row_count: result.document.declared_row_count,
      parsed_row_count: result.document.parsed_row_count,
    });
  } catch (e) {
    if (e instanceof BankPdfProcessingError) {
      const status = e.code === 'not_found' ? 404 : e.code === 'rate_limited' ? 429 : 400;
      const message =
        e.code === 'account_unresolved'
          ? 'We could not tell which account this statement belongs to. Please resolve the account before processing.'
          : e.code === 'invalid_state'
            ? 'This document is not currently ready to be processed.'
            : e.code === 'rate_limited'
              ? e.message
              : e.message;
      return bad(message, status);
    }
    return bad('We could not process this bank statement.', 500);
  }
}

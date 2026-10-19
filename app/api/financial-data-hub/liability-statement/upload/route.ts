import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import { isFdhDocumentUploadEnabled } from '@/lib/financial-data-hub/constants/featureFlags';
import { FDH_MAX_FILE_SIZE_BYTES } from '@/lib/financial-data-hub/domain/fileValidation';
import {
  uploadAndProcessLiabilityStatement,
  LiabilityStatementProcessingError,
  LIABILITY_STATEMENT_FAILURE_MESSAGES,
} from '@/lib/financial-data-hub/services/liabilityStatementProcessingService';
import { FdhUploadLifecycleError } from '@/lib/financial-data-hub/services/uploadLifecycle';
import { liabilityStatementUploadMetadataSchema } from '@/lib/financial-data-hub/validation/liabilityStatement';
import {
  assertNoIdenticalDocumentWithDifferentOwner,
  documentOwnerConflictResponse,
  recordDocumentOwner,
  resolveUploadOwnerFromUrl,
} from '@/lib/financial-data-hub/services/documentOwnerRequest';
import { refuseUnlessFinancialImportAllowed } from '@/lib/entitlements/financialDataImport';
import { looksLikePdf } from '@/lib/financial-data-hub/domain/fileValidation';
import { isLiabilityPdfRouteEnabled, PDF_ROUTE_DISABLED_MESSAGE } from '@/lib/financial-data-hub/pdf-statements';
import type { LiabilityFacilityType } from '@/lib/financial-data-hub/liability/types';

const CSV_MAX_BYTES = FDH_MAX_FILE_SIZE_BYTES['text/csv'];
const PDF_MAX_BYTES = FDH_MAX_FILE_SIZE_BYTES['application/pdf'];

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
  // Premium Upload Entitlement (14-10-2026): a customer financial upload is a Premium capability. Refused here, before the body,
  // a document row, a credential, storage, a scan, a parser or a provider is touched. Server-authoritative; no client flag is read.
  const importDenied = await refuseUnlessFinancialImportAllowed(user.id, 'fdh.liability_statement.upload');
  if (importDenied) return importDenied;

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
    facility_type: url.searchParams.get('facility_type') || undefined,
  };
  const parsed = liabilityStatementUploadMetadataSchema.safeParse(metadataInput);
  if (!parsed.success) return bad(parsed.error.issues[0]?.message ?? 'Invalid request', 422);

  // Owner-before-upload (Phase 2): REQUIRED and validated before the file is read. Only owners the
  // canonical Liabilities model separates correctly today (self / spouse / joint household / SMSF in
  // Australia); company, trust and HUF debt is refused so no entity debt can enter personal DTI / DSR.
  const ownerRequest = await resolveUploadOwnerFromUrl(user.id, url, 'liability');
  if (!ownerRequest.ok) return ownerRequest.response;

  const contentLength = Number(req.headers.get('content-length') ?? '0');
  if (!contentLength || contentLength <= 0) return bad('File upload incomplete.', 422);
  // The larger (PDF) ceiling bounds the read; the file's own kind, decided from its BYTES below, decides which ceiling applies.
  if (contentLength > PDF_MAX_BYTES) return bad('File too large.', 413);

  const arrayBuffer = await req.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  if (bytes.byteLength === 0) return bad('File upload incomplete.', 422);

  // PDF statement route (19/10/2026). The bytes decide the kind, never a header. A PDF while this route's own switch is OFF is
  // refused HERE: no document row, no storage, no scan, no reader, no provider. A CSV is untouched by the switch.
  const isPdf = looksLikePdf(bytes);
  if (isPdf && !isLiabilityPdfRouteEnabled()) return bad(PDF_ROUTE_DISABLED_MESSAGE, 403);
  if (!isPdf && bytes.byteLength > CSV_MAX_BYTES) return bad('File too large.', 413);
  // A loan PDF needs the loan type the person chose (a wrong one makes the existing liability unfindable); asked for BEFORE any row exists.
  if (isPdf && parsed.data.statement_type === 'loan' && !parsed.data.facility_type) {
    return bad('Choose the type of loan (for example home loan) before uploading a loan PDF.', 422);
  }

  try {
    await assertNoIdenticalDocumentWithDifferentOwner(user.id, bytes, ['credit_card_statement', 'loan_statement'], ownerRequest.owner);
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
        facilityType: (parsed.data.facility_type ?? undefined) as LiabilityFacilityType | undefined,
      },
      bytes,
    );
    await recordDocumentOwner(user.id, result.document.id, ownerRequest.owner);
    // On a duplicate-whole-document upload, `result.document` is a NEW
    // document row that intentionally has no `fdh_liability_statements` row
    // of its own (uploadAndProcessLiabilityStatement never re-persists
    // evidence for a duplicate) -- only the ORIGINAL document
    // (`duplicate_of_document_id`) does. The client's review step fetches
    // GET .../liability-statement/{document_id}, which resolves via that
    // document's own statement_upload_id link, so returning the new
    // document's id here left every duplicate re-upload live-404ing on
    // review with "No statement evidence has been extracted from this
    // document yet." even though `duplicate: true` and a real `statement_id`
    // were both present. Point document_id at the original document instead
    // so the existing evidence the response promises is actually what loads.
    const reviewDocumentId =
      // 2026-09-25: the original upload the service carried on with (evidence
      // OR an AI draft awaiting review), found by the shared identical-upload
      // rule -- never the copy, which has nothing of its own to review.
      result.duplicateOfDocumentId ?? result.document.id;
    return ok({
      owner_role: ownerRequest.owner.ownerRole,
      document_id: reviewDocumentId,
      duplicate_of_document_id: result.duplicateOfDocumentId ?? null,
      processing_status: result.document.processing_status,
      pipeline_status: result.pipelineStatus,
      statement_id: result.statementId,
      duplicate: result.pipelineStatus === 'duplicate_statement',
      error_message: result.failureKind ? (LIABILITY_STATEMENT_FAILURE_MESSAGES[result.failureKind] ?? null) : null,
      // AIE liability AI-fallback (2026-09-23). Non-null ONLY when
      // `pipeline_status === 'ai_fallback_available'`, and then it is a DRAFT:
      // nothing has been written, `statement_id` is null, and the document is
      // deliberately still in `queued`/`uploaded`. The client must show this
      // for explicit review and call
      // `POST .../{documentId}/ai-fallback/confirm` before anything is saved.
      ai_fallback_draft: result.aiFallbackDraft ?? null,
      // 14-10-2026: present ('premium_required' | 'entitlement_unavailable') only when the file could not be read
      // natively and the AI reading was NOT attempted for entitlement reasons, so the screen can explain and offer
      // the upgrade. Null in every other case.
      ai_fallback_refusal: result.aiFallbackRefusal ?? null,
    });
  } catch (e) {
    const ownerConflict = documentOwnerConflictResponse(e);
    if (ownerConflict) return ownerConflict;
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

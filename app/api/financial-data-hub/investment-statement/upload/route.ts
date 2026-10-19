import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';
import { getUserFullExperienceHomeCountry } from '@/lib/services/jurisdiction';
import { isFdhDocumentUploadEnabled } from '@/lib/financial-data-hub/constants/featureFlags';
import { FDH_MAX_FILE_SIZE_BYTES } from '@/lib/financial-data-hub/domain/fileValidation';
import {
  uploadAndProcessAuInvestmentStatement,
  AuInvestmentStatementProcessingError,
  AU_INVESTMENT_STATEMENT_FAILURE_MESSAGES,
} from '@/lib/financial-data-hub/services/investmentStatementProcessingService';
import { FdhUploadLifecycleError } from '@/lib/financial-data-hub/services/uploadLifecycle';
import { auInvestmentStatementUploadMetadataSchema } from '@/lib/financial-data-hub/validation/auInvestmentStatement';
import {
  assertNoIdenticalDocumentWithDifferentOwner,
  documentOwnerConflictResponse,
  recordDocumentOwner,
  resolveUploadOwnerFromUrl,
} from '@/lib/financial-data-hub/services/documentOwnerRequest';
import { refuseUnlessFinancialImportAllowed } from '@/lib/entitlements/financialDataImport';
import { looksLikePdf } from '@/lib/financial-data-hub/domain/fileValidation';
import { isAuInvestmentPdfRouteEnabled, PDF_ROUTE_DISABLED_MESSAGE } from '@/lib/financial-data-hub/pdf-statements';

const CSV_MAX_BYTES = FDH_MAX_FILE_SIZE_BYTES['text/csv'];
const PDF_MAX_BYTES = FDH_MAX_FILE_SIZE_BYTES['application/pdf'];

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
  // Premium Upload Entitlement (14-10-2026): a customer financial upload is a Premium capability. Refused here, before the body,
  // a document row, a credential, storage, a scan, a parser or a provider is touched. Server-authoritative; no client flag is read.
  const importDenied = await refuseUnlessFinancialImportAllowed(user.id, 'fdh.investment_statement.upload');
  if (importDenied) return importDenied;

  if (!isFdhDocumentUploadEnabled()) {
    return bad('Statement uploads are not currently enabled in this environment.', 403);
  }

  // G5-D2 (related entry point): this whole FDH-11 CSV-statement pipeline is
  // AU-only by design end-to-end (uploadAndProcessAuInvestmentStatement
  // hardcodes country_code:'AU' on the upload session, and the paired
  // account-match route hardcoded countryCode:'AU' when matching/creating
  // ii_accounts). requireCountryConfirmedUser() admits any FULL-experience
  // country (AU or IN), not only AU, so without this explicit, authoritative
  // (never client-supplied, never currency-derived) check an IN user's own
  // statement could be silently created and matched as an Australian
  // document/account. India statements are certified only through the
  // separate CAS-based Investment Intelligence import (R1-R6) — not this
  // route — so a non-AU authoritative country fails closed here with an
  // honest reason rather than proceeding under the wrong country.
  const supabase = await createClient();
  const homeCountry = await getUserFullExperienceHomeCountry(user.id, supabase);
  if (homeCountry !== 'AU') {
    return bad(
      'This statement upload is only available for accounts confirmed in Australia. India brokerage/mutual-fund statements use the CAS-based Investment Intelligence import instead.',
      403
    );
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

  // Owner-before-upload (Phase 2): Self / Spouse / Joint (percentages required, the same allocation model
  // as the India CAS) -- REQUIRED and validated before the file is read. Company, trust and SMSF holdings
  // are refused until they have their own separate records, so nothing entity-held lands in personal holdings.
  const ownerRequest = await resolveUploadOwnerFromUrl(user.id, url, 'au_investment');
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
  if (isPdf && !isAuInvestmentPdfRouteEnabled()) return bad(PDF_ROUTE_DISABLED_MESSAGE, 403);
  if (!isPdf && bytes.byteLength > CSV_MAX_BYTES) return bad('File too large.', 413);

  try {
    await assertNoIdenticalDocumentWithDifferentOwner(user.id, bytes, ['investment_statement'], ownerRequest.owner);
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
    await recordDocumentOwner(user.id, result.document.id, ownerRequest.owner);
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
      // AIE AU investment-statement AI fallback (2026-09-23). Present ONLY
      // when `pipeline_status === 'ai_fallback_available'`, i.e. the native
      // extractor could not read this layout and an AI read a DRAFT off the
      // same bytes. NOTHING has been written at this point — no statement, no
      // positions, no activities, and no `failed` status either. The panel
      // shows this for review and only its explicit confirm
      // (POST .../ai-fallback/confirm) ever writes anything.
      ai_fallback_draft: result.aiFallbackDraft ?? null,
      // 14-10-2026: present ('premium_required' | 'entitlement_unavailable') only when the file could not be read
      // natively and the AI reading was NOT attempted for entitlement reasons, so the screen can explain and offer
      // the upgrade. Null in every other case.
      ai_fallback_refusal: result.aiFallbackRefusal ?? null,
    });
  } catch (e) {
    const ownerConflict = documentOwnerConflictResponse(e);
    if (ownerConflict) return ownerConflict;
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

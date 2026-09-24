import { z } from 'zod';
import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import { isFdhDocumentUploadEnabled } from '@/lib/financial-data-hub/constants/featureFlags';
import {
  processPayslipDocument,
  PayslipProcessingError,
  PAYSLIP_FAILURE_MESSAGES,
  toPayslipAiDraftForReview,
} from '@/lib/financial-data-hub/services/payslipProcessingService';

const bodySchema = z.object({ password: z.string().max(200).optional() }).optional();

// POST /api/financial-data-hub/payslip/{documentId}/process — FDH-9 spec
// sections 4, 21, 25-29, 45-46, 55-58. Turns an uploaded payslip document into
// payroll EVIDENCE (`fdh_payroll_events`/`fdh_payroll_components`). Never
// touches Income (spec section 4: "parsing does not change Income").
// Idempotent/retry-safe — see payslipProcessingService.ts's own header.
export async function POST(req: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  if (!isFdhDocumentUploadEnabled()) {
    return bad('Payslip processing is not currently enabled in this environment.', 403);
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
    const result = await processPayslipDocument(user.id, documentId, password);
    return ok({
      document_id: result.document.id,
      processing_status: result.document.processing_status,
      error_code: result.document.error_code,
      error_message: result.document.error_code ? (PAYSLIP_FAILURE_MESSAGES[result.document.error_code] ?? null) : null,
      payroll_event_id: result.payrollEventId,
      pipeline_status: result.pipelineStatus,
      duplicate: result.pipelineStatus === 'duplicate_payslip',
      // AI-fallback addition: present only when pipeline_status is
      // 'ai_fallback_available'. Nothing has been written yet — this is a
      // DRAFT for the caller to show the user for review/correction, then
      // submit to POST .../ai-fallback/confirm. See
      // docs/aie-programme/AIE_UNIFIED_DOCUMENT_FALLBACK_DESIGN_2026_09_22.md.
      // AIE-1 final completion (2026-09-25), found by the live DEV journey:
      // this used to return the whole internal `PayrollExtraction` (with
      // `components`, `parserName`, `warnings`, `extractionConfidence`...),
      // the panel posts the draft back verbatim, and the confirm route's
      // `.strict()` schema rightly rejects those keys -- so EVERY AI-fallback
      // confirmation failed with 422. Only the reviewable fields go out now,
      // exactly the confirm route's own vocabulary.
      ai_fallback_draft: result.aiFallbackDraft ? toPayslipAiDraftForReview(result.aiFallbackDraft) : null,
    });
  } catch (e) {
    if (e instanceof PayslipProcessingError) {
      // M12C §10: `rate_limited` -> 429, matching the bank-PDF route's own
      // mapping exactly so both PDF password surfaces refuse identically.
      const status =
        e.code === 'not_found' ? 404 : e.code === 'wrong_document_type' ? 422 : e.code === 'invalid_state' ? 409 : e.code === 'rate_limited' ? 429 : 500;
      return bad(e.message, status);
    }
    return bad('We could not process this payslip.', 500);
  }
}

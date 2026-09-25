import { z } from 'zod';
import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import { isFdhDocumentUploadEnabled } from '@/lib/financial-data-hub/constants/featureFlags';
import { confirmAiPayslipFallback, PayslipProcessingError, PAYSLIP_FAILURE_MESSAGES, getDocumentIdForPayrollEvent } from '@/lib/financial-data-hub/services/payslipProcessingService';
import { PAYROLL_COUNTRIES, PAY_FREQUENCIES } from '@/lib/financial-data-hub/payslip/types';

// POST /api/financial-data-hub/payslip/{documentId}/ai-fallback/confirm
//
// The "then ask you to review" half of the payslip AI-fallback path (see
// docs/aie-programme/AIE_UNIFIED_DOCUMENT_FALLBACK_DESIGN_2026_09_22.md).
// `processPayslipDocument()` never writes anything when it returns
// `pipeline_status: 'ai_fallback_available'` — it only returns a DRAFT for
// the user to review. This route is the explicit confirmation step: the
// caller submits the (possibly user-corrected) extracted values, which are
// validated here exactly as a manual Income entry already would be, and
// handed to `confirmAiPayslipFallback`, which writes through the SAME
// `persistPayrollEvidence` path a native successful parse uses — no second
// write path, no auto-write of an unreviewed AI guess.
//
// TRUST MODEL, disclosed explicitly. The submitted values are NOT compared
// back against what the AI originally proposed — the user may correct any
// field, exactly as they already can on the plain manual Income form this
// replaces for a payslip that could not be natively parsed. This is not a
// new privilege: an authenticated user could already enter any figure they
// wanted for their OWN payroll evidence via that manual form.
const bodySchema = z
  .object({
    employerName: z.string().max(200).nullable().optional(),
    payPeriodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    payPeriodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    paymentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    payFrequency: z.enum(PAY_FREQUENCIES),
    grossPay: z.number().finite().nullable().optional(),
    basePay: z.number().finite().nullable().optional(),
    overtimePay: z.number().finite().nullable().optional(),
    bonusPay: z.number().finite().nullable().optional(),
    commissionPay: z.number().finite().nullable().optional(),
    allowancesTotal: z.number().finite().nullable().optional(),
    reimbursementsTotal: z.number().finite().nullable().optional(),
    otherEarnings: z.number().finite().nullable().optional(),
    taxWithheld: z.number().finite().nullable().optional(),
    employeeDeductionsTotal: z.number().finite().nullable().optional(),
    salarySacrifice: z.number().finite().nullable().optional(),
    professionalTax: z.number().finite().nullable().optional(),
    employerRetirementContribution: z.number().finite().nullable().optional(),
    employeeRetirementContribution: z.number().finite().nullable().optional(),
    employerNpsContribution: z.number().finite().nullable().optional(),
    employeeNpsContribution: z.number().finite().nullable().optional(),
    netPay: z.number().finite().nullable().optional(),
    country: z.enum(PAYROLL_COUNTRIES),
    currencyCode: z.string().regex(/^[A-Z]{3}$/),
  })
  .strict()
  .refine((v) => v.grossPay !== null && v.grossPay !== undefined || v.netPay !== null && v.netPay !== undefined, {
    message: 'at least one of grossPay or netPay is required',
  });

function undef<T>(v: T | null | undefined): T | undefined {
  return v === null ? undefined : v;
}

export async function POST(req: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  if (!isFdhDocumentUploadEnabled()) {
    return bad('Payslip processing is not currently enabled in this environment.', 403);
  }

  const rawBody = await req.json().catch(() => null);
  const parsedBody = bodySchema.safeParse(rawBody);
  if (!parsedBody.success) return bad('Invalid or incomplete payslip values.', 422);
  const v = parsedBody.data;

  try {
    const result = await confirmAiPayslipFallback(user.id, documentId, {
      country: v.country,
      currencyCode: v.currencyCode,
      employerName: undef(v.employerName),
      payPeriodStart: undef(v.payPeriodStart),
      payPeriodEnd: undef(v.payPeriodEnd),
      paymentDate: undef(v.paymentDate),
      payFrequency: v.payFrequency,
      payFrequencySource: 'user_confirmed',
      grossPay: undef(v.grossPay),
      basePay: undef(v.basePay),
      overtimePay: undef(v.overtimePay),
      bonusPay: undef(v.bonusPay),
      commissionPay: undef(v.commissionPay),
      allowancesTotal: undef(v.allowancesTotal),
      reimbursementsTotal: undef(v.reimbursementsTotal),
      otherEarnings: undef(v.otherEarnings),
      taxWithheld: undef(v.taxWithheld),
      employeeDeductionsTotal: undef(v.employeeDeductionsTotal),
      salarySacrifice: undef(v.salarySacrifice),
      professionalTax: undef(v.professionalTax),
      employerRetirementContribution: undef(v.employerRetirementContribution),
      employeeRetirementContribution: undef(v.employeeRetirementContribution),
      employerNpsContribution: undef(v.employerNpsContribution),
      employeeNpsContribution: undef(v.employeeNpsContribution),
      netPay: undef(v.netPay),
      components: [],
      parserName: 'aie_payslip_ai_fallback_user_confirmed',
      parserVersion: '1',
      extractionConfidence: 0,
      warnings: [],
    });
    return ok({
      document_id: result.document.id,
      processing_status: result.document.processing_status,
      payroll_event_id: result.payrollEventId,
      pipeline_status: result.pipelineStatus,
      duplicate: result.pipelineStatus === 'duplicate_payslip',
      // Where to carry on from: the upload the duplicate matches (2026-09-25).
      duplicate_of_document_id: result.pipelineStatus === 'duplicate_payslip' && result.payrollEventId ? await getDocumentIdForPayrollEvent(user.id, result.payrollEventId) : null,
    });
  } catch (e) {
    if (e instanceof PayslipProcessingError) {
      const status = e.code === 'not_found' ? 404 : e.code === 'wrong_document_type' ? 422 : e.code === 'invalid_state' ? 409 : 500;
      return bad(PAYSLIP_FAILURE_MESSAGES[e.code] ?? e.message, status);
    }
    return bad('We could not save this payslip.', 500);
  }
}

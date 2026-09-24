import { z } from 'zod';
import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import {
  correctPayrollEvent,
  getPayrollEventIdForDocument,
  getPayrollEventForReview,
  PayslipProcessingError,
  type PayrollCorrections,
} from '@/lib/financial-data-hub/services/payslipProcessingService';
import { PAY_FREQUENCIES } from '@/lib/financial-data-hub/payslip/types';

// POST /api/financial-data-hub/payslip/{documentId}/correct
//
// The write behind the Income tab's "Review / Correct" step. Until
// 2026-09-24 that button re-fetched the screen the user was already on and
// changed nothing — there was no correction surface at all, which is how a
// production payslip whose period base pay was actually a YEAR-TO-DATE total
// had no offered way to be fixed.
//
// NO PARALLEL WRITER. This route validates, then hands the whole job to
// `correctPayrollEvent`, which recomputes the gross-to-net identity with the
// SAME certified `reconcileGrossToNet` the extraction path uses and writes
// through `fdh9_correct_payroll_event` — the narrowly-scoped RPC migration
// 0091's own authoritative-write trigger asked a correction UI to add. The
// corrected event then flows onward through the EXISTING certified path
// unchanged: /approve -> /proposal -> /income-proposals/{id}/apply. Nothing
// here touches canonical Income, exactly as before (spec section 4).
//
// TRUST MODEL, stated plainly. A user may set any figure on their OWN payroll
// evidence, exactly as they already can on the manual Income form and on the
// AI-fallback confirm route. What is new is that the correction is recorded
// as a correction: the field names land in
// `fdh_payroll_events.user_corrected_fields`, `last_corrected_at`/
// `last_corrected_by` attribute it, a `payroll_event_corrected` audit event
// is written, and a corrected gross is stamped `gross_pay_source =
// 'user_corrected'` so it is never mistaken for a figure read off the
// document.

const money = z.number().finite().min(0).max(1_000_000_000).nullable();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable();

// Written out rather than generated from `PAYROLL_CORRECTABLE_MONEY_FIELDS`
// so the schema's own type is exact; the test
// `tests/unit/fdh9PayslipCorrection.test.ts` asserts the two lists agree, so
// they cannot drift apart silently.
const bodySchema = z
  .object({
    employer_name: z.string().max(200).nullable().optional(),
    pay_period_start: isoDate.optional(),
    pay_period_end: isoDate.optional(),
    payment_date: isoDate.optional(),
    pay_frequency: z.enum(PAY_FREQUENCIES).optional(),

    gross_pay: money.optional(),
    base_pay: money.optional(),
    overtime_pay: money.optional(),
    bonus_pay: money.optional(),
    commission_pay: money.optional(),
    allowances_total: money.optional(),
    reimbursements_total: money.optional(),
    other_earnings: money.optional(),
    tax_withheld: money.optional(),
    employee_deductions_total: money.optional(),
    salary_sacrifice: money.optional(),
    professional_tax: money.optional(),
    employer_retirement_contribution: money.optional(),
    employee_retirement_contribution: money.optional(),
    employer_nps_contribution: money.optional(),
    employee_nps_contribution: money.optional(),
    net_pay: money.optional(),
  })
  .strict()
  // An empty body is a mistake, not a no-op correction.
  .refine((v) => Object.keys(v).length > 0, { message: 'no corrections supplied' });

export async function POST(req: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const rawBody = await req.json().catch(() => null);
  const parsedBody = bodySchema.safeParse(rawBody);
  if (!parsedBody.success) return bad('Those values could not be saved. Check each figure and try again.', 422);

  // A period that ends before it starts is refused here with an honest
  // message rather than surfacing the database's own constraint name. The
  // constraint still exists and is still the backstop.
  const start = parsedBody.data.pay_period_start;
  const end = parsedBody.data.pay_period_end;
  if (start && end && end < start) {
    return bad('The pay period end date cannot be before its start date.', 422);
  }

  try {
    const result = await correctPayrollEvent(user.id, documentId, parsedBody.data as PayrollCorrections);
    const payrollEventId = await getPayrollEventIdForDocument(user.id, documentId);
    const review = payrollEventId ? await getPayrollEventForReview(user.id, payrollEventId) : null;
    return ok({
      payroll_event_id: result.payrollEventId,
      corrected_fields: result.correctedFields,
      reconciliation_status: result.reconciliationStatus,
      reconciliation_variance: result.reconciliationVariance,
      reconciliation_restamped: result.reconciliationRestamped,
      payroll_event: review?.event ?? null,
      components: review?.components ?? [],
    });
  } catch (e) {
    if (e instanceof PayslipProcessingError) {
      const status =
        e.code === 'not_found' ? 404 : e.code === 'wrong_document_type' ? 422 : e.code === 'invalid_state' ? 409 : 500;
      return bad(e.message, status);
    }
    return bad('These corrections could not be saved.', 500);
  }
}

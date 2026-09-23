import { z } from 'zod';
import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import {
  correctLiabilityStatement,
  getLiabilityStatementIdForDocument,
  getLiabilityStatementForReview,
  LiabilityStatementProcessingError,
  type LiabilityCorrections,
} from '@/lib/financial-data-hub/services/liabilityStatementProcessingService';

// POST /api/financial-data-hub/liability-statement/{documentId}/correct
//
// The write behind the Liabilities tab's statement review/correct step. Until
// 2026-09-24 that panel offered a "Review / Correct" button whose entire
// handler was `loadReview(documentId!)` — a re-fetch that set the phase the
// panel was already rendered in, so it changed nothing. It was the same dead
// control the payslip panel had; that one became real first (migration 0185,
// `.../payslip/{id}/correct`), and this route is its liability counterpart.
//
// NO PARALLEL WRITER. This route validates, then hands the whole job to
// `correctLiabilityStatement`, which recomputes the statement identity with
// the SAME certified `reconcileCreditCardStatement`/`reconcileLoanStatement`
// the extraction path uses and writes through
// `fdh10_correct_liability_statement` — the narrowly-scoped RPC migration
// 0096's authoritative-write trigger requires. The corrected statement then
// flows onward through the EXISTING certified path unchanged:
// /approve -> /proposal -> /liability-proposals/{id}/apply. Nothing here
// touches canonical Liability (spec section 21), exactly as before.
//
// TRUST MODEL, stated plainly. A user may set any figure on their OWN
// statement evidence, exactly as they already can on the manual Liability
// form. What is new is that the correction is recorded as a correction: the
// field names land in `fdh_liability_statements.user_corrected_fields`,
// `last_corrected_at`/`last_corrected_by` attribute it, and a
// `liability_statement_corrected` audit event is written, so a user-supplied
// figure is never mistaken for one read off the statement.

// SIGNED vs NON-NEGATIVE, and why the distinction is real here where the
// payslip route needed none. A credit-card BALANCE can legitimately be
// negative (an account in credit), a loan principal likewise during a
// payout, and `adjustments_total` is `±` in the formula's own words — so a
// blanket `min(0)` would refuse true statements. The activity totals are
// magnitudes whose SIGN the formula applies itself
// (`- payments - refunds + purchases ...`), so a negative one there would
// silently invert a subtraction; those stay `min(0)`.
const signedMoney = z.number().finite().min(-1_000_000_000).max(1_000_000_000).nullable();
const money = z.number().finite().min(0).max(1_000_000_000).nullable();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable();

// Written out rather than generated from the service's exported field lists
// so the schema's own type is exact; the test
// `tests/unit/fdh10LiabilityCorrection.test.ts` asserts the lists agree, so
// they cannot drift apart silently.
const bodySchema = z
  .object({
    institution_name: z.string().max(200).nullable().optional(),

    statement_period_start: isoDate.optional(),
    statement_period_end: isoDate.optional(),
    statement_date: isoDate.optional(),
    due_date: isoDate.optional(),

    opening_balance: signedMoney.optional(),
    closing_balance: signedMoney.optional(),
    credit_limit: money.optional(),
    minimum_payment: money.optional(),
    purchases_total: money.optional(),
    cash_advances_total: money.optional(),
    refunds_total: money.optional(),

    opening_principal: signedMoney.optional(),
    closing_principal: signedMoney.optional(),
    drawdowns_total: money.optional(),
    capitalised_total: money.optional(),
    principal_repayments_total: money.optional(),

    interest_total: money.optional(),
    fees_total: money.optional(),
    payments_total: money.optional(),
    adjustments_total: signedMoney.optional(),

    // numeric(8,4) with its own `>= 0` CHECK in migration 0096. The upper
    // bound is a typo guard, not a policy: 200% APR is absurd but 100% is
    // not unheard of on a short-term facility.
    interest_rate: z.number().finite().min(0).max(200).nullable().optional(),
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
  // message rather than surfacing the database's own constraint name
  // (`chk_fdh_liability_statements_period`). The constraint still exists and
  // is still the backstop.
  const start = parsedBody.data.statement_period_start;
  const end = parsedBody.data.statement_period_end;
  if (start && end && end < start) {
    return bad('The statement period end date cannot be before its start date.', 422);
  }

  try {
    const result = await correctLiabilityStatement(user.id, documentId, parsedBody.data as LiabilityCorrections);
    const statementId = await getLiabilityStatementIdForDocument(user.id, documentId);
    const review = statementId ? await getLiabilityStatementForReview(user.id, statementId) : null;
    return ok({
      statement_id: result.statementId,
      corrected_fields: result.correctedFields,
      reconciliation_status: result.reconciliationStatus,
      reconciliation_variance: result.reconciliationVariance,
      reconciliation_restamped: result.reconciliationRestamped,
      statement: review?.statement ?? null,
      activities: review?.activities ?? [],
    });
  } catch (e) {
    if (e instanceof LiabilityStatementProcessingError) {
      const status =
        e.code === 'not_found' ? 404 : e.code === 'wrong_document_type' ? 422 : e.code === 'invalid_state' ? 409 : 500;
      return bad(e.message, status);
    }
    return bad('These corrections could not be saved.', 500);
  }
}

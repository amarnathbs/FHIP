import { z } from 'zod';
import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import { isFdhDocumentUploadEnabled } from '@/lib/financial-data-hub/constants/featureFlags';
import {
  confirmAiLiabilityFallback,
  LiabilityStatementProcessingError,
} from '@/lib/financial-data-hub/services/liabilityStatementProcessingService';
import { liabilityStatementUploadMetadataSchema } from '@/lib/financial-data-hub/validation/liabilityStatement';
import { LIABILITY_ACTIVITY_TYPES, LIABILITY_FACILITY_TYPES } from '@/lib/financial-data-hub/liability/types';
import { AIE_LIABILITY_MAX_ACTIVITIES } from '@/lib/aie/adapters/liability';

// POST /api/financial-data-hub/liability-statement/{documentId}/ai-fallback/confirm
//
// The "then ask you to review" half of the liability-statement AI-fallback
// path (see docs/aie-programme/AIE_UNIFIED_DOCUMENT_FALLBACK_DESIGN_2026_09_22.md).
// The upload/process routes write NOTHING when they return
// `pipeline_status: 'ai_fallback_available'` — no `fdh_liability_statements`
// row, no activities, not even a `processing_status` change. They only return
// a DRAFT for the user to review. This route is the explicit confirmation
// step, and it is the ONLY way an AI-read liability statement ever becomes
// evidence.
//
// WHAT THE CLIENT MAY SEND, AND WHAT IT MAY NOT. The body carries only what a
// human could have typed off the page: the same statement metadata the upload
// form already collects, a facility type the USER picked, and per activity a
// type, a date, a positive amount, the printed description/merchant and any
// principal/interest/fee split the statement itself disclosed. It CANNOT send
// a per-type total, a reconciliation status or variance, a bank-match verdict,
// a review status, a parser name or an extraction confidence — every one of
// those is recomputed or fixed server-side by
// `persistLiabilityStatementEvidence`, the same function a native extraction
// calls. A client that wanted to smuggle a "reconciled" verdict past the
// checks has no field in which to put it.
//
// WHY THE METADATA IS RE-SUBMITTED RATHER THAN REMEMBERED. Exactly as in the
// sibling `.../{documentId}/process` route: this service is stateless between
// calls and never persisted the metadata the user chose at upload time (a
// liability document row carries the file, not the form). The client re-sends
// what it originally chose, merged with whatever AI-read header values the
// user accepted on screen.
//
// TRUST MODEL, disclosed explicitly. The submitted values are NOT compared
// back against what the AI originally proposed — the user may correct any
// field, exactly as they already can when adding a liability by hand. This is
// not a new privilege: an authenticated user could already enter any statement
// figures they liked against their OWN account. What they still cannot do is
// make an unreconciled statement claim to be reconciled, or make an AI-read
// statement look natively parsed.

const activitySchema = z
  .object({
    activityType: z.enum(LIABILITY_ACTIVITY_TYPES),
    activityDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    // Positive magnitude only; meaning is carried by `activityType`. A signed
    // amount here would be a second, contradictory encoding of direction and
    // would invert one of the statement totals. Strictly positive: a zero
    // line is not activity evidence and would fail
    // `fdh_liability_statement_activities`' `CHECK (amount > 0)` at write time.
    amount: z.number().finite().positive(),
    descriptionRaw: z.string().max(500).nullable().optional(),
    merchantRaw: z.string().max(200).nullable().optional(),
    principalComponent: z.number().finite().nonnegative().nullable().optional(),
    interestComponent: z.number().finite().nonnegative().nullable().optional(),
    feeComponent: z.number().finite().nonnegative().nullable().optional(),
  })
  .strict();

const bodySchema = z
  .object({
    metadata: liabilityStatementUploadMetadataSchema,
    /** Required for a loan; ignored (and forced to `credit_card`) for a card.
     * The user picks this on screen — the AI is never asked for it. See
     * `lib/aie/adapters/liability/schema.ts`'s header for why this one field
     * is singled out from every other header fact. */
    facilityType: z.enum(LIABILITY_FACILITY_TYPES),
    activities: z.array(activitySchema).min(1).max(AIE_LIABILITY_MAX_ACTIVITIES),
    /** The extraction's own warnings, echoed back so they are persisted with
     * the evidence instead of being lost at the request boundary. Bounded so a
     * client cannot use this as free-form storage. */
    aiWarnings: z.array(z.string().max(200)).max(200).optional(),
  })
  .strict();

function orUndefined<T>(v: T | null | undefined): T | undefined {
  return v === null || v === undefined ? undefined : v;
}

export async function POST(req: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  if (!isFdhDocumentUploadEnabled()) {
    return bad('Statement uploads are not currently enabled in this environment.', 403);
  }

  const rawBody = await req.json().catch(() => null);
  const parsedBody = bodySchema.safeParse(rawBody);
  if (!parsedBody.success) return bad('Invalid or incomplete statement values.', 422);
  const v = parsedBody.data;

  // A credit-card statement can only ever be a credit-card facility, and a
  // loan statement can never be one. Rejected here with a clear message rather
  // than silently coerced, so a UI bug is visible instead of producing a
  // liability that can never be matched to the user's existing one.
  if (v.metadata.statement_type === 'loan' && v.facilityType === 'credit_card') {
    return bad('Choose the kind of loan this statement is for.', 422);
  }

  try {
    const result = await confirmAiLiabilityFallback(user.id, documentId, {
      metadata: {
        statementType: v.metadata.statement_type,
        countryCode: v.metadata.country_code,
        currencyCode: v.metadata.currency_code,
        institutionName: orUndefined(v.metadata.institution_name),
        maskedIdentifier: orUndefined(v.metadata.masked_identifier),
        statementPeriodStart: orUndefined(v.metadata.statement_period_start),
        statementPeriodEnd: orUndefined(v.metadata.statement_period_end),
        statementDate: orUndefined(v.metadata.statement_date),
        dueDate: orUndefined(v.metadata.due_date),
        openingBalance: orUndefined(v.metadata.opening_balance),
        closingBalance: orUndefined(v.metadata.closing_balance),
        creditLimit: orUndefined(v.metadata.credit_limit),
        minimumPayment: orUndefined(v.metadata.minimum_payment),
        interestRate: orUndefined(v.metadata.interest_rate),
      },
      facilityType: v.facilityType,
      activities: v.activities.map((a, i) => ({
        activityType: a.activityType,
        activityDate: a.activityDate,
        amount: a.amount,
        descriptionRaw: orUndefined(a.descriptionRaw),
        merchantRaw: orUndefined(a.merchantRaw),
        principalComponent: orUndefined(a.principalComponent),
        interestComponent: orUndefined(a.interestComponent),
        feeComponent: orUndefined(a.feeComponent),
        // Re-assigned from the REVIEWED order, not carried from the draft, so
        // a user who removed a bogus line does not leave a gap in the recorded
        // source row numbers.
        sourceRowNumber: i + 1,
      })),
      aiWarnings: v.aiWarnings,
    });
    return ok({
      document_id: result.document.id,
      processing_status: result.document.processing_status,
      pipeline_status: result.pipelineStatus,
      statement_id: result.statementId,
    });
  } catch (e) {
    if (e instanceof LiabilityStatementProcessingError) {
      const status = e.code === 'not_found' ? 404 : e.code === 'invalid_state' ? 409 : e.code === 'wrong_document_type' ? 422 : 500;
      return bad(e.message, status);
    }
    return bad('We could not save this statement.', 500);
  }
}

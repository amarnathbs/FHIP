import { z } from 'zod';
import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import { isFdhDocumentUploadEnabled } from '@/lib/financial-data-hub/constants/featureFlags';
import { confirmAiBankStatementFallback, BankPdfProcessingError } from '@/lib/financial-data-hub/services/bankPdfProcessingService';
import { AIE_BANK_STATEMENT_MAX_TRANSACTIONS } from '@/lib/aie/adapters/bankStatement';

// POST /api/financial-data-hub/bank-pdf/{documentId}/ai-fallback/confirm
//
// The "then ask you to review" half of the bank-statement AI-fallback path
// (see docs/aie-programme/AIE_UNIFIED_DOCUMENT_FALLBACK_DESIGN_2026_09_22.md).
// `processBankPdfDocument()` writes NOTHING when it returns
// `pipeline_status: 'ai_fallback_available'` — it only returns a draft for
// the user to review. This route is the explicit confirmation step.
//
// WHAT THE CLIENT MAY SEND, AND WHAT IT MAY NOT. The body carries only what a
// human could have typed off the page: per row a date, a description, a
// positive amount, a direction and an optional running balance; plus the
// statement's period and declared balances. It CANNOT send a source-row hash,
// an economic fingerprint, a duplicate decision, a reconciliation outcome or
// a certification status — every one of those is recomputed server-side by
// `runBankPdfPipelineFromReadRows` from the submitted rows, using the same
// deterministic code the native path uses. A client that wanted to smuggle a
// "reconciled" verdict past the checks has no field in which to put it.
//
// TRUST MODEL, disclosed explicitly. The submitted values are NOT compared
// back against what the AI originally proposed — the user may correct any
// field, exactly as they already can when entering transactions by hand. This
// is not a new privilege: an authenticated user could already record any
// transaction they wanted against their OWN account. What they still cannot
// do is make an unreconciled statement claim to be reconciled.
const rowSchema = z
  .object({
    transactionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    descriptionRaw: z.string().min(1).max(500),
    // Positive magnitude only; direction is `creditDebit`. A signed amount
    // here would be a second, contradictory encoding of direction.
    amountOriginal: z.number().finite().nonnegative(),
    creditDebit: z.enum(['credit', 'debit']),
    balanceAfter: z.number().finite().nullable(),
  })
  .strict();

const bodySchema = z
  .object({
    rows: z.array(rowSchema).min(1).max(AIE_BANK_STATEMENT_MAX_TRANSACTIONS),
    statementPeriodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    statementPeriodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    declaredOpeningBalance: z.number().finite().nullable().optional(),
    declaredClosingBalance: z.number().finite().nullable().optional(),
    // Only ever a partial identifier. Rejected outright if it carries a run
    // of 7+ digits, matching the same rule FDH-3's own upload validation
    // applies — a UI bug that sent a full account number produces a visible
    // error rather than quietly persisting one.
    maskedAccountIdentifier: z
      .string()
      .max(64)
      .refine((v) => !/[0-9]{7,}/.test(v), { message: 'Enter only the last few digits of the account number.' })
      .nullable()
      .optional(),
  })
  .strict();

function orNull<T>(v: T | null | undefined): T | null {
  return v === undefined ? null : v;
}

export async function POST(req: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  if (!isFdhDocumentUploadEnabled()) {
    return bad('Bank statement processing is not currently enabled in this environment.', 403);
  }

  const rawBody = await req.json().catch(() => null);
  const parsedBody = bodySchema.safeParse(rawBody);
  if (!parsedBody.success) return bad('Invalid or incomplete statement values.', 422);
  const v = parsedBody.data;

  try {
    const result = await confirmAiBankStatementFallback(user.id, documentId, {
      rows: v.rows.map((r, i) => ({ ...r, sourceRowNumber: i + 1 })),
      statementPeriodStart: orNull(v.statementPeriodStart),
      statementPeriodEnd: orNull(v.statementPeriodEnd),
      declaredOpeningBalance: orNull(v.declaredOpeningBalance),
      declaredClosingBalance: orNull(v.declaredClosingBalance),
      maskedAccountIdentifier: orNull(v.maskedAccountIdentifier),
    });
    return ok({
      document_id: result.document.id,
      pipeline_status: result.pipelineStatus,
      certification_status: result.certificationStatus,
      processing_status: result.document.processing_status,
      reconciliation_status: result.reconciliationStatus,
      transactions_created: result.transactionsCreated,
      duplicates_skipped: result.duplicatesSkipped,
      duplicate_candidates: result.duplicateCandidates,
    });
  } catch (e) {
    if (e instanceof BankPdfProcessingError) {
      const status = e.code === 'not_found' ? 404 : e.code === 'invalid_state' ? 409 : e.code === 'account_unresolved' ? 422 : 400;
      const message =
        e.code === 'account_unresolved'
          ? 'We could not tell which account this statement belongs to. Please resolve the account before confirming.'
          : e.code === 'invalid_state'
            ? 'This statement has no AI-extracted draft awaiting confirmation.'
            : e.message;
      return bad(message, status);
    }
    return bad('We could not save this statement.', 500);
  }
}

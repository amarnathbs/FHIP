import { z } from 'zod';
import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import { isFdhDocumentUploadEnabled } from '@/lib/financial-data-hub/constants/featureFlags';
import { confirmAiDraftIntoJob } from '@/lib/financial-data-hub/services/bankImportAdmission';
import { PDF_MAX_TRANSACTION_ROWS } from '@/lib/financial-data-hub/bank-pdf/constants';
import { acceptedJobResponse, isUnavailable, unavailableResponse } from '@/lib/financial-data-hub/bankImport/routeHelpers';
import { refuseUnlessImportRunMayStart } from '@/lib/entitlements/financialDataImport';
import { fdhDocumentRunPosition } from '@/lib/financial-data-hub/services/importRunPosition';

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
    // A long statement is read in parts (WP-G), so the reviewed draft can hold far more than the 80 lines one reading is limited to;
    // the ceiling is the importer's own row limit.
    rows: z.array(rowSchema).min(1).max(PDF_MAX_TRANSACTION_ROWS),
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
  // Premium Upload Entitlement (14-10-2026): starting NEW extraction work (a retry / re-parse) is Premium; the first run of a
  // document admitted while Premium and the idempotent in-flight lifecycle still complete after a downgrade.
  const importDenied = await refuseUnlessImportRunMayStart(user.id, 'fdh.bank_pdf.ai_fallback_confirm', () => fdhDocumentRunPosition(user.id, documentId));
  if (importDenied) return importDenied;

  if (!isFdhDocumentUploadEnabled()) {
    return bad('Bank statement processing is not currently enabled in this environment.', 403);
  }

  const rawBody = await req.json().catch(() => null);
  const parsedBody = bodySchema.safeParse(rawBody);
  if (!parsedBody.success) return bad('Invalid or incomplete statement values.', 422);
  const v = parsedBody.data;

  try {
    // WP-G: confirming no longer writes the lines inside this request. It claims the server-issued draft (once) and queues the
    // writing as the statement's background job; the browser polls the job to its end. A replayed confirmation finds the same job.
    const outcome = await confirmAiDraftIntoJob({
      userId: user.id,
      documentId,
      reviewed: {
        rows: v.rows.map((r, i) => ({ ...r, sourceRowNumber: i + 1 })),
        statementPeriodStart: orNull(v.statementPeriodStart),
        statementPeriodEnd: orNull(v.statementPeriodEnd),
        declaredOpeningBalance: orNull(v.declaredOpeningBalance),
        declaredClosingBalance: orNull(v.declaredClosingBalance),
        maskedAccountIdentifier: orNull(v.maskedAccountIdentifier),
      },
    });
    if (outcome.kind === 'job') return acceptedJobResponse(outcome.job);
    if (outcome.kind === 'result') return ok(outcome.payload);
    return bad(outcome.message, outcome.status);
  } catch (e) {
    if (isUnavailable(e)) return unavailableResponse();
    console.error('[bank-pdf/ai-fallback/confirm] unexpected failure', { documentIdPrefix: documentId.slice(0, 8), name: e instanceof Error ? e.name : typeof e, message: e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300) });
    return bad('We could not save this statement.', 500);
  }
}

import { z } from 'zod';
import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import { isFdhDocumentUploadEnabled } from '@/lib/financial-data-hub/constants/featureFlags';
import {
  confirmAiAuInvestmentFallback,
  AuInvestmentStatementProcessingError,
} from '@/lib/financial-data-hub/services/investmentStatementProcessingService';
import { AIE_AU_INVESTMENT_MAX_HOLDINGS, AIE_AU_INVESTMENT_MAX_TRANSACTIONS } from '@/lib/aie/adapters/auInvestment';
import { AU_STATEMENT_TRANSACTION_TYPES } from '@/lib/financial-data-hub/investment/types';

// POST /api/financial-data-hub/investment-statement/{documentId}/ai-fallback/confirm
//
// The "then ask you to review" half of the FDH-11 AU investment-statement
// AI-fallback path (see
// docs/aie-programme/AIE_UNIFIED_DOCUMENT_FALLBACK_DESIGN_2026_09_22.md §2.1).
// The upload/process routes write NOTHING when they return
// `pipeline_status: 'ai_fallback_available'` — they only return a draft for
// the user to review. This route is the explicit confirmation step, and it is
// the ONLY way an AI-read investment statement can ever become evidence.
//
// WHAT THE CLIENT MAY SEND, AND WHAT IT MAY NOT. The body carries only what a
// human could have typed off the page: per holding a security name, code,
// ISIN, unit count, unit price, market value and valuation date; per activity
// a type from FDH-11's own closed statement vocabulary, the trade and
// settlement dates, the security, the units and price, a positive amount and
// the brokerage; plus the statement's own header dates and institution. It
// CANNOT send a currency, a country, a reconciliation status, a security
// match, a bank match, an approval or an extraction confidence — every one of
// those is either re-established server-side from the document itself
// (`confirmAiAuInvestmentFallback`) or computed afterwards by FDH-11's own
// already-certified code. A client that wanted to smuggle a "reconciled"
// verdict past the checks has no field in which to put it.
//
// NUMBERS TRAVEL AS EXACT DECIMAL STRINGS, not JSON numbers. FDH-11's evidence
// types store units and money as strings precisely to keep IEEE-754 loss out
// of a share registry's 6-decimal unit holdings, and a JSON number here would
// reintroduce it at the one boundary designed to prevent it. Unit prices allow
// more decimal places than money because AU fund unit prices are genuinely
// printed to 3-6 places.
//
// TRUST MODEL, disclosed explicitly. The submitted values are NOT compared
// back against what the AI originally proposed — the user may correct or
// remove any line, exactly as they already can when adding an investment by
// hand. This is not a new privilege: an authenticated user could already
// record any holding they wanted against their OWN account. What they still
// cannot do is skip the reconciliation, security-match and explicit approve
// steps that stand between this evidence and canonical Investment
// Intelligence.
const MONEY = /^\d{1,15}(\.\d{1,2})?$/;
// Units and unit prices: wider precision, same exact-decimal-string rule.
const DECIMAL_6 = /^\d{1,15}(\.\d{1,6})?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const holdingSchema = z
  .object({
    securityNameRaw: z.string().min(1).max(300),
    tickerRaw: z.string().max(32).nullable(),
    isin: z.string().max(32).nullable(),
    quantity: z.string().regex(DECIMAL_6),
    unitPrice: z.string().regex(DECIMAL_6).nullable(),
    marketValue: z.string().regex(MONEY).nullable(),
    valuationDate: z.string().regex(ISO_DATE),
  })
  .strict();

const activitySchema = z
  .object({
    transactionType: z.enum(AU_STATEMENT_TRANSACTION_TYPES),
    tradeDate: z.string().regex(ISO_DATE).nullable(),
    settlementDate: z.string().regex(ISO_DATE).nullable(),
    securityNameRaw: z.string().max(300).nullable(),
    tickerRaw: z.string().max(32).nullable(),
    quantity: z.string().regex(DECIMAL_6).nullable(),
    unitPrice: z.string().regex(DECIMAL_6).nullable(),
    // Positive magnitude only; meaning is carried by `transactionType`. A
    // signed amount would be a second, contradictory encoding of direction.
    amount: z.string().regex(MONEY),
    brokerageRaw: z.string().regex(MONEY).nullable(),
  })
  .strict();

const bodySchema = z
  .object({
    csv_kind: z.enum(['transaction', 'portfolio']).optional(),
    holdings: z.array(holdingSchema).max(AIE_AU_INVESTMENT_MAX_HOLDINGS).default([]),
    activities: z.array(activitySchema).max(AIE_AU_INVESTMENT_MAX_TRANSACTIONS).default([]),
    institutionName: z.string().max(200).nullable().optional(),
    // Only ever a PARTIAL identifier. An AU broker account reference is a
    // HIN/SRN; rejecting any run of 7+ digits outright means a UI bug that
    // sent a full one produces a visible error rather than quietly persisting
    // it into evidence this module has spent real effort not to carry.
    maskedAccountIdentifier: z
      .string()
      .max(64)
      .refine((v) => !/[0-9]{7,}/.test(v), { message: 'Enter only the last few digits of the account number.' })
      .nullable()
      .optional(),
    statementDate: z.string().regex(ISO_DATE).nullable().optional(),
    statementPeriodStart: z.string().regex(ISO_DATE).nullable().optional(),
    statementPeriodEnd: z.string().regex(ISO_DATE).nullable().optional(),
  })
  .strict()
  .refine((v) => v.holdings.length + v.activities.length > 0, {
    message: 'At least one holding or transaction is required.',
  });

function orNull<T>(v: T | null | undefined): T | null {
  return v === undefined ? null : v;
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

  try {
    const result = await confirmAiAuInvestmentFallback(user.id, documentId, {
      csvKind: v.csv_kind,
      holdings: v.holdings,
      activities: v.activities,
      institutionName: orNull(v.institutionName),
      maskedAccountIdentifier: orNull(v.maskedAccountIdentifier),
      statementDate: orNull(v.statementDate),
      statementPeriodStart: orNull(v.statementPeriodStart),
      statementPeriodEnd: orNull(v.statementPeriodEnd),
    });
    // The SAME envelope the upload and process routes return, so the panel's
    // existing `handleStatementOutcome` can consume a confirmed AI draft
    // exactly as it consumes a natively-extracted statement — the point of the
    // whole design being that the two are indistinguishable downstream.
    return ok({
      document_id: result.document.id,
      processing_status: result.document.processing_status,
      pipeline_status: result.pipelineStatus,
      statement_id: result.statementId,
      positions_extracted: result.positionsExtracted,
      activities_extracted: result.activitiesExtracted,
      duplicate: false,
      error_message: null,
    });
  } catch (e) {
    if (e instanceof AuInvestmentStatementProcessingError) {
      const status = e.code === 'not_found' ? 404 : e.code === 'invalid_state' ? 409 : 500;
      return bad(e.message, status);
    }
    return bad('We could not save this statement.', 500);
  }
}

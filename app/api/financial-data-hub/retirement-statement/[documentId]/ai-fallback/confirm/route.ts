import { z } from 'zod';
import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import { isFdhDocumentUploadEnabled } from '@/lib/financial-data-hub/constants/featureFlags';
import {
  confirmAiRetirementFallback,
  RetirementStatementProcessingError,
  RETIREMENT_STATEMENT_FAILURE_MESSAGES,
} from '@/lib/financial-data-hub/services/retirementStatementProcessingService';
import {
  RETIREMENT_ACTIVITY_TYPES,
  RETIREMENT_ACCOUNT_TYPES,
  RETIREMENT_STATEMENT_TYPES,
} from '@/lib/financial-data-hub/retirement/types';
import { currencyMatchesJurisdiction } from '@/lib/financial-data-hub/validation/retirementStatement';
import { AIE_RETIREMENT_MAX_ACTIVITIES, AIE_RETIREMENT_MAX_POSITIONS, AIE_RETIREMENT_PARSER_NAME } from '@/lib/aie/adapters/retirement';

// POST /api/financial-data-hub/retirement-statement/{documentId}/ai-fallback/confirm
//
// The "then ask you to review" half of the retirement-statement AI-fallback
// path (see docs/aie-programme/AIE_UNIFIED_DOCUMENT_FALLBACK_DESIGN_2026_09_22.md).
// The upload/process routes write NOTHING when they return
// `pipeline_status: 'ai_fallback_available'` — they only return a draft. This
// route is the explicit confirmation step: the submitted (possibly
// user-corrected) values are validated here and handed to
// `confirmAiRetirementFallback`, which writes through the SAME
// `persistRetirementEvidence` a native successful parse uses.
//
// MONEY TRAVELS AS DECIMAL STRINGS, NOT JSON NUMBERS, ALL THE WAY THROUGH.
// `RetirementStatementExtraction` stores money as exact decimal strings and
// its own type header calls a `number` on a money field "a defect", so
// accepting a JSON number here — even to convert it immediately — would
// reintroduce IEEE-754 loss at precisely the boundary the string
// representation exists to protect. The Zod schema below therefore refuses a
// number outright rather than coercing one.
//
// WHAT THE CLIENT MAY NOT SEND. No jurisdiction-independent currency, no
// reconciliation verdict, no SMSF classification, no statement id. SMSF
// routing in particular is recomputed server-side by
// `confirmAiRetirementFallback` from the fund name and text sample — a user
// cannot route a statement into or away from SMSF handling by editing a
// payload.
const decimalString = z.string().regex(/^-?\d{1,15}(\.\d{1,2})?$/, 'must be an exact decimal string');
const quantityString = z.string().regex(/^-?\d{1,15}(\.\d{1,6})?$/, 'must be an exact decimal string');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const activitySchema = z
  .object({
    activityType: z.enum(RETIREMENT_ACTIVITY_TYPES),
    // Positive magnitude only; direction comes from the shared
    // RETIREMENT_ACTIVITY_DIRECTION table, never from a sign here.
    amount: decimalString.refine((v) => !v.startsWith('-'), { message: 'amount must be a positive magnitude' }),
    activityDate: isoDate.nullable().optional(),
    descriptionRaw: z.string().max(300).nullable().optional(),
    employerNameRaw: z.string().max(200).nullable().optional(),
    isSummaryTotal: z.boolean(),
    isYearToDate: z.boolean(),
  })
  .strict();

const positionSchema = z
  .object({
    optionNameRaw: z.string().min(1).max(200),
    assetClassRaw: z.string().max(120).nullable().optional(),
    units: quantityString.nullable().optional(),
    unitPrice: quantityString.nullable().optional(),
    marketValue: decimalString.nullable().optional(),
    valuationDate: isoDate.nullable().optional(),
  })
  .strict();

const moneyField = decimalString.nullable().optional();

const bodySchema = z
  .object({
    jurisdiction: z.enum(['AU', 'IN']),
    currencyCode: z.enum(['AUD', 'INR']),
    statementType: z.enum(RETIREMENT_STATEMENT_TYPES),
    accountType: z.enum(RETIREMENT_ACCOUNT_TYPES),
    fundName: z.string().max(200).nullable().optional(),
    // MASKED ONLY, the identical rule the upload metadata schema applies: a
    // value carrying a run of 7+ digits is refused rather than silently
    // truncated, so a UI bug that sent a whole member number produces a
    // visible error instead of quietly persisting one.
    maskedAccountIdentifier: z
      .string()
      .max(64)
      .refine((v) => !/[0-9]{7,}/.test(v), { message: 'Enter only the last few digits of your member number, not the whole number.' })
      .nullable()
      .optional(),
    statementDate: isoDate.nullable().optional(),
    statementStartDate: isoDate.nullable().optional(),
    statementEndDate: isoDate.nullable().optional(),
    openingBalance: moneyField,
    closingBalance: moneyField,
    employerContributions: moneyField,
    personalContributions: moneyField,
    salarySacrifice: moneyField,
    governmentContributions: moneyField,
    rolloversIn: moneyField,
    rolloversOut: moneyField,
    withdrawals: moneyField,
    pensionPayments: moneyField,
    investmentEarnings: moneyField,
    fees: moneyField,
    insurancePremiums: moneyField,
    tax: moneyField,
    activities: z.array(activitySchema).max(AIE_RETIREMENT_MAX_ACTIVITIES),
    positions: z.array(positionSchema).max(AIE_RETIREMENT_MAX_POSITIONS),
  })
  .strict()
  .refine((v) => v.activities.length > 0 || v.closingBalance != null || v.openingBalance != null, {
    message: 'a balance or at least one activity is required',
  });

function undef<T>(v: T | null | undefined): T | undefined {
  return v === null || v === undefined ? undefined : v;
}

export async function POST(req: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  if (!isFdhDocumentUploadEnabled()) {
    return bad('Retirement statement processing is not currently enabled in this environment.', 403);
  }

  const rawBody = await req.json().catch(() => null);
  const parsedBody = bodySchema.safeParse(rawBody);
  if (!parsedBody.success) return bad('Invalid or incomplete retirement statement values.', 422);
  const v = parsedBody.data;

  // The same jurisdiction/currency coherence rule the upload route enforces —
  // a statement whose own arithmetic mixes AUD and INR is not coherent.
  if (!currencyMatchesJurisdiction(v.jurisdiction, v.currencyCode)) {
    return bad('The currency does not match the jurisdiction for this statement.', 422);
  }

  try {
    const result = await confirmAiRetirementFallback(
      user.id,
      documentId,
      {
        statementType: v.statementType,
        jurisdiction: v.jurisdiction,
        accountType: v.accountType,
        fundName: undef(v.fundName),
        maskedAccountIdentifier: undef(v.maskedAccountIdentifier),
        currencyCode: v.currencyCode,
        statementDate: undef(v.statementDate),
        statementStartDate: undef(v.statementStartDate),
        statementEndDate: undef(v.statementEndDate),
        openingBalance: undef(v.openingBalance),
        closingBalance: undef(v.closingBalance),
        employerContributions: undef(v.employerContributions),
        personalContributions: undef(v.personalContributions),
        salarySacrifice: undef(v.salarySacrifice),
        governmentContributions: undef(v.governmentContributions),
        rolloversIn: undef(v.rolloversIn),
        rolloversOut: undef(v.rolloversOut),
        withdrawals: undef(v.withdrawals),
        pensionPayments: undef(v.pensionPayments),
        investmentEarnings: undef(v.investmentEarnings),
        fees: undef(v.fees),
        insurancePremiums: undef(v.insurancePremiums),
        tax: undef(v.tax),
        // Never AI-derived and never client-supplied — see `mapping.ts`.
        ytdEmployerContributions: undefined,
        ytdPersonalContributions: undefined,
        activities: v.activities.map((a, i) => ({
          activityType: a.activityType,
          amount: a.amount,
          currencyCode: v.currencyCode,
          activityDate: undef(a.activityDate),
          descriptionRaw: undef(a.descriptionRaw),
          employerNameRaw: undef(a.employerNameRaw),
          isSummaryTotal: a.isSummaryTotal,
          isYearToDate: a.isYearToDate,
          sourceRowNumber: i + 1,
        })),
        positions: v.positions.map((p, i) => ({
          optionNameRaw: p.optionNameRaw,
          assetClassRaw: undef(p.assetClassRaw),
          units: undef(p.units),
          unitPrice: undef(p.unitPrice),
          marketValue: undef(p.marketValue),
          currencyCode: v.currencyCode,
          valuationDate: undef(p.valuationDate),
          sourceRowNumber: i + 1,
        })),
        // Stamped so a reviewer and every downstream consumer can tell an
        // AI-read, user-confirmed statement from a natively-parsed one.
        parserName: `${AIE_RETIREMENT_PARSER_NAME}_user_confirmed`,
        parserVersion: '1',
        // P4/REC-04: no confidence channel is trusted anywhere here.
        extractionConfidence: 0,
        warnings: [],
      },
      { fundName: undef(v.fundName), statementTextSample: undef(v.fundName) },
    );

    return ok({
      document_id: result.document.id,
      statement_id: result.statementId,
      pipeline_status: result.pipelineStatus,
      failure_kind: result.failureKind ?? null,
      failure_message: result.failureKind
        ? RETIREMENT_STATEMENT_FAILURE_MESSAGES[result.failureKind] ?? RETIREMENT_STATEMENT_FAILURE_MESSAGES.unknown_error
        : null,
      activities_extracted: result.activitiesExtracted,
      activities_deduplicated: result.activitiesDeduplicated,
      positions_extracted: result.positionsExtracted,
    });
  } catch (e) {
    if (e instanceof RetirementStatementProcessingError) {
      return bad(e.message, e.code === 'not_found' ? 404 : e.code === 'invalid_state' ? 409 : 400);
    }
    return bad('We could not save this retirement statement.', 500);
  }
}

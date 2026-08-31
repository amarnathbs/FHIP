import { z } from 'zod';
import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import {
  uploadAndProcessRetirementStatement,
  RetirementStatementProcessingError,
  RETIREMENT_STATEMENT_FAILURE_MESSAGES,
} from '@/lib/financial-data-hub/services/retirementStatementProcessingService';

// POST /api/financial-data-hub/retirement-statement/upload
//
// Upload AND process a retirement statement CSV (spec sections 91, 119).
// Reuses FDH-3's document lifecycle unchanged — no new upload framework.
//
// CANONICAL RETIREMENT IS UNCHANGED BY THIS CALL (spec section 56). This route
// creates statement EVIDENCE only.

const metadataSchema = z.object({
  jurisdiction: z.enum(['AU', 'IN']),
  currency_code: z.enum(['AUD', 'INR']),
  fund_name: z.string().max(200).optional(),
  // MASKED ONLY (spec section 89). A value containing a run of 7+ digits is
  // rejected here rather than silently truncated, so a UI bug that sent a full
  // member number produces a visible error instead of quietly persisting it.
  // Migration 0112's CHECK constraint is the second, independent refusal.
  masked_account_identifier: z.string().max(64)
    .refine((v) => !/[0-9]{7,}/.test(v), {
      message: 'Enter only the last few digits of your member number, not the whole number.',
    })
    .optional(),
  statement_date: z.string().date().optional(),
  statement_period_start: z.string().date().optional(),
  statement_period_end: z.string().date().optional(),
});

/**
 * CURRENCY MUST MATCH JURISDICTION for a NEW statement's own arithmetic to be
 * coherent (spec section 68: never sum AUD and INR without canonical FX
 * treatment).
 *
 * NOTE what this does NOT do (spec sections 69-70): it does not consult the
 * user's country of residence. An Australian resident may hold an Indian EPF
 * account, and an Indian resident may retain Australian super; blocking either
 * on residence would erase a legitimate foreign retirement holding.
 */
function currencyMatchesJurisdiction(jurisdiction: 'AU' | 'IN', currency: string): boolean {
  return jurisdiction === 'AU' ? currency === 'AUD' : currency === 'INR';
}

export async function POST(req: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const url = new URL(req.url);
  const parsed = metadataSchema.safeParse({
    jurisdiction: url.searchParams.get('jurisdiction') ?? undefined,
    currency_code: url.searchParams.get('currency_code') ?? undefined,
    fund_name: url.searchParams.get('fund_name') ?? undefined,
    masked_account_identifier: url.searchParams.get('masked_account_identifier') ?? undefined,
    statement_date: url.searchParams.get('statement_date') ?? undefined,
    statement_period_start: url.searchParams.get('statement_period_start') ?? undefined,
    statement_period_end: url.searchParams.get('statement_period_end') ?? undefined,
  });
  if (!parsed.success) {
    return bad(parsed.error.issues[0]?.message ?? 'Check the statement details and try again.', 400);
  }
  const meta = parsed.data;

  if (!currencyMatchesJurisdiction(meta.jurisdiction, meta.currency_code)) {
    return bad(
      meta.jurisdiction === 'AU'
        ? 'Australian superannuation statements are recorded in AUD.'
        : 'Indian retirement statements are recorded in INR.',
      400,
    );
  }

  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.byteLength === 0) return bad('The uploaded file was empty.', 400);

  try {
    const result = await uploadAndProcessRetirementStatement(
      user.id,
      {
        jurisdiction: meta.jurisdiction,
        currencyCode: meta.currency_code,
        fundName: meta.fund_name,
        maskedAccountIdentifier: meta.masked_account_identifier,
        statementDate: meta.statement_date,
        statementPeriodStart: meta.statement_period_start,
        statementPeriodEnd: meta.statement_period_end,
        // The fund name doubles as SMSF-detection input. No document body text
        // is retained anywhere — `statementTextSample` is a transient
        // parameter, never a column.
        statementTextSample: meta.fund_name,
      },
      bytes,
    );

    return ok({
      document_id: result.document.id,
      statement_id: result.statementId,
      pipeline_status: result.pipelineStatus,
      failure_kind: result.failureKind ?? null,
      // NEVER a bare number that could render as "$0" — the message names the
      // real state (spec section 94).
      failure_message: result.failureKind
        ? RETIREMENT_STATEMENT_FAILURE_MESSAGES[result.failureKind]
          ?? RETIREMENT_STATEMENT_FAILURE_MESSAGES.unknown_error
        : null,
      activities_extracted: result.activitiesExtracted,
      activities_deduplicated: result.activitiesDeduplicated,
      positions_extracted: result.positionsExtracted,
    });
  } catch (e) {
    if (e instanceof RetirementStatementProcessingError) {
      return bad(e.message, e.code === 'not_found' ? 404 : 400);
    }
    throw e;
  }
}

import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import { isFdhDocumentUploadEnabled } from '@/lib/financial-data-hub/constants/featureFlags';
import {
  uploadAndProcessRetirementStatement,
  RetirementStatementProcessingError,
  RETIREMENT_STATEMENT_FAILURE_MESSAGES,
} from '@/lib/financial-data-hub/services/retirementStatementProcessingService';
import {
  retirementStatementUploadMetadataSchema as metadataSchema,
  currencyMatchesJurisdiction,
} from '@/lib/financial-data-hub/validation/retirementStatement';

// POST /api/financial-data-hub/retirement-statement/upload
//
// Upload AND process a retirement statement CSV (spec sections 91, 119).
// Reuses FDH-3's document lifecycle unchanged — no new upload framework.
//
// CANONICAL RETIREMENT IS UNCHANGED BY THIS CALL (spec section 56). This route
// creates statement EVIDENCE only.
//
// `metadataSchema`/`currencyMatchesJurisdiction` moved to
// `lib/financial-data-hub/validation/retirementStatement.ts` 2026-09-21
// (real-malware-gate async fix) — the new `[documentId]/process/route.ts`
// resumption route needs the identical validation for a re-submitted
// metadata body.

export async function POST(req: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  // LR-4 (2026-09-08): every other FDH-3-descended upload route (Income/
  // Payslip, Liability, AU Investment) calls this same gate; Retirement
  // statement upload never did — a real, unintentional production-safety
  // gap found during LR-4's capability audit, not a design choice (no
  // comment anywhere in this file claimed otherwise). Fixed by adding the
  // identical check, in the identical place, that every sibling route uses.
  if (!isFdhDocumentUploadEnabled()) {
    return bad('Statement uploads are not currently enabled in this environment.', 403);
  }

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
      // AIE retirement-statement AI-fallback (2026-09-23). Present (non-null)
      // ONLY when `pipeline_status === 'ai_fallback_available'`: the native
      // CSV parse failed on a readable-but-unrecognised layout and an AI read
      // a DRAFT off it. Nothing has been written at this point; the panel
      // shows this for explicit review and then posts it to
      // `.../ai-fallback/confirm`. Returned from BOTH this route and its
      // sibling because a `pending_scan` upload finishes through the other
      // one, and a draft must not be reachable from only one of the two.
      ai_fallback_draft: result.aiFallbackDraft ?? null,
    });
  } catch (e) {
    if (e instanceof RetirementStatementProcessingError) {
      return bad(e.message, e.code === 'not_found' ? 404 : 400);
    }
    throw e;
  }
}

// Investment Intelligence — AI-fallback DOCUMENT extraction (2026-09-17 PO
// addendum to the Holdings drilldown task).
//
// Generalizes the AI-fallback trigger the Holdings task already built
// (aiFallbackReconciliation.ts, per-scheme reconciliation-failure) to two
// EARLIER failure points in documentProcessing.ts's processSourceDocument():
//
//   1. 'format_unrecognized' — the deterministic parser registry could not
//      confidently identify the document's source/format at all
//      (`!detection.parser || !parsed`). No transaction line has even been
//      attempted yet.
//   2. 'parse_failed' — a parser WAS identified, but its own
//      validateParsedOutput() rejected the result (`!validation.ok`).
//
// Both previously went straight to the user-facing "Statement source/format
// could not be confidently identified." / validation-error message. Per the
// PO's own instruction: try the SAME AI-fallback mechanism first; only show
// that message if AI-fallback is ALSO tried and ALSO fails.
//
// HARD REQUIREMENT (not a suggestion): a successful AI extraction is NEVER
// auto-written into the user's holdings. It is staged as a
// `ii_ai_extraction_reviews` row with status='pending_review' and shown to
// the user for **explicit accept** (aiExtractionReviewApply.ts), showing
// both cost value and market value per holding. Only accept() writes
// canonical rows.
//
// Shares aiFallbackReconciliation.ts's architecture and its own documented
// finding: the real AIE pipeline (lib/aie/*) does not exist on this branch
// (only on unmerged aie-1-* branches — see that file's header for the full
// finding). The same conservative choice applies here: a real integration
// seam (`resolveAieDocumentProvider`) that returns null today, an honest
// 'unavailable' outcome, and zero real provider calls in this task's own
// verification (unit tests inject a fake provider).

import { createAdminClient } from '@/lib/supabase/admin';
import { isAiFallbackEnabled } from './aiFallbackFeatureFlag';

export type AiFallbackTriggerReason = 'format_unrecognized' | 'parse_failed';

/** Mirrors the exact two documentProcessing.ts conditions this module
 * exists to intercept — never a third, independently-invented judgement of
 * whether a document "looks parseable". */
export function documentAiFallbackTriggerReason(input: {
  parserRecognizedFormat: boolean;
  validationOk: boolean | null; // null when parserRecognizedFormat is false (validation was never reached)
}): AiFallbackTriggerReason | null {
  if (!input.parserRecognizedFormat) return 'format_unrecognized';
  if (input.validationOk === false) return 'parse_failed';
  return null;
}

export interface AieExtractedTransaction {
  dateIso: string;
  description: string;
  amount: number; // signed per source convention, same as ParsedTransactionRecord.amountScaled's convention
  units: number | null;
  navPrice: number | null;
  canonicalType: string; // IiTransactionType — validated against the enum at write time (aiExtractionReviewApply.ts), never trusted blindly
}

export interface AieExtractedHolding {
  schemeName: string;
  isin: string | null;
  amcName: string | null;
  folioNumber: string | null;
  costValue: number; // "Cost of Investment" as printed — shown to the user, never silently combined with market value
  marketValue: number;
  units: number;
  asOfDateIso: string;
  /** Best-effort per-line transaction detail. Genuinely optional — an AI
   * extraction that can only read a "Summary of Holdings" table (cost/
   * market value/units) without a clean transaction ledger is still usable
   * (see aiExtractionReviewApply.ts's opening-balance-marker fallback for a
   * brand-new position), just less precise than one that includes this. */
  transactions: AieExtractedTransaction[];
}

export interface AieDocumentExtractionRequest {
  maskedDocumentText: string; // already PII-masked by the caller — this module never sees raw statement text
}

export interface AieDocumentExtractionResult {
  holdings: AieExtractedHolding[];
  providerConfidence: number;
  /** Optional — only set when the extraction can honestly state the
   * statement's own coverage window (e.g. from a printed "Statement Date"
   * plus a known prior statement date). Used by aiExtractionReviewApply.ts
   * to (optionally) run the same missing-transaction detection the
   * deterministic path runs; left null rather than guessed when the
   * extraction cannot support it (see missingTransactionDetection.ts's own
   * "no period, no comparison" principle). */
  statementPeriodStartIso: string | null;
  statementPeriodEndIso: string | null;
}

export type AieDocumentProvider = (req: AieDocumentExtractionRequest) => Promise<AieDocumentExtractionResult>;

/** Same reasoning as aiFallbackReconciliation.ts's resolveAieProvider(): a
 * genuine static/dynamic import of a module that does not exist on this
 * branch would risk the production build; returns null unconditionally
 * today, and is the one obvious place to wire in the real
 * lib/aie/provider/gateway.ts document-extraction provider once an
 * aie-1-* branch merges. */
async function resolveAieDocumentProvider(): Promise<AieDocumentProvider | null> {
  return null;
}

export type AiFallbackDocumentOutcome =
  | { outcome: 'disabled' }
  | { outcome: 'unavailable'; reason: string }
  | { outcome: 'already_pending'; reviewId: string; holdings: AieExtractedHolding[] }
  | { outcome: 'already_decided'; reviewId: string; status: 'accepted' | 'rejected' }
  | { outcome: 'pending_review'; reviewId: string; holdings: AieExtractedHolding[] }
  | { outcome: 'no_usable_data'; reason: string }
  | { outcome: 'still_failed'; reason: string };

export interface AiFallbackDocumentContext {
  userId: string;
  sourceDocumentId: string;
  parseRunId: string | null;
  triggerReason: AiFallbackTriggerReason;
  request: AieDocumentExtractionRequest;
  /** Test/DI seam — defaults to the real resolveAieDocumentProvider(). Unit
   * tests and this task's own manual verification against the real SBI
   * fixture inject a fake provider here rather than ever calling a real
   * one (see the final report for why, even though the PO explicitly
   * authorized a real call against that specific low-cost fixture: doing
   * so would require either bypassing the not-yet-built real AIE masking
   * step, or building a second, parallel AI-calling mechanism — both
   * explicitly prohibited by this task's own standing constraints). */
  providerOverride?: AieDocumentProvider | null;
}

/** Minimum bar for "usable data" per the PO's own wording: scheme identity,
 * cost value, market value, and units, for at least one holding. */
function hasUsableData(result: AieDocumentExtractionResult): boolean {
  return result.holdings.some(
    (h) => h.schemeName.trim().length > 0 && Number.isFinite(h.costValue) && Number.isFinite(h.marketValue) && Number.isFinite(h.units) && h.units > 0
  );
}

/**
 * The single entry point documentProcessing.ts calls at its two early
 * failure points. Idempotent per source document: a reprocess click never
 * re-sends an already-pending-or-decided document to the provider again.
 */
export async function getAiFallbackDocumentExtraction(ctx: AiFallbackDocumentContext): Promise<AiFallbackDocumentOutcome> {
  if (!isAiFallbackEnabled()) return { outcome: 'disabled' };

  const admin = createAdminClient();

  const { data: existing } = await admin
    .from('ii_ai_extraction_reviews')
    .select('id, status, extracted_holdings')
    .eq('user_id', ctx.userId)
    .eq('source_document_id', ctx.sourceDocumentId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existing) {
    if (existing.status === 'pending_review') {
      return { outcome: 'already_pending', reviewId: existing.id as string, holdings: existing.extracted_holdings as AieExtractedHolding[] };
    }
    if (existing.status === 'accepted' || existing.status === 'rejected') {
      return { outcome: 'already_decided', reviewId: existing.id as string, status: existing.status };
    }
  }

  const provider = ctx.providerOverride !== undefined ? ctx.providerOverride : await resolveAieDocumentProvider();
  if (!provider) {
    return {
      outcome: 'unavailable',
      reason:
        'The AI-fallback extraction pipeline (lib/aie) is not present in this deployment yet — it lives on unmerged aie-1-* branches. No AI provider was called.',
    };
  }

  let result: AieDocumentExtractionResult;
  try {
    result = await provider(ctx.request);
  } catch (e) {
    return { outcome: 'still_failed', reason: e instanceof Error ? e.message : 'AI-fallback document extraction failed.' };
  }

  if (!hasUsableData(result)) {
    return { outcome: 'no_usable_data', reason: 'The AI-fallback extraction did not produce a scheme with a cost value, market value, and a positive unit balance for any holding.' };
  }

  const { data: created, error } = await admin
    .from('ii_ai_extraction_reviews')
    .insert({
      user_id: ctx.userId,
      source_document_id: ctx.sourceDocumentId,
      parse_run_id: ctx.parseRunId,
      trigger_reason: ctx.triggerReason,
      status: 'pending_review',
      extracted_holdings: result.holdings,
      provider_confidence: result.providerConfidence,
      statement_period_start: result.statementPeriodStartIso,
      statement_period_end: result.statementPeriodEndIso,
    })
    .select('id')
    .single();
  if (error || !created) {
    return { outcome: 'still_failed', reason: error?.message ?? 'Could not stage the AI-extracted holdings for review.' };
  }

  return { outcome: 'pending_review', reviewId: created.id as string, holdings: result.holdings };
}

/** Builds the masked document text an AIE provider would receive. Masking
 * itself is intentionally NOT implemented here — see
 * aiFallbackReconciliation.ts's describeUnmaskedLedgerForAudit for the same
 * reasoning: the real AIE masking module is a separate, already-built,
 * separately-certified component on the aie-1-* branches, not present on
 * `main`. This function only shapes what WOULD be sent. */
export function describeUnmaskedDocumentTextForAudit(rawText: string): string {
  return `[${rawText.length} chars of extracted document text — PII masking is applied by the real AIE pipeline once wired in; this deployment never sends unmasked data]`;
}

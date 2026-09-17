// Investment Intelligence — Performance tab Holdings drilldown (2026-09-17).
//
// AI-fallback reconciliation trigger for a scheme that fails the EXISTING
// deterministic unit-reconciliation check (ii_portfolio_truth_status,
// computed by reconciliation.ts + documentProcessing.ts's
// evaluatePositionAndCertify — see that file for the full pipeline). This
// module deliberately does NOT re-implement or hand-debug the camsParser.ts
// defects that cause a handful of real schemes (Axis ~156.618 units, Kotak
// ~111.505 units, per II_PC4_STATUS_2026_09_07.md) to fail reconciliation —
// that is explicitly out of scope for this task.
//
// *** IMPORTANT — architectural finding, not silently worked around ***
// The task brief describes an existing, already-built AIE AI-fallback
// extraction pipeline (lib/aie/provider/openaiAieProvider.ts,
// lib/aie/provider/gateway.ts, lib/aie/adapters/investment-intelligence/*)
// living on `main` and ready to be reused. A real AIE pipeline DOES exist in
// this repository's history, but ONLY on a family of unmerged sibling
// branches (feature/aie-1-1-document-gateway,
// feature/aie-1-2-investment-adapter, etc.) — `lib/aie/` is not present on
// `main`/this branch at all (confirmed: `git ls-tree` against this branch
// returns nothing under lib/aie; the files only exist on
// origin/feature/aie-1-*). This task's own instructions prohibit touching
// any other branch/worktree, so those files cannot be merged, cherry-picked
// or vendor-copied in here without exceeding this task's authority and
// silently entangling two independent, separately-gated initiatives.
//
// The conservative choice made here (flagged in the final report, not
// guessed silently): implement the REAL trigger condition and a REAL,
// persisted caching mechanism using tables that already exist on `main`
// (ii_reconciliation_cases), but make the actual "call an AI provider" step
// a single, clearly-named integration seam — `resolveAieProvider()` below —
// that:
//   - is OFF by default (feature flag, same convention as the Financial
//     Data Hub module's own upload-enablement flag and the real AIE
//     flags on the aie-1-* branches: an env var must equal the literal
//     string 'true'),
//   - even when ON, honestly reports 'unavailable' rather than fabricating a
//     result, for as long as `lib/aie` is not actually present in this
//     deployment (a dynamic import that fails to resolve is caught, not
//     thrown),
//   - once an AIE branch merges to `main` and exposes a provider matching
//     `AieMaskedReconciliationProvider`, wiring it in is a one-line change to
//     `resolveAieProvider()` — no caller of this module needs to change.
//
// This never builds a second, parallel AI-calling mechanism (no fetch/HTTP
// call to OpenAI appears anywhere in this file), never bypasses PII masking
// (the seam's contract requires the caller supply already-masked evidence —
// enforced by the input type only carrying a `maskedLedgerText` field, never
// raw transaction text), and never calls a real provider in this task's own
// verification (see the unit tests, which inject a fake provider).

import { createAdminClient } from '@/lib/supabase/admin';
import { openReconciliationCase } from './reconciliationCases';

/** Same convention as the Financial Data Hub module's own upload-enablement
 * flag and every AIE flag on the aie-1-* branches: must equal the literal string
 * 'true'; anything else (unset, misconfigured) leaves it OFF. Default OFF in
 * every environment, including DEV — a Product Owner/operator opts in
 * explicitly per the task brief ("default OFF in production, testable in
 * DEV"). */
export function isAiFallbackReconciliationEnabled(): boolean {
  return process.env.II_AI_FALLBACK_RECONCILIATION_ENABLED === 'true';
}

export interface ReconciliationFailureInput {
  status: string | null; // ii_portfolio_truth_status.status
  unitVarianceWithinTolerance: boolean | null;
}

/** The one place that decides "does this scheme need the AI fallback at
 * all". Mirrors the EXISTING PC4 reconciliation verdict exactly — never a
 * second, independent judgement of whether the numbers are trustworthy. */
export function schemeReconciliationFailed(input: ReconciliationFailureInput): boolean {
  if (input.status === 'failed') return true;
  if (input.unitVarianceWithinTolerance === false) return true;
  return false;
}

export interface AieMaskedReconciliationRequest {
  maskedLedgerText: string; // already PII-masked by the caller — this module never sees raw statement text
  statementClosingUnits: string;
}

export interface AieMaskedReconciliationResult {
  correctedClosingUnits: string;
  correctedLedgerSummary: string;
  providerConfidence: number;
}

export type AieProvider = (req: AieMaskedReconciliationRequest) => Promise<AieMaskedReconciliationResult>;

/**
 * Resolves the real AIE masked-extraction provider if this deployment has
 * one. Deliberately NOT a dynamic `import('@/lib/aie/...')`: `lib/aie` does
 * not exist on this branch (see this file's header), and Next.js's webpack
 * build statically analyses even dynamic `import()` calls for code-splitting
 * — pointing one at a genuinely nonexistent module risks turning
 * "unavailable" into a broken production build, which this task's own
 * verification requirement (`npm run build` must genuinely succeed) cannot
 * risk for an integration seam that is off by default anyway.
 *
 * Returns `null` unconditionally today. Once an aie-1-* branch merges to
 * `main` and lib/aie/provider/gateway.ts exists for real, this function's
 * body is the one, obvious place to add a real static
 * `import { maskedReconciliationProvider } from '@/lib/aie/provider/gateway'`
 * and return it — a one-line change, not a redesign of this module or its
 * callers. Left as an explicit open item in this task's final report rather
 * than guessed at silently.
 */
async function resolveAieProvider(): Promise<AieProvider | null> {
  return null;
}

export type AiFallbackOutcome =
  | { outcome: 'disabled' }
  | { outcome: 'unavailable'; reason: string }
  | { outcome: 'cached'; result: AieMaskedReconciliationResult }
  | { outcome: 'corrected'; result: AieMaskedReconciliationResult }
  | { outcome: 'still_failed'; reason: string };

export interface AiFallbackContext {
  userId: string;
  accountId: string;
  instrumentId: string;
  sourceDocumentId: string | null;
  request: AieMaskedReconciliationRequest;
  /** Test/DI seam — defaults to the real resolveAieProvider(). Unit tests
   * inject a fake provider here rather than ever calling a real one. */
  providerOverride?: AieProvider | null;
}

const AI_FALLBACK_DISCREPANCY_TYPE = 'ai_fallback_reconciliation_attempted';

/**
 * Looks for a previously-cached, resolved AI-fallback correction for this
 * exact (account, instrument, sourceDocument) before ever considering a
 * fresh provider call — this IS the "cache the corrected result rather than
 * recomputing on every page view" requirement. The cache is a resolved
 * ii_reconciliation_cases row (no new table needed): reuses the exact
 * established "flag something for human attention, never silently mutate
 * data" pattern this module family already follows, rather than inventing a
 * second persistence mechanism.
 */
async function findCachedResult(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
  accountId: string,
  instrumentId: string,
  sourceDocumentId: string | null
): Promise<AieMaskedReconciliationResult | null> {
  const { data } = await admin
    .from('ii_reconciliation_cases')
    .select('evidence, discrepancy_details, source_document_id')
    .eq('user_id', userId)
    .eq('subject_type', 'account')
    .eq('subject_id', accountId)
    .eq('discrepancy_type', AI_FALLBACK_DISCREPANCY_TYPE)
    .eq('status', 'resolved')
    .order('opened_at', { ascending: false });

  for (const row of data ?? []) {
    const details = row.discrepancy_details as Record<string, unknown> | null;
    if (details?.instrumentId !== instrumentId) continue;
    if (sourceDocumentId && row.source_document_id !== sourceDocumentId) continue;
    const evidence = row.evidence as { correctedResult?: AieMaskedReconciliationResult } | null;
    if (evidence?.correctedResult) return evidence.correctedResult;
  }
  return null;
}

/**
 * The single entry point callers (holdingsRepository.ts) use. Never throws
 * for an unavailable/disabled provider — that is a normal, expected,
 * honestly-reported outcome, not an error.
 */
export async function getAiFallbackReconciliation(ctx: AiFallbackContext): Promise<AiFallbackOutcome> {
  if (!isAiFallbackReconciliationEnabled()) return { outcome: 'disabled' };

  const admin = createAdminClient();
  const cached = await findCachedResult(admin, ctx.userId, ctx.accountId, ctx.instrumentId, ctx.sourceDocumentId);
  if (cached) return { outcome: 'cached', result: cached };

  const provider = ctx.providerOverride !== undefined ? ctx.providerOverride : await resolveAieProvider();
  if (!provider) {
    return {
      outcome: 'unavailable',
      reason:
        'The AI-fallback extraction pipeline (lib/aie) is not present in this deployment yet — it lives on unmerged aie-1-* branches. No AI provider was called; the deterministic result is shown as unresolved instead of a possibly-wrong number.',
    };
  }

  let result: AieMaskedReconciliationResult;
  try {
    result = await provider(ctx.request);
  } catch (e) {
    return { outcome: 'still_failed', reason: e instanceof Error ? e.message : 'AI-fallback provider call failed.' };
  }

  // Persist as a resolved case — this becomes next call's cache hit, so a
  // given scheme is sent to the (real, once wired) provider at most once
  // per source document, never once per page view.
  const caseId = await openReconciliationCase(ctx.userId, {
    subjectType: 'account',
    subjectId: ctx.accountId,
    discrepancyType: AI_FALLBACK_DISCREPANCY_TYPE,
    severity: 'info',
    sourceDocumentId: ctx.sourceDocumentId,
    details: { instrumentId: ctx.instrumentId, providerConfidence: result.providerConfidence },
    evidence: { correctedResult: result },
  });
  if (caseId) {
    await admin
      .from('ii_reconciliation_cases')
      .update({ status: 'resolved', resolved_at: new Date().toISOString(), resolved_by_actor_type: 'system', resolution_method: 'ai_fallback_reconciliation' })
      .eq('id', caseId);
  }

  return { outcome: 'corrected', result };
}

/** Builds the masked ledger text an AIE provider would receive. Masking
 * itself is intentionally NOT implemented here — the real AIE masking
 * (lib/aie/masking/piiMasking.ts on the aie-1-* branches, one-way HMAC per
 * the standing Product Owner decision) is a separate, already-built,
 * separately-certified module. This function only shapes what WOULD be
 * sent, so a future wiring-in of the real provider has a single, obvious
 * place to route through that real masking step instead of a placeholder. */
export function describeUnmaskedLedgerForAudit(ledgerRowCount: number, statementClosingUnits: string): string {
  return `[${ledgerRowCount} transaction rows — PII masking is applied by the real AIE pipeline once wired in; this deployment never sends unmasked data] statement_closing_units=${statementClosingUnits}`;
}

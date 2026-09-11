/**
 * AIE-1.3 — FDH bank-statement adapter: the `ReconciliationRule` handoff
 * (AIE13-RECON-01..12, execution-sequence step 7).
 *
 * P4 / AIE13-RECON-10 ("prevent confidence score from overriding
 * reconciliation"), enforced structurally here exactly as AIE-1.1's own
 * `reconciliation/types.ts` enforces it: this function's signature has no
 * `confidence` parameter anywhere, and the ONE AI-eligible candidate this
 * adapter ever produces (`INSTITUTION_HINT_FIELD_NAME`, see parser.ts) is
 * read below ONLY to enrich `displayCandidate`/`evidenceRef` on an
 * already-blocking unresolved item — it is never capable of turning a
 * `fail`/`indeterminate` outcome into a `pass` (AIE13-AI-10: "do not use AI
 * repair to make balance reconciliation pass"). There is no code path in
 * this file that reads the AI candidate's value before the outcome has
 * already been decided from deterministic evidence alone.
 *
 * `worstOutcome`/`blockingItemsForReconciliation` (AIE-1.1's own
 * `reconciliation/types.ts`) are reused unchanged by the caller
 * (`runExtractionPipeline`) — this file only produces the
 * `AieReconciliationRunResult[]` array; it does not itself create
 * unresolved items (that stays AIE-1.1 core's job, per P7: no second
 * exception system).
 */

import type { ReconciliationRule } from '../../reconciliation/types';
import type { AieFieldCandidate, AieReconciliationRunResult } from '../../types';
import {
  ACCOUNT_AMBIGUOUS_FIELD_NAME,
  DATE_RANGE_OVERLAP_FIELD_NAME,
  INSTITUTION_HINT_FIELD_NAME,
  RECONCILIATION_METHOD_FIELD_NAME,
  RECONCILIATION_STATUS_FIELD_NAME,
  RECONCILIATION_VARIANCE_FIELD_NAME,
  TRANSACTION_ROW_FIELD_PREFIX,
} from './types';

export const RULE_BALANCE_RECONCILIATION = 'fdh_bank_statement_balance_reconciliation';
export const RULE_LAYOUT_CERTIFICATION = 'fdh_bank_statement_layout_certification';
export const RULE_DATE_RANGE_OVERLAP = 'fdh_bank_statement_date_range_overlap';
export const RULE_VERSION = '1';

function findCandidate(candidates: readonly AieFieldCandidate[], fieldName: string): AieFieldCandidate | undefined {
  return candidates.find((c) => c.fieldName === fieldName);
}

/**
 * AIE13-RECON-01/02/07: maps FDH-5's own already-certified
 * `reconcileBalances()` status vocabulary (`fdh_reconciliation_results`'s
 * closed enum: 'not_available' | 'pending' | 'reconciled' | 'failed' |
 * 'user_accepted_exception') onto AIE-1.1's PASS/PASS_WITH_TOLERANCE/FAIL/
 * INDETERMINATE/NOT_APPLICABLE vocabulary — a translation, not a second
 * reconciliation engine (AIE13's own binding scope: "reuse the secure
 * document lifecycle... already proven").
 */
export const fdhBankStatementReconciliationRule: ReconciliationRule = ({ candidates }) => {
  const results: AieReconciliationRunResult[] = [];

  const statusCandidate = findCandidate(candidates, RECONCILIATION_STATUS_FIELD_NAME);
  const hasAnyTransactionRow = candidates.some((c) => c.fieldName.startsWith(TRANSACTION_ROW_FIELD_PREFIX));

  if (!statusCandidate) {
    // The parser never reached balance reconciliation at all — either the
    // layout was UNSUPPORTED (no certified adapter matched; AIE13-BASE-04:
    // "unsupported-bank claims remain truthful", so this is never silently
    // treated as clean) or AMBIGUOUS (two certified candidates too close to
    // call — `ACCOUNT_AMBIGUOUS_FIELD_NAME`/AI hint present) or every row
    // was rejected on an otherwise-detected layout. All three are
    // INDETERMINATE, never FAIL's stronger "we know this is wrong" claim and
    // never PASS — evidence is genuinely insufficient to conclude either
    // way, which is exactly what AIE's INDETERMINATE outcome means.
    const ambiguous = findCandidate(candidates, ACCOUNT_AMBIGUOUS_FIELD_NAME);
    results.push({
      ruleId: RULE_LAYOUT_CERTIFICATION,
      ruleVersion: RULE_VERSION,
      outcome: 'indeterminate',
      materiality: ambiguous ? 'ambiguous_layout' : 'unsupported_layout_or_all_rows_rejected',
    });
    return results;
  }

  const status = statusCandidate.valueRaw;
  const methodCandidate = findCandidate(candidates, RECONCILIATION_METHOD_FIELD_NAME);
  const varianceCandidate = findCandidate(candidates, RECONCILIATION_VARIANCE_FIELD_NAME);
  const variance = varianceCandidate && !varianceCandidate.isNull ? Number(varianceCandidate.valueRaw) : null;

  const outcome: AieReconciliationRunResult['outcome'] =
    status === 'reconciled'
      ? 'pass'
      : status === 'user_accepted_exception'
        ? 'pass_with_tolerance'
        : status === 'failed'
          ? 'fail'
          : status === 'pending'
            ? 'indeterminate' // partial balance coverage — genuinely cannot conclude (AIE13-RECON-04)
            : // 'not_available': rows exist but none carried balance evidence at
              // all is INDETERMINATE (never silently PASS); truly zero rows on an
              // otherwise-detected, empty statement is NOT_APPLICABLE (nothing to
              // reconcile is a real, honest outcome, not a failure).
              hasAnyTransactionRow
              ? 'indeterminate'
              : 'not_applicable';

  results.push({
    ruleId: RULE_BALANCE_RECONCILIATION,
    ruleVersion: RULE_VERSION,
    outcome,
    delta: variance,
    tolerance: 0,
    materiality: methodCandidate?.valueRaw ?? null,
  });

  // AIE13-DUP / prohibition "no duplicate transaction import from PDF/PDF or
  // PDF/CSV overlap": a statement-period overlap with an already-imported
  // statement for the same account is reported as its OWN rule so it can
  // never be silently absorbed into (or silently clear) the balance
  // reconciliation outcome above — `warning` severity only, because the
  // real duplicate-prevention mechanism is the per-row economic-fingerprint
  // dedup index (shared, unchanged, across CSV and PDF sources — see
  // parser.ts's reuse of `bank-csv/dedup.ts`), which already runs
  // independently of this signal; this rule exists purely so an overlapping
  // PERIOD is never invisible to a reviewer even when every individual row
  // dedups cleanly.
  const overlapCandidate = findCandidate(candidates, DATE_RANGE_OVERLAP_FIELD_NAME);
  if (overlapCandidate?.valueRaw === 'true') {
    results.push({
      ruleId: RULE_DATE_RANGE_OVERLAP,
      ruleVersion: RULE_VERSION,
      // `indeterminate` (not `fail`): overlap is a legitimate, common case
      // (e.g. a statement's last day equals the next statement's first day)
      // that per-row dedup already resolves correctly in most cases — but it
      // is never silently absorbed into `pass` either; a human/PC5 reviewer
      // sees it via the resulting unresolved item, per AIE13-RECON-08.
      outcome: 'indeterminate',
      materiality: 'statement_period_overlaps_prior_import',
    });
  }

  return results;
};

/** Exposed for the intake route: was an AI-suggested institution candidate
 * present, and does it name an adapter this repository actually certifies?
 * Read-ONLY for display/audit purposes (AIE13-AI-08's source-reference
 * requirement) — see this file's own header for why it can never change the
 * reconciliation outcome above. */
export function extractInstitutionHintForDisplay(candidates: readonly AieFieldCandidate[]): string | null {
  const hint = candidates.find((c) => c.fieldName === INSTITUTION_HINT_FIELD_NAME && c.sourceMethod === 'ai');
  return hint && !hint.isNull ? hint.valueRaw : null;
}

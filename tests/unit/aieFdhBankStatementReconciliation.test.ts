/**
 * AIE-1.3 — FDH bank-statement adapter: reconciliation-rule tests
 * (AIE13-RECON-01..12, non-negotiable prohibition "no acceptance/import
 * when balance reconciliation materially fails or is indeterminate", and
 * AIE13-AI-10 "do not use AI repair to make balance reconciliation pass").
 */
import { describe, it, expect } from 'vitest';
import { fdhBankStatementReconciliationRule, extractInstitutionHintForDisplay } from '@/lib/aie/adapters/fdhBankStatement/reconciliation';
import { worstOutcome, blockingItemsForReconciliation } from '@/lib/aie/reconciliation/types';
import {
  ACCOUNT_AMBIGUOUS_FIELD_NAME,
  DATE_RANGE_OVERLAP_FIELD_NAME,
  INSTITUTION_HINT_FIELD_NAME,
  RECONCILIATION_METHOD_FIELD_NAME,
  RECONCILIATION_STATUS_FIELD_NAME,
  RECONCILIATION_VARIANCE_FIELD_NAME,
  TRANSACTION_ROW_FIELD_PREFIX,
  UNREADABLE_ROW_COUNT_FIELD_NAME,
  UNREADABLE_ROW_EVIDENCE_FIELD_NAME,
} from '@/lib/aie/adapters/fdhBankStatement/types';
import type { AieFieldCandidate, AieReconciliationRunResult } from '@/lib/aie/types';

/**
 * M12A-F1 added a second always-emitted rule (row-extraction completeness), so
 * a candidate set that omits its candidate now fails CLOSED — which is the
 * point of the change, and is proved directly further down. These existing
 * cases are about the BALANCE rule's vocabulary translation, so they supply the
 * completeness candidate at its clean value (zero unreadable rows) rather than
 * leaving it absent; that keeps each test testing the one thing it names.
 */
function statusCandidates(status: string, variance: string | null = '0', unreadableRowCount = '0'): AieFieldCandidate[] {
  return [
    { fieldName: RECONCILIATION_STATUS_FIELD_NAME, valueRaw: status, isNull: false, sourceMethod: 'deterministic' },
    { fieldName: RECONCILIATION_METHOD_FIELD_NAME, valueRaw: 'balance_rollforward', isNull: false, sourceMethod: 'deterministic' },
    { fieldName: RECONCILIATION_VARIANCE_FIELD_NAME, valueRaw: variance, isNull: variance === null, sourceMethod: 'deterministic' },
    { fieldName: UNREADABLE_ROW_COUNT_FIELD_NAME, valueRaw: unreadableRowCount, isNull: false, sourceMethod: 'deterministic' },
  ];
}

/** The balance rule is always first; the completeness rule is always present. */
const balanceRule = (results: readonly AieReconciliationRunResult[]) => results.find((r) => r.ruleId.includes('balance_reconciliation'))!;
const completenessRule = (results: readonly AieReconciliationRunResult[]) => results.find((r) => r.ruleId.includes('row_extraction_completeness'))!;

describe('AIE-1.3 FDH bank-statement reconciliation rule — FDH-5 status vocabulary translated to AIE outcomes', () => {
  it('reconciled -> pass', () => {
    const results = fdhBankStatementReconciliationRule({ runId: 'r1', candidates: statusCandidates('reconciled') });
    expect(results[0].outcome).toBe('pass');
    expect(worstOutcome(results)).toBe('pass');
    expect(blockingItemsForReconciliation(results)).toEqual([]);
  });

  it('failed -> fail, and produces a blocking unresolved item', () => {
    const results = fdhBankStatementReconciliationRule({ runId: 'r1', candidates: statusCandidates('failed', '12.34') });
    expect(results[0].outcome).toBe('fail');
    expect(results[0].delta).toBe(12.34);
    const blocking = blockingItemsForReconciliation(results);
    expect(blocking.length).toBe(1);
    expect(blocking[0].severity).toBe('blocking');
    expect(blocking[0].reasonCode).toContain('balance_reconciliation');
  });

  it('pending (partial balance coverage) -> indeterminate, still blocking', () => {
    const results = fdhBankStatementReconciliationRule({ runId: 'r1', candidates: statusCandidates('pending', null) });
    expect(results[0].outcome).toBe('indeterminate');
    expect(blockingItemsForReconciliation(results).length).toBe(1);
  });

  it('not_available WITH transaction rows present -> indeterminate (never silently pass)', () => {
    const candidates: AieFieldCandidate[] = [
      ...statusCandidates('not_available', null),
      { fieldName: `${TRANSACTION_ROW_FIELD_PREFIX}1`, valueRaw: '{}', isNull: false, sourceMethod: 'deterministic' },
    ];
    const results = fdhBankStatementReconciliationRule({ runId: 'r1', candidates });
    expect(results[0].outcome).toBe('indeterminate');
  });

  it('not_available with ZERO transaction rows -> not_applicable (a genuinely empty statement is honest, not a failure)', () => {
    const results = fdhBankStatementReconciliationRule({ runId: 'r1', candidates: statusCandidates('not_available', null) });
    expect(results[0].outcome).toBe('not_applicable');
  });

  it('user_accepted_exception -> pass_with_tolerance', () => {
    const results = fdhBankStatementReconciliationRule({ runId: 'r1', candidates: statusCandidates('user_accepted_exception', '0.01') });
    expect(results[0].outcome).toBe('pass_with_tolerance');
  });

  it('missing reconciliation-status candidate entirely (unsupported/all-rows-rejected layout) -> indeterminate, blocking', () => {
    const results = fdhBankStatementReconciliationRule({ runId: 'r1', candidates: [] });
    expect(results[0].outcome).toBe('indeterminate');
    expect(results[0].materiality).toBe('unsupported_layout_or_all_rows_rejected');
    expect(blockingItemsForReconciliation(results).length).toBe(1);
  });

  it('ambiguous layout (account-ambiguous candidate present, no status candidate) -> indeterminate, materiality reflects ambiguity', () => {
    const candidates: AieFieldCandidate[] = [
      { fieldName: ACCOUNT_AMBIGUOUS_FIELD_NAME, valueRaw: 'false', isNull: false, sourceMethod: 'deterministic' },
    ];
    const results = fdhBankStatementReconciliationRule({ runId: 'r1', candidates });
    expect(results[0].outcome).toBe('indeterminate');
    expect(results[0].materiality).toBe('ambiguous_layout');
  });

  it('date-range overlap adds its OWN indeterminate rule without changing the balance rule', () => {
    const candidates: AieFieldCandidate[] = [
      ...statusCandidates('reconciled'),
      { fieldName: DATE_RANGE_OVERLAP_FIELD_NAME, valueRaw: 'true', isNull: false, sourceMethod: 'deterministic' },
    ];
    const results = fdhBankStatementReconciliationRule({ runId: 'r1', candidates });
    expect(results).toHaveLength(3); // balance, row-extraction completeness, overlap
    expect(balanceRule(results).outcome).toBe('pass');
    expect(completenessRule(results).outcome).toBe('pass');
    expect(results.find((r) => r.ruleId.includes('overlap'))?.outcome).toBe('indeterminate');
    // Overall worst-outcome across the rules is still indeterminate — never
    // silently swallowed by the passing balance rule.
    expect(worstOutcome(results)).toBe('indeterminate');
  });

  // -------------------------------------------------------------------------
  // M12A-F1 — row-extraction completeness. "Did the arithmetic close?" and
  // "did we read every transaction the statement printed?" are two questions,
  // and the corpus proved what it costs to answer only the first (FDH-A11).
  // -------------------------------------------------------------------------

  it('M12A-F1: zero unreadable rows -> an explicit PASS, asserted rather than left silent', () => {
    const results = fdhBankStatementReconciliationRule({ runId: 'r1', candidates: statusCandidates('reconciled', '0', '0') });
    const rule = completenessRule(results);
    expect(rule.outcome).toBe('pass');
    expect(rule.delta).toBe(0);
    expect(rule.materiality).toBe('all_printed_rows_read');
    expect(worstOutcome(results)).toBe('pass');
    expect(blockingItemsForReconciliation(results)).toEqual([]);
  });

  it('M12A-F1: an unreadable printed row BLOCKS the run even though balance reconciliation itself passes', () => {
    const candidates: AieFieldCandidate[] = [
      ...statusCandidates('reconciled', '0', '1'),
      {
        fieldName: UNREADABLE_ROW_EVIDENCE_FIELD_NAME,
        valueRaw: JSON.stringify([{ sourceRowNumber: 1, reason: 'invalid_transaction_date' }]),
        isNull: false,
        sourceMethod: 'deterministic',
      },
    ];
    const results = fdhBankStatementReconciliationRule({ runId: 'r1', candidates });

    // The balance rule is untouched — this is an ADDITIONAL question, not a
    // reinterpretation of the existing answer.
    expect(balanceRule(results).outcome).toBe('pass');
    expect(completenessRule(results).outcome).toBe('indeterminate');
    expect(completenessRule(results).delta).toBe(1);
    // The reviewer is told WHICH row and WHY, never a guess at its contents.
    expect(completenessRule(results).materiality).toContain('invalid_transaction_date');

    // And the run cannot be accepted: one blocking item, from AIE-1.1 core's
    // own unchanged derivation, not a second exception channel.
    expect(worstOutcome(results)).toBe('indeterminate');
    const blocking = blockingItemsForReconciliation(results);
    expect(blocking.map((b) => b.reasonCode)).toContain('reconciliation_indeterminate:fdh_bank_statement_row_extraction_completeness');
    expect(blocking.every((b) => b.severity === 'blocking')).toBe(true);
  });

  it('M12A-F1: an ABSENT completeness candidate fails closed — an unreported signal is never read as a clean one', () => {
    // Exactly the shape a run from the pre-M12A parser produces. The defect
    // this closes WAS an absent signal being treated as good news, so absence
    // must block rather than pass.
    const candidates: AieFieldCandidate[] = [
      { fieldName: RECONCILIATION_STATUS_FIELD_NAME, valueRaw: 'reconciled', isNull: false, sourceMethod: 'deterministic' },
      { fieldName: RECONCILIATION_METHOD_FIELD_NAME, valueRaw: 'balance_rollforward', isNull: false, sourceMethod: 'deterministic' },
      { fieldName: RECONCILIATION_VARIANCE_FIELD_NAME, valueRaw: '0', isNull: false, sourceMethod: 'deterministic' },
    ];
    const results = fdhBankStatementReconciliationRule({ runId: 'r1', candidates });
    expect(balanceRule(results).outcome).toBe('pass');
    expect(completenessRule(results).outcome).toBe('indeterminate');
    expect(completenessRule(results).materiality).toBe('row_extraction_completeness_not_reported');
    expect(worstOutcome(results)).toBe('indeterminate');
  });

  it('AIE13-AI-10 / P4: an AI-supplied institution-hint candidate can NEVER upgrade a FAILED reconciliation to a pass', () => {
    const candidates: AieFieldCandidate[] = [
      ...statusCandidates('failed', '999.99'),
      { fieldName: INSTITUTION_HINT_FIELD_NAME, valueRaw: 'au_cba_pdf_v1', isNull: false, sourceMethod: 'ai' },
    ];
    const results = fdhBankStatementReconciliationRule({ runId: 'r1', candidates });
    expect(results[0].outcome).toBe('fail');
    // The AI candidate is readable for DISPLAY only — proven separately, not
    // as an input this function's outcome branches on.
    expect(extractInstitutionHintForDisplay(candidates)).toBe('au_cba_pdf_v1');
  });

  it('a deterministic (non-AI) candidate named the same as the institution-hint field is never treated as a displayable AI hint', () => {
    const candidates: AieFieldCandidate[] = [
      { fieldName: INSTITUTION_HINT_FIELD_NAME, valueRaw: 'au_cba_pdf_v1', isNull: false, sourceMethod: 'deterministic' },
    ];
    expect(extractInstitutionHintForDisplay(candidates)).toBeNull();
  });
});

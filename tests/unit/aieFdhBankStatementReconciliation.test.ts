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
} from '@/lib/aie/adapters/fdhBankStatement/types';
import type { AieFieldCandidate } from '@/lib/aie/types';

function statusCandidates(status: string, variance: string | null = '0'): AieFieldCandidate[] {
  return [
    { fieldName: RECONCILIATION_STATUS_FIELD_NAME, valueRaw: status, isNull: false, sourceMethod: 'deterministic' },
    { fieldName: RECONCILIATION_METHOD_FIELD_NAME, valueRaw: 'balance_rollforward', isNull: false, sourceMethod: 'deterministic' },
    { fieldName: RECONCILIATION_VARIANCE_FIELD_NAME, valueRaw: variance, isNull: variance === null, sourceMethod: 'deterministic' },
  ];
}

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
    expect(results).toHaveLength(2);
    expect(results.find((r) => r.ruleId.includes('balance'))?.outcome).toBe('pass');
    expect(results.find((r) => r.ruleId.includes('overlap'))?.outcome).toBe('indeterminate');
    // Overall worst-outcome across both rules is still indeterminate — never
    // silently swallowed by the passing balance rule.
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

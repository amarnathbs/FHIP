import { describe, it, expect } from 'vitest';
import { evaluateCertification, type CertificationInput } from '@/lib/services/investment-intelligence/certification';
import type { ReconcilePositionResult } from '@/lib/services/investment-intelligence/reconciliation';

const ZERO = BigInt(0);

function reconOk(): ReconcilePositionResult {
  return {
    reconciledOpeningUnitsScaled: ZERO,
    reconciledClosingUnitsScaled: ZERO,
    statementClosingUnitsScaled: ZERO,
    unitVarianceScaled: ZERO,
    withinTolerance: true,
  };
}

function baseInput(overrides: Partial<CertificationInput> = {}): CertificationInput {
  return {
    sourceDetected: true,
    parserFatalError: false,
    documentCorrupt: false,
    ownerUnresolved: false,
    instrumentUnresolved: false,
    crossHouseholdConflict: false,
    invalidCanonicalRecord: false,
    hasOpenBlockingReconciliationCase: false,
    hasMaterialUnclassifiedTransaction: false,
    hasNonMaterialUnclassifiedTransaction: false,
    reconciliation: reconOk(),
    historyCompleteness: 'complete_from_inception',
    staleStatementDays: 10,
    staleThresholdDays: 120,
    ...overrides,
  };
}

describe('evaluateCertification (spec sections 27, 29 — Portfolio Truth certification rules)', () => {
  it('REC-010 / a fully clean position certifies as CERTIFIED (not merely "parser ran without crashing")', () => {
    const outcome = evaluateCertification(baseInput());
    expect(outcome.status).toBe('certified');
    expect(outcome.blockingReasons).toEqual([]);
    expect(outcome.warningReasons).toEqual([]);
  });

  it('a material unit-variance mismatch blocks certification (RECONCILIATION_REQUIRED), never silently downgraded to a warning', () => {
    const outcome = evaluateCertification(baseInput({ reconciliation: { ...reconOk(), withinTolerance: false } }));
    expect(outcome.status).toBe('reconciliation_required');
    expect(outcome.blockingReasons.map((b) => b.code)).toContain('unit_variance_exceeds_tolerance');
  });

  it('an unresolved owner blocks certification', () => {
    const outcome = evaluateCertification(baseInput({ ownerUnresolved: true }));
    expect(outcome.status).toBe('reconciliation_required');
    expect(outcome.blockingReasons.map((b) => b.code)).toContain('unresolved_owner');
  });

  it('an unresolved/ambiguous instrument blocks certification', () => {
    const outcome = evaluateCertification(baseInput({ instrumentUnresolved: true }));
    expect(outcome.status).toBe('reconciliation_required');
  });

  it('a corrupted document blocks certification', () => {
    const outcome = evaluateCertification(baseInput({ documentCorrupt: true }));
    expect(outcome.status).toBe('reconciliation_required');
  });

  it('source undetected blocks certification', () => {
    const outcome = evaluateCertification(baseInput({ sourceDetected: false }));
    expect(outcome.status).toBe('reconciliation_required');
  });

  it('a cross-household mapping conflict blocks certification', () => {
    const outcome = evaluateCertification(baseInput({ crossHouseholdConflict: true }));
    expect(outcome.status).toBe('reconciliation_required');
  });

  it('a material unclassified transaction blocks certification', () => {
    const outcome = evaluateCertification(baseInput({ hasMaterialUnclassifiedTransaction: true }));
    expect(outcome.status).toBe('reconciliation_required');
  });

  it('an open blocking-severity reconciliation case blocks certification', () => {
    const outcome = evaluateCertification(baseInput({ hasOpenBlockingReconciliationCase: true }));
    expect(outcome.status).toBe('reconciliation_required');
  });

  it('incomplete transaction history (but reconciling holdings) permits CERTIFIED_WITH_WARNINGS, not a block', () => {
    const outcome = evaluateCertification(baseInput({ historyCompleteness: 'partial_history' }));
    expect(outcome.status).toBe('certified_with_warnings');
    expect(outcome.warningReasons.map((w) => w.code)).toContain('incomplete_transaction_history');
  });

  it('a holdings-only position (no transaction history) permits CERTIFIED_WITH_WARNINGS', () => {
    const outcome = evaluateCertification(baseInput({ historyCompleteness: 'holdings_only' }));
    expect(outcome.status).toBe('certified_with_warnings');
  });

  it('reconciliation that could not be evaluated (no opening balance) permits CERTIFIED_WITH_WARNINGS, not a block', () => {
    const outcome = evaluateCertification(baseInput({ reconciliation: { ...reconOk(), withinTolerance: null } }));
    expect(outcome.status).toBe('certified_with_warnings');
  });

  it('a stale statement date permits CERTIFIED_WITH_WARNINGS', () => {
    const outcome = evaluateCertification(baseInput({ staleStatementDays: 200, staleThresholdDays: 120 }));
    expect(outcome.status).toBe('certified_with_warnings');
    expect(outcome.warningReasons.map((w) => w.code)).toContain('stale_statement_date');
  });

  it('a non-material unclassified line permits CERTIFIED_WITH_WARNINGS, never a block', () => {
    const outcome = evaluateCertification(baseInput({ hasNonMaterialUnclassifiedTransaction: true }));
    expect(outcome.status).toBe('certified_with_warnings');
  });

  it('a blocker is NEVER downgraded to a warning even when warning-triggering conditions are also present', () => {
    const outcome = evaluateCertification(baseInput({ ownerUnresolved: true, historyCompleteness: 'partial_history', staleStatementDays: 500 }));
    expect(outcome.status).toBe('reconciliation_required');
    expect(outcome.warningReasons).toEqual([]); // blockers short-circuit — warnings are not even evaluated once a blocker exists
  });

  it('multiple simultaneous blockers are all reported, not just the first one found', () => {
    const outcome = evaluateCertification(baseInput({ ownerUnresolved: true, instrumentUnresolved: true, documentCorrupt: true }));
    expect(outcome.blockingReasons.length).toBeGreaterThanOrEqual(3);
  });
});

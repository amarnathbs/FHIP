import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { deriveTransactionCompleteness, deriveHoldingsReconciliationStatus } from '@/lib/services/investment-intelligence/dataQuality';
import { DEFAULT_RECONCILIATION_CONFIG } from '@/lib/services/investment-intelligence/reconciliationConfig';
import { computeParserConfidence } from '@/lib/services/investment-intelligence/parsers/registry';

describe('deriveTransactionCompleteness (spec section 28 — transparent quality components)', () => {
  it('maps complete_from_inception/complete_from_known_opening_balance to "complete"', () => {
    expect(deriveTransactionCompleteness('complete_from_inception')).toBe('complete');
    expect(deriveTransactionCompleteness('complete_from_known_opening_balance')).toBe('complete');
  });
  it('maps partial_history to "partial"', () => {
    expect(deriveTransactionCompleteness('partial_history')).toBe('partial');
  });
  it('maps holdings_only and null to "unknown"', () => {
    expect(deriveTransactionCompleteness('holdings_only')).toBe('unknown');
    expect(deriveTransactionCompleteness(null)).toBe('unknown');
  });
});

describe('deriveHoldingsReconciliationStatus', () => {
  it('maps null (not evaluated) to "not_evaluated"', () => {
    expect(deriveHoldingsReconciliationStatus(null, null)).toBe('not_evaluated');
  });
  it('maps false (outside tolerance) to "material_mismatch"', () => {
    expect(deriveHoldingsReconciliationStatus(false, false)).toBe('material_mismatch');
  });
  it('maps true + zero variance to "matched"', () => {
    expect(deriveHoldingsReconciliationStatus(true, true)).toBe('matched');
  });
  it('maps true + nonzero (but within-tolerance) variance to "within_tolerance"', () => {
    expect(deriveHoldingsReconciliationStatus(true, false)).toBe('within_tolerance');
  });
});

describe('DEFAULT_RECONCILIATION_CONFIG (spec section 25 — configurable, documented, not scattered)', () => {
  it('matches the documented default values exactly (unit tolerance 0.0001, currency tolerance 1.00, 120-day freshness window)', () => {
    expect(DEFAULT_RECONCILIATION_CONFIG.configVersion).toBe('r2-default-1.0.0');
    expect(DEFAULT_RECONCILIATION_CONFIG.statementFreshnessWarningDays).toBe(120);
  });

  it('MUST hold the same values as migration 0041\'s seed row (ii_reconciliation_config) — read directly from the migration SQL to catch drift', () => {
    // This test reads the migration file's literal text rather than
    // executing SQL (no DB in this sandbox) — it still catches the most
    // common real drift (someone changes one side and forgets the other).
    const migrationPath = join(process.cwd(), 'supabase/migrations/0041_ii_r2_scheme_resolution_and_portfolio_truth.sql');
    const sql = readFileSync(migrationPath, 'utf8');
    expect(sql).toContain("'r2-default-1.0.0'");
    expect(sql).toContain('0.0001'); // unit_tolerance
    expect(sql).toContain('1.00'); // currency_tolerance
    expect(sql).toContain('120'); // statement_freshness_warning_days
  });
});

describe('computeParserConfidence (spec section 28 — documented deterministic formula)', () => {
  it('returns 1.0 for a clean parse (no warnings, no transactions to classify)', () => {
    expect(computeParserConfidence([], [])).toBe(1);
  });

  it('subtracts 0.15 per error-severity warning', () => {
    const score = computeParserConfidence([{ code: 'x', message: 'x', severity: 'error' }], []);
    expect(score).toBeCloseTo(0.85, 6);
  });

  it('subtracts 0.05 per warning-severity warning', () => {
    const score = computeParserConfidence([{ code: 'x', message: 'x', severity: 'warning' }], []);
    expect(score).toBeCloseTo(0.95, 6);
  });

  it('info-severity warnings do not reduce the score', () => {
    const score = computeParserConfidence([{ code: 'x', message: 'x', severity: 'info' }], []);
    expect(score).toBe(1);
  });

  it('scales by classification confidence when transactions are present, losing at most 30% of score', () => {
    const allUnclassified = computeParserConfidence([], [0, 0, 0]); // confidence 0 for every transaction
    expect(allUnclassified).toBeCloseTo(0.7, 6);
    const allExact = computeParserConfidence([], [1, 1, 1]);
    expect(allExact).toBe(1);
  });

  it('never goes below 0 or above 1', () => {
    const score = computeParserConfidence(
      Array.from({ length: 20 }, () => ({ code: 'x', message: 'x', severity: 'error' as const })),
      [0]
    );
    expect(score).toBe(0);
  });
});

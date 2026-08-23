// Investment Intelligence R2 — versioned, configurable reconciliation
// tolerances (spec section 25: "Use configurable tolerances, not
// scattered magic numbers ... keep tolerances configurable/versioned,
// never use a wide tolerance to conceal parser defects").
//
// DEFAULT_RECONCILIATION_CONFIG below and the seed row inserted by
// migration 0041 (`ii_reconciliation_config`, config_version
// 'r2-default-1.0.0') MUST hold identical values — enforced by
// tests/unit/iiReconciliationConfig.test.ts. The DB table is the
// admin-tunable source of truth once migrations are applied; this
// constant is the safe fallback used by every fixture-only/pre-migration
// test run in this sandbox, and by any code path invoked before the DB
// table can be reached.

import { createClient } from '@/lib/supabase/server';
import { parseExactDecimal } from './decimal';

// These two literals are fixed, valid decimal strings — parseExactDecimal
// on a hardcoded literal like this can never fail, so a non-null-style
// helper (rather than a defensive fallback branch that could never
// actually execute) keeps the intent honest.
function mustParseScaled(literal: string): bigint {
  const parsed = parseExactDecimal(literal);
  if (!parsed.ok) throw new Error(`Unreachable: hardcoded literal "${literal}" failed to parse`);
  return parsed.scaled;
}

export interface ReconciliationConfig {
  configVersion: string;
  unitToleranceScaled: bigint; // scaled per decimal.ts's DECIMAL_SCALE
  currencyToleranceScaled: bigint;
  statementFreshnessWarningDays: number;
}

// unit_tolerance = 0.0001 — matches AMFI's 4-decimal-unit statement
// precision (a real CAS never prints units to more than 3-4 decimal
// places, so treating a difference below this as rounding noise, not a
// genuine reconciliation failure, is conservative and documented, not
// arbitrary).
// currency_tolerance = 1.00 (major unit, INR/AUD) — absorbs paisa/cent
// rounding across a chain of transactions without masking a real,
// material mismatch (spec explicitly warns against a WIDE tolerance
// concealing parser defects; 1 rupee/dollar across a multi-lakh/multi-
// thousand portfolio value is not material).
export const DEFAULT_RECONCILIATION_CONFIG: ReconciliationConfig = {
  configVersion: 'r2-default-1.0.0',
  unitToleranceScaled: mustParseScaled('0.0001'),
  currencyToleranceScaled: mustParseScaled('1.00'),
  statementFreshnessWarningDays: 120,
};

/**
 * Load the active reconciliation config from ii_reconciliation_config
 * (RLS: world-readable). Falls back to DEFAULT_RECONCILIATION_CONFIG if
 * the table is unreachable (e.g. migration not yet applied in this
 * sandbox — see R2_TESTING_AND_VERIFICATION.md) or has no active row,
 * never throwing and never silently using a DIFFERENT tolerance than the
 * documented default.
 */
export async function loadActiveReconciliationConfig(): Promise<ReconciliationConfig> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.from('ii_reconciliation_config').select('*').eq('is_active', true).maybeSingle();
    if (error || !data) return DEFAULT_RECONCILIATION_CONFIG;
    const unit = parseExactDecimal(String(data.unit_tolerance));
    const currency = parseExactDecimal(String(data.currency_tolerance));
    if (!unit.ok || !currency.ok) return DEFAULT_RECONCILIATION_CONFIG;
    return {
      configVersion: data.config_version as string,
      unitToleranceScaled: unit.scaled,
      currencyToleranceScaled: currency.scaled,
      statementFreshnessWarningDays: (data.statement_freshness_warning_days as number) ?? DEFAULT_RECONCILIATION_CONFIG.statementFreshnessWarningDays,
    };
  } catch {
    return DEFAULT_RECONCILIATION_CONFIG;
  }
}

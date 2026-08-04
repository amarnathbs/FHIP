// Forecasting Engine orchestrator (Phase 1 skeleton). Pure function — takes
// already-resolved inputs and returns rows ready for the service layer to
// persist into forecast_results / forecast_explanations. No Supabase access
// here, matching the engines/ vs services/ split used across every module.
import { createHash } from 'crypto';
import { runNetWorthForecast, type NetWorthCalculatorInput } from './netWorthCalculator';
import { runGoalForecast, type GoalCalculatorInput } from './goalCalculator';
import { runInvestmentForecast, type InvestmentCalculatorInput } from './investmentCalculator';
import { runDebtForecast, type DebtCalculatorInput } from './debtCalculator';
import { runRetirementForecast, type RetirementCalculatorInput } from './retirementCalculator';
import { runCrossBorderForecast, type CrossBorderCalculatorInput } from './crossBorderCalculator';
import { runResilienceForecast, type ResilienceCalculatorInput } from './resilienceCalculator';
import type { ForecastType, MonthlyForecastOutput } from './types';

// Bump this whenever a registered calculator's logic changes in a way that
// would change its output for the same inputs. forecast_runs.engine_version
// is stored per run and MUST be included alongside input_hash when deciding
// whether an existing completed run can be reused — matching on input_hash
// alone would let a stale pre-fix run get served forever after a calculator
// bug fix, since the inputs (and therefore the hash) never changed, only the
// code that turns them into a result.
export const FORECAST_ENGINE_VERSION = 'forecast-1.5.0';

// Registry of calculators — all 7 non-Premium forecast types from the
// roadmap are now registered (Premium/Monte Carlo simulation is explicitly
// deferred per spec section 27, Phase 8).
const CALCULATORS: Partial<Record<ForecastType, (input: unknown) => MonthlyForecastOutput>> = {
  net_worth: (input) => runNetWorthForecast(input as NetWorthCalculatorInput),
  goal: (input) => runGoalForecast(input as GoalCalculatorInput),
  investment: (input) => runInvestmentForecast(input as InvestmentCalculatorInput),
  debt: (input) => runDebtForecast(input as DebtCalculatorInput),
  retirement: (input) => runRetirementForecast(input as RetirementCalculatorInput),
  cross_border: (input) => runCrossBorderForecast(input as CrossBorderCalculatorInput),
  resilience: (input) => runResilienceForecast(input as ResilienceCalculatorInput),
};

export function isForecastTypeSupported(forecastType: ForecastType): boolean {
  return forecastType in CALCULATORS;
}

export function runForecastCalculation(forecastType: ForecastType, input: unknown): MonthlyForecastOutput {
  const calculator = CALCULATORS[forecastType];
  if (!calculator) {
    throw new Error(`No forecast calculator registered yet for forecast_type "${forecastType}"`);
  }
  return calculator(input);
}

// Recursively sorts object keys so JSON.stringify produces the same string
// regardless of property insertion order (a plain Object.keys()-as-replacer
// only sorts the top level and silently drops differently-named nested
// keys, which would corrupt the hash).
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

// Deterministic hash of everything that affects the output, so the service
// layer can skip recomputing/re-persisting an identical run (spec section 26:
// "Store an input hash to identify unchanged forecast inputs" / "Prevent
// duplicate identical forecast runs").
export function computeForecastInputHash(payload: unknown): string {
  const json = JSON.stringify(sortKeysDeep(payload));
  return createHash('sha256').update(json).digest('hex');
}

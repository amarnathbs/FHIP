// Resolves the assumption hierarchy defined in the forecasting spec (section
// 6.4): user-specific forecast assumption -> user-specific product assumption
// -> scenario assumption -> country default -> global default.
//
// Phase 1 only has two source tables (forecast_assumptions, scoped by
// forecast_profile_id and optionally scenario_id, and forecast_global_assumptions,
// scoped by country_code), so the 5-level spec hierarchy collapses to 4
// practical tiers here. Later phases (e.g. per-investment-product overrides)
// can add another tier without changing this function's callers.
import type { AssumptionValueType, ResolvedAssumption, ResolvedAssumptionSet } from './types';

export interface RawForecastAssumption {
  scenario_id: string | null;
  assumption_category: string;
  assumption_key: string;
  assumption_value: number;
  value_type: AssumptionValueType;
  unit: string | null;
  source_reference: string | null;
}

export interface RawGlobalAssumption {
  country_code: string | null;
  assumption_category: string;
  assumption_key: string;
  assumption_value: number;
  value_type: AssumptionValueType;
  unit: string | null;
  source_reference: string | null;
}

export function resolveAssumptions(params: {
  scenarioId: string;
  countryCode: string | null;
  profileAssumptions: RawForecastAssumption[];
  globalAssumptions: RawGlobalAssumption[];
}): ResolvedAssumptionSet {
  const { scenarioId, countryCode, profileAssumptions, globalAssumptions } = params;
  const resolved: ResolvedAssumptionSet = {};

  const scenarioScoped = profileAssumptions.filter((a) => a.scenario_id === scenarioId);
  const profileScoped = profileAssumptions.filter((a) => a.scenario_id === null);
  const countryDefaults = countryCode ? globalAssumptions.filter((a) => a.country_code === countryCode) : [];
  const globalDefaults = globalAssumptions.filter((a) => a.country_code === null);

  const applyTier = (rows: RawForecastAssumption[] | RawGlobalAssumption[], sourceType: ResolvedAssumption['sourceType']) => {
    for (const row of rows) {
      if (resolved[row.assumption_key]) continue; // higher tier already set it
      resolved[row.assumption_key] = {
        key: row.assumption_key,
        category: row.assumption_category,
        value: row.assumption_value,
        valueType: row.value_type,
        unit: row.unit,
        sourceType,
        sourceReference: row.source_reference,
      };
    }
  };

  applyTier(scenarioScoped, 'user_override');
  applyTier(profileScoped, 'user_override');
  applyTier(countryDefaults, 'country_default');
  applyTier(globalDefaults, 'global_default');

  return resolved;
}

export function getAssumptionValue(set: ResolvedAssumptionSet, key: string, fallback: number): number {
  return set[key]?.value ?? fallback;
}

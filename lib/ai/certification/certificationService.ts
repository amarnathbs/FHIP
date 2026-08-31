// Module 11.0 — AIContextCertificationService (spec sections 23-24).
//
// Pure, DB-free certification logic. Every function here takes ALREADY
// LOADED summary values (booleans/numbers/dates already produced by the
// canonical engines) and returns a DomainCertification — it never queries
// the database and never recomputes a financial value itself. This keeps
// certification logic unit-testable without a Supabase client and keeps a
// hard line between "did the certified engine produce this" (elsewhere) and
// "is what it produced trustworthy enough to hand to an AI" (here).
//
// Rule enforced throughout: missing data is never treated as zero (spec
// section 23). A `null`/absent metric always routes to PARTIAL/UNAVAILABLE,
// never to a certified zero.

import type { CertificationState, DomainCertification } from '@/lib/ai/context/types';

/** A monthly-cadence domain older than this is STALE, not CERTIFIED. */
export const STALE_THRESHOLD_DAYS = 45;

function daysSince(dateIso: string | null): number | null {
  if (!dateIso) return null;
  const then = new Date(dateIso).getTime();
  if (Number.isNaN(then)) return null;
  return (Date.now() - then) / (1000 * 60 * 60 * 24);
}

export function isStale(dataAsOf: string | null, thresholdDays = STALE_THRESHOLD_DAYS): boolean {
  const d = daysSince(dataAsOf);
  return d !== null && d > thresholdDays;
}

function cert(status: CertificationState, reason: string | null, modelVersions: string[], dataAsOf: string | null): DomainCertification {
  return { status, reason, model_versions: modelVersions, data_as_of: dataAsOf };
}

// ---------------------------------------------------------------------------
// Cash flow / balance sheet — both derive from computeDashboard() output.
// hasIncome/hasExpenses/hasAssets/hasLiabilities are DashboardSummary's own
// data-presence flags; we never infer presence from whether a number is 0,
// because "0 income recorded" and "no income data entered" are different
// facts DashboardSummary already keeps separate upstream.
// ---------------------------------------------------------------------------
export function certifyCashFlow(input: {
  hasIncome: boolean;
  hasExpenses: boolean;
  dataAsOf: string | null;
}): DomainCertification {
  if (!input.hasIncome && !input.hasExpenses) {
    return cert('UNAVAILABLE', 'No income or expense data has been entered.', [], null);
  }
  if (!input.hasIncome || !input.hasExpenses) {
    return cert('PARTIAL', input.hasIncome ? 'Expense data is missing.' : 'Income data is missing.', ['dashboard-1.0.0'], input.dataAsOf);
  }
  if (isStale(input.dataAsOf)) {
    return cert('STALE', `Cash flow data was last refreshed ${input.dataAsOf}, more than ${STALE_THRESHOLD_DAYS} days ago.`, ['dashboard-1.0.0'], input.dataAsOf);
  }
  return cert('CERTIFIED', null, ['dashboard-1.0.0'], input.dataAsOf);
}

export function certifyBalanceSheet(input: {
  hasAssets: boolean;
  hasLiabilities: boolean;
  dataAsOf: string | null;
}): DomainCertification {
  if (!input.hasAssets && !input.hasLiabilities) {
    return cert('UNAVAILABLE', 'No asset or liability data has been entered.', [], null);
  }
  if (!input.hasAssets || !input.hasLiabilities) {
    return cert('PARTIAL', input.hasAssets ? 'Liability data is missing.' : 'Asset data is missing.', ['dashboard-1.0.0'], input.dataAsOf);
  }
  if (isStale(input.dataAsOf)) {
    return cert('STALE', `Balance sheet data was last refreshed ${input.dataAsOf}, more than ${STALE_THRESHOLD_DAYS} days ago.`, ['dashboard-1.0.0'], input.dataAsOf);
  }
  return cert('CERTIFIED', null, ['dashboard-1.0.0'], input.dataAsOf);
}

// ---------------------------------------------------------------------------
// Score / DNA / Resilience — each already carries its own eligibility/status
// concept from its engine; we translate rather than re-derive.
// ---------------------------------------------------------------------------
export function certifyScore(input: {
  eligibilityState: 'not_yet_scored' | 'preliminary' | 'full' | string;
  modelVersion: string;
  calculationDate: string | null;
}): DomainCertification {
  if (input.eligibilityState === 'not_yet_scored') {
    return cert('UNAVAILABLE', 'Financial Health Score has not been calculated yet.', [], null);
  }
  if (input.eligibilityState === 'preliminary') {
    return cert('PARTIAL', 'Financial Health Score is preliminary — some sections are incomplete.', [input.modelVersion], input.calculationDate);
  }
  if (isStale(input.calculationDate)) {
    return cert('STALE', `Score was last calculated ${input.calculationDate}.`, [input.modelVersion], input.calculationDate);
  }
  return cert('CERTIFIED', null, [input.modelVersion], input.calculationDate);
}

export function certifyDna(input: {
  status: 'insufficient_data' | 'indicative' | 'confirmed' | 'high_confidence' | string;
  modelVersion: string;
  classificationDate: string | null;
}): DomainCertification {
  if (input.status === 'insufficient_data') {
    return cert('UNAVAILABLE', 'Financial DNA classification does not yet have enough data.', [], null);
  }
  if (input.status === 'indicative') {
    return cert('PARTIAL', 'Financial DNA classification is indicative, not yet confirmed.', [input.modelVersion], input.classificationDate);
  }
  if (isStale(input.classificationDate)) {
    return cert('STALE', `Financial DNA was last classified ${input.classificationDate}.`, [input.modelVersion], input.classificationDate);
  }
  return cert('CERTIFIED', null, [input.modelVersion], input.classificationDate);
}

export function certifyResilience(input: {
  eligibilityState: 'not_yet_available' | 'preliminary' | 'full' | string;
  modelVersion: string | null;
  calculationDate: string | null;
}): DomainCertification {
  if (input.eligibilityState === 'not_yet_available') {
    return cert('UNAVAILABLE', 'Resilience score has not been calculated yet.', [], null);
  }
  if (input.eligibilityState === 'preliminary') {
    return cert('PARTIAL', 'Resilience score is preliminary — some sections are incomplete.', input.modelVersion ? [input.modelVersion] : [], input.calculationDate);
  }
  if (isStale(input.calculationDate)) {
    return cert('STALE', `Resilience was last calculated ${input.calculationDate}.`, input.modelVersion ? [input.modelVersion] : [], input.calculationDate);
  }
  return cert('CERTIFIED', null, input.modelVersion ? [input.modelVersion] : [], input.calculationDate);
}

// ---------------------------------------------------------------------------
// Investments / retirement / insurance
// ---------------------------------------------------------------------------
export function certifyInvestments(input: { hasInvestments: boolean; dataAsOf: string | null }): DomainCertification {
  if (!input.hasInvestments) return cert('UNAVAILABLE', 'No investment data has been entered.', [], null);
  if (isStale(input.dataAsOf)) return cert('STALE', `Investment data was last refreshed ${input.dataAsOf}.`, ['dashboard-1.0.0'], input.dataAsOf);
  return cert('CERTIFIED', null, ['dashboard-1.0.0'], input.dataAsOf);
}

export function certifyRetirement(input: { hasRetirement: boolean; dataAsOf: string | null }): DomainCertification {
  if (!input.hasRetirement) return cert('UNAVAILABLE', 'No retirement account data has been entered.', [], null);
  if (isStale(input.dataAsOf)) return cert('STALE', `Retirement data was last refreshed ${input.dataAsOf}.`, ['dashboard-1.0.0'], input.dataAsOf);
  return cert('CERTIFIED', null, ['dashboard-1.0.0'], input.dataAsOf);
}

// Insurance is deliberately never UNAVAILABLE-because-empty: an empty
// insurance_policies table is ambiguous between "never asked" and
// "confirmed no cover" upstream, so we surface PARTIAL with an explicit
// missing-categories list instead of collapsing to a single boolean — this
// mirrors financialSectionStatusData's not_applicable vs never-reviewed
// distinction (spec section 16).
export function certifyInsurance(input: { hasInsurance: boolean; missingCategoryCount: number; dataAsOf: string | null }): DomainCertification {
  if (!input.hasInsurance && input.missingCategoryCount > 0) {
    return cert('PARTIAL', 'Insurance coverage has not been reviewed for all categories.', [], input.dataAsOf);
  }
  if (!input.hasInsurance) {
    return cert('UNAVAILABLE', 'No insurance data has been entered.', [], null);
  }
  if (input.missingCategoryCount > 0) {
    return cert('PARTIAL', `${input.missingCategoryCount} insurance categories are missing or unknown.`, ['dashboard-1.0.0'], input.dataAsOf);
  }
  return cert('CERTIFIED', null, ['dashboard-1.0.0'], input.dataAsOf);
}

// ---------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------
export function certifyGoals(input: { goalCount: number; dataAsOf: string | null }): DomainCertification {
  if (input.goalCount === 0) return cert('UNAVAILABLE', 'No goals have been created.', [], null);
  return cert('CERTIFIED', null, ['goals-1.0.0'], input.dataAsOf);
}

// ---------------------------------------------------------------------------
// Forecasts
// ---------------------------------------------------------------------------
export function certifyForecast(input: { hasRun: boolean; runStatus: string | null; modelVersion: string | null; calculationDate: string | null }): DomainCertification {
  if (!input.hasRun) return cert('UNAVAILABLE', 'No forecast has been run for this household.', [], null);
  if (input.runStatus && input.runStatus !== 'completed' && input.runStatus !== 'success') {
    return cert('PARTIAL', `Latest forecast run status is "${input.runStatus}".`, input.modelVersion ? [input.modelVersion] : [], input.calculationDate);
  }
  if (isStale(input.calculationDate)) return cert('STALE', `Forecast was last run ${input.calculationDate}.`, input.modelVersion ? [input.modelVersion] : [], input.calculationDate);
  return cert('CERTIFIED', null, input.modelVersion ? [input.modelVersion] : [], input.calculationDate);
}

// ---------------------------------------------------------------------------
// Financial Twin
// ---------------------------------------------------------------------------
export function certifyTwin(input: { hasRun: boolean; status: 'indicative' | 'confirmed' | 'restated' | null; modelVersion: string | null; calculationDate: string | null }): DomainCertification {
  if (!input.hasRun) return cert('UNAVAILABLE', 'No Financial Twin comparison has been generated.', [], null);
  if (input.status === 'indicative') return cert('PARTIAL', 'Financial Twin result is indicative (peer sample size below confidence threshold).', input.modelVersion ? [input.modelVersion] : [], input.calculationDate);
  if (isStale(input.calculationDate)) return cert('STALE', `Financial Twin was last generated ${input.calculationDate}.`, input.modelVersion ? [input.modelVersion] : [], input.calculationDate);
  return cert('CERTIFIED', null, input.modelVersion ? [input.modelVersion] : [], input.calculationDate);
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------
export function certifyReports(input: { reportCount: number; latestStatus: string | null; dataAsOf: string | null }): DomainCertification {
  if (input.reportCount === 0) return cert('UNAVAILABLE', 'No reports have been generated.', [], null);
  if (input.latestStatus && !['ready', 'published', 'revised'].includes(input.latestStatus)) {
    return cert('PARTIAL', `Latest report status is "${input.latestStatus}".`, ['report-1.0.0'], input.dataAsOf);
  }
  return cert('CERTIFIED', null, ['report-1.0.0'], input.dataAsOf);
}

// ---------------------------------------------------------------------------
// Cross-border — the one domain that FAILS CLOSED on currency-integrity
// failure regardless of any other signal (spec section 21).
// ---------------------------------------------------------------------------
export function certifyCrossBorder(input: {
  countriesInUse: string[];
  currencyIntegrityOk: boolean;
  dataAsOf: string | null;
}): DomainCertification {
  if (!input.currencyIntegrityOk) {
    return cert('INVALID', 'Currency integrity check failed: at least one record uses an unrecognised or unsupported currency code.', [], null);
  }
  if (input.countriesInUse.length <= 1) {
    return cert('UNAVAILABLE', 'This household has no cross-border financial data.', [], null);
  }
  return cert('CERTIFIED', null, ['dashboard-1.0.0'], input.dataAsOf);
}

/**
 * Rolls a full domain map down to a single root-level summary status
 * (spec section 7's `certification_status`). This is a SUMMARY signal for
 * display only — actual per-domain gating always uses the domain map, never
 * this rollup, so one UNAVAILABLE optional domain (e.g. Financial Twin)
 * never blocks an unrelated CERTIFIED domain (e.g. cash flow).
 */
export function rollUpCertification(statuses: CertificationState[]): CertificationState {
  const meaningful = statuses.filter((s) => s !== 'UNAVAILABLE');
  if (meaningful.length === 0) return 'UNAVAILABLE';
  if (meaningful.some((s) => s === 'INVALID')) return 'INVALID';
  if (meaningful.every((s) => s === 'CERTIFIED')) return 'CERTIFIED';
  if (meaningful.some((s) => s === 'STALE')) return 'STALE';
  return 'PARTIAL';
}

// Module 11.2 — versioned deterministic/knowledge answer templates (spec
// sections 14, 68-71).
//
// Templates are wording ONLY. They never compute a financial value — every
// value they render was already extracted from a certified
// FinancialContextObject section by lib/ai/resolution/deterministicResolver.ts.
// A future wording change bumps TEMPLATE_VERSION for the affected template
// code; it never changes what number is shown (spec section 68: "a later
// answer wording change must not change underlying financial calculation
// semantics").
//
// Currency/date formatting reuses the existing FHIP engines (spec sections
// 70-71) — this file never re-implements Intl formatting itself.

import { formatMoney } from '@/lib/engines/money';
import { formatDateShort } from '@/lib/engines/date';

export const TEMPLATE_REGISTRY_VERSION = 'resolution-templates-1.0.0';

export type MetricFormat = 'money' | 'percent' | 'count' | 'months' | 'text' | 'date' | 'list' | 'score';

export interface MetricTemplateConfig {
  template_code: string;
  template_version: number;
  /** Human label used in the headline, e.g. "net worth". */
  label: string;
  format: MetricFormat;
  /** One-sentence plain-English definition of the metric (spec section 16-17). */
  meaning: string;
  related_module: string | null;
  action_route: string | null;
}

export const METRIC_TEMPLATES: Record<string, MetricTemplateConfig> = {
  CURRENT_NET_WORTH: { template_code: 'CURRENT_NET_WORTH', template_version: 1, label: 'net worth', format: 'money', meaning: 'Net worth is the value of your recorded assets minus your recorded liabilities.', related_module: 'dashboard', action_route: '/dashboard' },
  TOTAL_ASSETS: { template_code: 'TOTAL_ASSETS', template_version: 1, label: 'total assets', format: 'money', meaning: 'Total assets is the sum of everything of financial value you have recorded — cash, property, investments and retirement accounts.', related_module: 'dashboard', action_route: '/dashboard' },
  TOTAL_LIABILITIES: { template_code: 'TOTAL_LIABILITIES', template_version: 1, label: 'total liabilities', format: 'money', meaning: 'Total liabilities is the sum of everything you owe that you have recorded — loans, credit cards and other debts.', related_module: 'dashboard', action_route: '/dashboard' },
  LIQUID_ASSETS: { template_code: 'LIQUID_ASSETS', template_version: 1, label: 'liquid assets', format: 'money', meaning: 'Liquid assets are the recorded assets you could access quickly if you needed to, such as cash and savings.', related_module: 'dashboard', action_route: '/dashboard' },
  MONTHLY_GROSS_INCOME: { template_code: 'MONTHLY_GROSS_INCOME', template_version: 1, label: 'monthly gross income', format: 'money', meaning: 'Monthly gross income is your recorded income before tax and other deductions.', related_module: 'dashboard', action_route: '/dashboard' },
  MONTHLY_NET_INCOME: { template_code: 'MONTHLY_NET_INCOME', template_version: 1, label: 'monthly net income', format: 'money', meaning: 'Monthly net income is your recorded take-home income after tax and other deductions.', related_module: 'dashboard', action_route: '/dashboard' },
  MONTHLY_EXPENSES: { template_code: 'MONTHLY_EXPENSES', template_version: 1, label: 'monthly expenses', format: 'money', meaning: 'Monthly expenses is the total of your recorded regular monthly spending.', related_module: 'dashboard', action_route: '/dashboard' },
  ESSENTIAL_EXPENSES: { template_code: 'ESSENTIAL_EXPENSES', template_version: 1, label: 'essential monthly expenses', format: 'money', meaning: 'Essential monthly expenses are the recorded expenses classified as non-discretionary, such as housing, utilities and groceries.', related_module: 'dashboard', action_route: '/dashboard' },
  MONTHLY_SURPLUS: { template_code: 'MONTHLY_SURPLUS', template_version: 1, label: 'monthly surplus', format: 'money', meaning: 'This is the amount remaining from your recorded monthly net income after your recorded monthly expenses.', related_module: 'dashboard', action_route: '/dashboard' },
  SAVINGS_RATE: { template_code: 'SAVINGS_RATE', template_version: 1, label: 'savings rate', format: 'percent', meaning: 'Savings rate is the share of your net income that is not spent, based on your recorded income and expenses.', related_module: 'dashboard', action_route: '/dashboard' },
  FINANCIAL_HEALTH_SCORE: { template_code: 'FINANCIAL_HEALTH_SCORE', template_version: 1, label: 'Financial Health Score', format: 'score', meaning: 'Your Financial Health Score is a single 0-100 measure combining several pillars of your recorded financial position.', related_module: 'score', action_route: '/score' },
  FINANCIAL_HEALTH_BAND: { template_code: 'FINANCIAL_HEALTH_BAND', template_version: 1, label: 'Financial Health Score band', format: 'text', meaning: 'This is the descriptive band your current Financial Health Score falls into.', related_module: 'score', action_route: '/score' },
  DNA_PRIMARY_PROFILE: { template_code: 'DNA_PRIMARY_PROFILE', template_version: 1, label: 'primary Financial DNA profile', format: 'text', meaning: 'Your Financial DNA profile classifies your recorded financial behaviour into a descriptive category.', related_module: 'dna', action_route: '/dna' },
  DNA_SECONDARY_PROFILE: { template_code: 'DNA_SECONDARY_PROFILE', template_version: 1, label: 'secondary Financial DNA profile', format: 'text', meaning: 'Your secondary Financial DNA profile is the next closest classification alongside your primary one.', related_module: 'dna', action_route: '/dna' },
  RESILIENCE_STATUS: { template_code: 'RESILIENCE_STATUS', template_version: 1, label: 'Financial Resilience status', format: 'text', meaning: 'Financial Resilience status summarises how well positioned your recorded finances are to absorb a financial shock.', related_module: 'resilience', action_route: '/resilience' },
  RESILIENCE_SCORE: { template_code: 'RESILIENCE_SCORE', template_version: 1, label: 'Financial Resilience score', format: 'score', meaning: 'Your Financial Resilience score is a single measure of how well positioned your recorded finances are to absorb a financial shock.', related_module: 'resilience', action_route: '/resilience' },
  EMERGENCY_FUND_MONTHS: { template_code: 'EMERGENCY_FUND_MONTHS', template_version: 1, label: 'emergency-fund coverage', format: 'months', meaning: 'Emergency-fund coverage is how many months of your recorded essential expenses your recorded liquid assets could cover.', related_module: 'resilience', action_route: '/resilience' },
  INVESTMENT_TOTAL: { template_code: 'INVESTMENT_TOTAL', template_version: 1, label: 'total investments', format: 'money', meaning: 'Total investments is the current recorded value of your investment holdings.', related_module: 'investments', action_route: '/investments' },
  INVESTMENT_DIVERSIFICATION: { template_code: 'INVESTMENT_DIVERSIFICATION', template_version: 1, label: 'investment diversification score', format: 'score', meaning: 'The diversification score reflects how spread your recorded investments are across holdings.', related_module: 'investments', action_route: '/investments' },
  RETIREMENT_BALANCE: { template_code: 'RETIREMENT_BALANCE', template_version: 1, label: 'retirement balance', format: 'money', meaning: 'Retirement balance is the current recorded total across your retirement accounts.', related_module: 'retirement', action_route: '/retirement' },
  INSURANCE_DATA_STATUS: { template_code: 'INSURANCE_DATA_STATUS', template_version: 1, label: 'insurance data status', format: 'text', meaning: 'This shows whether FHIP has complete, partial, or no recorded insurance information for your household.', related_module: 'insurance', action_route: '/insurance' },
  GOAL_COUNT: { template_code: 'GOAL_COUNT', template_version: 1, label: 'number of goals', format: 'count', meaning: 'This is the number of financial goals you currently have recorded.', related_module: 'goals', action_route: '/goals' },
  GOALS_ON_TRACK_COUNT: { template_code: 'GOALS_ON_TRACK_COUNT', template_version: 1, label: 'goals on track', format: 'count', meaning: 'This is how many of your recorded goals the certified forecast currently classifies as on track.', related_module: 'goals', action_route: '/goals' },
  GOALS_AT_RISK_COUNT: { template_code: 'GOALS_AT_RISK_COUNT', template_version: 1, label: 'goals at risk', format: 'count', meaning: 'This is how many of your recorded goals the certified forecast currently classifies as off track or at risk.', related_module: 'goals', action_route: '/goals' },
  FORECAST_LATEST_RUN_DATE: { template_code: 'FORECAST_LATEST_RUN_DATE', template_version: 1, label: 'forecast last calculated', format: 'date', meaning: 'This is when FHIP last calculated the base-case forecast currently shown.', related_module: 'forecasting', action_route: '/forecasting' },
  TWIN_COHORT: { template_code: 'TWIN_COHORT', template_version: 1, label: 'Financial Twin peer cohort', format: 'text', meaning: 'This describes the peer cohort your Financial Twin comparison currently uses.', related_module: 'twin', action_route: '/twin' },
  TWIN_CONFIDENCE: { template_code: 'TWIN_CONFIDENCE', template_version: 1, label: 'Financial Twin confidence', format: 'text', meaning: 'This describes how confident the current Financial Twin comparison is.', related_module: 'twin', action_route: '/twin' },
  REPORT_PERIOD: { template_code: 'REPORT_PERIOD', template_version: 1, label: 'most recent report period', format: 'text', meaning: 'This is the reporting period covered by your most recent generated report.', related_module: 'reports', action_route: '/reports' },
  REPORT_VERSION: { template_code: 'REPORT_VERSION', template_version: 1, label: 'most recent report version', format: 'text', meaning: 'This is the version number of your most recent generated report.', related_module: 'reports', action_route: '/reports' },
  COUNTRIES_PRESENT: { template_code: 'COUNTRIES_PRESENT', template_version: 1, label: 'countries represented', format: 'list', meaning: 'These are the countries currently represented in your recorded financial data.', related_module: 'dashboard', action_route: '/dashboard' },
  CURRENCIES_PRESENT: { template_code: 'CURRENCIES_PRESENT', template_version: 1, label: 'currencies recorded', format: 'list', meaning: 'These are the currencies currently recorded in your financial data.', related_module: 'dashboard', action_route: '/dashboard' },
  REPORTING_CURRENCY: { template_code: 'REPORTING_CURRENCY', template_version: 1, label: 'reporting currency', format: 'text', meaning: 'This is the currency FHIP uses to report your figures.', related_module: 'dashboard', action_route: '/dashboard' },
  SNAPSHOT_DATE: { template_code: 'SNAPSHOT_DATE', template_version: 1, label: 'financial snapshot date', format: 'date', meaning: 'This is the date your current financial snapshot is as of.', related_module: 'dashboard', action_route: '/dashboard' },
  DATA_COMPLETENESS: { template_code: 'DATA_COMPLETENESS', template_version: 1, label: 'data completeness', format: 'list', meaning: 'This shows which financial areas currently have complete, certified data and which do not.', related_module: 'dashboard', action_route: '/dashboard' },
  STALE_DATA_AREAS: { template_code: 'STALE_DATA_AREAS', template_version: 1, label: 'stale data areas', format: 'list', meaning: 'These are the financial areas currently based on data FHIP considers stale.', related_module: 'dashboard', action_route: '/dashboard' },
};

export function formatMetricValue(format: MetricFormat, value: unknown, currency: 'AUD' | 'INR'): string {
  if (value === null || value === undefined) return 'not available';
  switch (format) {
    case 'money':
      return formatMoney(Number(value), currency);
    case 'percent':
      return `${(Number(value) * 100).toFixed(1)}%`;
    case 'count':
      return String(value);
    case 'months':
      return `${Number(value).toFixed(1)} months`;
    case 'score':
      return String(value);
    case 'date':
      return formatDateShort(String(value), currency);
    case 'list':
      return Array.isArray(value) ? (value.length > 0 ? value.join(', ') : 'none recorded') : String(value);
    case 'text':
    default:
      return String(value);
  }
}

export function renderMetricHeadline(config: MetricTemplateConfig, formattedValue: string): string {
  if (config.format === 'list') return `Your current ${config.label}: ${formattedValue}.`;
  return `Your current ${config.label} is ${formattedValue}.`;
}

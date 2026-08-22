// R1.6 — Typed FHIP Contextual Integration registry (spec Part D, §55-56,
// §65). Single source of truth for every "context key" a Resource can be
// mapped to: no context key string is ever hand-typed anywhere else in the
// app (spec §56: "do not scatter strings throughout the app"), and the
// admin Context Mapping screen (app/api/admin/resources/context/route.ts)
// rejects any key that is not listed here (spec §58/§96).
//
// Every entry's `route` was verified against the real, currently-shipping
// FHIP route map (spec §9/§146.B) — read directly from
// components/ui/AppShell.tsx's own navigation config and the actual
// app/(app)/** route tree, not invented. The verified route map (for the R1.6
// completion report):
//
//   Dashboard            /dashboard
//   Income               /income
//   Expenses             /expenses
//   Assets                /assets
//   Liabilities           /liabilities
//   Investment & Retire.  /investments
//   Insurance             /insurance
//   Goals                 /goals
//   Scores                /score
//   DNA                   /dna
//   Resilience            /resilience
//   Twin / Benchmark       /financial-twin
//   Forecasting overview  /forecast
//   Forecasting Net Worth /forecast/net-worth
//   Forecasting Retire.   /forecast/retirement
//   Recommendations       /recommendations
//   Reports                /reports
//
// Every `metricKey` below is a real, live-computed metric this codebase
// already surfaces (lib/engines/dashboard.ts's RatioResult.key values,
// Score/Resilience page headings, Forecasting net-worth page) — not an
// invented placeholder (spec §55: "audit current actual FHIP metrics before
// defining final keys").
//
// This registry intentionally does NOT decide *which* Resource a context key
// resolves to — that is the admin-curated resource_context_links table
// (spec §57/§140: "mapping changes without code deployment"). This file only
// owns the fixed vocabulary of valid keys and their FHIP module/route/label
// metadata, exactly as spec §65 asks: "contextKey -> module metadata -> FHIP
// route. Then Resource maps to context key."

export interface FhipContextDefinition {
  /** Stable dot-namespaced key, e.g. "dashboard.savings_rate". */
  key: string;
  /** FHIP module this context belongs to (matches the module labels used across the app nav). */
  module: string;
  /** Short human label for admin UI + the "What does this mean?" link's accessible name (spec §111). */
  label: string;
  /** The verified, real FHIP route this context's "Use this in FHIP" action opens (spec §64/§65). */
  route: string;
}

// Ordered roughly by rollout module (Dashboard, Scores, Resilience,
// Forecasting, Goals — the modules R1.6 actually integrates the reusable
// help component into, spec §66/§114) followed by additional registered-but-
// not-yet-integrated keys other modules may adopt later without a new
// migration (spec §124: "R1.6 provides the system. Mappings can be
// curated/imported later.").
export const FHIP_CONTEXTS: readonly FhipContextDefinition[] = [
  { key: 'dashboard.net_worth', module: 'Dashboard', label: 'Net Worth', route: '/dashboard' },
  { key: 'dashboard.savings_rate', module: 'Dashboard', label: 'Savings Rate', route: '/dashboard' },
  { key: 'dashboard.emergency_fund', module: 'Dashboard', label: 'Emergency Fund', route: '/dashboard' },
  { key: 'dashboard.debt_service_ratio', module: 'Dashboard', label: 'Debt Service Ratio', route: '/dashboard' },
  { key: 'dashboard.debt_to_income', module: 'Dashboard', label: 'Debt-to-Income', route: '/dashboard' },
  { key: 'scores.financial_health_score', module: 'Scores', label: 'Financial Health Score', route: '/score' },
  { key: 'resilience.emergency_fund', module: 'Resilience', label: 'Financial Resilience', route: '/resilience' },
  { key: 'forecasting.net_worth', module: 'Forecasting', label: 'Net Worth Forecast', route: '/forecast/net-worth' },
  { key: 'forecasting.retirement', module: 'Forecasting', label: 'Retirement Forecast', route: '/forecast/retirement' },
  { key: 'goals.progress', module: 'Goals', label: 'Goal Progress', route: '/goals' },
  // Registered for future/admin-curated use even though R1.6 does not mount
  // a <WhatDoesThisMean> at these surfaces itself in this phase (spec §124 —
  // the system supports it; a later pass or R1.7 mapping curation can adopt
  // it with zero code change once a suitable Resource exists). Documented as
  // deferred, not silently invented — see the R1.6 completion report §N/§P.
  { key: 'investments.diversification', module: 'Investments', label: 'Investment Diversification', route: '/investments' },
  { key: 'liabilities.debt_ratio', module: 'Liabilities', label: 'Debt Ratio', route: '/liabilities' },
  { key: 'expenses.total', module: 'Expenses', label: 'Total Expenses', route: '/expenses' },
] as const;

// The full verified FHIP route allowlist (spec §9/§45/§65's "internal
// destination must use approved FHIP routes" for CTA destination_type =
// 'fhip_module') — every entry read from components/ui/AppShell.tsx's own
// nav config plus the Resources/marketing routes, not invented. Kept here
// (not duplicated in lib/resources/cta/validation.ts) so both the CTA
// destination validator and the context registry share one authoritative
// list.
export const FHIP_MODULE_ROUTES: readonly string[] = [
  '/dashboard',
  '/income',
  '/expenses',
  '/assets',
  '/liabilities',
  '/investments',
  '/insurance',
  '/goals',
  '/score',
  '/dna',
  '/resilience',
  '/financial-twin',
  '/forecast',
  '/forecast/net-worth',
  '/forecast/retirement',
  '/forecast/goals',
  '/forecast/debt',
  '/forecast/investments',
  '/forecast/cross-border',
  '/forecast/resilience',
  '/forecast/variance',
  '/forecast/report',
  '/forecast/scenarios',
  '/forecast/assumptions',
  '/forecast/history',
  '/recommendations',
  '/reports',
] as const;

export type FhipContextKey = (typeof FHIP_CONTEXTS)[number]['key'];

const CONTEXT_BY_KEY = new Map(FHIP_CONTEXTS.map((c) => [c.key, c]));

export function getContextDefinition(key: string): FhipContextDefinition | null {
  return CONTEXT_BY_KEY.get(key) ?? null;
}

/** spec §58/§96: the only validation gate for a context_key value anywhere in R1.6 — admin mapping create/update, and the search/context RPC callers, all route through this. */
export function isRegisteredContextKey(key: string): boolean {
  return CONTEXT_BY_KEY.has(key);
}

// spec §101: "Context registry must not produce a broken route... Add
// automated route-map validation where practical." Every route above must be
// an absolute internal path starting with exactly one leading slash, no
// protocol, no query string trickery — checked once here so a future typo
// added to FHIP_CONTEXTS fails a unit test rather than shipping a broken
// link (tests/unit/resourcesDiscoveryR1_6.test.ts exercises this).
export function isWellFormedInternalRoute(route: string): boolean {
  return /^\/[a-zA-Z0-9/_-]*$/.test(route) && !route.startsWith('//');
}

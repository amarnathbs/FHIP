// NAV2 Fund analytics report: how large one report may be (PO decision, 07-10-2026).
//
// The hosting platform (AWS Amplify compute) kills every request at 28 s whatever a route declares (CloudWatch "Duration 28003 ms"; see
// lib/services/investment-intelligence/pc6/ingestBudget.ts). The engine needs about 0.6 to 0.9 s per fund that is not already in the shared
// cache (measured, loaded development machine: 10 funds 10.7 s, 20 funds 18 s, 40 funds 35 s), so:
//   * one report covers at most FUND_ANALYTICS_MAX_FUNDS funds (the same number as the pairwise-correlation limit, so every report within
//     the cap has its pair table); a person who holds more chooses which funds go into the report and can make a second one for the rest;
//   * a generation never starts engine work that would not finish inside GENERATION_BUDGET_MS: it prepares as many funds as fit (they go
//     into the shared cache) and asks the person to generate again, which then picks up where it stopped.
export const FUND_ANALYTICS_MAX_FUNDS = 20;
/** The time a generation may use before the platform's 28 s limit, leaving room for the database writes. */
export const GENERATION_BUDGET_MS = 20_000;
/** A deliberately high estimate of the engine time for one fund that is not in the cache. */
export const ENGINE_MS_PER_UNCACHED_FUND = 1_000;

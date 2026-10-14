// NAV2 Fund analytics report: how large one report may be (PO decision, 07-10-2026).
//
// The hosting platform (AWS Amplify compute) kills every request at 28 s whatever a route declares (CloudWatch "Duration 28003 ms"; see
// lib/services/investment-intelligence/pc6/ingestBudget.ts). The engine needs about 0.6 to 0.9 s per fund that is not already in the shared
// cache (measured, loaded development machine: 10 funds 10.7 s, 20 funds 18 s, 40 funds 35 s), so:
//   * one report covers at most FUND_ANALYTICS_MAX_FUNDS funds (the same number as the pairwise-correlation limit, so every report within
//     the cap has its pair table); a person who holds more chooses which funds go into the report and can make a second one for the rest;
//   * a generation never starts engine work that would not finish inside GENERATION_BUDGET_MS: it prepares as many funds as fit (they go
//     into the shared cache) and asks the person to generate again, which then picks up where it stopped.
//
// ONE CLOCK FOR THE WHOLE REQUEST (release candidate B3). Every figure below is measured from the moment the route handler starts, so it
// includes sign-in, the Premium check, the switch read, the price-history gate, the planner, every database read, the engine, the
// database writes and building the response. The platform ceiling is 28 s; the application's own hard deadline is 22 s, leaving 6 s of
// margin for the platform's own overhead (cold start, network, response streaming) that the application cannot measure.
export const FUND_ANALYTICS_MAX_FUNDS = 20;
/** The application's own hard deadline for one generation request, from route entry. Well under the platform's 28 s. */
export const REQUEST_DEADLINE_MS = 22_000;
/** Reserved for persisting the report (up to about 2 MB of JSON, the dependency rows) and building the response. */
export const PERSIST_AND_RESPONSE_RESERVE_MS = 4_000;
/** Reserved for the small cache write that ends a call which prepares funds but does not issue the report. */
export const CACHE_WRITE_RESERVE_MS = 2_000;
/** The least time the persist step is given: when the engine ends with less than this left, the report is issued by the next call instead. */
export const MIN_PERSIST_MS = 1_500;
/** The time engine work may END by (from route entry): no engine work is started that is estimated to finish after this. */
export const GENERATION_BUDGET_MS = REQUEST_DEADLINE_MS - PERSIST_AND_RESPONSE_RESERVE_MS;
/**
 * A deliberately high estimate of the engine time for one fund that is not in the cache. MEASURED on the development machine after the date helpers
 * were made to remember their answers (a CPU profile showed half the engine time was date parsing): 130 to 160 ms per fund, cold, for 1,600 daily
 * prices (scripts/nav2_rc/engine_timing.ts). Before that change it was 650 to 760 ms, and the previous estimate here was 1,000 ms. The estimate is
 * four times the measured figure, because the production processor is unknown. It only decides how many funds one request STARTS; the hard deadline
 * above is what protects the response. Do not lower it without a production measurement (STOP GATE 2).
 */
export const ENGINE_MS_PER_UNCACHED_FUND = 600;

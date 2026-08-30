# ADR-M11-001: Governed AI Explanation Architecture

## Status
Accepted (Module 11.0 — AI Architecture & Readiness Foundation)

## Context
Module 11 ("AI Coach™ / AI Insights & Plain-English Guidance") introduces the first LLM-backed surface in FHIP. Modules 1-10 already contain a mature, tested calculation stack — `computeDashboard()`, `computeHealthScore()`, `classifyFinancialDna()`, `computeResilience()`, the goal/forecast engines, Financial Twin/benchmarking, and Reports — each with its own persisted, versioned output (`financial_snapshots`, `financial_health_scores`, `financial_dna_profiles`, `resilience_scores`, `goal_forecasts`/`goal_snapshots`, `financial_twin_runs`, `reports`). None of these engines has ever needed an LLM, and none should ever be re-implemented by one: an LLM is non-deterministic, cannot be unit-tested against a financial-identity oracle the way `computeDashboard()` is, and would silently diverge from the numbers already shown on the Dashboard/Score/Twin/Report pages the moment it tried to reconstruct them itself.

At the same time, an AI explanation layer needs *some* connection to real household data to be useful, and FHIP has never previously sent any data to a third-party model provider. There is no existing "what may an external service see" contract anywhere in the codebase (repository discovery for Module 11.0 confirmed no `fx_validation`, `certification_status`, or cross-cutting integrity table exists yet — each module independently carries its own `model_version` + `data_completeness` fields, composable but not yet composed). Without an explicit boundary, the first AI feature risks becoming the first place raw rows are serialised wholesale to an external API, the first place a household's data leaks to another household's session, and the first place a hallucinated number reaches a user framed as a fact FHIP calculated.

## Decision
Module 11.0 establishes the following non-negotiable architecture, binding on every future AI phase (11.1+) unless a future ADR explicitly supersedes a specific point:

1. **Deterministic engines calculate; AI explains.** The Financial Health Score, Financial DNA, Resilience, net worth, income/expenses/surplus, savings rate, DTI/DSR, emergency-fund coverage, investment/retirement/insurance totals and diversification metrics, goal/forecast projections, Financial Twin percentiles, and all report figures remain the exclusive output of their existing engines. No AI code path may compute, re-derive, or approximate any of these values.
2. **AI receives a controlled Financial Context Object**, not database rows. `AIContextService` assembles a purpose-built DTO (`lib/ai/context/financialContextObject.ts`) by calling the *existing* load functions (`loadDashboard`, `loadHealthScore`, `loadFinancialDna`, `loadResilience`, `loadGoalsPage`, `listTwinRuns`/`getTwinRunDetail`, `listReports`) wherever a read-only wrapper already exists, or reading the exact same persisted table one of those wrappers reads from when the wrapper itself requires caller-side setup a read-only context snapshot doesn't need (e.g. `forecast_runs`/`forecast_results`, which `getForecastRunDetail` also reads but only after a `forecast_profile_id` has been resolved) — never by recomputing a value, and never from a table no certified engine already writes to.
3. **User-facing AI cannot access the database directly.** No AI provider, prompt, or generated code has a live database connection, a Supabase client, or a service-role key. Every fact reaching a model arrives pre-shaped inside the Financial Context Object.
4. **Every AI invocation passes through a central AI Model Gateway** (`AIModelGateway`, `lib/ai/gateway/`). Business/future services never import a vendor SDK directly.
5. **Provider implementation is abstracted** behind `AIProvider` (`lib/ai/providers/types.ts`), with `MockAIProvider` (deterministic, no network, no cost) and a minimal `OpenAIProviderAdapter` (unused by anything user-facing in 11.0) proving the abstraction holds without depending on either implementation.
6. **Every personalised request requires an authorised household context.** `resolveHouseholdContext()` re-validates ownership server-side on every call; a caller-supplied household/user ID is never trusted.
7. **Every personalised financial fact requires certified source data.** `AIContextCertificationService` (`lib/ai/certification/`) gates each context domain independently — see ADR consequence below and `docs/architecture/MODULE_11_CERTIFICATION_GATE.md` equivalent (certification report, section H).
8. **AI runs are auditable.** Every gateway invocation — mock or real — writes one `ai_runs` row before returning, capturing prompt/model/context versions, token/cost estimates, safety classification, and outcome, whether it succeeds, fails validation, or times out.
9. **Prompts are versioned product assets** (`ai_prompt_templates`), not inline strings. A prompt is DRAFT → TESTING → APPROVED → ACTIVE → RETIRED; only one ACTIVE version per `(prompt_code, country_scope)` is live at a time.
10. **AI writes to canonical financial records are disabled in Module 11.0.** No AI code path has an insert/update/delete grant on `income_sources`, `assets`, `liabilities`, `investments`, `retirement_accounts`, `insurance_policies`, `user_goals`, or any of their calculated-output tables. `ai_insights`/`ai_recommendations` store *structured facts already computed by the deterministic engines*, never a new fact the AI itself invented.
11. **AI provider secrets remain server-side.** Provider API keys are read only inside `lib/ai/providers/*` server modules via `process.env`, never exposed to a client bundle, never accepted as a request parameter.
12. **AI context uses data minimisation.** The allowlist in `lib/ai/context/allowlist.ts` is the single place that decides what leaves the server; anything not explicitly allowlisted is dropped before the context is ever handed to a provider adapter, regardless of what the underlying `load*()` call returned.
13. **Unsafe/unreliable source states fail closed.** `UNAVAILABLE`/`INVALID` certification, a schema-invalid provider response, a provider timeout, or a failed household-ownership check all produce "no personalised explanation for this domain" — never a fallback invented answer.
14. **Model/provider changes require controlled configuration.** The model registry (`ai_model_registry`) is the only place a task type is bound to a concrete provider/model; nothing hardcodes a model name in business logic.
15. **Future Premium entitlement and quota controls are explicitly deferred to Module 11.1.** Module 11.0 anticipates them in schema shape (e.g. `ai_usage_ledger`'s billing-period grouping) but implements no enforcement, no allowance, no kill switch.

## Alternatives considered
1. **Let AI query Supabase directly with a scoped read-only role.** Rejected: even a read-only role can still be tricked (via prompt injection or a buggy tool-call loop) into requesting another household's row, and every future engine change would silently change what the AI can see with no single review point. The Financial Context Object gives one reviewable seam instead of N ad-hoc queries.
2. **Recompute Score/DNA/Resilience/forecast values inside the AI prompt or a "helper" calculation in the AI layer**, so the AI can freely narrate without waiting on the real engines. Rejected outright per the spec's governing principle (Section 2) and because two independently-maintained implementations of, e.g., DSR would inevitably drift — the Dashboard and the AI Coach would eventually disagree about the same household's own numbers, which is worse than being conservative about what the AI can discuss.
3. **Single all-or-nothing certification flag** ("this household's data is/isn't ready for AI"). Rejected: real households are routinely CERTIFIED on cash flow while INSURANCE data is still incomplete; an all-or-nothing gate would either block cash-flow explanations unnecessarily or let the AI hallucinate insurance conclusions it has no basis for. Domain-level certification (Section 24) lets each future explanation be exactly as confident as its own inputs.
4. **Build provider integration first, governance later** (ship a working OpenAI-backed chat, retrofit audit/certification/safety afterwards). Rejected per the spec's explicit phase boundary (Section 1) and because retrofitting an audit trail onto already-shipped provider calls means the riskiest period (initial rollout) is the one with the weakest evidence trail.
5. **Store the full assembled Financial Context Object as the audit record** (log the actual payload sent to the provider on every run). Rejected as the default: raw context contains real financial values; logging it unconditionally on every run multiplies the blast radius of any future log-store compromise. `ai_runs` instead stores a `context_hash` and structural metadata (domain statuses, token counts) by default, with any raw-payload debug logging left an explicit, access-restricted, retention-configurable opt-in (Section 32), not the standing behaviour.

## Consequences
- Positive: Modules 1-10 require **zero code changes** — every context field is read through an existing, already-tested `load*()` function or an existing persisted table, never a new parallel calculation path.
- Positive: A future AI Coach conversation can never show a Score, DTI, or forecast figure that disagrees with the Dashboard, because both read the exact same persisted row.
- Positive: Cross-user data leakage, prompt injection, and provider outages all have one enforcement point each (`resolveHouseholdContext`, the allowlist + system/data separation contract, `AIModelGateway`'s fail-closed error handling) rather than being re-solved per feature in 11.1+.
- Negative: Every new AI-facing insight in 11.1+ that needs a metric not yet exposed by an existing `load*()` function requires either extending that canonical service (correct, but touches Module 1-10 code under review) or marking the domain PARTIAL/UNAVAILABLE until it is — this is a deliberate friction, not an oversight; it is the mechanism that prevents a second, AI-only calculation path from ever appearing.
- Negative: The certification/allowlist/audit machinery is real engineering overhead before a single user-visible AI feature ships. Accepted because the spec (and the sensitivity of the data involved) treats this as a hard prerequisite, not a nice-to-have.

## Migration implications
Module 11.0 adds only new, additive tables (`ai_model_registry`, `ai_prompt_templates`, `ai_runs`, `ai_usage_ledger`, `ai_answer_cache`, `ai_insights`, `ai_recommendations`, `ai_feedback`, `ai_evaluations`, `ai_safety_events`) — see the completion report for the exact migration file and RLS policies. No Module 1-10 table is altered. `ai_recommendations` is a deliberately distinct concept from the pre-existing Resources-module `action_recommendation_master`/`action_recommendation_conditions` admin system; the two are never joined or merged, and the completion report documents the distinction explicitly to prevent future confusion.

## Testing implications
Module 11.0's acceptance gate (see completion report, Section 50/51 of the spec) must prove — not merely assert — that: a non-owning user cannot fetch another household's AI context, run, cached answer, insight, recommendation, or feedback (RLS + server-side ownership check, both real, both re-run live); a certification failure in one domain does not block an unrelated CERTIFIED domain; a malformed/hallucinated provider response is rejected by schema validation before it can reach a user; and the identical request produces the identical shaped output through `MockAIProvider` today and would through a real provider adapter later, without any business-service code change.

---

## Amendment 1 — decision #16: the AI context path is a strictly read-only, failure-observing consumer

*Added during the Module 11.0 residual-closure round. See the completion report, section Q.*

**Context.** Decision #1-2 committed Module 11.0 to reading every financial
value through an existing certified Module 1-10 service rather than
recomputing it. Certification exercised above a deliberately-failing database
dependency showed two consequences of that decision that the original ADR did
not anticipate:

1. Those services are *load-and-persist* functions, not pure readers. Reusing
   them verbatim meant the AI context build wrote canonical financial rows
   (`financial_snapshots`, and `goal_forecasts`/`goal_snapshots` for a
   household with active goals) as a side effect — contradicting the module's
   own "no AI writes to canonical financial data" invariant.
2. Those services coalesce a failed read to an empty result, so a database
   outage was indistinguishable from an empty household. The certification
   service then honestly reported per-domain `UNAVAILABLE`, the root rollup
   landed on `PARTIAL`, and `AIModelGateway` admitted the request — a
   fail-open on exactly the dependency certification depends on.

**Decision.** Every source read on the AI context path goes through
`lib/ai/context/certifiedSourceClient.ts`, a wrapper that (a) records every
PostgREST read error and (b) intercepts every write verb before it reaches the
database. `buildFinancialContextObject()` gates on the recorded read failures
*before* certifying any domain: any failure returns a wholly `INVALID`
context, which the gateway already rejects. A certification that could not be
performed is never a certification that passed, and reusing a previous
successful certification is explicitly out of scope — Module 11.0 derives
certification per request and deliberately has no stale-certification policy.

**Consequences.** Decision #1-2's "zero Module 1-10 code changes" property is
preserved exactly: the wrapper lives entirely inside `lib/ai/`, and the
loaders' returned financial values are unchanged (each already guards its
follow-up writes on the result of the first). The AI read path is now
structurally incapable of mutating canonical financial data, rather than
merely intended not to. Any future consumer added under `lib/ai/` inherits
both properties automatically by using the same client.

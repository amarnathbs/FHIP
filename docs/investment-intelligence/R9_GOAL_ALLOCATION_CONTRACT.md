# R9 Goal Allocation Contract

## Model

- One investment -> one goal, one investment -> multiple goals, multiple investments -> one goal, and unallocated investments are all supported (spec section 15) — proven in `tests/unit/iiR9ReviewCentreEngine.test.ts` and `scripts/r9_independent_goals_forecasting_oracle.mjs`.
- Allocation basis (spec section 18): the **published `investments.id` row** — the canonical level Forecasting/Dashboard already read, and the only level that avoids duplicating the same economic holding across layers. `ii_goal_allocations` is anchored to the same `investments.id` via its new `linked_investment_id` column (migration `0067`, section 0).
- Integrity (spec section 16): `total active percentage allocation <= 100%` per investment, enforced by the pre-existing `checkFundingAllocation()`/`evaluateAllocation()` (`lib/services/goalFundingAllocation.ts`), now actually called by every R9 write path (`goalAllocations.ts`'s `createOrUpdateGoalAllocation`/`updateGoalAllocation`). Proven in `tests/unit/iiR9GoalAllocationLifecycle.test.ts`.
- Unallocated investments (spec section 17) are never forced into a goal; the Review Centre surfaces them as an `unallocated_investment` OBSERVATION, never an error.
- History (spec section 19): changing an allocation supersedes the old `ii_goal_allocations` row (`status='superseded'`, `effective_to=today`) and inserts a fresh one — never a silent overwrite.
- Lifecycle (spec section 20): removal marks `status='removed'` (never a hard delete) and deactivates (`is_active=false`) only the specific `goal_funding_sources` row it produced.
- Currency (spec section 21): the goal's own `currency_code` is preserved; no new FX engine was introduced. `computeGoalLinkedValues()` reports `currencyCode: null` when a goal's linked investments span more than one currency, rather than silently picking one or fabricating a conversion — a caller needing a single reporting-currency figure must use FHIP's existing canonical conversion (Module 10 / dashboard), never an R9-invented rate.

## Ownership boundary vs. `goal_funding_sources`

`goal_funding_sources` remains the single authoritative table Forecasting reads. `ii_goal_allocations` is the Investment-Intelligence-side audit/provenance mirror (`source: 'user'|'system_suggested'`, effective-dated). R9 keeps them in lockstep on every write; it does not duplicate the cap logic, and it does not let `ii_goal_allocations` become a second source of allocation truth.

## Disclosed gap (pre-existing, not introduced by R9)

`goal_funding_sources.linked_investment_id` (migration `0009`) is a plain FK with no DB-level check that the referenced `investments.id` belongs to the same `user_id` as the funding-source row — this is systemic to every user-owned table in this project (RLS scopes rows, not FK targets; e.g. `investments` itself has the identical `for all using/with check auth.uid()=user_id` pattern, so a user could already directly edit their own `investments.current_value` via raw REST). In practice this specific gap is neutralized by `resolveAllocatedAmount()`'s explicit `.eq('user_id', userId)` filter when resolving a linked investment's value, so a forged cross-tenant reference resolves to $0, not a leak. R9's OWN new write path (`goalAllocations.ts`) closes the equivalent gap for its own surface with an explicit `assertOwnsInvestment()` check (proven in `tests/unit/iiR9GoalAllocationLifecycle.test.ts`'s first case), but does not retrofit Module 7's own `goal_funding_sources` API — that is out of R9's ownership boundary per spec section 148 ("the existing canonical FHIP systems win, R9 must adapt"), and is flagged separately rather than silently patched.

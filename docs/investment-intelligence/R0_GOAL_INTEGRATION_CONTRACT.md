# R0 — Goal Integration Contract

Status: FINAL (R0)
Depends on: `R0_CURRENT_STATE_DISCOVERY.md` (section 6 — `goal_funding_sources`/`checkFundingAllocation()` verified as live, production code), `R0_CANONICAL_DATA_CONTRACT.md`, `R0_NET_WORTH_DEDUP_CONTRACT.md`

## 1. FHIP Goals is canonical — Investment Intelligence integrates, does not replace

`user_goals` remains the single goal record (design principle 10). Investment Intelligence never creates a competing goal entity, goal status, or goal target. `ii_goal_allocations` (`R0_CANONICAL_DATA_CONTRACT.md`) is the Investment-Intelligence-side record of a goal linkage, and it is kept in lockstep with the **existing, live** `goal_funding_sources` mechanism rather than duplicating its allocation-limit logic:

- When a canonical position is published (`R0_FHIP_PUBLISHING_CONTRACT.md`) and the user links it to a goal, publishing writes (or updates) both an `ii_goal_allocations` row **and** a `goal_funding_sources` row (`source_type='investment'`, `linked_investment_id` = the published `investments.id`), so the existing `checkFundingAllocation()`/`evaluateAllocation()` 100%-cap logic (`R0_CURRENT_STATE_DISCOVERY.md` section 6) applies unchanged — Investment Intelligence does not need to reimplement the "can't allocate more than 100% of one balance across goals" rule; it is inherited for free.
- `ii_goal_allocations` exists specifically because `goal_funding_sources.linked_investment_id` points at the **post-publication** `investments.id`, which can in principle be re-pointed (e.g. scenario 3/5 reconciliation in `R0_NET_WORTH_DEDUP_CONTRACT.md`, where a manual row is later linked to an imported position) — `ii_goal_allocations.investment_position_id` anchors to the **pre-publication canonical position** `(account_id, instrument_id)` so the allocation's history survives a republish or a reconciliation-driven relink without needing to be re-entered.

## 2. Allocation types

`ii_goal_allocations.allocation_type` supports the same three types the spec requests, mirroring `goal_funding_sources`' own `allocation_percentage`/`allocated_amount` split:

- **percentage** — mirrors `goal_funding_sources.allocation_percentage`; subject to the existing 100%-cap check.
- **fixed amount** — mirrors `goal_funding_sources.allocated_amount` when `allocation_percentage` is null (the existing `checkFundingAllocation()` code already treats a null percentage as carrying "no double-counting risk" since it isn't drawn as a share of a value that can also be drawn elsewhere — `R0_CURRENT_STATE_DISCOVERY.md` section 6 quotes this exactly).
- **residual/flexible** — a goal-side concept ("whatever's left after other goals' allocations") that does not need a new `investments`-side mechanism; it's expressed as an `ii_goal_allocations` row with `allocation_type='residual'` and no fixed percentage, resolved at read-time by the goal-funding calculation layer (an R1 service-layer detail, not a schema concern).

## 3. Rules, verified against the existing mechanism

1. **Allocations cannot accidentally exceed available position value without a clear warning/allowed design** — enforced today by `evaluateAllocation()`'s `wouldBeTotalPct > 100` rejection with an explicit user-facing error message (`R0_CURRENT_STATE_DISCOVERY.md` section 6 quotes the exact message). Investment Intelligence inherits this unchanged by writing through `goal_funding_sources`.
2. **Multiple goals may share one investment where permitted** — already true today (the entire point of `allocation_percentage`); unchanged.
3. **Historical allocation changes need effective dates** — `ii_goal_allocations.effective_from`/`effective_to` (`R0_CANONICAL_DATA_CONTRACT.md`) provide this; `goal_funding_sources` itself has no effective-dating (it uses `is_active` only), so `ii_goal_allocations` is intentionally the richer historical record on the Investment Intelligence side, while `goal_funding_sources` continues to reflect only the *current* allocation for the existing goal-forecast calculators (`goalForecast.ts`, `goalFundingAllocation.ts`) that already consume it.
4. **Goal deletion must not delete investment data** — `goal_funding_sources.goal_id` already cascades on delete (`references user_goals(id) on delete cascade`, `R0_CURRENT_STATE_DISCOVERY.md` section 6) which only removes the *funding-source linkage row*, never the `investments`/`assets`/`retirement_accounts` row it points at (no cascade exists from `goal_funding_sources` back onto `investments`). `ii_goal_allocations.goal_id` is specified with the same `on delete cascade` semantics — deleting a goal removes the allocation record, never the underlying published position or its `ii_holding_snapshots`/`ii_transactions` history.
5. **Investment deletion/archive must update goal linkage safely** — archiving a published `investments` row (`R0_NET_WORTH_DEDUP_CONTRACT.md` scenario 10) does not delete `goal_funding_sources` rows referencing it (no cascade in that direction either), which means an archived investment can leave a "goal funded by an archived position" state. This is flagged as an **R1 implementation requirement** (not an R0 schema gap): the archive flow must proactively mark dependent `goal_funding_sources`/`ii_goal_allocations` rows `is_active=false`/`status='removed'` rather than leaving a silently-stale link, tracked in `R1_IMPLEMENTATION_SPEC.md`.
6. **Forecasting must consume confirmed mappings** — `goalFundingAllocation.ts`'s `computeAllocatedMonthlyContribution()` already reads `annual_contribution` off the *published* `investments` row (`R0_CURRENT_STATE_DISCOVERY.md` section 6) — since publishing writes into that exact column (`R0_FHIP_PUBLISHING_CONTRACT.md` ANNUAL CONTRIBUTION), this consumption path requires no change once positions are published through the standard mechanism.

## 4. Design test (spec Section 19E)

| Case | Mechanism | Result |
|---|---|---|
| One position → one goal | One `ii_goal_allocations` + one `goal_funding_sources` row | Straightforward; existing cap logic trivially satisfied (≤100%) |
| One position → multiple goals | Multiple `ii_goal_allocations`/`goal_funding_sources` rows, same `linked_investment_id`, percentages summing ≤100% | `checkFundingAllocation()` enforces the cap across all of them |
| Multiple positions → one goal | Multiple `goal_funding_sources` rows, same `goal_id`, different `linked_investment_id` | Already supported — `goal_funding_sources` is goal-to-many-sources by design |
| Goal allocation change | New `ii_goal_allocations` row with `effective_from` = change date, prior row's `effective_to` set; `goal_funding_sources.allocation_percentage` updated in place (existing table has no history — this is the intentional Investment-Intelligence-side enrichment noted in rule 3) | Historical allocation is reconstructible from `ii_goal_allocations`; current-state consumers unaffected |
| Goal unlink | `ii_goal_allocations.status='removed'`; corresponding `goal_funding_sources.is_active=false` | Position remains published and counted in net worth; only the goal linkage is removed |

All five cases resolve without any change to `goalFundingAllocation.ts`, `goalForecast.ts`, or the `goal_funding_sources` schema.

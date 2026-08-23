# ADR-004: FHIP Publication and Net-Worth Deduplication

## Status
Accepted (R0) — the single most critical decision in R0, per spec Section 9/21.

## Context
`computeDashboard()` sums `investments`/`assets`/`retirement_accounts` directly with no existing "exclude this row" concept, and a confirmed, live overlap already exists between the `asset` and `investment` master-item catalogues (e.g. `gold`, `shares`, `etfs`, `managed_funds` are valid `master_item_key`s in both — `R0_CURRENT_STATE_DISCOVERY.md` sections 8, 11). Investment Intelligence must guarantee a single canonical position contributes to household net worth exactly once, across at least the 12 scenarios enumerated in the spec.

## Decision
Adopt exactly two of the spec's seven candidate concepts — `publication_target` and `include_in_net_worth` — both as columns on a new `ii_fhip_publications` entity, and reject the remaining five (`canonical_position_id`, `publication_id`, `economic_asset_id`, `source_system`, `canonical_owner_module`) as redundant with entities/mechanisms already present elsewhere in the design. Deduplication is enforced by: (1) never inserting a second register row for an already-published position — publishing updates the existing `investments.id`/`assets.id`/`retirement_accounts.id` row; (2) routing every position to exactly one `publication_target` decided once at publish time from instrument classification; (3) a `unique(canonical_position_id)` constraint on `ii_fhip_publications`. Full rationale and rejection reasoning: `R0_NET_WORTH_DEDUP_CONTRACT.md` section 1. Full scenario resolution: same document, section 2.

## Alternatives considered
1. **Tag every register row with `source_system`/`canonical_owner_module` and filter in `computeDashboard()`** — rejected: requires modifying the one pure, well-tested function every other consumer (Reports, Forecasting) already depends on (`R0_CURRENT_STATE_DISCOVERY.md` section 8), for no benefit over excluding at publish time instead.
2. **A single new `economic_asset_id` shared across all three registers, enforced by a global uniqueness constraint spanning three tables** — rejected: cross-table uniqueness constraints are awkward in Postgres (require a shared surrogate table or triggers) for no benefit over simply never creating the duplicate row in the first place; also duplicates the identity already established by `(account_id, instrument_id)`.
3. **Let both a manual and an imported row coexist, with a UI-level "hide duplicate" toggle** — rejected: silently wrong net worth is not an acceptable interim state per design principle 4 ("must never be counted twice... merely because it can appear conceptually under Assets, Investments, Retirement...") — explicitly what this ADR exists to prevent, not defer to a UI patch.

## Consequences
- Positive: `computeDashboard()`, `reportSections.ts`, and every forecast calculator require zero changes (ADR-001's consequence, reinforced here).
- Positive: the dedup guarantee is enforced at the database level (`unique(canonical_position_id)`), not merely by application-layer discipline.
- Negative: requires a reconciliation/linking UX flow (matching a newly-imported position against a pre-existing manual row) that is real product work, not yet built — flagged as an R1+ requirement, not resolved by schema alone.

## Migration implications
`ii_fhip_publications` is new and additive. No existing register table requires a schema change for this ADR's mechanism to work — the `unique(canonical_position_id)` constraint lives entirely within the new table.

## Testing implications
R1's acceptance gate must re-run the 12-scenario matrix from `R0_NET_WORTH_DEDUP_CONTRACT.md` as an actual integration test once the schema exists (R0 only runs it as a design/paper test — `R0_TESTING_AND_VERIFICATION.md` section C), and must prove `computeDashboard()`'s output is unchanged (same 124-test baseline, `R0_TESTING_AND_VERIFICATION.md` section A) for every household with no Investment Intelligence data.

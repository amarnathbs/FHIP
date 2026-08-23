# R9 Security Model

## RLS

Both new tables (`ii_review_items`, `ii_review_rule_registry`) have RLS enabled (migration `0067`). `ii_review_items` uses the project's standard owned-row policy (`for all using/with check auth.uid()=user_id`). `ii_review_rule_registry` uses the standard trusted-reference-data policy (`for select using (true)`, no write policy — matches `forecast_global_assumptions`). `ii_goal_allocations`'s existing R1 policy is unchanged.

## Bounded write surfaces (spec section 69)

No R9 API route exposes a generic table PATCH. Every write goes through a narrow, purpose-specific function:

| Route | Underlying function | User-controllable fields |
|---|---|---|
| `POST .../goal-allocations`, `POST .../goals/:id/allocations` | `createOrUpdateGoalAllocation` | `goalId`, `investmentPositionId`, `allocationType`, `allocationValue`, `linkedInvestmentId` — never `status`, `source`, `id` |
| `PUT .../goal-allocations/:id` | `updateGoalAllocation` | `allocationType`, `allocationValue`, `linkedInvestmentId` only (`iiGoalAllocationUpdateSchema`) |
| `DELETE .../goal-allocations/:id` | `removeGoalAllocation` | none — the id in the URL only |
| `POST .../review/:id/acknowledge`, `/dismiss` | `acknowledgeReviewItem`/`dismissReviewItem` | `note` only (`iiReviewActionSchema`) — `severity`, `evidence`, `status` (beyond the one deterministic transition), `source_module` are never accepted |
| `POST .../review/refresh`, `.../forecast/refresh` | `runReviewCentreRefresh` | none — scoped to the caller's own `user_id` |

## Same-user valid-FK forgery (spec sections 67-68, 115)

Tested in `tests/unit/iiR9GoalAllocationLifecycle.test.ts`: a user supplying their own real `goalId` but a real investment **belonging to a different tenant** (`linkedInvestmentId`, valid FK, wrong owner) is rejected by `assertOwnsInvestment()` before any write — no `ii_goal_allocations` or `goal_funding_sources` row is created. Also proven at the RLS layer in `scripts/ii_r9_certification.mjs`: a tenant cannot INSERT a `ii_review_items` row claiming another tenant's `user_id`, and cannot UPDATE another tenant's row to forge `severity`/`status`.

## Disclosed limitation (systemic, not R9-specific)

RLS's `with check (auth.uid()=user_id)` permits the row **owner** to write arbitrary column values to their own row via **direct PostgREST** access (bypassing the Next.js API's field-restricted schemas) — e.g. a user could, via a raw REST call, set their own `ii_review_items.severity` to a self-chosen value. This is identical to the pre-existing pattern on every other user-owned FHIP table (`investments`, `ii_fhip_publications`, `ii_goal_allocations` itself, etc. — confirmed via `0003_module2.sql`'s `"own rows - investments"` policy, byte-for-byte the same shape). It is not a new hole R9 introduced; the project's accepted threat model treats the application API surface, not column-level ACLs under RLS, as the trust boundary for a user's own data. Flagged here for completeness per spec section 68's exact wording, not silently omitted.

## Global/reference data (spec section 120)

`ii_review_rule_registry` has no write policy for `authenticated` — only the service-role key (used exclusively by `reviewCentreData.ts`'s server-side reads, never for writes from a request context) can modify thresholds. No API route accepts a rule/threshold value from the client.

## Trusted processing (spec section 121)

`runReviewCentreRefresh()` uses `createAdminClient()` (service-role) for its cross-table reads and the `ii_review_items` upsert, exactly like every prior II release's server-side orchestration (`investmentPublicationService.ts`, `analyticsOrchestrator.ts`) — proven functional end-to-end by `scripts/ii_r9_certification.mjs` and the full existing II regression suite passing unchanged.

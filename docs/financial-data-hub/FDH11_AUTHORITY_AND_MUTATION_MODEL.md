# FDH-11 — Authority & Mutation Model (spec section 84)

| Entity | Classification | Mechanism |
|---|---|---|
| AU investment statement (`fdh_investment_statements`) — descriptive fields (institution, dates, statement type) | User-readable, System-derived | RLS owner-only; written by the service-role processing pipeline at upload/extraction time |
| AU investment statement — `approval_status`/`approved_at`/`approved_by` | System-derived, RPC/service-only | `approveAuStatement()` (bridge), gated by the authoritative-write trigger (`auth.role() <> 'authenticated'` blocks direct writes) |
| AU investment statement — `canonical_account_id` | System-derived, RPC/service-only | `resolveAndPersistAuStatementAccount()`/`confirmNewAuStatementAccount()` (bridge) only |
| AU statement positions (`fdh_investment_statement_positions`) — raw extracted fields | System-derived | Written once at extraction; not user-editable (no correction UI built this pass — a disclosed residual, matching spec 61's "user should be able to see" framing rather than "user should be able to edit statement evidence") |
| AU statement positions — `security_match_status`/`matched_instrument_id`/`apply_status`/`canonical_holding_snapshot_id`/`applied_at`/`applied_by` | System-derived, RPC/service-only | `resolveAndPersistAuSecurityMatch()`, `applyAuStatementPosition()` (bridge) only |
| AU statement activities (`fdh_investment_statement_activities`) — raw extracted fields | System-derived | Same as positions |
| AU statement activities — `security_match_status`/`matched_instrument_id`/`linked_transaction_id`/`bank_match_status`/`bank_match_candidates`/`apply_status`/`canonical_transaction_id`/`applied_at`/`applied_by`/`apply_rejected_reason` | System-derived, RPC/service-only | `resolveAndPersistAuSecurityMatch()`, `matchAuStatementActivitiesToBank()`, `applyAuStatementActivity()` (bridge/Hub-service) only |
| Bank match (`linked_transaction_id` → `fdh_transactions`) | System-derived | Same-tenant ownership enforced by `fdh11_assert_investment_activity_owner()` trigger — a forged cross-tenant `linked_transaction_id` is rejected outright |
| Canonical II transaction (`ii_transactions`) | II-owned, RPC/service-only (via bridge) | Only `applyAuStatementActivity()` writes here from FDH-11's side; `ii_transactions` RLS (`for all using (auth.uid() = user_id)`) additionally scopes every row to its owner |
| Canonical II holding snapshot (`ii_holding_snapshots`) | II-owned, service-only | Only `applyAuStatementPosition()` writes here; the table has **no authenticated INSERT/UPDATE/DELETE policy at all** (SELECT-only for the owner) — confirmed by direct migration inspection, a stronger guarantee than FDH-11 itself imposes |
| `ii_instrument_identifiers` (`asx_ticker` rows) | Global, admin/service-only | World-readable, no authenticated write policy (unchanged by FDH-11 — the widening only touched the CHECK constraint and the partial unique index, not the RLS policy) |
| India module reference (`/investment-intelligence`) | User-readable, India-owned | FDH-11 never writes to any India-specific table or code path; the Investments-tab "India Investments" button is a plain `<Link>`, not an API call |

## Same-tenant authority (spec section 85) — proven, not assumed

`scripts/fdh11_certification.mjs` checks 3 (six sub-checks) reproduce, against real Postgres (PGlite): an `authenticated` user attempting to directly `UPDATE` `approval_status`, `apply_status`, `canonical_holding_snapshot_id`, `canonical_transaction_id`, `security_match_status`, or `matched_instrument_id` on their **own** row is rejected with `"this field is system-authoritative and may not be written directly by the authenticated role"`; the same write via the service-role bridge succeeds. A harness self-check (removing the guard trigger in an isolated throwaway copy of the schema) confirms the forgery *would* succeed without the trigger — proving the check is not vacuous.

## Cross-tenant security (spec sections 86-88)

Enforced at two layers: ordinary RLS (`auth.uid() = user_id`) blocks Tenant B from reading/writing Tenant A's rows at all, and same-tenant **ownership-guard** triggers (`fdh11_assert_investment_statement_owner`, `fdh11_assert_investment_position_owner`, `fdh11_assert_investment_activity_owner`) block a service-role write that would otherwise bypass RLS from cross-linking to another tenant's `fdh_statement_uploads`, `fdh_investment_statements`, or `fdh_transactions` row — both reproduced live in `scripts/fdh11_certification.mjs` checks 4.

## Global security integrity (spec section 89)

A user cannot mutate the global canonical security master through statement import: `ii_instruments`/`ii_instrument_identifiers` carry no authenticated write policy at all (world-readable, admin/service-role write only, unchanged by FDH-11); the only creation path from a statement is `createProvisionalAuSecurity()` (bridge), which reuses II's own existing `resolveOrCreateInstrument()` governance function — the same one R2/R12 use for every other jurisdiction — rather than a bespoke FDH-11 write.

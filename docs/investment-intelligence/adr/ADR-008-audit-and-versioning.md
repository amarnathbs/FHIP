# ADR-008: Audit and Versioning

## Status
Accepted (R0)

## Context
Financial calculations should remain deterministic, versioned and reproducible (design principle 13), and a wide set of lifecycle events must be auditable (spec Section 15). Discovery found FHIP already has two audit-shaped tables (`audit_events`, `financial_records_audit`) scaffolded since the earliest migrations, but confirmed **neither is referenced by any application code today** — genuinely dead scaffolding, not a working audit trail to extend (`R0_CURRENT_STATE_DISCOVERY.md` section 2).

## Decision
Specify a new, Investment-Intelligence-owned `ii_audit_events` table rather than retrofitting the existing dead tables, with a frozen vocabulary of 19 required event types (`R0_AUDIT_REQUIREMENTS.md`). Structural properties (append-only, owner-read-only RLS, nullable `user_id` for system events, `actor_type` tracking) are carried forward from the *one* proven pattern the existing dead table does still demonstrate (its asymmetric `for select`-only RLS policy), without assuming the rest of its shape is fit for purpose.

## Alternatives considered
1. **Extend `audit_events` with Investment-Intelligence-specific columns** — rejected: would make Investment Intelligence the first real consumer of an unproven table, with no evidence its generic `entity text`/`entity_id uuid`/`metadata jsonb` shape can cleanly express the specific, richer event vocabulary this domain requires (e.g. `parser_version`, `reconciliation_case_id`) without everything living in loosely-typed `metadata`.
2. **Extend `financial_records_audit`** — rejected for the same reason, plus it is explicitly scoped to the seven-register financial-capture model (`entity` implicitly meaning income/expense/asset/liability/etc.), not a natural fit for Investment-Intelligence-specific subjects like source documents or reconciliation cases.
3. **No dedicated audit table — rely on Postgres's own write-ahead log / Supabase's point-in-time recovery for forensic history** — rejected: does not satisfy the requirement for an application-queryable, user-visible-where-appropriate audit trail (e.g. "when was this position last reconciled"), which needs to be a first-class queryable table, not an infrastructure-level log.

## Consequences
- Positive: `ii_audit_events`' shape can be driven entirely by Investment Intelligence's own real requirements rather than compromising with a generic table designed for a different purpose.
- Positive: does not risk waking up dormant, never-tested code paths that reference the old tables (there are none — so no regression risk either way, but building fresh avoids any hidden assumption about their fitness).
- Negative: leaves the two existing dead audit tables un-consolidated — an explicit, out-of-scope observation (not an R0/R1 deliverable to clean up unrelated dead scaffolding), noted as a candidate for a separate, unrelated cleanup task.

## Migration implications
`ii_audit_events` is new and additive. `audit_events`/`financial_records_audit` are untouched by this decision (no migration removes or alters them — that would be out of scope for an Investment-Intelligence-focused release).

## Testing implications
R1 must test that every event-type trigger point listed in `R0_AUDIT_REQUIREMENTS.md` section 2 actually emits an `ii_audit_events` row in the relevant code path (an integration-test checklist, not just a schema check) and that no `update`/`delete` operation is possible against the table via RLS.

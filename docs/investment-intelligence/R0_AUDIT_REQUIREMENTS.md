# R0 — Audit Requirements

Status: FINAL (R0) — freezes requirements only. **R1 implements the audit layer** (spec Section 15); no audit code is written in R0.
Depends on: `R0_CANONICAL_DATA_CONTRACT.md` (`ii_audit_events`), `R0_CURRENT_STATE_DISCOVERY.md` (section 2 — confirms `audit_events`/`financial_records_audit` exist but are unused today)

## 1. Why not simply reuse the existing `audit_events`/`financial_records_audit` tables

Both tables are scaffolded in the schema (migrations `0001`, `0003`) but confirmed **unused by any current application code** — no `.ts` file anywhere in the repository references either table (`R0_CURRENT_STATE_DISCOVERY.md` section 2). Reusing a table that has never been exercised in production would mean Investment Intelligence becomes the first real consumer of untested scaffolding, with no confidence its shape (a generic `event_type text`, `entity text`, `entity_id uuid`, `metadata jsonb`) matches the specific, enumerated event types the spec requires (see section 2 below). `ii_audit_events` is specified as its own table (`R0_CANONICAL_DATA_CONTRACT.md`) — structurally similar (append-only, owner-read-only RLS, `jsonb` metadata) but Investment-Intelligence-owned, so its shape can be driven by this document's requirements without needing to first retrofit or reinterpret dead scaffolding. This is documented here as a deliberate ADR-level decision — see `ADR-008`.

## 2. Required audit event types (frozen, per spec Section 15)

| Event type | Trigger | Minimum metadata |
|---|---|---|
| `upload` | A source document is uploaded | `source_document_id`, `source_id`, `original_filename`, `file_size` |
| `parse` | A parser run starts | `source_document_id`, `parser_version` |
| `parser_version` | Recorded as a field on the `parse`/`parse_completed` events, not a separate event type — captures which parser build produced a given interpretation, for reproducibility | n/a (field, not event) |
| `parse_completed` | A parser run finishes (success or failure) | `source_document_id`, `parser_version`, `status`, `transactions_created`, `error` (if failed) |
| `reconciliation_opened` | A discrepancy is detected | `reconciliation_case_id`, `subject_type`, `subject_id`, `discrepancy_type` |
| `reconciliation_resolved` | A case is resolved | `reconciliation_case_id`, `resolution`, `actor_type` |
| `user_correction` | A user edits a published or canonical value | `subject_type`, `subject_id`, `field`, `previous_value`, `new_value` |
| `admin_correction` | An admin edits a canonical/reference value | `subject_type`, `subject_id`, `field`, `previous_value`, `new_value`, `admin_user_id` |
| `publication` | A canonical position is first published | `publication_id`, `canonical_position_id`, `publication_target`, `published_row_id` |
| `republishing` | An existing publication is refreshed | `publication_id`, `previous_snapshot_id`, `new_snapshot_id` |
| `nav_price_update` | `ii_prices_nav` gains a new series point | `instrument_id`, `price_date`, `source_id` |
| `calculation` | Any `ii_analytics_results` row is produced | `subject_type`, `subject_id`, `metric_key`, `calculation_version` |
| `rule_change` | An `ii_tax_rule_versions` or insight-rule version changes | `rule_set_key` or `rule_code`, `previous_version`, `new_version` |
| `goal_allocation` | An `ii_goal_allocations` row is created/changed/removed | `allocation_id`, `goal_id`, `investment_position_id`, `allocation_type`, `allocation_value` |
| `export` | Any Investment-Intelligence data is exported (report, download) | `export_type`, `subject_ids` |
| `permission_grant` | Access is granted (e.g. future professional/adviser access) | `grantee_type`, `grantee_id`, `scope` |
| `permission_revoke` | Access is revoked | `grantee_type`, `grantee_id`, `scope` |
| `professional_access` | A professional/adviser (future) reads or acts on data | `professional_id`, `action`, `subject_type`, `subject_id` |
| `archive` | A position/account/document is archived | `subject_type`, `subject_id` |
| `deletion` | Hard deletion occurs (rare — most lifecycle is archive, per design principle 6) | `subject_type`, `subject_id`, `reason` |

## 3. Structural requirements (frozen)

- **Append-only**: `ii_audit_events` supports `insert` and owner-scoped `select` only — no `update`/`delete` policy exists, mirroring the one asymmetric RLS policy already present in the codebase today (`audit_events`' existing `for select using (...)`-only policy, `R0_CURRENT_STATE_DISCOVERY.md` section 10). This is the one existing pattern genuinely worth carrying forward unchanged, even though the table itself is new.
- **Actor tracking**: every event records `actor_type` (`user|admin|system|professional`) and, where applicable, `actor_id` — so a system-initiated NAV refresh is distinguishable from a user action or an admin correction at a glance, not just by inference from event type.
- **Nullable `user_id`**: system-initiated events (e.g. a scheduled reference-data refresh touching no specific user) have no owning user — `ii_audit_events.user_id` is nullable, unlike every user-owned entity table which requires it.
- **Never the sole mechanism for functional correctness**: audit events record *that* something happened, for compliance/debugging visibility — they must never be relied upon as the only place a state transition is recorded (e.g. `ii_fhip_publications.status` itself must reflect current state; the audit event is a historical trail alongside it, not a substitute for it).

## 4. R1 scope note

R0 freezes the table shape and event-type vocabulary above. R1 is responsible for actually wiring every listed trigger point into a real `ii_audit_events` insert — tracked as an explicit R1 deliverable in `R1_IMPLEMENTATION_SPEC.md`, not implied to already exist.

# ADR-003: Source of Truth and Provenance

## Status
Accepted (R0)

## Context
Imported investment records must maintain source provenance, and user corrections must never destroy or silently overwrite original source evidence (design principles 5, 6). The existing FHIP registers have no provenance concept at all today — every `investments`/`assets`/`retirement_accounts` row is simply "what the user typed," with no distinction between a first-entry and a correction (`R0_CURRENT_STATE_DISCOVERY.md` section 4).

## Decision
Adopt the five-layer provenance chain: original source evidence → parsed canonical interpretation → reconciliation adjustment/correction → certified canonical record → FHIP publication (`R0_SOURCE_PROVENANCE_CONTRACT.md`). Source documents (`ii_source_documents`) are immutable once uploaded — a revised statement is a new row (`superseded_by_document_id`), never an edit. Corrections (user or admin) are new layered records, never in-place mutations of the parsed interpretation or the original evidence.

## Alternatives considered
1. **Mutate the parsed record in place on correction** — rejected: directly violates design principle 6 and makes it impossible to answer "what did the original statement actually say" after a correction, which is exactly the scenario reconciliation exists to handle safely.
2. **Store only the certified canonical record, discard the original document after parsing** — rejected: removes the ability to re-parse with an improved parser version later, and removes the audit trail's evidentiary value entirely.
3. **A single "source" text column on each entity (e.g. `source = 'cams'`) with no document-level tracking** — rejected: cannot support de-duplicating a re-uploaded identical file, cannot support the `superseded_by_document_id` refresh chain, and gives no path to the signed-URL storage model already proven by `report-exports` (`R0_CURRENT_STATE_DISCOVERY.md` section 9).

## Consequences
- Positive: every published value can be traced back to the exact document and parser version that produced it, satisfying the audit requirements in `R0_AUDIT_REQUIREMENTS.md`.
- Positive: a bad parse can be corrected by re-parsing against the still-intact original document, without needing the user to re-upload.
- Negative: storage grows monotonically (documents are never deleted on correction) — an explicit, accepted tradeoff given design principle 6's priority over storage efficiency; retention/archival policy is deferred to a later release, not an R0/R1 concern.

## Migration implications
None — all provenance entities (`ii_source_documents`, `ii_transactions`, `ii_reconciliation_cases`) are new; no existing table requires a provenance column added retroactively (manually-entered `investments`/`assets`/`retirement_accounts` rows simply have no `ii_fhip_publications` row referencing them, which is itself sufficient signal that they carry no Investment Intelligence provenance).

## Testing implications
R1 must include a test proving a corrected/reconciled value never overwrites the stored original document's checksum/content, and that re-parsing an unchanged document is idempotent (does not create duplicate transactions).

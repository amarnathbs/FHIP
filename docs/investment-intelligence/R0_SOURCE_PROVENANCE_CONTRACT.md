# R0 — Source / Provenance Contract

Status: FINAL (R0)
Depends on: `R0_CANONICAL_DATA_CONTRACT.md` (`ii_sources`, `ii_source_documents`), `R0_CURRENT_STATE_DISCOVERY.md` (section 9 — `report-exports` storage precedent)

## 1. Source categories

`ii_sources` (a world-readable, admin-curated reference table — same pattern as the existing `master_financial_items`/`goal_types`, `R0_CURRENT_STATE_DISCOVERY.md` section 2.1) enumerates:

| `source_key` | `source_category` | Notes |
|---|---|---|
| `cams` | `statement_provider` | India — CAMS consolidated account statement |
| `kfintech` | `statement_provider` | India — KFintech (KFin Technologies) statement |
| `mfcentral` | `statement_provider` | India — MFCentral-compatible source |
| `nsdl` | `statement_provider` | India — NSDL demat statement |
| `cdsl` | `statement_provider` | India — CDSL demat statement |
| `broker` | `broker` | Generic broker contract-note/statement source |
| `manual` | `manual` | User-entered directly, no document |
| `admin_correction` | `admin` | Admin-applied correction, always distinct from a user correction |
| `api_connector` | `api_connector` | Future consent-based API/aggregator connector (not built in R0/R1) |

India-specific rows (`cams`, `kfintech`, `mfcentral`, `nsdl`, `cdsl`) are contributed by the India adapter as data, not schema (`R0_DOMAIN_ARCHITECTURE.md`) — adding an Australian source later (e.g. a future `computershare`/broker-specific row) is a new `ii_sources` row, not a migration.

## 2. The layering principle

```
Original source evidence            (ii_source_documents — the uploaded file itself, immutable, never edited)
        |
        v
Parsed canonical interpretation      (ii_transactions / ii_holding_snapshots derived from the document,
                                       tagged with parser_version — corrigible by re-parsing, not by
                                       hand-editing the parsed row)
        |
        v
Reconciliation adjustment/correction (ii_reconciliation_cases — opened when parsed data conflicts with
                                       prior certified data or a user's manual entry; resolved by a
                                       human decision, recorded, never silent)
        |
        v
Certified canonical record           (the ii_holding_snapshots/ii_transactions rows once quality_status
                                       reaches 'certified' — the record other Investment Intelligence
                                       features and publishing are allowed to treat as trustworthy)
        |
        v
FHIP publication                     (ii_fhip_publications -> assets/investments/retirement_accounts,
                                       per R0_FHIP_PUBLISHING_CONTRACT.md)
```

**The original source document is never mutated to make reconciliation appear successful.** Concretely: `ii_source_documents` rows are never UPDATEd to change their content or checksum; a corrected understanding of a statement is expressed as new `ii_transactions`/`ii_holding_snapshots` rows (or a new `ii_reconciliation_cases` resolution), never as an edit to the stored file or its extracted-text representation. A re-upload of a genuinely revised statement creates a **new** `ii_source_documents` row linked via `superseded_by_document_id`, preserving the original in full (`R0_CANONICAL_DATA_CONTRACT.md`).

## 3. User vs. admin corrections stay distinguishable

A user correction (editing a published `investments` row directly, per `R0_FHIP_PUBLISHING_CONTRACT.md` section 3 / `R0_NET_WORTH_DEDUP_CONTRACT.md` scenario 12) and an admin correction (an operator fixing a parser misread) are recorded through different `actor_type` values on the `ii_audit_events` row that necessarily accompanies either action (`R0_AUDIT_REQUIREMENTS.md`), and neither ever silently overwrites the layer below it: a user correction sits **above** the certified canonical record (it corrects what's *shown*, not what was *parsed*); an admin correction, if it must revise the parsed interpretation itself, does so by creating a new interpretation layer referencing the original document, never by editing the original document or silently replacing history.

## 4. Storage handling

Source documents (the actual uploaded files) are stored in a private Supabase Storage bucket, written only by the service-role client and read back only via short-lived signed URLs — directly reusing the existing, proven `report-exports` bucket pattern (`R0_CURRENT_STATE_DISCOVERY.md` section 9: `app/api/report-exports/[exportId]/download/route.ts`'s `admin.storage.from('report-exports').createSignedUrl(...)`). A new bucket (e.g. `investment-source-documents`) following the identical access pattern is the R1 implementation of this — not a new access model to design from scratch.

## 5. What R0 does not specify

Actual CAMS/KFintech/NSDL/CDSL parsing logic, parser implementation, or parser-version semantics beyond the `parser_version` column existing on the interpretation layer — explicitly out of scope (no CAS parser built in R0/R1, per the task's non-goals).

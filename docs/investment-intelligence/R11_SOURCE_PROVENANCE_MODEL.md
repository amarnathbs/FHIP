# R11 Source Provenance Model (User & Professional View)

Spec sections 72-76. This is the USER-FACING provenance model built on top of the R2 provenance data model (`ii_source_documents`, `ii_transaction_source_links`) and R11's new `ii_reconciliation_cases` extensions — no new database concepts, only a defined read/presentation contract.

## What a user (or, where scoped, a professional) can see for a canonical holding

For a canonical position `(account_id, instrument_id)`:

1. **Contributing sources** — every distinct `ii_sources.source_key` with a linked `ii_transaction_source_links` row across that position's transactions (traceable via `ii_transaction_source_links.transaction_id → ii_transactions.account_id/instrument_id`).
2. **Last import date** — `max(ii_source_documents.uploaded_at)` across those linked documents.
3. **Source status** — `ii_source_documents.status` (`uploaded`/`parsing`/`parsed`/`parse_failed`/`superseded`/`archived` — R1 vocabulary, unchanged).
4. **Reconciliation status** — the position's `ii_portfolio_truth_status.status` (R2, unchanged) PLUS any open `ii_reconciliation_cases` with `discrepancy_type` in the R11 `cross_source_*` family.
5. **Conflicts** — any `ii_reconciliation_cases` row with `discrepancy_type IN ('cross_source_conflict', 'cross_source_review_required', 'cross_source_holding_conflict')` and `status='open'`, surfaced as "Two sources disagree about this holding" with the `matchedFields`/`differingFields` detail from `discrepancy_details` — without exposing raw parser internals (field names are the same domain vocabulary already used elsewhere in II, e.g. "amount", "units", "reference", not internal variable/column names).

## Deterministic language, never unsupported certainty claims

Per spec section 76, the provenance surface must say **"Preferred source under current reconciliation rules"** (a fact about the frozen policy — see `R11_SOURCE_PRECEDENCE_POLICY.md`) and must never say **"This source is definitely correct"** (an unsupported certainty claim R11 cannot make — deterministic identity resolution proves two records describe the same transaction, not that either record is factually accurate). This wording constraint is documented here as the copy contract for any future UI built on this model; R11 ships the data model and API surface (`app/api/professional-access/proxy/investments-summary/route.ts` is the one representative read endpoint built in this release — see `R11_PROFESSIONAL_ACCESS_MODEL.md`), not a dedicated end-user provenance screen (out of the bounded scope frozen in P0; a UI-only follow-up, not a data-model gap).

## Professional visibility (where scoped)

A professional with `VIEW_SOURCE_PROVENANCE` (see `R11_PERMISSION_MATRIX.md`) may see the SAME structured provenance summary described above — never the raw source document. `VIEW_RAW_DOCUMENTS` does not exist as a grantable scope in R11 at all (`isRawDocumentScopeSupported()` returns `false` unconditionally, `permissions.ts`); this is enforced twice: once by the scope simply not being a member of `PROFESSIONAL_SCOPES`, and independently by every professional-facing read path using the service-role client only after a live `checkAccessLive()` scope check, never reaching `ii_source_documents`/storage at all (verified in `scripts/r11_rls_certification.mjs` Section 9's analogue for document access — see `R11_SECURITY_MODEL.md`).

## Provenance is never lost

Every corroborating source remains linked via `ii_transaction_source_links` regardless of precedence outcome (see `R11_SOURCE_PRECEDENCE_POLICY.md` — "precedence never erases evidence"). A conflicting/ambiguous candidate is inserted as its own row (`status='review_required'`) rather than discarded, so the provenance view can show BOTH sides of a disagreement, not just the winner.

// Investment Intelligence FS1 — shared, provider-agnostic sentinel for the
// "opening balance existed before this statement's visible window" evidence
// marker (dispatch section 17). A single, named constant so a provider
// adapter (currently only camsFolioStatementParser.ts) and the DB-touching
// orchestrator (documentProcessing.ts) can never drift onto two different
// magic strings for the same concept.
//
// This is stored as `ii_transactions.source_reference` on a row whose
// `transaction_type = 'adjustment'` — deliberately NOT a new transaction
// type/column/migration (dispatch section 6's gate): 'adjustment' already
// exists, is already excluded from R6's tax-lot acquisition mapping
// (taxRepository.ts's ACQUISITION_TYPE_MAP), and `source_reference` is
// already a plain, unconstrained `text` column. See
// camsFolioStatementParser.ts's OPENING_BALANCE_SOURCE_REFERENCE re-export
// and reconciliation.ts's `reconcilePosition` for how this value's presence
// changes reconciliation behaviour (never a fabricated purchase/tax lot).
export const OPENING_BALANCE_SOURCE_REFERENCE = 'OPENING_BALANCE' as const;

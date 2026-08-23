# R2 — Architecture Exception

Status: FINAL

**NONE.**

R2 was implemented entirely within the frozen R0/R1 architecture (`R0_CANONICAL_DATA_CONTRACT.md`, `R0_CANONICAL_IDENTIFIER_STRATEGY.md`, `R0_SOURCE_PROVENANCE_CONTRACT.md`, `R0_NET_WORTH_DEDUP_CONTRACT.md`, `R0_SECURITY_RLS_ARCHITECTURE.md`, `R0_AUDIT_REQUIREMENTS.md`) without requiring any contradiction to be resolved. Every new table, column, and constraint added by migrations `0039`-`0041` is an **additive extension** of the R1 schema (new tables, new nullable columns, check-constraint supersets), not a redesign of anything R0/R1 froze:

- The 20 canonical `ii_*` entities from R1 are unchanged in shape — R2 adds 5 new tables (`ii_document_parse_runs`, `ii_transaction_source_links`, `ii_scheme_alias_map`, `ii_portfolio_truth_status`, `ii_reconciliation_config`) that all follow the exact same ownership/RLS idioms R0 froze (owner-only `for all using (auth.uid() = user_id)` for user-owned entities, world-read/admin-write for reference entities) — no new RLS shape was invented.
- The canonical-identifier strategy (`R0_CANONICAL_IDENTIFIER_STRATEGY.md`) is followed exactly: `ii_scheme_alias_map` is a mapping table onto the existing `ii_instruments.id`, never a competing identity; the scheme resolver (`schemeResolution.ts`) never lets a source-provider code become a canonical identifier.
- The net-worth dedup mechanism (`R0_NET_WORTH_DEDUP_CONTRACT.md`) is untouched — R2 never calls `publishPositionStructural()` and never writes to `assets`/`investments`/`retirement_accounts`, so the single-target-per-position guarantee that mechanism relies on is not exercised or at risk in R2 at all.
- The provenance layering (`R0_SOURCE_PROVENANCE_CONTRACT.md`) is extended, not replaced: `ii_document_parse_runs` is the new "which parser version produced this" lineage layer the R1 report explicitly flagged as an R2 decision (`R1_IMPLEMENTATION_REPORT.md` section 9), sitting between the immutable `ii_source_documents` evidence layer and the immutable `ii_transactions`/`ii_holding_snapshots` interpretation layer exactly as the existing diagram describes.
- The audit vocabulary (`R0_AUDIT_REQUIREMENTS.md`) is extended additively — every R1 event type is kept, R2 adds the 14 new event types spec section 33 names, via a widened `check` constraint, not a new table.

No R0/R1 decision was reversed, weakened, or worked around. This file exists (per the task instructions) to state that fact explicitly rather than by omission.

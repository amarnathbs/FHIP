# FDH-11 — Architecture

## The three-layer split

```
                    INVESTMENTS (app UX)
                         │
            ┌────────────┴────────────┐
            │                         │
            ↓                         ↓
      AU INVESTMENTS            INDIA INVESTMENTS
            │                         │
    FDH-11 parses AU             EXISTING /investment-intelligence
      statements only           (CAMS/KFintech parsers, R2-R12)
            │                         │
            ↓                         ↓
      Existing canonical         Existing canonical
   Investment Intelligence       Investment Intelligence
   (ii_accounts/ii_instruments/  (SAME tables)
    ii_transactions/
    ii_holding_snapshots)
            │                         │
            └────────────┬────────────┘
                         ↓
                UNIFIED INVESTMENTS UX (Investments tab)
```

There is exactly one canonical ledger. AU and India are two *ingestion* paths into it, not two parallel portfolio engines.

## Module map

```
lib/financial-data-hub/investment/          (the Hub — NEVER imports II, NEVER touches ii_ tables)
  types.ts                    statement evidence types (AuInvestmentStatementExtraction, etc.)
  quantity.ts                 exact bigint-scaled quantity arithmetic (6dp, independent of money.ts)
  transactionClassification.ts   statement-type -> financial-treatment (proves buy≠expense etc. structurally)
  holdingsReconciliation.ts   opening+txns vs statement closing quantity
  cashReconciliation.ts       opening+flows vs statement closing cash
  accountMatching.ts          pure AU account-match decision (masked id -> institution -> ambiguous/no_match)
  securityMatching.ts         pure AU security-match decision (ISIN -> asx_ticker -> unresolved)
  bankMatching.ts             pure bank<->broker event matching (amount+date+institution, never amount alone)
  csvExtraction.ts            the two certified generic CSV adapters' extraction logic
  detection.ts                CSV format detection (detected/ambiguous/manual_mapping_required/invalid)
  adapters/                   AdapterSignature-based registry (types.ts, registry.ts, auGenericCsv.ts)
  services/investmentStatementProcessingService.ts   the ONE service-role file: upload+extract+persist evidence

lib/investment-import-bridge/               (OUTSIDE the Hub — the only code allowed to import II)
  types.ts                    BridgeApplyResult / error codes
  auAccountResolution.ts      fetch ii_accounts candidates, delegate decision to the Hub's pure matcher
  auSecurityResolution.ts     fetch ii_instrument_identifiers candidates, delegate to the Hub's pure matcher
  approveAuStatement.ts       approval_status: pending -> approved (evidence only, no canonical write)
  applyAuStatementActivity.ts THE canonical writer for transactions (compare-and-swap, fingerprint dedup)
  applyAuStatementPosition.ts THE canonical writer for holding snapshots (compare-and-swap, upsert-on-conflict)
  currentVsStatement.ts       read-only CURRENT vs STATEMENT comparison (spec section 61)

app/api/financial-data-hub/investment-statement/    (composes Hub service + bridge; not import-restricted)
  upload/route.ts, [documentId]/route.ts, /account-match, /security-match, /bank-match,
  /approve, /current-vs-statement, /apply

components/investments/AuInvestmentStatementImportPanel.tsx   (Investments-tab UI, fetch() only)

supabase/migrations/0106_...sql   fdh_investment_statements/_positions/_activities (evidence, not canonical)
                                   + asx_ticker identifier-scheme widening on ii_instrument_identifiers
```

## Why the bridge exists (short version — full ADR in FDH11_INVESTMENT_INTELLIGENCE_BRIDGE.md)

`FDH1_INVESTMENT_BOUNDARY.md` (Product Owner Decision 2) requires: FDH owns document acquisition/extraction/reconciliation/review/approval; Investment Intelligence owns the canonical ledger; FDH never writes an `ii_` table directly and never imports an II engine. That boundary is mechanically enforced for the Hub module by `tests/unit/fdh11Isolation.test.ts` (mirroring `fdh1Isolation.test.ts`). Something, somewhere, still has to turn *approved* AU evidence into real `ii_transactions`/`ii_holding_snapshots` rows — that something is `lib/investment-import-bridge/`, living outside the Hub for the same reason `lib/import-bridge/` does for FDH-9/FDH-10.

## No Silent Apply, mechanically

Every evidence row (`fdh_investment_statement_positions`/`_activities`) carries its own `apply_status` (`pending -> applying -> applied`/`skipped`), separate from the statement's own `approval_status` (`pending -> approved`). A row can only be applied once: `approval_status = 'approved'` AND `security_match_status = 'matched'` AND (for activities) `canonical_account_id` resolved AND the compare-and-swap `UPDATE ... WHERE apply_status = 'pending'` actually claims the row. Every one of these gates is enforced by an `authoritative-write` trigger (migration `0106` Part F) that rejects a direct write from the `authenticated` role — only the service-role bridge, running under a role Postgres itself distinguishes (`auth.role() = 'service_role'`), can move these columns. No RPC is used for this (see the bridge ADR for why); Postgres's own single-statement atomicity for the compare-and-swap `UPDATE`, plus the pre-existing `uidx_ii_transactions_fingerprint` unique index as a backstop against a race between two concurrent Applies, together provide the "exactly once" guarantee spec section 122 requires — both independently proven in `scripts/fdh11_certification.mjs`.

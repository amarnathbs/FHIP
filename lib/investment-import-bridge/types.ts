/**
 * FDH-11 — Australia Investment Statement Intelligence: the one-way
 * FDH-evidence -> canonical-Investment-Intelligence bridge.
 *
 * WHY THIS MODULE LIVES OUTSIDE `lib/financial-data-hub/`. The Hub
 * (`lib/financial-data-hub/investment/`) produces STATEMENT EVIDENCE and
 * never imports Investment Intelligence code or touches an `ii_*` table —
 * mechanically enforced by `tests/unit/fdh11Isolation.test.ts`, mirroring
 * `fdh1Isolation.test.ts`'s pre-existing rule for the rest of the Hub. This
 * module is the "single one-way adapter function" `FDH1_INVESTMENT_
 * BOUNDARY.md` section 6 sketched but deliberately left unimplemented,
 * pending FDH-11 — the exact same relationship `lib/import-bridge/` already
 * has to FDH-9/FDH-10's evidence and to `income_sources`/`liabilities`.
 *
 * ARCHITECTURE DECISION (spec section 65) — documented in full in
 * `docs/financial-data-hub/FDH11_INVESTMENT_INTELLIGENCE_BRIDGE.md`:
 * `fhip_import_proposals`/`fhip_import_applications` (the FDH-9/FDH-10
 * generic bridge) is a SINGLE-ROW field-patch model — one proposal patches
 * one row of one target table (`income_sources`/`liabilities`). Investment
 * Intelligence's canonical truth is LEDGER-shaped: applying one statement
 * means inserting zero-or-more NEW `ii_transactions` rows (never rewriting
 * an existing one) plus, optionally, one `ii_holding_snapshots` row. That is
 * categorically not a single-row field patch, and forcing it into one would
 * violate spec sections 59-62's explicit "do not do
 * `holding.quantity = statement.quantity`" rule. This module therefore does
 * NOT reuse `fhip_import_proposals` — it is a new, narrow, typed bridge,
 * exactly as spec section 65 anticipates as the fallback when the generic
 * bridge is not appropriate.
 *
 * NO RPC. Investment Intelligence's own architecture-exception doc
 * (`lib/services/investment-intelligence/investmentPublicationService.ts`,
 * header) states this codebase has never used a Postgres RPC / multi-
 * statement transaction anywhere. This bridge follows that established
 * precedent rather than introducing the first one: atomicity for "exactly
 * once" Apply is achieved with a single compare-and-swap UPDATE statement
 * (`apply_status: 'pending' -> 'applying'`), which Postgres itself executes
 * atomically as one statement — no stored procedure required. See
 * `applyAuStatementActivity.ts`.
 */

export type BridgeApplyErrorCode =
  | 'NOT_APPROVED'
  | 'NOT_MATCHED'
  | 'ALREADY_APPLIED'
  | 'ALREADY_APPLYING'
  | 'STALE_EVIDENCE'
  | 'FOREIGN_ACCOUNT'
  | 'FOREIGN_SECURITY'
  | 'CANONICAL_TYPE_UNSUPPORTED'
  | 'NOT_FOUND'
  | 'UNKNOWN_ERROR';

export interface BridgeApplyResult {
  ok: boolean;
  code: BridgeApplyErrorCode | null;
  canonicalTransactionId: string | null;
  error: string | null;
}

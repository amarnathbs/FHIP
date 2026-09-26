/**
 * Upload field-disposition registry -- types (WP-00).
 *
 * THE GOVERNING RULE (the PO's brief): after a user reviews and APPLIES /
 * APPROVES an uploaded document, every approved financial fact ends in exactly
 * ONE of:
 *   A_STATE        canonical financial state (income_sources, liabilities,
 *                  assets, retirement_accounts, investments, ii_* ...)
 *   B_EVENT        canonical financial event (fdh_transactions + allocations /
 *                  links -- the approved transaction layer)
 *   C_EVIDENCE     supporting evidence / provenance -- must be USER-VISIBLE
 *   D_METADATA     derived / technical metadata
 *   E_UNSUPPORTED  explicitly unsupported / rejected, with a visible explanation
 * Silently unmapped = 0. Every field an active adapter extracts, every
 * evidence column and every activity/event enum value has an entry here; the
 * gate test (tests/unit/uploadFieldDispositionRegistry.test.ts) fails on an
 * orphan (a field with no entry) and on a stale entry (an entry whose field no
 * longer exists).
 *
 * WHY THIS LIVES OUTSIDE THE FDH MODULE. tests/unit/fdh1Isolation.test.ts
 * forbids any FDH file from naming an Input Data register, and destinations
 * must name them. These files import nothing, and `sourceRef` uses short
 * prefixes instead of module paths:
 *   'fdh:<path>#<Name>'  -> the FDH module (lib/<fdh>/<path>)
 *   'aie:<path>#<Name>'  -> lib/aie/adapters/<path>
 *   'ii:<path>#<Name>'   -> lib/services/investment-intelligence/<path>
 *   'db:<table>'         -> the table's columns, replayed from the migration ledger
 *   'enum:<CONST>'       -> an enum constant's values
 */

export type Disposition = 'A_STATE' | 'B_EVENT' | 'C_EVIDENCE' | 'D_METADATA' | 'E_UNSUPPORTED';

export type SourceKind = 'ts_interface' | 'zod_schema' | 'db_column' | 'enum_value' | 'field_list';

export type AdapterId =
  | 'bank_csv'
  | 'bank_pdf'
  | 'bank_ai_draft'
  | 'bank_ledger'
  | 'economic_type'
  | 'payslip_native'
  | 'payslip_ai'
  | 'liability_native'
  | 'liability_ai'
  | 'liability_ledger'
  | 'au_investment_native'
  | 'au_investment_ai'
  | 'retirement_native'
  | 'retirement_ai'
  | 'ii_cas'
  | 'insurance';

export type EntryStatus = 'compliant' | 'open_gap' | 'not_active';

export type Severity = 'P0' | 'P1' | 'P2' | 'P3';

export interface FieldDispositionEntry {
  adapter: AdapterId;
  sourceKind: SourceKind;
  sourceRef: string;
  /** Property / zod key / column / enum value. */
  field: string;
  disposition: Disposition;
  /** e.g. 'income_sources.amount', 'fdh_transactions(bucket=spending)', 'evidence:fdh_payroll_events.tax_withheld'. */
  destination: string;
  /** Where the user sees it. REQUIRED for C and E unless status is open_gap. */
  userVisibleAt: string | null;
  economicMeaning?: string;
  status: EntryStatus;
  /** Required for open_gap: an id in APPROVED_UPLOAD_CANONICAL_DATA_FLOW_MATRIX.md's gap register. */
  gapId?: string;
  severity?: Severity;
  /** The work package that will close the gap. */
  ownerWp?: string;
}

/** Canonical destinations an A or B entry may name (registry rule R4). */
export const CANONICAL_DESTINATION_PREFIXES = [
  'income_sources',
  'expense_items',
  'assets',
  'liabilities',
  'investments',
  'retirement_accounts',
  'insurance_policies',
  'ii_',
  'fdh_transactions',
  'fdh_transaction_allocations',
  'fdh_transaction_links',
] as const;

/** A registry file: its entries, and the open-gap ratchet (may only go DOWN). */
export interface RegistryFile {
  id: string;
  /** Work package that owns edits to this file. */
  ownerWp: string;
  entries: readonly FieldDispositionEntry[];
  OPEN_GAP_CEILING: number;
}

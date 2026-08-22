/**
 * R7 — Bank CSV Engine: adapter contract (spec section 19).
 *
 * `BankCsvAdapter` is a pure, side-effect-free description of one bank's CSV
 * export shape plus the logic to recognise and read it. Adapters never touch
 * the database and never do I/O — `detection.ts` and `normalize.ts` drive
 * them. Each adapter is versioned independently of its certification record
 * in `fdh_parser_registry`/`fdh_parser_versions` (the DB rows are the
 * governance/audit trail; this object is the actual behaviour).
 */

import type { FdhCsvAmountConvention } from '../../constants/enums';
import type { SupportedDateFormat } from '../dateFormats';

/** A column-name/order signal the detector matches against a candidate
 * header row. All signature fields are matched case-insensitively after
 * whitespace normalisation. */
export interface AdapterSignature {
  /** Header cell names (in any order) that must ALL be present for this
   * adapter to be considered at all. Matched by normalised substring/exact
   * match — see `detection.ts` `matchesRequiredHeaders`. */
  requiredHeaders: string[];
  /** Optional header cells whose presence increases confidence but whose
   * absence does not disqualify the adapter. */
  optionalHeaders?: string[];
  /** Exact expected column count, when the format is rigid. */
  expectedColumnCount?: number;
}

export type AdapterCertificationState = 'certified' | 'experimental';

export interface BankCsvAdapter {
  /** Stable identifier, matches `fdh_parser_registry.parser_key`. */
  id: string;
  /** null for a country-neutral generic adapter. */
  institutionCode: string | null;
  /** null for a country-neutral generic adapter. */
  country: 'AU' | 'IN' | null;
  /** Semantic version of THIS adapter's behaviour. */
  version: string;
  certificationState: AdapterCertificationState;
  displayName: string;
  signature: AdapterSignature;
  amountConvention: FdhCsvAmountConvention;
  dateFormat: SupportedDateFormat;
  delimiter: string;
  /**
   * Maps this adapter's own column names to the canonical roles. Values are
   * exact header names as they appear in a matching source file.
   */
  columnRoles: {
    transactionDate: string;
    postedDate?: string;
    valueDate?: string;
    description: string;
    amount?: string;
    debit?: string;
    credit?: string;
    drCrIndicator?: string;
    balance?: string;
    reference?: string;
  };
  /** Scores how well a header row matches this adapter, in [0, 1]. Pure
   * function — used by the detection pipeline's confidence scoring. */
  scoreHeader(header: readonly string[]): number;
}

export function normaliseHeaderCell(cell: string): string {
  return cell.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Generic confidence scorer shared by every adapter: fraction of the
 * signature's required headers present, weighted 0.8, plus a 0.2 bonus for
 * every optional header also present (capped at 1.0).
 *
 * EXACT match only (after whitespace/case normalisation) — deliberately NOT
 * a substring match. An early version used `.includes()`, which let a
 * generic adapter's required header `"Debit"` match an institution
 * adapter's own `"Debit Amount"` column, scoring the generic fallback close
 * enough to a certified institution match to trigger a false AMBIGUOUS
 * result (caught by certification case R7-TC021/R7-TC024). A bank's real
 * header name is either the name an adapter expects or it is not.
 */
export function scoreHeaderAgainstSignature(header: readonly string[], signature: AdapterSignature): number {
  const normalised = header.map(normaliseHeaderCell);
  const requiredHits = signature.requiredHeaders.filter((h) => normalised.includes(normaliseHeaderCell(h))).length;
  if (requiredHits < signature.requiredHeaders.length) return 0;
  const requiredScore = 0.8;
  const optional = signature.optionalHeaders ?? [];
  const optionalHits = optional.filter((h) => normalised.includes(normaliseHeaderCell(h))).length;
  const optionalScore = optional.length > 0 ? 0.2 * (optionalHits / optional.length) : 0.2;
  return Math.min(1, requiredScore + optionalScore);
}

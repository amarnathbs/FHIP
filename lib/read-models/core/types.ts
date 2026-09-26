/**
 * Canonical read models -- shared types (WP-02).
 *
 * THE CONTRACT EVERY SELECTOR KEEPS:
 *  - A read that fails is `{ status: 'unavailable' }`, never an empty list or
 *    a zero. A consumer that receives 'unavailable' must show "unavailable",
 *    not $0 (DC-14).
 *  - A missing value is `null`, never 0 (GAP-09: an unknown net pay is not the
 *    gross; an unknown contribution frequency is not "monthly").
 *  - Every money line keeps its NATIVE amount and currency, plus the amount in
 *    the household's reporting currency when -- and only when -- that currency
 *    is supported; otherwise `amountReporting` is null and the line is counted
 *    in an `unconverted` bucket instead of being added raw (DC-12).
 *  - Every line carries its provenance, so the Input Data tabs can say
 *    "Imported from bank statement" without knowing any FDH internals.
 */

export type ReadModelUnavailable = {
  status: 'unavailable';
  /** Stable machine reason, e.g. 'query_failed', 'invalid_split'. */
  reason: string;
  /** The table / step that failed, for logs. Never row data. */
  source: string;
};

export type ReadModelResult<T> = ({ status: 'ok' } & T) | ReadModelUnavailable;

/** Thrown inside a selector; converted to `ReadModelUnavailable` at its edge. */
export class ReadModelUnavailableError extends Error {
  constructor(public readonly reason: string, public readonly source: string) {
    super(`${reason}: ${source}`);
    this.name = 'ReadModelUnavailableError';
  }
}

export function toUnavailable(error: unknown, fallbackSource = 'read_model'): ReadModelUnavailable {
  if (error instanceof ReadModelUnavailableError) {
    return { status: 'unavailable', reason: error.reason, source: error.source };
  }
  return { status: 'unavailable', reason: 'unexpected_error', source: fallbackSource };
}

export type ProvenanceKind =
  | 'manual'
  | 'payslip_import'
  | 'bank_statement'
  | 'card_statement'
  | 'loan_statement'
  | 'broker_statement'
  | 'retirement_statement'
  | 'investment_intelligence';

export interface Provenance {
  kind: ProvenanceKind;
  /** fdh_statement_uploads.id of the document this came from, when imported. */
  statementUploadId: string | null;
  /** fdh_financial_accounts.id (imported) -- null for manual rows. */
  accountId: string | null;
  /** User-facing label, e.g. "Imported from bank statement". */
  label: string;
}

export const PROVENANCE_LABELS: Record<ProvenanceKind, string> = {
  manual: 'Entered by you',
  payslip_import: 'Imported from payslip',
  bank_statement: 'Imported from bank statement',
  card_statement: 'Imported from credit card statement',
  loan_statement: 'Imported from loan statement',
  broker_statement: 'Imported from broker statement',
  retirement_statement: 'Imported from retirement statement',
  investment_intelligence: 'Imported via Investment Intelligence',
};

export function provenance(kind: ProvenanceKind, statementUploadId: string | null = null, accountId: string | null = null): Provenance {
  return { kind, statementUploadId, accountId, label: PROVENANCE_LABELS[kind] };
}

/** A money amount in its own currency, plus its reporting-currency value. */
export interface MoneyValue {
  amountNative: number;
  currency: string;
  /** null = currency not convertible (unsupported) -- excluded from totals. */
  amountReporting: number | null;
}

/** Household member / entity roles used across registers and imports. */
export type OwnerRole = 'self' | 'spouse' | 'joint' | 'child' | 'family_trust' | 'company' | 'smsf' | 'other';

/** SMSF-owned rows are the fund's, not the household's (LR-FI-1). Null/unknown
 * owners are household (the existing fail-safe direction). */
export function isHouseholdOwner(owner: string | null | undefined): boolean {
  return owner !== 'smsf';
}

/** A per-currency tally of amounts that could not be converted. */
export interface UnconvertedTally {
  count: number;
  byCurrency: Record<string, number>;
}

export function emptyUnconverted(): UnconvertedTally {
  return { count: 0, byCurrency: {} };
}

export function addUnconverted(t: UnconvertedTally, currency: string, amount: number): void {
  t.count += 1;
  t.byCurrency[currency] = roundMoney((t.byCurrency[currency] ?? 0) + amount);
}

/** Rounds to 4 dp -- the storage precision of every FDH / register amount --
 * so float noise never leaks into an oracle comparison. */
export function roundMoney(n: number): number {
  return Math.round(n * 10000) / 10000;
}

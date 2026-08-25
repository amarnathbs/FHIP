/**
 * FHIP Input Data Import Bridge — generic vocabulary.
 *
 * WHY THIS LIVES OUTSIDE `lib/financial-data-hub/`.
 *
 * Two reasons, both load-bearing:
 *
 *  1. ARCHITECTURE. Spec section 7 requires a generic import-proposal
 *     architecture "suitable for later use by Income, Expenses, Investments,
 *     Liabilities, Retirement", explicitly so FDH-15 becomes a governance
 *     certification rather than an architectural rewrite. A service five
 *     domains share is not an FDH internal.
 *
 *  2. ISOLATION. `tests/unit/fdh1Isolation.test.ts` mechanically forbids any
 *     file under `lib/financial-data-hub/` from naming a protected Input Data
 *     register, calling `makeRegistry`, or querying `income_sources`. Those
 *     guarantees are valuable and FDH-9 leaves every one of them intact and
 *     untouched by keeping the bridge here instead.
 *
 * THE CONTRACT THIS MODULE EXISTS TO ENFORCE:
 *
 *     Preview -> Compare -> User Approval -> Apply
 *
 * A proposal is INERT. Generating one, and approving the evidence behind it,
 * change nothing in any canonical register. Only `applyImportProposal()`
 * mutates Input Data, and only when a user explicitly asked it to.
 */

export const IMPORT_TARGET_DOMAINS = [
  'income', 'expense', 'asset', 'liability', 'investment', 'retirement',
] as const;
export type ImportTargetDomain = (typeof IMPORT_TARGET_DOMAINS)[number];

export const IMPORT_SOURCE_KINDS = [
  'payslip', 'bank_statement', 'investment_statement', 'loan_statement', 'retirement_statement',
] as const;
export type ImportSourceKind = (typeof IMPORT_SOURCE_KINDS)[number];

/** How a value is compared and coerced. Domain-agnostic. */
export const IMPORT_VALUE_KINDS = ['money', 'text', 'enum', 'bool', 'int'] as const;
export type ImportValueKind = (typeof IMPORT_VALUE_KINDS)[number];

/**
 * What the ENGINE recommends. The user is never bound by it and the apply API
 * re-derives its own decision rather than trusting it.
 */
export type RecommendedApplyMode = 'add_new' | 'update_existing' | 'keep_existing';

/**
 * What the USER chose. `keep_existing` is a first-class decision that results
 * in NO write of any kind and marks the proposal dismissed so it is not
 * re-offered on every page load (spec section 59).
 */
export const USER_APPLY_DECISIONS = [
  'add_new', 'update_existing', 'apply_selected_fields', 'keep_existing',
] as const;
export type UserApplyDecision = (typeof USER_APPLY_DECISIONS)[number];

/** The persisted apply modes — `keep_existing` never reaches this stage. */
export type PersistedApplyMode = 'add_new' | 'update_existing' | 'apply_selected_fields';

/**
 * One proposed field change.
 *
 * `existingValue` is the STALENESS ORACLE: it is the value the target row held
 * when the proposal was generated. At apply time the server re-reads the row
 * and refuses if any SELECTED field has since changed (spec section 48).
 */
export interface ProposedField {
  fieldName: string;
  valueKind: ImportValueKind;
  /** Serialised proposed value; null means "propose clearing/not set". */
  proposedValue: string | null;
  /** Serialised value observed on the target at generation time; null when
   * adding a new entry, or when the target did not have the field set. */
  existingValue: string | null;
  /** Whether this field is ticked by default in the compare view. */
  isRecommended: boolean;
  /** Whether the user must positively confirm it — used for inferred pay
   * frequency and for variable pay (spec sections 26-27). */
  requiresConfirmation: boolean;
  confidence?: number;
  /** Machine-readable justification shown in the compare view. */
  reasonCode: string;
}

/** A proposal, before it is persisted. */
export interface ImportProposalDraft {
  targetDomain: ImportTargetDomain;
  sourceKind: ImportSourceKind;
  currencyCode: string | null;
  targetEntityId: string | null;
  targetEntityUpdatedAt: string | null;
  recommendedApplyMode: RecommendedApplyMode;
  duplicateOfEntityId: string | null;
  fields: ProposedField[];
  /** Human-facing summary for the review screen. Never used for arithmetic. */
  summary: ImportProposalSummary;
}

export interface ImportProposalSummary {
  title: string;
  lines: { label: string; value: string; note?: string }[];
  /** Review reasons the user should see before approving (spec section 42). */
  reviewReasons: string[];
}

/**
 * A domain adapter. Income is the only one FDH-9 ships; Expenses,
 * Investments, Liabilities and Retirement are later additions of a FILE, not
 * of a schema.
 */
export interface ImportDomainAdapter<TEvidence, TExisting> {
  domain: ImportTargetDomain;

  /**
   * THE SECURITY ALLOW-LIST. The complete set of canonical columns this
   * adapter may ever write. The apply path rejects any field outside it,
   * regardless of what a request asked for or what a stored proposal
   * contains — so a forged proposal row cannot widen the blast radius.
   */
  applicableFields: readonly string[];

  buildProposal(evidence: TEvidence, existing: readonly TExisting[]): ImportProposalDraft;

  /** Turn a serialised proposal value back into a column value. */
  coerce(fieldName: string, value: string | null, valueKind: ImportValueKind): unknown;

  /** Serialise a live column value for comparison against `existingValue`. */
  serialise(fieldName: string, value: unknown, valueKind: ImportValueKind): string | null;

  /** Domain rules that must hold for a write to be legal (e.g. a new Income
   * entry needs a name and an amount). */
  validateApply(
    mode: PersistedApplyMode,
    fields: readonly ProposedField[],
    selected: readonly string[],
  ): { ok: true } | { ok: false; error: string };
}

/** Errors the apply path returns. Each is a distinct, testable outcome. */
export type ImportApplyErrorCode =
  | 'PROPOSAL_NOT_FOUND'
  | 'PROPOSAL_NOT_ACTIONABLE'
  | 'STALE_PROPOSAL'
  | 'TARGET_NOT_FOUND'
  | 'FORBIDDEN_FIELD'
  | 'NO_FIELDS_SELECTED'
  | 'INVALID_APPLY_MODE'
  | 'DOMAIN_VALIDATION_FAILED'
  | 'ALREADY_APPLIED'
  | 'WRITE_FAILED';

export class ImportApplyError extends Error {
  constructor(readonly code: ImportApplyErrorCode, message: string, readonly details?: unknown) {
    super(message);
    this.name = 'ImportApplyError';
  }
}

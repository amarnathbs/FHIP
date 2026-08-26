/**
 * FHIP Input Data Import Bridge — the LIABILITY adapter (FDH-10, spec sections
 * 50-58).
 *
 * The second domain adapter, following the exact shape FDH-9's
 * `incomeAdapter.ts` established (spec section 7's whole reason for the
 * bridge existing: "later use by ... Liabilities ... a governance
 * certification rather than an architectural rewrite" — this file is that
 * later use).
 *
 * ===========================================================================
 * WHAT THIS ADAPTER PROPOSES, AND WHY
 * ===========================================================================
 *
 * `balance` — the statement's CLOSING balance (card) or closing PRINCIPAL
 * (loan). Never the statement's total-activity figure and never a card's
 * available-credit or credit-limit (spec section 85: credit limit is
 * metadata, never net worth).
 *
 * `interest_rate` — proposed ONLY for a LOAN facility, and only the loan's
 * own rate. A credit card's purchase/cash-advance APR is never written here
 * (spec section 77: "never overwrite a canonical loan rate with a card
 * purchase APR accidentally") — `applicableFields` does not even list
 * `interest_rate` as something a credit-card evidence object may propose; see
 * `buildProposal`'s own guard.
 *
 * `monthly_repayment` — proposed from a loan's contractual/minimum repayment
 * or a card's minimum payment, kept distinct in meaning even though they
 * share one canonical column today (spec section 78: "minimum payment (card)
 * != regular loan repayment — preserve the semantic distinction" is satisfied
 * by the review UI labelling the field per facility type, not by inventing a
 * second canonical column the register does not have — spec section 125:
 * "never invent fields the Liability model lacks").
 *
 * `credit_limit` / `masked_identifier` / `minimum_payment` / `due_date` —
 * card/loan metadata additive to the canonical model (migration 0096).
 * `available_credit` is DELIBERATELY NOT in `LIABILITY_APPLICABLE_FIELDS` at
 * all in this cut — it is informational evidence surfaced in the statement
 * review UX only, not something FDH-10 writes onto the canonical Liability,
 * closing off any path by which it could ever be summed into net worth (spec
 * section 85).
 *
 * `liability_name` / `debt_type` / `lender` / `currency_code` /
 * `country_code` — proposed ONLY when creating a new Liability (`!target`),
 * exactly like income's `source_name`/`income_type`/`currency_code` — an
 * import never silently renames or re-types a Liability the user already
 * named and classified themselves.
 */

import type {
  ImportDomainAdapter,
  ImportProposalDraft,
  ImportValueKind,
  PersistedApplyMode,
  ProposedField,
  RecommendedApplyMode,
} from '../types';
import { serialiseValue, deserialiseValue } from '../proposalEngine';
import { matchLiabilityFacility, type ExistingLiabilityCandidate } from '@/lib/financial-data-hub/liability/facilityMatching';
import { FACILITY_TO_DEBT_TYPE, type LiabilityFacilityType } from '@/lib/financial-data-hub/liability/types';

/** The subset of a canonical `liabilities` row this adapter reads. */
export interface ExistingLiabilityRow {
  id: string;
  liability_name: string;
  debt_type: string;
  balance: number;
  interest_rate: number | null;
  monthly_repayment: number;
  currency_code: string;
  country_code: string | null;
  lender: string | null;
  credit_limit: number | null;
  masked_identifier: string | null;
  minimum_payment: number | null;
  due_date: string | null;
  updated_at?: string | null;
}

/** Statement evidence this adapter consumes — a plain shape, not an import of
 * `lib/financial-data-hub/liability/types` extraction types, for the exact
 * reason `IncomeEvidence` is its own plain shape (keeps the bridge usable by
 * future adapters without coupling it to any one FDH-internal module). */
export interface LiabilityEvidence {
  statementId: string;
  facilityType: LiabilityFacilityType;
  institutionName?: string;
  maskedIdentifier?: string;
  currencyCode: string;
  countryCode?: string;
  closingBalance?: number;
  closingPrincipal?: number;
  interestRate?: number;
  minimumPayment?: number;
  monthlyRepaymentAmount?: number;
  creditLimit?: number;
  dueDate?: string;
  reviewReasons: string[];
}

/** Every canonical column this adapter is EVER permitted to write (spec
 * section 53's typed allow-list — no dynamic column name ever reaches the
 * apply path from proposal data alone). */
export const LIABILITY_APPLICABLE_FIELDS = [
  'liability_name',
  'debt_type',
  'lender',
  'currency_code',
  'country_code',
  'balance',
  'interest_rate',
  'monthly_repayment',
  'credit_limit',
  'masked_identifier',
  'minimum_payment',
  'due_date',
] as const;

const FIELD_KINDS: Record<string, ImportValueKind> = {
  liability_name: 'text',
  debt_type: 'enum',
  lender: 'text',
  currency_code: 'enum',
  country_code: 'enum',
  balance: 'money',
  interest_rate: 'money',
  monthly_repayment: 'money',
  credit_limit: 'money',
  masked_identifier: 'text',
  minimum_payment: 'money',
  due_date: 'text',
};

export function findDuplicateLiability(
  evidence: LiabilityEvidence,
  existing: readonly ExistingLiabilityRow[],
): { liabilityId: string | null; outcome: 'single_match' | 'no_match' | 'ambiguous' } {
  const debtType = FACILITY_TO_DEBT_TYPE[evidence.facilityType];
  const candidates: ExistingLiabilityCandidate[] = existing.map((row) => ({
    liabilityId: row.id,
    debtType: row.debt_type,
    currencyCode: row.currency_code,
    maskedIdentifier: row.masked_identifier,
    lender: row.lender,
    liabilityName: row.liability_name,
  }));
  const result = matchLiabilityFacility(
    { facilityDebtType: debtType, currencyCode: evidence.currencyCode, institutionName: evidence.institutionName ?? null, maskedIdentifier: evidence.maskedIdentifier ?? null },
    candidates,
  );
  return { liabilityId: result.matchedLiabilityId, outcome: result.outcome };
}

function field(
  fieldName: string,
  proposed: unknown,
  existingRow: ExistingLiabilityRow | null,
  opts: { isRecommended?: boolean; requiresConfirmation?: boolean; reasonCode: string; confidence?: number },
): ProposedField {
  const kind = FIELD_KINDS[fieldName];
  return {
    fieldName,
    valueKind: kind,
    proposedValue: serialiseValue(proposed, kind),
    existingValue: existingRow
      ? serialiseValue((existingRow as unknown as Record<string, unknown>)[fieldName], kind)
      : null,
    isRecommended: opts.isRecommended ?? true,
    requiresConfirmation: opts.requiresConfirmation ?? false,
    confidence: opts.confidence,
    reasonCode: opts.reasonCode,
  };
}

export const liabilityAdapter: ImportDomainAdapter<LiabilityEvidence, ExistingLiabilityRow> = {
  domain: 'liability',
  applicableFields: LIABILITY_APPLICABLE_FIELDS,

  buildProposal(evidence, existing): ImportProposalDraft {
    const duplicate = findDuplicateLiability(evidence, existing);
    // AMBIGUOUS facility match is never silently resolved to the first
    // candidate (spec sections 52, 125) — the proposal simply targets no
    // existing entity and carries the ambiguity as a review reason; the UI
    // surfaces REVIEW_REQUIRED and the user picks (or adds new) explicitly.
    const target = duplicate.outcome === 'single_match'
      ? existing.find((r) => r.id === duplicate.liabilityId) ?? null
      : null;
    const recommendedApplyMode: RecommendedApplyMode = target ? 'update_existing' : 'add_new';
    const reviewReasons = [...evidence.reviewReasons];
    if (duplicate.outcome === 'ambiguous') reviewReasons.push('ambiguous_facility_match_review_required');

    const fields: ProposedField[] = [];
    const isCreditCard = evidence.facilityType === 'credit_card';

    if (!target) {
      const debtType = FACILITY_TO_DEBT_TYPE[evidence.facilityType];
      fields.push(field('liability_name', evidence.institutionName ? `${labelForFacility(evidence.facilityType)} — ${evidence.institutionName}` : labelForFacility(evidence.facilityType), null, { reasonCode: 'derived_from_statement' }));
      fields.push(field('debt_type', debtType, null, { reasonCode: 'derived_from_facility_type' }));
      fields.push(field('currency_code', evidence.currencyCode, null, { reasonCode: 'read_from_statement' }));
      if (evidence.countryCode) fields.push(field('country_code', evidence.countryCode, null, { reasonCode: 'read_from_statement' }));
    }

    if (evidence.institutionName) {
      fields.push(field('lender', evidence.institutionName, target, { reasonCode: 'read_from_statement' }));
    }
    if (evidence.maskedIdentifier) {
      fields.push(field('masked_identifier', evidence.maskedIdentifier, target, { reasonCode: 'read_from_statement' }));
    }

    // --- balance: closing balance (card) or closing principal (loan) -------
    const closing = isCreditCard ? evidence.closingBalance : evidence.closingPrincipal;
    if (closing !== undefined) {
      fields.push(field('balance', closing, target, { reasonCode: isCreditCard ? 'statement_closing_balance' : 'statement_closing_principal' }));
    } else {
      reviewReasons.push('no_closing_balance_on_statement');
    }

    // --- interest_rate: LOAN ONLY (spec section 77) -------------------------
    if (!isCreditCard && evidence.interestRate !== undefined) {
      fields.push(field('interest_rate', evidence.interestRate, target, { reasonCode: 'statement_loan_rate' }));
    }

    // --- monthly_repayment: card minimum payment or loan repayment ---------
    const repayment = isCreditCard ? evidence.minimumPayment : evidence.monthlyRepaymentAmount;
    if (repayment !== undefined) {
      fields.push(field('monthly_repayment', repayment, target, {
        requiresConfirmation: isCreditCard, // a card's MINIMUM payment is not the user's habitual repayment — spec 78
        reasonCode: isCreditCard ? 'statement_minimum_payment' : 'statement_contractual_repayment',
      }));
      if (isCreditCard) reviewReasons.push('minimum_payment_is_not_your_regular_repayment');
    }

    if (isCreditCard && evidence.creditLimit !== undefined) {
      fields.push(field('credit_limit', evidence.creditLimit, target, { reasonCode: 'statement_credit_limit' }));
    }
    if (isCreditCard && evidence.minimumPayment !== undefined) {
      fields.push(field('minimum_payment', evidence.minimumPayment, target, { reasonCode: 'statement_minimum_payment' }));
    }
    if (evidence.dueDate) {
      fields.push(field('due_date', evidence.dueDate, target, { reasonCode: 'statement_due_date' }));
    }

    return {
      targetDomain: 'liability',
      sourceKind: isCreditCard ? 'credit_card_statement' : 'loan_statement',
      currencyCode: evidence.currencyCode,
      targetEntityId: target?.id ?? null,
      targetEntityUpdatedAt: target?.updated_at ?? null,
      recommendedApplyMode,
      duplicateOfEntityId: duplicate.outcome === 'single_match' ? duplicate.liabilityId : null,
      fields,
      summary: buildSummary(evidence, target, reviewReasons),
    };
  },

  coerce(_fieldName, value, valueKind) {
    return deserialiseValue(value, valueKind);
  },

  serialise(_fieldName, value, valueKind) {
    return serialiseValue(value, valueKind);
  },

  validateApply(mode: PersistedApplyMode, fields, selected) {
    if (selected.length === 0) {
      return { ok: false, error: 'No fields were selected to apply.' };
    }
    if (mode === 'add_new') {
      const names = new Set(selected);
      if (!names.has('liability_name')) return { ok: false, error: 'A new liability needs a name.' };
      if (!names.has('debt_type')) return { ok: false, error: 'A new liability needs a type.' };
      if (!names.has('balance')) return { ok: false, error: 'A new liability needs a balance.' };
      if (!names.has('currency_code')) return { ok: false, error: 'A new liability needs a currency.' };
    }
    const known = new Set(fields.map((f) => f.fieldName));
    for (const name of selected) {
      if (!known.has(name)) return { ok: false, error: `Field ${name} is not part of this proposal.` };
    }
    return { ok: true };
  },
};

/** The non-negotiable base of a NEW liability row (mirrors
 * `newIncomeRowDefaults`). `owner` defaults to 'self' for the same reason
 * FDH-9 defaults Income's owner — a statement carries no evidence of which
 * household member the facility belongs to. */
export function newLiabilityRowDefaults(): Record<string, unknown> {
  return { owner: 'self', is_active: true };
}

function labelForFacility(facilityType: LiabilityFacilityType): string {
  switch (facilityType) {
    case 'credit_card': return 'Credit Card';
    case 'personal_loan': return 'Personal Loan';
    case 'home_loan': return 'Home Loan';
    case 'investment_property_loan': return 'Investment Property Loan';
    case 'vehicle_loan': return 'Vehicle Loan';
    case 'other_term_loan': return 'Loan';
    case 'line_of_credit': return 'Line of Credit';
    case 'overdraft': return 'Overdraft';
    default: return 'Liability';
  }
}

function buildSummary(
  evidence: LiabilityEvidence,
  target: ExistingLiabilityRow | null,
  reviewReasons: string[],
): ImportProposalDraft['summary'] {
  const lines: { label: string; value: string; note?: string }[] = [];
  const money = (n: number | undefined) =>
    n === undefined ? 'Not shown on statement' : n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  lines.push({ label: 'Institution', value: evidence.institutionName ?? 'Not identified' });
  lines.push({ label: 'Facility', value: labelForFacility(evidence.facilityType) });
  if (evidence.facilityType === 'credit_card') {
    lines.push({ label: 'Closing balance', value: money(evidence.closingBalance) });
    lines.push({ label: 'Credit limit', value: money(evidence.creditLimit), note: 'Not counted in net worth' });
    lines.push({ label: 'Minimum payment', value: money(evidence.minimumPayment), note: 'Not the same as your regular repayment' });
  } else {
    lines.push({ label: 'Closing principal', value: money(evidence.closingPrincipal) });
    lines.push({ label: 'Interest rate', value: evidence.interestRate !== undefined ? `${evidence.interestRate}%` : 'Not shown on statement' });
  }

  return {
    title: target
      ? `Update your existing liability “${target.liability_name}”?`
      : 'Add this as a new liability?',
    lines,
    reviewReasons: [...new Set(reviewReasons)],
  };
}

/**
 * FHIP Input Data Import Bridge — the INCOME adapter.
 *
 * The first (and, in FDH-9, only) domain adapter. It maps approved payroll
 * evidence onto the canonical `income_sources` model and nothing else.
 *
 * ===========================================================================
 * THE FOUR RULES THAT MAKE THIS FINANCIALLY CORRECT
 * ===========================================================================
 *
 * 1. GROSS, NEVER NET (spec section 24). The canonical Income form's `amount`
 *    column is labelled "Gross Amount" in the grid. It is therefore populated
 *    from the payslip's GROSS figure. Populating it with net pay because net
 *    happens to match the bank deposit would understate income by the whole
 *    tax and deduction stack. Net is carried separately in `net_amount`, which
 *    is what that column is for.
 *
 * 2. VARIABLE PAY IS NOT RECURRING INCOME (spec section 25). A single payslip
 *    containing a $2,500 bonus does not mean the household earns a bonus every
 *    fortnight. Bonus, overtime, commission and arrears are SUBTRACTED from
 *    the recurring gross proposal and surfaced separately as variable-income
 *    evidence. Nothing turns them into recurring income without user action.
 *
 * 3. REIMBURSEMENTS ARE NOT INCOME (spec section 38). An expense reimbursement
 *    is the return of money already spent. It never inflates recurring income,
 *    even though it does reach the bank account.
 *
 * 4. EMPLOYER CONTRIBUTIONS ARE NOT TAKE-HOME INCOME (spec section 39).
 *    Employer super / employer PF / employer NPS are extracted and preserved
 *    on the payroll event, and are never added to an Income amount.
 *
 * ===========================================================================
 * ONLY REAL COLUMNS (spec section 23)
 * ===========================================================================
 *
 * "Do not invent fields the Income model lacks." The canonical `income_sources`
 * table has NO start_date, NO end_date and NO household_member FK — ownership
 * is the `owner` role enum. So the spec's *possible* field "start date /
 * observed period" is deliberately NOT proposed: the pay period lives on the
 * payroll event, where there is somewhere to put it.
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

/** The subset of a canonical `income_sources` row this adapter reads. */
export interface ExistingIncomeRow {
  id: string;
  source_name: string;
  income_type: string;
  amount: number;
  net_amount: number | null;
  frequency: string;
  currency_code: string;
  owner: string;
  is_taxable: boolean;
  employer_name: string | null;
  notes: string | null;
  master_item_key: string | null;
  source_type?: string | null;
  updated_at?: string | null;
}

/**
 * The payroll evidence this adapter consumes. Deliberately a PLAIN SHAPE
 * rather than an import from `lib/financial-data-hub/payslip/types` — the
 * bridge must stay usable by a future adapter whose evidence is a bank
 * statement or an investment statement, and coupling it to FDH's payslip types
 * would defeat that.
 */
export interface IncomeEvidence {
  payrollEventId: string;
  employerName?: string;
  currencyCode: string;
  /** Canonical `income_sources.frequency` value, or null when the payroll
   * frequency has no canonical equivalent (semimonthly / irregular / unknown). */
  canonicalFrequency: string | null;
  /** True when the payslip literally stated its frequency. */
  frequencyStated: boolean;
  grossPay?: number;
  netPay?: number;
  /** Variable components in THIS pay period. */
  bonusPay?: number;
  overtimePay?: number;
  commissionPay?: number;
  arrearsPay?: number;
  reimbursementsTotal?: number;
  /** Whether the payslip's stated gross already includes reimbursements. */
  reimbursementsIncludedInGross: boolean;
  /** Review reasons carried from extraction/reconciliation/bank matching. */
  reviewReasons: string[];
  bankMatchStatus: 'matched' | 'no_match' | 'multiple_candidates' | 'not_attempted';
}

/** Every canonical column this adapter is EVER permitted to write. */
export const INCOME_APPLICABLE_FIELDS = [
  'source_name',
  'employer_name',
  'income_type',
  'amount',
  'net_amount',
  'frequency',
  'currency_code',
  'is_taxable',
] as const;

const FIELD_KINDS: Record<string, ImportValueKind> = {
  source_name: 'text',
  employer_name: 'text',
  income_type: 'enum',
  amount: 'money',
  net_amount: 'money',
  frequency: 'enum',
  currency_code: 'enum',
  is_taxable: 'bool',
};

/** Case/punctuation-folded employer comparison, for duplicate detection. */
function foldEmployer(name: string | null | undefined): string | null {
  if (!name) return null;
  const folded = name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  let out = folded;
  for (const suffix of ['pty ltd', 'pty limited', 'private limited', 'pvt ltd', 'limited', 'ltd', 'llp', 'inc', 'corp', 'company']) {
    if (out.endsWith(` ${suffix}`)) out = out.slice(0, -(suffix.length + 1)).trim();
  }
  return out || null;
}

/**
 * RECURRING gross for this pay period.
 *
 * gross MINUS every variable component, MINUS reimbursements when the stated
 * gross included them. Returns undefined when there is no gross to work from —
 * FDH-9 never substitutes net.
 */
export function computeRecurringGross(evidence: IncomeEvidence): number | undefined {
  if (evidence.grossPay === undefined) return undefined;
  const variable =
    (evidence.bonusPay ?? 0)
    + (evidence.overtimePay ?? 0)
    + (evidence.commissionPay ?? 0)
    + (evidence.arrearsPay ?? 0)
    + (evidence.reimbursementsIncludedInGross ? (evidence.reimbursementsTotal ?? 0) : 0);
  const recurring = evidence.grossPay - variable;
  // A negative or zero recurring gross means the period was entirely variable
  // pay (a bonus-only run). Proposing 0 as someone's salary would be wrong, so
  // nothing is proposed at all.
  return recurring > 0 ? Number(recurring.toFixed(2)) : undefined;
}

/** True when this pay period contained any variable component. */
export function hasVariablePay(evidence: IncomeEvidence): boolean {
  return Boolean(
    (evidence.bonusPay ?? 0)
    || (evidence.overtimePay ?? 0)
    || (evidence.commissionPay ?? 0)
    || (evidence.arrearsPay ?? 0),
  );
}

/**
 * Find an existing Income entry that likely represents the SAME employment
 * (spec section 29).
 *
 * Employer name is the primary signal; a salary row whose `source_name`
 * contains the employer is the fallback for rows entered before
 * `employer_name` was filled in. Deliberately conservative: a false positive
 * here proposes an UPDATE the user can decline, whereas a false negative
 * creates the duplicate Salary entry the spec explicitly forbids.
 */
export function findDuplicateIncome(
  evidence: IncomeEvidence,
  existing: readonly ExistingIncomeRow[],
): ExistingIncomeRow | null {
  const employer = foldEmployer(evidence.employerName);
  if (!employer) return null;

  const byEmployer = existing.find((row) => foldEmployer(row.employer_name) === employer);
  if (byEmployer) return byEmployer;

  const byName = existing.find(
    (row) => row.income_type === 'salary' && (foldEmployer(row.source_name) ?? '').includes(employer),
  );
  return byName ?? null;
}

function field(
  fieldName: string,
  proposed: unknown,
  existingRow: ExistingIncomeRow | null,
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

export const incomeAdapter: ImportDomainAdapter<IncomeEvidence, ExistingIncomeRow> = {
  domain: 'income',
  applicableFields: INCOME_APPLICABLE_FIELDS,

  buildProposal(evidence, existing): ImportProposalDraft {
    const duplicate = findDuplicateIncome(evidence, existing);
    const target = duplicate;
    const recommendedApplyMode: RecommendedApplyMode = target ? 'update_existing' : 'add_new';

    const recurringGross = computeRecurringGross(evidence);
    const variable = hasVariablePay(evidence);
    const reviewReasons = [...evidence.reviewReasons];

    const fields: ProposedField[] = [];

    // --- source_name: only when creating a new entry ------------------------
    // Renaming a row the user named themselves is not this bridge's business.
    if (!target) {
      fields.push(field(
        'source_name',
        evidence.employerName ? `Salary — ${evidence.employerName}` : 'Salary',
        null,
        { reasonCode: 'derived_from_employer' },
      ));
      fields.push(field('income_type', 'salary', null, { reasonCode: 'payslip_is_employment_income' }));
      fields.push(field('is_taxable', true, null, { reasonCode: 'employment_income_is_taxable' }));
    }

    if (evidence.employerName) {
      fields.push(field('employer_name', evidence.employerName, target, { reasonCode: 'read_from_payslip' }));
    }

    // --- amount: GROSS recurring, never net ---------------------------------
    if (recurringGross !== undefined) {
      fields.push(field('amount', recurringGross, target, {
        reasonCode: variable ? 'recurring_gross_excludes_variable_pay' : 'gross_from_payslip',
      }));
      if (variable) {
        reviewReasons.push('variable_pay_excluded_from_recurring');
      }
    } else {
      reviewReasons.push('no_gross_pay_on_payslip');
    }

    // --- net_amount: only when this period is representative ----------------
    // A period containing a bonus has an unrepresentative net, so proposing it
    // as the ongoing net would be misleading.
    if (evidence.netPay !== undefined && !variable) {
      fields.push(field('net_amount', evidence.netPay, target, { reasonCode: 'net_from_payslip' }));
    } else if (evidence.netPay !== undefined && variable) {
      reviewReasons.push('net_not_proposed_period_includes_variable_pay');
    }

    // --- frequency: cautious ------------------------------------------------
    // Proposed only when the payroll frequency has a canonical equivalent, and
    // marked requires_confirmation unless the payslip literally stated it
    // (spec section 27).
    if (evidence.canonicalFrequency) {
      fields.push(field('frequency', evidence.canonicalFrequency, target, {
        requiresConfirmation: !evidence.frequencyStated,
        reasonCode: evidence.frequencyStated ? 'frequency_stated_on_payslip' : 'frequency_inferred_single_payslip',
      }));
      if (!evidence.frequencyStated) reviewReasons.push('frequency_uncertain');
    } else {
      reviewReasons.push('frequency_has_no_canonical_equivalent');
    }

    if (!target) {
      fields.push(field('currency_code', evidence.currencyCode, null, { reasonCode: 'read_from_payslip' }));
    }

    if (evidence.bankMatchStatus === 'no_match') reviewReasons.push('bank_deposit_not_found');
    if (evidence.bankMatchStatus === 'multiple_candidates') reviewReasons.push('multiple_matching_deposits');

    return {
      targetDomain: 'income',
      sourceKind: 'payslip',
      currencyCode: evidence.currencyCode,
      targetEntityId: target?.id ?? null,
      targetEntityUpdatedAt: target?.updated_at ?? null,
      recommendedApplyMode,
      duplicateOfEntityId: duplicate?.id ?? null,
      fields,
      summary: buildSummary(evidence, recurringGross, variable, target, reviewReasons),
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
      // A brand-new Income entry is meaningless without a name and an amount.
      const names = new Set(selected);
      if (!names.has('source_name')) return { ok: false, error: 'A new income entry needs a name.' };
      if (!names.has('amount')) return { ok: false, error: 'A new income entry needs a gross amount.' };
      if (!names.has('frequency')) return { ok: false, error: 'A new income entry needs a frequency.' };
    }
    // Every selected field must genuinely be part of this proposal.
    const known = new Set(fields.map((f) => f.fieldName));
    for (const name of selected) {
      if (!known.has(name)) return { ok: false, error: `Field ${name} is not part of this proposal.` };
    }
    return { ok: true };
  },
};

/**
 * The non-negotiable base of a NEW income row.
 *
 * These are not proposed fields — the user does not tick them — but a row
 * cannot exist without them. `owner` defaults to 'self' because a payslip
 * carries no evidence about which household member the income belongs to, and
 * inventing one would be worse than a sensible default the user can change.
 */
export function newIncomeRowDefaults(): Record<string, unknown> {
  return { owner: 'self', is_active: true, source_type: 'payslip_import' };
}

function buildSummary(
  evidence: IncomeEvidence,
  recurringGross: number | undefined,
  variable: boolean,
  target: ExistingIncomeRow | null,
  reviewReasons: string[],
): ImportProposalDraft['summary'] {
  const lines: { label: string; value: string; note?: string }[] = [];
  const money = (n: number | undefined) =>
    n === undefined ? 'Not shown on payslip' : n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  lines.push({ label: 'Employer', value: evidence.employerName ?? 'Not identified' });
  lines.push({ label: 'Income type', value: 'Salary' });
  lines.push({
    label: 'Pay frequency',
    value: evidence.canonicalFrequency ?? 'Not certain',
    note: evidence.frequencyStated ? 'Stated on your payslip' : 'Worked out from this payslip — please confirm',
  });
  lines.push({
    label: 'Ordinary gross pay',
    value: money(recurringGross),
    note: variable ? 'Bonus, overtime and commission are left out of your regular income' : undefined,
  });
  if (variable) {
    const variableTotal =
      (evidence.bonusPay ?? 0) + (evidence.overtimePay ?? 0)
      + (evidence.commissionPay ?? 0) + (evidence.arrearsPay ?? 0);
    lines.push({
      label: 'Variable pay this period',
      value: money(Number(variableTotal.toFixed(2))),
      note: 'Recorded as evidence — not added to your regular income',
    });
  }
  lines.push({ label: 'Net pay', value: money(evidence.netPay), note: 'What actually reached your account' });
  if (evidence.bankMatchStatus === 'matched') {
    lines.push({
      label: 'Bank deposit',
      value: 'Matched',
      note: 'Your payslip and your bank deposit are the same payment — counted once',
    });
  }

  return {
    title: target
      ? `Update your existing income entry “${target.source_name}”?`
      : 'Add this as a new income source?',
    lines,
    reviewReasons: [...new Set(reviewReasons)],
  };
}

/**
 * WP-09 (GAP-07) -- plain-language words for every review reason and field
 * reason code the Income adapter (lib/import-bridge/adapters/incomeAdapter.ts)
 * and the proposal service can emit. Before this the adapter's explanation was
 * built and thrown away, and the compare step showed none of it.
 *
 * tests/unit/fdh9IncomeApplyGuards.test.ts scans the adapter and the service
 * for every code they emit and fails if one has no words here.
 */

export const REVIEW_REASON_TEXT: Record<string, string> = {
  gross_to_net_variance: 'Your gross pay minus deductions does not exactly equal your net pay on this payslip.',
  gross_to_net_insufficient_data: 'This payslip does not show enough deductions to check gross against net.',
  variable_pay_excluded_from_recurring: 'Bonus, overtime and commission are left out of your regular income. They count once, as one-off income on their pay date.',
  no_gross_pay_on_payslip: 'No gross pay could be read from this payslip, so no regular amount is proposed.',
  net_not_proposed_period_includes_variable_pay: 'Take-home pay this period includes one-off pay, so it is not proposed as your usual take-home pay.',
  frequency_uncertain: 'How often you are paid was worked out from this one payslip. Please confirm it.',
  frequency_has_no_canonical_equivalent: 'This payslip is paid twice a month or irregularly. Choose how often to record it before adding it as new income.',
  bank_deposit_not_found: 'No matching bank deposit was found yet. When you import the bank statement it will be matched and counted once.',
  multiple_matching_deposits: 'More than one bank deposit matches this payslip. It is counted once either way.',
  existing_income_in_other_currency: 'You have an income entry for this employer in another currency. It is not updated, because the currencies are never mixed.',
  revised_payslip: 'This payslip replaces an earlier one for the same pay period.',
  reimbursement_inclusion_assumed: 'This payslip does not show whether its gross includes reimbursements, so they were taken out to be safe.',
  salary_sacrifice_basis_unknown: 'This payslip shows salary sacrifice but not whether its gross is before or after it.',
  matched_catalogue_salary_without_employer: 'Your existing Employment Salary entry has no employer, so it is proposed as the entry this payslip updates. Choose "add as a new income source" if it is a different job.',
};

export const FIELD_REASON_TEXT: Record<string, string> = {
  derived_from_employer: 'Named after the employer on your payslip',
  payslip_is_employment_income: 'A payslip is employment income',
  employment_income_is_taxable: 'Employment income is taxable',
  read_from_payslip: 'Read from your payslip',
  recurring_gross_excludes_variable_pay: 'Your regular gross, without bonus, overtime or commission',
  gross_from_payslip: 'Gross pay from your payslip',
  net_from_payslip: 'Take-home pay from your payslip',
  net_converted_to_chosen_frequency: 'Take-home pay converted to the frequency you chose',
  frequency_stated_on_payslip: 'Stated on your payslip',
  frequency_inferred_single_payslip: 'Worked out from this payslip — please confirm',
  frequency_chosen_by_user: 'You chose this',
  semimonthly_converted_to_chosen_frequency: 'Twice-monthly pay converted to the frequency you chose',
};

export function reviewReasonText(code: string): string {
  return REVIEW_REASON_TEXT[code] ?? 'Please check this detail before applying.';
}

export function fieldReasonText(code: string | null | undefined): string | null {
  if (!code) return null;
  return FIELD_REASON_TEXT[code] ?? null;
}

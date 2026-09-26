/**
 * Field dispositions -- PAYSLIP (native parser + AI fallback) and the payroll
 * evidence tables. Owner: WP-09. Matrix section 2.
 *
 * WP-09 closed GAP-03 (write), GAP-04, GAP-05, GAP-07, GAP-08, GAP-10, GAP-12
 * and GAP-15 here:
 *  - every evidence figure is user-visible in Income > Payslip details
 *    (components/income/PayslipDetails.tsx, from the review step and from an
 *    imported Income row), labelled from THIS registry (lib/income/
 *    payslipDetails.ts);
 *  - variable pay is a dated one-off actual income event of the Applied
 *    payslip's Income row (selectIncome actual.variablePay, PO D-06), deduped
 *    against the matched bank credit;
 *  - owner, currency and event-level idempotency are enforced by the 0210
 *    apply RPC; the bank match is re-stamped on bank approval.
 * Still open: GAP-01 (the dashboard consumers switch in WP-03) and GAP-09
 * (null net = unknown in the consumers, WP-03).
 */
import { A, B, C, D, E, gap, rows, technical, type Row } from './build';
import type { RegistryFile } from './types';

const GAP01 = gap('GAP-01', 'P0', 'WP-03'); // dedupe key honoured by selectIncome (WP-02); consumers switch in WP-03
const GAP09 = gap('GAP-09', 'P2', 'WP-03');

const INCOME = 'Income tab';
const DETAILS = 'Income > Payslip details';
const EV = (col: string) => `evidence:fdh_payroll_events.${col}`;
const VARIABLE = "income_sources (the Applied payslip's row) -> selectIncome actual.variablePay: dated one-off actual income, deduped against the matched bank credit (PO D-06)";
const VARIABLE_SEEN = 'Income > Actual income (one-off pay)';

/** Shared by the native type, the AI schema and the table (field -> column). */
function payslipFacts(style: 'camel' | 'snake'): Row[] {
  const f = (camel: string, snake: string) => (style === 'camel' ? camel : snake);
  return [
    [f('employerName', 'employer_name'), A, 'income_sources.employer_name', INCOME],
    [f('payPeriodStart', 'pay_period_start'), C, EV('pay_period_start'), DETAILS],
    [f('payPeriodEnd', 'pay_period_end'), C, EV('pay_period_end'), DETAILS],
    [f('paymentDate', 'payment_date'), C, EV('payment_date') + ' (economic date)', DETAILS],
    [f('payFrequency', 'pay_frequency'), A, 'income_sources.frequency (user-confirmed; semimonthly / irregular / unknown: user chooses)', INCOME],
    [f('grossPay', 'gross_pay'), A, 'income_sources.amount (recurring gross)', INCOME],
    [f('basePay', 'base_pay'), C, EV('base_pay'), DETAILS],
    [f('overtimePay', 'overtime_pay'), B, VARIABLE, VARIABLE_SEEN],
    [f('bonusPay', 'bonus_pay'), B, VARIABLE, VARIABLE_SEEN],
    [f('commissionPay', 'commission_pay'), B, VARIABLE, VARIABLE_SEEN],
    [f('allowancesTotal', 'allowances_total'), A, 'income_sources.amount (inside recurring gross)', DETAILS],
    [f('reimbursementsTotal', 'reimbursements_total'), E, 'not income (taken out of recurring gross when the payslip lines show it is inside gross)', `${DETAILS} ("Not income")`],
    [f('otherEarnings', 'other_earnings'), B, VARIABLE, VARIABLE_SEEN],
    [f('taxWithheld', 'tax_withheld'), C, EV('tax_withheld'), DETAILS],
    [f('employeeDeductionsTotal', 'employee_deductions_total'), C, EV('employee_deductions_total'), DETAILS],
    [f('salarySacrifice', 'salary_sacrifice'), C, EV('salary_sacrifice') + ' (+ the recorded gross basis)', DETAILS],
    [f('professionalTax', 'professional_tax'), C, EV('professional_tax'), DETAILS],
    [f('employerRetirementContribution', 'employer_retirement_contribution'), C, EV('employer_retirement_contribution') + ' (never income)', DETAILS],
    [f('employeeRetirementContribution', 'employee_retirement_contribution'), C, EV('employee_retirement_contribution'), DETAILS],
    [f('employerNpsContribution', 'employer_nps_contribution'), C, EV('employer_nps_contribution') + ' (never income)', DETAILS],
    [f('employeeNpsContribution', 'employee_nps_contribution'), C, EV('employee_nps_contribution'), DETAILS],
    [f('netPay', 'net_pay'), A, 'income_sources.net_amount (null = unknown, never gross)', INCOME, GAP09],
  ];
}

const YTD: Row[] = [
  ['ytdGross', C, EV('ytd_gross') + ' (never summed)', DETAILS],
  ['ytdTax', C, EV('ytd_tax'), DETAILS],
  ['ytdNet', C, EV('ytd_net'), DETAILS],
  ['ytdEmployerRetirement', C, EV('ytd_employer_retirement'), DETAILS],
  ['ytdEmployeeRetirement', C, EV('ytd_employee_retirement'), DETAILS],
];

const NATIVE: Row[] = [
  ['country', D, 'fdh_payroll_events.country_code'],
  ['currencyCode', A, 'income_sources.currency_code (CURRENCY_MISMATCH on update, 0210)', INCOME],
  ['payFrequencySource', D, 'fdh_payroll_events.pay_frequency_source'],
  ['grossPaySource', D, 'fdh_payroll_events.gross_pay_source'],
  ...payslipFacts('camel'),
  ...YTD,
  ['components', C, 'evidence:fdh_payroll_components', DETAILS],
  ['parserName', D, 'fdh_payroll_events.parser_name'],
  ['parserVersion', D, 'fdh_payroll_events.parser_version'],
  ['extractionConfidence', D, 'fdh_payroll_events.extraction_confidence'],
  ['warnings', D, 'fdh_payroll_events.review_status (warnings force review)'],
];

const COMPONENT: Row[] = [
  ['side', C, 'evidence:fdh_payroll_components.component_side', DETAILS],
  ['type', C, 'evidence:fdh_payroll_components.component_type', DETAILS],
  ['labelRaw', C, 'evidence:fdh_payroll_components.label_raw', DETAILS],
  ['amount', C, 'evidence:fdh_payroll_components.amount', DETAILS],
  ['isYearToDate', C, 'evidence:fdh_payroll_components.is_year_to_date', DETAILS],
];

const AI: Row[] = [
  ['schemaVersion', D, 'aie run evidence'],
  ['documentMissingReasonCode', D, 'aie run evidence'],
  ...payslipFacts('camel'),
];

const EVENTS: Row[] = [
  ...technical(['id', 'user_id', 'household_id', 'statement_upload_id', 'employer_normalised', 'country_code'], 'fdh_payroll_events'),
  ['currency_code', A, 'income_sources.currency_code (CURRENCY_MISMATCH on update, 0210)', INCOME],
  ['pay_frequency_source', D, 'fdh_payroll_events.pay_frequency_source'],
  ...payslipFacts('snake'),
  ['ytd_gross', C, EV('ytd_gross'), DETAILS],
  ['ytd_tax', C, EV('ytd_tax'), DETAILS],
  ['ytd_net', C, EV('ytd_net'), DETAILS],
  ['ytd_employer_retirement', C, EV('ytd_employer_retirement'), DETAILS],
  ['ytd_employee_retirement', C, EV('ytd_employee_retirement'), DETAILS],
  ...technical(['parser_name', 'parser_version', 'extraction_confidence', 'reconciliation_status', 'reconciliation_variance'], 'fdh_payroll_events'),
  ['bank_match_status', D, 'fdh_payroll_events.bank_match_status (re-matched on bank approval: fdh9_restamp_payroll_bank_match, 0210)'],
  ['bank_match_transaction_id', D, 'dedup link: the payslip and its bank credit are ONE income event (selectIncome)', null, GAP01],
  ...technical(['bank_match_confidence', 'review_status', 'approval_status', 'approved_at', 'approved_by'], 'fdh_payroll_events'),
  ['superseded_by_payroll_event_id', D, 'fdh_payroll_events.superseded_by_payroll_event_id (fdh9_supersede_payroll_event, 0210)'],
  ...technical(['payslip_fingerprint', 'created_at', 'updated_at', 'gross_pay_source', 'user_corrected_fields', 'last_corrected_at', 'last_corrected_by'], 'fdh_payroll_events'),
  ['income_owner', A, 'income_sources.owner (self / spouse, chosen at upload, fixed at approval; 0210 MEMBER_MISMATCH)', INCOME],
];

const COMPONENTS_TABLE: Row[] = [
  ...technical(['id', 'user_id', 'payroll_event_id'], 'fdh_payroll_components'),
  ['component_side', C, 'evidence:fdh_payroll_components.component_side', DETAILS],
  ['component_type', C, 'evidence:fdh_payroll_components.component_type', DETAILS],
  ['label_raw', C, 'evidence:fdh_payroll_components.label_raw', DETAILS],
  ['amount', C, 'evidence:fdh_payroll_components.amount', DETAILS],
  ['is_year_to_date', C, 'evidence:fdh_payroll_components.is_year_to_date', DETAILS],
  ['created_at', D, 'fdh_payroll_components.created_at'],
];

export const payslipRegistry: RegistryFile = {
  id: 'payslip',
  ownerWp: 'WP-09',
  OPEN_GAP_CEILING: 4,
  entries: [
    ...rows('payslip_native', 'ts_interface', 'fdh:payslip/types.ts#PayrollExtraction', NATIVE),
    ...rows('payslip_native', 'ts_interface', 'fdh:payslip/types.ts#PayrollComponent', COMPONENT),
    ...rows('payslip_ai', 'zod_schema', 'aie:payslip/schema.ts#payslipDocumentFactsSchema', AI),
    ...rows('payslip_native', 'db_column', 'db:fdh_payroll_events', EVENTS),
    ...rows('payslip_native', 'db_column', 'db:fdh_payroll_components', COMPONENTS_TABLE),
  ],
};

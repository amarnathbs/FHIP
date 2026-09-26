/**
 * Field dispositions -- PAYSLIP (native parser + AI fallback) and the payroll
 * evidence tables. Owner: WP-09. Matrix section 2.
 */
import { A, B, C, D, E, gap, rows, technical, type Row } from './build';
import type { RegistryFile } from './types';

// GAP-01 and GAP-09 closed by WP-03 (2026-09-27): the Dashboard takes income
// from selectIncome (payslip + its matched bank credit = one event), and an
// unknown net is never replaced by the gross.
const GAP03 = gap('GAP-03', 'P1', 'WP-09');
const GAP04 = gap('GAP-04', 'P1', 'WP-09');
const GAP05 = gap('GAP-05', 'P1', 'WP-09');
const GAP07 = gap('GAP-07', 'P2', 'WP-09');
const GAP08 = gap('GAP-08', 'P2', 'WP-09');
const GAP10 = gap('GAP-10', 'P2', 'WP-09');
const GAP12 = gap('GAP-12', 'P3', 'WP-09');
const GAP15 = gap('GAP-15', 'P3', 'WP-09');

const INCOME = 'Income tab';
const EV = (col: string) => `evidence:fdh_payroll_events.${col}`;
const VARIABLE = 'fdh_transactions(income, one-off, dated, deduped against the matched bank credit -- D-06)';

/** Shared by the native type, the AI schema and the table (field -> column). */
function payslipFacts(style: 'camel' | 'snake'): Row[] {
  const f = (camel: string, snake: string) => (style === 'camel' ? camel : snake);
  return [
    [f('employerName', 'employer_name'), A, 'income_sources.employer_name', INCOME, GAP04],
    [f('payPeriodStart', 'pay_period_start'), C, EV('pay_period_start'), null, GAP07],
    [f('payPeriodEnd', 'pay_period_end'), C, EV('pay_period_end'), null, GAP07],
    [f('paymentDate', 'payment_date'), C, EV('payment_date') + ' (economic date)', null, GAP07],
    [f('payFrequency', 'pay_frequency'), A, 'income_sources.frequency (user-confirmed)', INCOME, GAP12],
    [f('grossPay', 'gross_pay'), A, 'income_sources.amount (recurring gross)', INCOME],
    [f('basePay', 'base_pay'), C, EV('base_pay'), null, GAP07],
    [f('overtimePay', 'overtime_pay'), B, VARIABLE, null, GAP08],
    [f('bonusPay', 'bonus_pay'), B, VARIABLE, null, GAP08],
    [f('commissionPay', 'commission_pay'), B, VARIABLE, null, GAP08],
    [f('allowancesTotal', 'allowances_total'), A, 'income_sources.amount (inside recurring gross)', null, GAP07],
    [f('reimbursementsTotal', 'reimbursements_total'), E, 'not income (subtracted from recurring gross)', null, GAP07],
    [f('otherEarnings', 'other_earnings'), B, VARIABLE, null, GAP08],
    [f('taxWithheld', 'tax_withheld'), C, EV('tax_withheld'), null, GAP07],
    [f('employeeDeductionsTotal', 'employee_deductions_total'), C, EV('employee_deductions_total'), null, GAP07],
    [f('salarySacrifice', 'salary_sacrifice'), C, EV('salary_sacrifice'), null, GAP07],
    [f('professionalTax', 'professional_tax'), C, EV('professional_tax'), null, GAP07],
    [f('employerRetirementContribution', 'employer_retirement_contribution'), C, EV('employer_retirement_contribution') + ' (never income)', 'Income > Import from payslip (evidence only)'],
    [f('employeeRetirementContribution', 'employee_retirement_contribution'), C, EV('employee_retirement_contribution'), null, GAP07],
    [f('employerNpsContribution', 'employer_nps_contribution'), C, EV('employer_nps_contribution') + ' (never income)', null, GAP07],
    [f('employeeNpsContribution', 'employee_nps_contribution'), C, EV('employee_nps_contribution'), null, GAP07],
    [f('netPay', 'net_pay'), A, 'income_sources.net_amount (null = unknown, never gross)', INCOME],
  ];
}

const YTD: Row[] = [
  ['ytdGross', C, EV('ytd_gross') + ' (never summed)', null, GAP07],
  ['ytdTax', C, EV('ytd_tax'), null, GAP07],
  ['ytdNet', C, EV('ytd_net'), null, GAP07],
  ['ytdEmployerRetirement', C, EV('ytd_employer_retirement'), null, GAP07],
  ['ytdEmployeeRetirement', C, EV('ytd_employee_retirement'), null, GAP07],
];

const NATIVE: Row[] = [
  ['country', D, 'fdh_payroll_events.country_code'],
  ['currencyCode', A, 'income_sources.currency_code', INCOME, GAP03],
  ['payFrequencySource', D, 'fdh_payroll_events.pay_frequency_source'],
  ['grossPaySource', D, 'fdh_payroll_events.gross_pay_source'],
  ...payslipFacts('camel'),
  ...YTD,
  ['components', C, 'evidence:fdh_payroll_components', null, GAP07],
  ['parserName', D, 'fdh_payroll_events.parser_name'],
  ['parserVersion', D, 'fdh_payroll_events.parser_version'],
  ['extractionConfidence', D, 'fdh_payroll_events.extraction_confidence'],
  ['warnings', D, 'fdh_payroll_events.review_status (warnings force review)'],
];

const COMPONENT: Row[] = [
  ['side', C, 'evidence:fdh_payroll_components.component_side', null, GAP07],
  ['type', C, 'evidence:fdh_payroll_components.component_type', null, GAP07],
  ['labelRaw', C, 'evidence:fdh_payroll_components.label_raw', null, GAP07],
  ['amount', C, 'evidence:fdh_payroll_components.amount', null, GAP07],
  ['isYearToDate', C, 'evidence:fdh_payroll_components.is_year_to_date', null, GAP07],
];

const AI: Row[] = [
  ['schemaVersion', D, 'aie run evidence'],
  ['documentMissingReasonCode', D, 'aie run evidence'],
  ...payslipFacts('camel'),
];

const EVENTS: Row[] = [
  ...technical(['id', 'user_id', 'household_id', 'statement_upload_id', 'employer_normalised', 'country_code'], 'fdh_payroll_events'),
  ['currency_code', A, 'income_sources.currency_code', INCOME, GAP03],
  ['pay_frequency_source', D, 'fdh_payroll_events.pay_frequency_source'],
  ...payslipFacts('snake'),
  ['ytd_gross', C, EV('ytd_gross'), null, GAP07],
  ['ytd_tax', C, EV('ytd_tax'), null, GAP07],
  ['ytd_net', C, EV('ytd_net'), null, GAP07],
  ['ytd_employer_retirement', C, EV('ytd_employer_retirement'), null, GAP07],
  ['ytd_employee_retirement', C, EV('ytd_employee_retirement'), null, GAP07],
  ...technical(['parser_name', 'parser_version', 'extraction_confidence', 'reconciliation_status', 'reconciliation_variance'], 'fdh_payroll_events'),
  ['bank_match_status', D, 'fdh_payroll_events.bank_match_status', null, GAP10],
  ['bank_match_transaction_id', D, 'dedup link: the payslip and its bank credit are ONE income event (selectIncome)'],
  ...technical(['bank_match_confidence', 'review_status', 'approval_status', 'approved_at', 'approved_by'], 'fdh_payroll_events'),
  ['superseded_by_payroll_event_id', D, 'fdh_payroll_events.superseded_by_payroll_event_id', null, GAP15],
  ...technical(['payslip_fingerprint', 'created_at', 'updated_at', 'gross_pay_source', 'user_corrected_fields', 'last_corrected_at', 'last_corrected_by'], 'fdh_payroll_events'),
  ['income_owner', A, 'income_sources.owner (self / spouse, chosen at upload)', null, GAP05],
];

const COMPONENTS_TABLE: Row[] = [
  ...technical(['id', 'user_id', 'payroll_event_id'], 'fdh_payroll_components'),
  ['component_side', C, 'evidence:fdh_payroll_components.component_side', null, GAP07],
  ['component_type', C, 'evidence:fdh_payroll_components.component_type', null, GAP07],
  ['label_raw', C, 'evidence:fdh_payroll_components.label_raw', null, GAP07],
  ['amount', C, 'evidence:fdh_payroll_components.amount', null, GAP07],
  ['is_year_to_date', C, 'evidence:fdh_payroll_components.is_year_to_date', null, GAP07],
  ['created_at', D, 'fdh_payroll_components.created_at'],
];

export const payslipRegistry: RegistryFile = {
  id: 'payslip',
  ownerWp: 'WP-09',
  OPEN_GAP_CEILING: 83,
  entries: [
    ...rows('payslip_native', 'ts_interface', 'fdh:payslip/types.ts#PayrollExtraction', NATIVE),
    ...rows('payslip_native', 'ts_interface', 'fdh:payslip/types.ts#PayrollComponent', COMPONENT),
    ...rows('payslip_ai', 'zod_schema', 'aie:payslip/schema.ts#payslipDocumentFactsSchema', AI),
    ...rows('payslip_native', 'db_column', 'db:fdh_payroll_events', EVENTS),
    ...rows('payslip_native', 'db_column', 'db:fdh_payroll_components', COMPONENTS_TABLE),
  ],
};

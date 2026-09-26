/**
 * WP-09 (GAP-07) -- every figure a payslip carries, grouped for the Payslip
 * details view, each with the plain-language disposition the upload
 * field-disposition REGISTRY gives it (lib/canonical-data/disposition/
 * payslip.ts). The label is derived from the registry, never restated, so the
 * screen cannot claim a figure "is used in your income" when the registry says
 * it is evidence only (tests/unit/payslipDetails.test.ts pins that).
 *
 * Pure and client-safe: the registry files import nothing at runtime.
 */
import { payslipRegistry } from '@/lib/canonical-data/disposition/payslip';
import type { Disposition } from '@/lib/canonical-data/disposition/types';

export type PayslipDetailGroupId = 'current' | 'employer' | 'ytd';

export const PAYSLIP_DETAIL_GROUPS: { id: PayslipDetailGroupId; title: string; fields: { column: string; label: string; kind: 'money' | 'text' | 'date' }[] }[] = [
  {
    id: 'current',
    title: 'This pay period',
    fields: [
      { column: 'employer_name', label: 'Employer', kind: 'text' },
      { column: 'pay_period_start', label: 'Pay period start', kind: 'date' },
      { column: 'pay_period_end', label: 'Pay period end', kind: 'date' },
      { column: 'payment_date', label: 'Payment date', kind: 'date' },
      { column: 'pay_frequency', label: 'Pay frequency', kind: 'text' },
      { column: 'gross_pay', label: 'Gross pay', kind: 'money' },
      { column: 'base_pay', label: 'Ordinary earnings', kind: 'money' },
      { column: 'overtime_pay', label: 'Overtime', kind: 'money' },
      { column: 'bonus_pay', label: 'Bonus', kind: 'money' },
      { column: 'commission_pay', label: 'Commission', kind: 'money' },
      { column: 'allowances_total', label: 'Allowances', kind: 'money' },
      { column: 'reimbursements_total', label: 'Reimbursements', kind: 'money' },
      { column: 'other_earnings', label: 'Other earnings / arrears', kind: 'money' },
      { column: 'tax_withheld', label: 'Tax withheld', kind: 'money' },
      { column: 'employee_deductions_total', label: 'Other deductions', kind: 'money' },
      { column: 'salary_sacrifice', label: 'Salary sacrifice', kind: 'money' },
      { column: 'professional_tax', label: 'Professional tax', kind: 'money' },
      { column: 'employee_retirement_contribution', label: 'Your super / PF contribution', kind: 'money' },
      { column: 'employee_nps_contribution', label: 'Your NPS contribution', kind: 'money' },
      { column: 'net_pay', label: 'Net pay', kind: 'money' },
    ],
  },
  {
    id: 'employer',
    title: 'Paid by your employer on top of your pay',
    fields: [
      { column: 'employer_retirement_contribution', label: 'Employer super / PF', kind: 'money' },
      { column: 'employer_nps_contribution', label: 'Employer NPS', kind: 'money' },
    ],
  },
  {
    id: 'ytd',
    title: 'Year to date (never added to this period)',
    fields: [
      { column: 'ytd_gross', label: 'Gross pay, year to date', kind: 'money' },
      { column: 'ytd_tax', label: 'Tax, year to date', kind: 'money' },
      { column: 'ytd_net', label: 'Net pay, year to date', kind: 'money' },
      { column: 'ytd_employer_retirement', label: 'Employer super / PF, year to date', kind: 'money' },
      { column: 'ytd_employee_retirement', label: 'Your super / PF, year to date', kind: 'money' },
    ],
  },
];

const DISPOSITION_TEXT: Record<Disposition, string> = {
  A_STATE: 'Used in your income entry',
  B_EVENT: 'Counted as one-off income on its pay date',
  C_EVIDENCE: 'Evidence only — not added to your income',
  D_METADATA: 'Payslip detail',
  E_UNSUPPORTED: 'Not income — left out of your income',
};

/** Column -> registry entry for the payroll-event table. */
const EVENT_ENTRIES = new Map(
  payslipRegistry.entries.filter((e) => e.sourceRef === 'db:fdh_payroll_events').map((e) => [e.field, e] as const),
);

/** The registry's disposition for a payroll-event column (undefined = not in the registry). */
export function dispositionOf(column: string): Disposition | undefined {
  return EVENT_ENTRIES.get(column)?.disposition;
}

/** User-facing words for a payroll-event column's disposition. */
export function dispositionLabel(column: string): string {
  const d = dispositionOf(column);
  if (!d) return 'Payslip detail';
  if (column === 'employer_retirement_contribution' || column === 'employer_nps_contribution') {
    return 'Evidence only — never added to your take-home income';
  }
  return DISPOSITION_TEXT[d];
}

export interface PayslipDetailRow {
  column: string;
  label: string;
  kind: 'money' | 'text' | 'date';
  /** null = the payslip does not show it (never zero). */
  value: string | number | null;
  disposition: Disposition | null;
  dispositionLabel: string;
  corrected: boolean;
}

export interface PayslipComponentRow {
  side: string;
  type: string;
  label: string;
  amount: number;
  isYearToDate: boolean;
}

/** Pure: a payroll-event row (snake_case, as the API sends it) -> grouped detail rows. */
export function buildPayslipDetails(event: Record<string, unknown>, components: readonly Record<string, unknown>[] = []) {
  const corrected = new Set(Array.isArray(event.user_corrected_fields) ? (event.user_corrected_fields as string[]) : []);
  const groups = PAYSLIP_DETAIL_GROUPS.map((g) => ({
    id: g.id,
    title: g.title,
    rows: g.fields.map<PayslipDetailRow>((f) => {
      const raw = event[f.column];
      const value = raw === null || raw === undefined || raw === '' ? null : f.kind === 'money' ? Number(raw) : String(raw);
      return {
        column: f.column,
        label: f.label,
        kind: f.kind,
        value,
        disposition: dispositionOf(f.column) ?? null,
        dispositionLabel: dispositionLabel(f.column),
        corrected: corrected.has(f.column),
      };
    }),
  }));
  const componentRows: PayslipComponentRow[] = components.map((c) => ({
    side: String(c.component_side ?? ''),
    type: String(c.component_type ?? 'unknown'),
    label: String(c.label_raw ?? c.component_type ?? ''),
    amount: Number(c.amount ?? 0),
    isYearToDate: Boolean(c.is_year_to_date),
  }));
  return { currency: String(event.currency_code ?? 'AUD'), groups, components: componentRows };
}

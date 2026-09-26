'use client';

/**
 * WP-13 (GAP-RET-03 / GAP-RET-04) -- retirement statement EVIDENCE, visible.
 *
 * Canonical Retirement is a summary-balance register: applying a super
 * statement sets one account's balance (and, only if the user ticks them, its
 * contribution rates). Everything else the statement said is evidence --
 * contributions, rollovers, earnings, fees, insurance, tax, and the investment
 * options held inside the fund -- and the brief requires that evidence to stay
 * USER-VISIBLE after Apply. This file renders it:
 *
 *   - `RetirementStatementDetails`: one statement -- every header total
 *     (including salary sacrifice, government contributions, rollovers in/out,
 *     withdrawals, pension payments and the year-to-date figures), what the
 *     reader could not read, the full contribution history with every activity
 *     column (description, employer, payslip / bank / rollover match), and the
 *     holdings in super with every column, labelled "not added to Net Worth".
 *     The import panel's review step uses this SAME component.
 *   - `RetirementStatementHistory`: the Retirement tab's paged list of the
 *     user's approved statements, each expandable into its details.
 *
 * Nothing here is summed into any total. API rows are snake_case and are read
 * through `normaliseRetirementHistory` (a contract test pins that the screen
 * reads the fields the API sends -- a camelCase cast renders blank).
 */

import { useCallback, useEffect, useState } from 'react';
import { formatMoneyExact } from '@/lib/engines/money';
import { NUM_CELL_CLASS, NUM_HEADER_CLASS } from '@/lib/ui/tableAlign';
import { fdhApi } from '@/lib/import-bridge/fdhRoutes';

// ---------------------------------------------------------------------------
// Row shapes (snake_case, exactly as the API sends them)
// ---------------------------------------------------------------------------

export interface RetirementStatementRow {
  id: string;
  statement_upload_id: string | null;
  statement_type: string;
  retirement_jurisdiction: string;
  account_type: string;
  fund_name: string | null;
  nickname: string | null;
  masked_account_identifier: string | null;
  currency_code: string;
  statement_date: string | null;
  statement_start_date: string | null;
  statement_end_date: string | null;
  opening_balance: string | null;
  closing_balance: string | null;
  employer_contributions: string | null;
  personal_contributions: string | null;
  salary_sacrifice: string | null;
  government_contributions: string | null;
  rollovers_in: string | null;
  rollovers_out: string | null;
  withdrawals: string | null;
  pension_payments: string | null;
  investment_earnings: string | null;
  fees: string | null;
  insurance_premiums: string | null;
  tax: string | null;
  ytd_employer_contributions: string | null;
  ytd_personal_contributions: string | null;
  extraction_status: string;
  reconciliation_status: string;
  reconciliation_variance: string | null;
  account_match_status: string;
  canonical_account_id: string | null;
  retirement_member_id: string | null;
  smsf_classification: string;
  approval_status: string;
  review_status: string;
  extraction_warnings: RetirementExtractionWarning[];
}

export interface RetirementExtractionWarning {
  code: string;
  count?: number;
  detail?: string;
}

export interface RetirementBankLeg {
  id: string;
  transaction_date: string | null;
  description_clean: string | null;
  amount_original: string | null;
  currency_original: string | null;
  credit_debit: string | null;
}

export interface RetirementActivityRow {
  id: string;
  activity_type: string;
  activity_date: string | null;
  effective_period_start: string | null;
  effective_period_end: string | null;
  amount: string;
  currency_code: string;
  description_raw: string | null;
  employer_name_raw: string | null;
  is_summary_total: boolean;
  is_year_to_date: boolean;
  payslip_match_status: string;
  payslip_match_variance: string | null;
  bank_match_status: string;
  linked_transaction_id: string | null;
  bank_leg_confirmed_at: string | null;
  bank_leg_confirmed_type: string | null;
  rollover_match_status: string;
  duplicate_of_activity_id: string | null;
  bank_leg: RetirementBankLeg | null;
}

export interface RetirementPositionRow {
  id: string;
  option_name_raw: string;
  asset_class_raw: string | null;
  ticker_raw: string | null;
  isin: string | null;
  units: string | null;
  unit_price: string | null;
  market_value: string | null;
  currency_code: string;
  valuation_date: string | null;
}

export interface RetirementHistoryItem {
  statement: RetirementStatementRow;
  activities: RetirementActivityRow[];
  positions: RetirementPositionRow[];
  accountName: string | null;
  outcome: 'applied' | 'kept_existing' | 'not_applied';
  appliedAt: string | null;
}

export interface RetirementHistoryPage {
  items: RetirementHistoryItem[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
}

// ---------------------------------------------------------------------------
// Contract: API JSON -> typed rows. Tolerant, never throws, drops malformed rows.
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));
const bool = (v: unknown): boolean => v === true;

function warnings(v: unknown): RetirementExtractionWarning[] {
  if (!Array.isArray(v)) return [];
  return v.filter(isObj).filter((w) => typeof w.code === 'string').map((w) => ({
    code: String(w.code),
    ...(typeof w.count === 'number' ? { count: w.count } : {}),
    ...(typeof w.detail === 'string' ? { detail: w.detail } : {}),
  }));
}

const STATEMENT_TEXT_FIELDS = [
  'statement_upload_id', 'fund_name', 'nickname', 'masked_account_identifier', 'statement_date', 'statement_start_date',
  'statement_end_date', 'opening_balance', 'closing_balance', 'employer_contributions', 'personal_contributions',
  'salary_sacrifice', 'government_contributions', 'rollovers_in', 'rollovers_out', 'withdrawals', 'pension_payments',
  'investment_earnings', 'fees', 'insurance_premiums', 'tax', 'ytd_employer_contributions', 'ytd_personal_contributions',
  'reconciliation_variance', 'canonical_account_id', 'retirement_member_id',
] as const;

export function normaliseRetirementStatement(raw: unknown): RetirementStatementRow | null {
  if (!isObj(raw) || typeof raw.id !== 'string') return null;
  const out: Json = {
    id: raw.id,
    statement_type: String(raw.statement_type ?? ''),
    retirement_jurisdiction: String(raw.retirement_jurisdiction ?? ''),
    account_type: String(raw.account_type ?? 'unknown'),
    currency_code: String(raw.currency_code ?? 'AUD'),
    extraction_status: String(raw.extraction_status ?? ''),
    reconciliation_status: String(raw.reconciliation_status ?? ''),
    account_match_status: String(raw.account_match_status ?? ''),
    smsf_classification: String(raw.smsf_classification ?? ''),
    approval_status: String(raw.approval_status ?? ''),
    review_status: String(raw.review_status ?? ''),
    extraction_warnings: warnings(raw.extraction_warnings),
  };
  for (const f of STATEMENT_TEXT_FIELDS) out[f] = str(raw[f]);
  return out as unknown as RetirementStatementRow;
}

export function normaliseRetirementActivity(raw: unknown): RetirementActivityRow | null {
  if (!isObj(raw) || typeof raw.id !== 'string' || typeof raw.activity_type !== 'string') return null;
  const leg = isObj(raw.bank_leg) && typeof raw.bank_leg.id === 'string'
    ? {
      id: raw.bank_leg.id,
      transaction_date: str(raw.bank_leg.transaction_date),
      description_clean: str(raw.bank_leg.description_clean),
      amount_original: str(raw.bank_leg.amount_original),
      currency_original: str(raw.bank_leg.currency_original),
      credit_debit: str(raw.bank_leg.credit_debit),
    }
    : null;
  return {
    id: raw.id,
    activity_type: raw.activity_type,
    activity_date: str(raw.activity_date),
    effective_period_start: str(raw.effective_period_start),
    effective_period_end: str(raw.effective_period_end),
    amount: String(raw.amount ?? ''),
    currency_code: String(raw.currency_code ?? 'AUD'),
    description_raw: str(raw.description_raw),
    employer_name_raw: str(raw.employer_name_raw),
    is_summary_total: bool(raw.is_summary_total),
    is_year_to_date: bool(raw.is_year_to_date),
    payslip_match_status: String(raw.payslip_match_status ?? 'not_attempted'),
    payslip_match_variance: str(raw.payslip_match_variance),
    bank_match_status: String(raw.bank_match_status ?? 'not_attempted'),
    linked_transaction_id: str(raw.linked_transaction_id),
    bank_leg_confirmed_at: str(raw.bank_leg_confirmed_at),
    bank_leg_confirmed_type: str(raw.bank_leg_confirmed_type),
    rollover_match_status: String(raw.rollover_match_status ?? 'not_attempted'),
    duplicate_of_activity_id: str(raw.duplicate_of_activity_id),
    bank_leg: leg,
  };
}

export function normaliseRetirementPosition(raw: unknown): RetirementPositionRow | null {
  if (!isObj(raw) || typeof raw.id !== 'string') return null;
  return {
    id: raw.id,
    option_name_raw: String(raw.option_name_raw ?? 'Unnamed investment option'),
    asset_class_raw: str(raw.asset_class_raw),
    ticker_raw: str(raw.ticker_raw),
    isin: str(raw.isin),
    units: str(raw.units),
    unit_price: str(raw.unit_price),
    market_value: str(raw.market_value),
    currency_code: String(raw.currency_code ?? 'AUD'),
    valuation_date: str(raw.valuation_date),
  };
}

const notNull = <T,>(v: T | null): v is T => v !== null;

/** The list endpoint's JSON (with or without the `{ data }` envelope). */
export function normaliseRetirementHistory(json: unknown): RetirementHistoryPage {
  const body = isObj(json) && isObj(json.data) ? json.data : json;
  if (!isObj(body)) return { items: [], page: 1, pageSize: 0, total: 0, hasMore: false };
  const list = Array.isArray(body.statements) ? body.statements : [];
  const items: RetirementHistoryItem[] = [];
  for (const raw of list) {
    if (!isObj(raw)) continue;
    const statement = normaliseRetirementStatement(raw.statement);
    if (!statement) continue;
    const application = isObj(raw.application) ? raw.application : null;
    items.push({
      statement,
      activities: (Array.isArray(raw.activities) ? raw.activities : []).map(normaliseRetirementActivity).filter(notNull),
      positions: (Array.isArray(raw.positions) ? raw.positions : []).map(normaliseRetirementPosition).filter(notNull),
      accountName: str(raw.account_name),
      outcome: raw.outcome === 'applied' || raw.outcome === 'kept_existing' ? raw.outcome : 'not_applied',
      appliedAt: application ? str(application.applied_at) : null,
    });
  }
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  return {
    items,
    page: num(body.page, 1),
    pageSize: num(body.page_size, items.length),
    total: num(body.total, items.length),
    hasMore: body.has_more === true,
  };
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

/** NEVER renders "$0" for an absent value: "not shown" is a different fact. */
export function statementMoney(value: string | null | undefined, currency: string): string {
  if (value === null || value === undefined || value === '') return 'Not shown on statement';
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  return formatMoneyExact(n, currency);
}

export const ACTIVITY_LABELS: Record<string, string> = {
  EMPLOYER_CONTRIBUTION: 'Employer contribution',
  PERSONAL_CONTRIBUTION: 'Personal contribution',
  SALARY_SACRIFICE: 'Salary sacrifice',
  GOVERNMENT_CONTRIBUTION: 'Government contribution',
  ROLLOVER_IN: 'Transfer in (rollover)',
  ROLLOVER_OUT: 'Transfer out (rollover)',
  INVESTMENT_EARNINGS: 'Investment earnings',
  INTEREST: 'Interest',
  DISTRIBUTION: 'Distribution',
  FEE: 'Fee',
  INSURANCE_PREMIUM: 'Insurance premium',
  TAX: 'Tax',
  PENSION_PAYMENT: 'Pension payment',
  WITHDRAWAL: 'Withdrawal',
  ADJUSTMENT: 'Adjustment',
  OTHER: 'Other',
  UNKNOWN: 'Not recognised',
};

/** Where the money went, so an internal movement is never mistaken for
 * household cash. */
export const ACTIVITY_NOTES: Record<string, string> = {
  EMPLOYER_CONTRIBUTION: 'Paid by your employer into the fund — not household spending or extra take-home pay.',
  SALARY_SACRIFICE: 'Deducted from pay before tax — not household spending.',
  GOVERNMENT_CONTRIBUTION: 'Paid by the government into the fund — not salary.',
  PERSONAL_CONTRIBUTION: 'A transfer from your bank into retirement — not household spending.',
  ROLLOVER_IN: 'Moved in from another retirement account — not new money.',
  ROLLOVER_OUT: 'Moved out to another retirement account — not spending.',
  INVESTMENT_EARNINGS: 'Earned and kept inside the fund — no money reached your bank account.',
  INTEREST: 'Credited inside the fund — no money reached your bank account.',
  DISTRIBUTION: 'Credited inside the fund — no money reached your bank account.',
  FEE: 'Deducted from your retirement balance — not a separate household bill.',
  INSURANCE_PREMIUM: 'Paid from your retirement balance — not a separate household bill.',
  TAX: 'Deducted from your retirement balance by the fund.',
  PENSION_PAYMENT: 'Paid from the fund to your bank account — counted once, as income, when you confirm the bank payment.',
  WITHDRAWAL: 'Paid from the fund to your bank account — your own savings moving, not income.',
  UNKNOWN: 'We could not tell what this line is, so it is shown for your review and not counted anywhere.',
};

const RECONCILIATION_LABEL: Record<string, string> = {
  reconciled: 'The figures on this statement add up.',
  variance: 'The figures on this statement do not add up.',
  insufficient_data: 'This statement does not show enough detail to check the figures.',
};

const WARNING_LABELS: Record<string, string> = {
  unreadable_amount_rows_skipped: 'Lines skipped because the amount could not be read',
  unreadable_date_rows: 'Lines whose date could not be read (kept, without a date)',
  unclassified_activity_rows: 'Lines we could not classify (shown as "Not recognised")',
  unreadable_summary_rows_skipped: 'Summary lines skipped because the amount could not be read',
  unreadable_holding_rows_skipped: 'Holdings skipped because the value could not be read',
  unrecognised_summary_rows: 'Summary lines we did not recognise (not used)',
  unrecognised_summary_label: 'Not recognised',
  summed_summary_lines: 'Several lines were added together',
  conflicting_balance_lines: 'The statement showed two different figures for the same balance; the first was used',
  date_format_not_inferable: 'The date format could not be worked out',
  document_missing_reason: 'Something was missing from the document',
  more_warnings_not_listed: 'Further notes not listed',
};

const FIELD_NAMES: Record<string, string> = {
  fees: 'fees', tax: 'tax', employerContributions: 'employer contributions', personalContributions: 'personal contributions',
  salarySacrifice: 'salary sacrifice', governmentContributions: 'government contributions', rolloversIn: 'rollovers in',
  rolloversOut: 'rollovers out', withdrawals: 'withdrawals', pensionPayments: 'pension payments',
  investmentEarnings: 'investment earnings', insurancePremiums: 'insurance premiums', openingBalance: 'opening balance',
  closingBalance: 'closing balance', ytdEmployerContributions: 'year-to-date employer contributions',
  ytdPersonalContributions: 'year-to-date personal contributions',
};

export function describeWarning(w: RetirementExtractionWarning): string {
  const label = WARNING_LABELS[w.code] ?? w.code.replace(/_/g, ' ');
  const parts = [label];
  if (w.detail) parts.push(`: ${FIELD_NAMES[w.detail] ?? w.detail}`);
  if (w.count !== undefined) parts.push(` (${w.count})`);
  return parts.join('');
}

function matchText(kind: 'payslip' | 'bank' | 'rollover', status: string): string {
  switch (status) {
    case 'matched': return kind === 'rollover' ? 'Paired with the other fund' : 'Matched';
    case 'no_match': return 'No match found';
    case 'multiple_candidates': return 'More than one possible match';
    case 'variance_review_required': return 'Amounts differ — please check';
    case 'payslip_evidence_not_available': return 'No payslip on file';
    case 'bank_evidence_not_available': return 'No bank statement on file';
    case 'not_expected': return 'Not paid through your bank';
    default: return '—';
  }
}

/** The header totals shown for every statement, in reading order. */
export const STATEMENT_HEADER_FIELDS: readonly { key: keyof RetirementStatementRow; label: string; note?: string }[] = [
  { key: 'opening_balance', label: 'Opening balance' },
  { key: 'closing_balance', label: 'Closing balance' },
  { key: 'employer_contributions', label: 'Employer contributions' },
  { key: 'personal_contributions', label: 'Personal contributions' },
  { key: 'salary_sacrifice', label: 'Salary sacrifice' },
  { key: 'government_contributions', label: 'Government contributions' },
  { key: 'rollovers_in', label: 'Rollovers in', note: 'Moved from another fund — not income' },
  { key: 'rollovers_out', label: 'Rollovers out', note: 'Moved to another fund — not spending' },
  { key: 'withdrawals', label: 'Withdrawals' },
  { key: 'pension_payments', label: 'Pension payments' },
  { key: 'investment_earnings', label: 'Investment earnings' },
  { key: 'fees', label: 'Fees', note: 'Deducted inside the fund — not a household bill' },
  { key: 'insurance_premiums', label: 'Insurance premiums' },
  { key: 'tax', label: 'Tax' },
  { key: 'ytd_employer_contributions', label: 'Employer contributions (year to date)' },
  { key: 'ytd_personal_contributions', label: 'Personal contributions (year to date)' },
];

export interface RetirementStatementDetailsProps {
  statement: RetirementStatementRow;
  activities: readonly RetirementActivityRow[];
  positions: readonly RetirementPositionRow[];
  /** Offered only on an APPROVED statement, for a matched, unconfirmed
   * personal contribution / withdrawal / pension payment. */
  onConfirmBankLeg?: (activity: RetirementActivityRow) => void;
  busyActivityId?: string | null;
}

const CONFIRMABLE = new Set(['PERSONAL_CONTRIBUTION', 'WITHDRAWAL', 'PENSION_PAYMENT']);

function bankCell(a: RetirementActivityRow, canConfirm: boolean, onConfirm: RetirementStatementDetailsProps['onConfirmBankLeg'], busy: boolean) {
  const leg = a.bank_leg;
  return (
    <>
      <span>{matchText('bank', a.bank_match_status)}</span>
      {leg && (
        <span className="block text-xs text-muted">
          {leg.transaction_date ?? '—'} · {leg.description_clean ?? 'Bank payment'} · {statementMoney(leg.amount_original, leg.currency_original ?? a.currency_code)}
        </span>
      )}
      {a.bank_leg_confirmed_type && (
        <span className="block text-xs text-green-800">
          Confirmed — this bank payment counts as {a.bank_leg_confirmed_type === 'income' ? 'income, once' : 'a transfer, not spending or income'}
        </span>
      )}
      {canConfirm && onConfirm && !a.bank_leg_confirmed_at && a.bank_match_status === 'matched' && CONFIRMABLE.has(a.activity_type) && !a.is_summary_total && !a.is_year_to_date && !a.duplicate_of_activity_id && (
        <button
          type="button"
          onClick={() => onConfirm(a)}
          disabled={busy}
          className="mt-1 rounded border border-gray-300 px-2 py-0.5 text-xs disabled:opacity-50"
        >
          {a.activity_type === 'PERSONAL_CONTRIBUTION'
            ? 'Confirm: this bank payment went into my super'
            : 'Confirm: this bank payment came from my super'}
        </button>
      )}
    </>
  );
}

export function RetirementStatementDetails({ statement, activities, positions, onConfirmBankLeg, busyActivityId }: RetirementStatementDetailsProps) {
  const currency = statement.currency_code;
  const canConfirm = statement.approval_status === 'approved';
  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        <div><dt className="text-muted">Fund</dt><dd>{statement.fund_name ?? 'Not identified'}</dd></div>
        {statement.nickname && <div><dt className="text-muted">Your name for it</dt><dd>{statement.nickname}</dd></div>}
        <div><dt className="text-muted">Member number</dt><dd>{statement.masked_account_identifier ?? 'Not shown'}</dd></div>
        <div><dt className="text-muted">Statement date</dt><dd>{statement.statement_date ?? 'Not shown on statement'}</dd></div>
        <div><dt className="text-muted">Period</dt><dd>{statement.statement_start_date ?? '—'} to {statement.statement_end_date ?? '—'}</dd></div>
        {STATEMENT_HEADER_FIELDS.map((f) => (
          <div key={f.key}>
            <dt className="text-muted">{f.label}</dt>
            <dd>
              {statementMoney(statement[f.key] as string | null, currency)}
              {f.note && statement[f.key] !== null && <span className="block text-xs text-muted">{f.note}</span>}
            </dd>
          </div>
        ))}
      </dl>

      <p className="rounded bg-gray-50 px-3 py-2 text-sm">
        <strong>Balance check:</strong>{' '}
        {RECONCILIATION_LABEL[statement.reconciliation_status] ?? statement.reconciliation_status}
        {statement.reconciliation_status === 'variance' && statement.reconciliation_variance
          && ` Difference: ${statementMoney(statement.reconciliation_variance, currency)}.`}
      </p>

      {statement.extraction_warnings.length > 0 && (
        <div className="rounded bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <p className="font-medium">What we could not read, or had to combine</p>
          <ul className="mt-1 list-disc pl-5">
            {statement.extraction_warnings.map((w, i) => <li key={`${w.code}-${i}`}>{describeWarning(w)}</li>)}
          </ul>
        </div>
      )}

      <div className="overflow-x-auto">
        <h4 className="mb-2 text-sm font-semibold">Contribution history and other activity</h4>
        {activities.length === 0 ? (
          <p className="text-sm text-muted">This statement listed no individual activity lines.</p>
        ) : (
          <table className="w-full min-w-[860px] border-collapse text-sm">
            <caption className="sr-only">Every activity line on this retirement statement</caption>
            <thead>
              <tr className="border-b border-gray-200 text-left">
                <th scope="col" className="py-2 pr-2">Date</th>
                <th scope="col" className="py-2 pr-2">What happened</th>
                <th scope="col" className="py-2 pr-2">Description</th>
                <th scope="col" className="py-2 pr-2">Employer</th>
                <th scope="col" className={`py-2 pr-2 ${NUM_HEADER_CLASS}`}>Amount</th>
                <th scope="col" className="py-2 pr-2">Payslip</th>
                <th scope="col" className="py-2 pr-2">Bank payment</th>
                <th scope="col" className="py-2">Rollover</th>
              </tr>
            </thead>
            <tbody>
              {activities.map((a) => (
                <tr key={a.id} className="border-b border-gray-100 align-top">
                  <td className="py-2 pr-2 whitespace-nowrap">
                    {a.activity_date ?? '—'}
                    {(a.effective_period_start || a.effective_period_end) && (
                      <span className="block text-xs text-muted">for {a.effective_period_start ?? '—'} to {a.effective_period_end ?? '—'}</span>
                    )}
                  </td>
                  <th scope="row" className="py-2 pr-2 text-left font-normal">
                    {ACTIVITY_LABELS[a.activity_type] ?? a.activity_type}
                    {a.is_summary_total && <span className="ml-2 text-xs text-muted">(statement total — not counted separately)</span>}
                    {a.is_year_to_date && <span className="ml-2 text-xs text-muted">(year to date — not counted separately)</span>}
                    {a.duplicate_of_activity_id && <span className="ml-2 text-xs text-muted">(already imported from another statement)</span>}
                    {ACTIVITY_NOTES[a.activity_type] && <span className="block text-xs text-muted">{ACTIVITY_NOTES[a.activity_type]}</span>}
                  </th>
                  <td className="py-2 pr-2">{a.description_raw ?? '—'}</td>
                  <td className="py-2 pr-2">{a.employer_name_raw ?? '—'}</td>
                  <td className={`py-2 pr-2 ${NUM_CELL_CLASS}`}>{statementMoney(a.amount, a.currency_code)}</td>
                  <td className="py-2 pr-2">
                    {matchText('payslip', a.payslip_match_status)}
                    {a.payslip_match_status === 'variance_review_required' && a.payslip_match_variance && (
                      <span className="block text-xs text-muted">Difference {statementMoney(a.payslip_match_variance, a.currency_code)}</span>
                    )}
                  </td>
                  <td className="py-2 pr-2">{bankCell(a, canConfirm, onConfirmBankLeg, busyActivityId === a.id)}</td>
                  <td className="py-2">{a.activity_type === 'ROLLOVER_IN' || a.activity_type === 'ROLLOVER_OUT' ? matchText('rollover', a.rollover_match_status) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {positions.length > 0 && (
        <div className="overflow-x-auto">
          <h4 className="mb-1 text-sm font-semibold">Holdings in super — not added to Net Worth</h4>
          <p className="mb-2 text-xs text-muted">
            What this fund is invested in, for information only. These holdings are already part of the fund&apos;s balance,
            so they are not added to your Net Worth or your investments a second time.
          </p>
          <table className="w-full min-w-[720px] border-collapse text-sm">
            <caption className="sr-only">Investment options held inside this retirement account (not added to Net Worth)</caption>
            <thead>
              <tr className="border-b border-gray-200 text-left">
                <th scope="col" className="py-2 pr-2">Investment option</th>
                <th scope="col" className="py-2 pr-2">Asset class</th>
                <th scope="col" className="py-2 pr-2">Code</th>
                <th scope="col" className="py-2 pr-2">ISIN</th>
                <th scope="col" className={`py-2 pr-2 ${NUM_HEADER_CLASS}`}>Units</th>
                <th scope="col" className={`py-2 pr-2 ${NUM_HEADER_CLASS}`}>Unit price</th>
                <th scope="col" className={`py-2 pr-2 ${NUM_HEADER_CLASS}`}>Value</th>
                <th scope="col" className="py-2">Valued on</th>
              </tr>
            </thead>
            <tbody>
              {positions.map((p) => (
                <tr key={p.id} className="border-b border-gray-100">
                  <th scope="row" className="py-2 pr-2 text-left font-normal">{p.option_name_raw}</th>
                  <td className="py-2 pr-2">{p.asset_class_raw ?? '—'}</td>
                  <td className="py-2 pr-2">{p.ticker_raw ?? '—'}</td>
                  <td className="py-2 pr-2">{p.isin ?? '—'}</td>
                  <td className={`py-2 pr-2 ${NUM_CELL_CLASS}`}>{p.units ?? '—'}</td>
                  <td className={`py-2 pr-2 ${NUM_CELL_CLASS}`}>{p.unit_price ?? '—'}</td>
                  <td className={`py-2 pr-2 ${NUM_CELL_CLASS}`}>{statementMoney(p.market_value, p.currency_code)}</td>
                  <td className="py-2">{p.valuation_date ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function outcomeText(item: RetirementHistoryItem): string {
  if (item.outcome === 'applied') {
    const when = item.appliedAt ? ` on ${item.appliedAt.slice(0, 10)}` : '';
    return item.accountName ? `Applied to “${item.accountName}”${when}` : `Applied${when}`;
  }
  if (item.outcome === 'kept_existing') return 'Reviewed — you kept your account as it was';
  return 'Approved — not applied to your accounts yet';
}

/** The list, as rendered. Pure (for tests and for the loading wrapper). */
export function RetirementStatementHistoryView({
  items, total, hasMore, loading, error, onLoadMore, onConfirmBankLeg, busyActivityId, notice,
}: {
  items: readonly RetirementHistoryItem[];
  total: number;
  hasMore: boolean;
  loading?: boolean;
  error?: string | null;
  notice?: string | null;
  onLoadMore?: () => void;
  onConfirmBankLeg?: (item: RetirementHistoryItem, activity: RetirementActivityRow) => void;
  busyActivityId?: string | null;
}) {
  return (
    <section
      id="imported-retirement-statements"
      className="rounded-lg border border-gray-200 bg-white p-4"
      role="region"
      aria-label="Imported retirement statements"
      aria-live="polite"
    >
      <h2 className="text-lg font-semibold">Imported retirement statements</h2>
      <p className="mt-1 text-sm text-muted">
        Everything your statements showed — contributions, rollovers, earnings, fees, insurance, tax and what each fund
        is invested in. Only the closing balance (and any contribution rate you chose to apply) changes your retirement
        accounts; the rest is kept here as a record.
      </p>
      {notice && <p className="mt-3 rounded bg-green-50 px-3 py-2 text-sm text-green-800">{notice}</p>}
      {error && <p className="mt-3 rounded bg-amber-50 px-3 py-2 text-sm text-amber-900">{error}</p>}
      {!error && items.length === 0 && !loading && (
        <p className="mt-3 text-sm text-muted">No imported statements yet. Use “Import retirement statement” above to add one.</p>
      )}
      <ul className="mt-3 space-y-3">
        {items.map((item) => {
          const s = item.statement;
          return (
            <li key={s.id} className="rounded border border-gray-200">
              <details>
                <summary className="cursor-pointer px-3 py-2 text-sm">
                  <span className="font-medium">{s.fund_name ?? s.nickname ?? 'Retirement statement'}</span>
                  {' — '}
                  {s.statement_start_date ?? '—'} to {s.statement_end_date ?? s.statement_date ?? '—'}
                  {' — closing balance '}
                  {statementMoney(s.closing_balance, s.currency_code)}
                  <span className="block text-xs text-muted">{outcomeText(item)}</span>
                </summary>
                <div className="border-t border-gray-100 p-3">
                  <RetirementStatementDetails
                    statement={s}
                    activities={item.activities}
                    positions={item.positions}
                    busyActivityId={busyActivityId}
                    onConfirmBankLeg={onConfirmBankLeg ? (a) => onConfirmBankLeg(item, a) : undefined}
                  />
                </div>
              </details>
            </li>
          );
        })}
      </ul>
      {loading && <p className="mt-3 text-sm">Loading your statements…</p>}
      {hasMore && !loading && (
        <button type="button" onClick={() => onLoadMore?.()} className="mt-3 rounded border border-gray-300 px-3 py-1 text-sm">
          Show more ({items.length} of {total})
        </button>
      )}
    </section>
  );
}

const PAGE_SIZE = 10;

function errorText(json: unknown, fallback: string): string {
  if (isObj(json)) {
    if (typeof json.message === 'string') return json.message;
    if (typeof json.error === 'string') return json.error;
  }
  return fallback;
}

/**
 * Reads pages 1..upToPage (so a confirmation or a new Apply is reflected in
 * every page shown so far). Never throws.
 */
async function loadHistoryPages(upToPage: number): Promise<{ items: RetirementHistoryItem[]; total: number; hasMore: boolean } | { error: string }> {
  try {
    const collected: RetirementHistoryItem[] = [];
    let last: RetirementHistoryPage | null = null;
    for (let p = 1; p <= upToPage; p += 1) {
      const res = await fetch(fdhApi.retirementStatements(p, PAGE_SIZE));
      const json: unknown = await res.json().catch(() => ({}));
      if (!res.ok) return { error: errorText(json, 'Could not load your imported statements.') };
      last = normaliseRetirementHistory(json);
      collected.push(...last.items);
      if (!last.hasMore) break;
    }
    return { items: collected, total: last?.total ?? collected.length, hasMore: last?.hasMore ?? false };
  } catch {
    return { error: 'Could not load your imported statements.' };
  }
}

/** The Retirement tab's statement history (fetches, pages, confirms). */
export function RetirementStatementHistory({ refreshKey = 0 }: { refreshKey?: number }) {
  const [items, setItems] = useState<RetirementHistoryItem[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyActivityId, setBusyActivityId] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void loadHistoryPages(page).then((result) => {
      if (cancelled) return;
      if ('error' in result) {
        setError(result.error);
      } else {
        setError(null);
        setItems(result.items);
        setTotal(result.total);
        setHasMore(result.hasMore);
      }
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [page, refreshKey, reloadTick]);

  const confirm = useCallback(async (item: RetirementHistoryItem, activity: RetirementActivityRow) => {
    const documentId = item.statement.statement_upload_id;
    if (!documentId) { setError('This statement can no longer be changed.'); return; }
    setBusyActivityId(activity.id);
    setNotice(null);
    try {
      const res = await fetch(fdhApi.retirementStatementBankLeg(documentId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ activity_id: activity.id }),
      });
      const json: unknown = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(json, 'This bank payment could not be confirmed.')); return; }
      const data = isObj(json) && isObj(json.data) ? json.data : {};
      setNotice(data.outcome === 'skipped_user_override'
        ? 'Confirmed. You had already categorised this bank payment yourself, so it was left exactly as you set it.'
        : data.counted_as === 'income'
          ? 'Confirmed. This bank payment now counts once, as retirement income.'
          : 'Confirmed. This bank payment now counts as a transfer into (or out of) super, not as spending or income.');
      setLoading(true);
      setReloadTick((t) => t + 1);
    } finally {
      setBusyActivityId(null);
    }
  }, []);

  return (
    <RetirementStatementHistoryView
      items={items}
      total={total}
      hasMore={hasMore}
      loading={loading}
      error={error}
      notice={notice}
      busyActivityId={busyActivityId}
      onLoadMore={() => { setLoading(true); setPage((p) => p + 1); }}
      onConfirmBankLeg={(item, a) => void confirm(item, a)}
    />
  );
}

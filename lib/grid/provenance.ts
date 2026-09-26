/**
 * WP-07 -- provenance of an Input Data row, for the grid badge (GAP-06, G7,
 * GAP-RET-08, and the WP-15 rows).
 *
 * Each register stamps `source_type` when an import writes it (payslip 0091,
 * liability 0096, retirement 0112, Investment Intelligence 0042, WP-15 0214).
 * Before WP-07 the grid only recognised the Investment Intelligence value, so
 * an imported income, liability or retirement row looked exactly like one the
 * user typed. This is the one table of what each value means to the user.
 *
 * THE HISTORY LINK. Each import domain's own history page is built by its own
 * work package (WP-09 payslip, WP-11 liability statements, WP-13 retirement
 * statements) as a builder on `fdhPages` in lib/import-bridge/fdhRoutes.ts,
 * named in HISTORY_ROUTE_BUILDER below. Until that builder exists the badge
 * shows no link at all -- never a link to a page that 404s.
 *
 * Client-safe: pure.
 */
import { fdhPages } from '@/lib/import-bridge/fdhRoutes';

export type ImportSourceType =
  | 'payslip_import'
  | 'liability_statement_import'
  | 'retirement_statement_import'
  | 'investment_intelligence_published'
  | 'bank_statement_import'
  | 'bank_statement_average';

export const IMPORT_SOURCE_TYPES: readonly ImportSourceType[] = [
  'payslip_import',
  'liability_statement_import',
  'retirement_statement_import',
  'investment_intelligence_published',
  'bank_statement_import',
  'bank_statement_average',
];

export function isImportSourceType(v: unknown): v is ImportSourceType {
  return typeof v === 'string' && (IMPORT_SOURCE_TYPES as readonly string[]).includes(v);
}

export interface ProvenanceRow {
  source_type?: unknown;
  last_imported_at?: unknown;
  debt_type?: unknown;
  source_financial_account_id?: unknown;
}

export interface ProvenanceBadgeModel {
  sourceType: ImportSourceType;
  label: string;
  /** Tooltip text: when the import last wrote this row, if recorded. */
  title: string;
  /** Where to see the import history, or null when that page does not exist yet. */
  historyHref: string | null;
  historyLabel: string;
}

/** The fdhPages builder each domain's history page will be published under. */
export const HISTORY_ROUTE_BUILDER: Record<'payslip_import' | 'liability_statement_import' | 'retirement_statement_import', string> = {
  payslip_import: 'payslipHistory',
  liability_statement_import: 'liabilityStatementHistory',
  retirement_statement_import: 'retirementStatementHistory',
};

function historyBuilder(name: string): (() => string) | null {
  const candidate = (fdhPages as unknown as Record<string, unknown>)[name];
  return typeof candidate === 'function' ? (candidate as () => string) : null;
}

function formatImportedAt(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** null = a manual row (or an unrecognised value): no badge. */
export function provenanceBadgeFor(row: ProvenanceRow): ProvenanceBadgeModel | null {
  const sourceType = row.source_type;
  if (!isImportSourceType(sourceType)) return null;
  let label: string;
  let historyHref: string | null = null;
  let historyLabel = 'View import history';
  switch (sourceType) {
    case 'payslip_import':
      label = 'Imported from payslip';
      historyHref = historyBuilder(HISTORY_ROUTE_BUILDER.payslip_import)?.() ?? null;
      break;
    case 'liability_statement_import':
      label = row.debt_type === 'credit_card' ? 'Imported from credit card statement' : 'Imported from loan statement';
      historyHref = historyBuilder(HISTORY_ROUTE_BUILDER.liability_statement_import)?.() ?? null;
      historyLabel = 'View statement history';
      break;
    case 'retirement_statement_import':
      label = 'Imported from retirement statement';
      historyHref = historyBuilder(HISTORY_ROUTE_BUILDER.retirement_statement_import)?.() ?? null;
      historyLabel = 'View statement history';
      break;
    case 'investment_intelligence_published':
      label = 'Imported via Investment Intelligence';
      historyHref = '/investment-intelligence/data';
      historyLabel = 'Manage in Investment Intelligence';
      break;
    case 'bank_statement_import':
      label = 'Imported from bank statement';
      historyHref = typeof row.source_financial_account_id === 'string' && row.source_financial_account_id
        ? fdhPages.activityTransactions({ accountId: row.source_financial_account_id })
        : fdhPages.activityTransactions();
      historyLabel = 'View account transactions';
      break;
    case 'bank_statement_average':
      label = 'Updated from your bank statement averages';
      historyHref = fdhPages.activitySpending();
      historyLabel = 'View spending';
      break;
  }
  const at = formatImportedAt(row.last_imported_at);
  return { sourceType, label, title: at ? `${label} — last imported ${at}` : label, historyHref, historyLabel };
}

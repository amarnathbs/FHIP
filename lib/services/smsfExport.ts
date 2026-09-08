// ---------------------------------------------------------------------------
// LR-6 WP-09/WP-10 — Accountant export + Auditor pack.
//
// No CSV/XLSX export utility existed anywhere in this codebase before this
// phase (confirmed by discovery: lib/engines/reportExport.ts explicitly
// marks 'csv' as "no renderer yet"; the `xlsx` package is used only for
// PARSING imported statements, never for writing an export). This is a new,
// small, self-contained CSV builder — CSV rather than XLSX/PDF, deliberately
// the smallest format that satisfies "structured CSV/XLSX/PDF as currently
// supported" (WP-09's own wording: "as currently supported", not "add every
// format"). PDF reuse (lib/services/reportPdfRenderer.ts) was considered and
// rejected for this phase: that pipeline renders a specific report ROUTE
// through headless Chromium, which would mean building a whole new printable
// SMSF report page just to reuse it — a much larger surface than this
// phase's export requirement, and not attempted here.
//
// This module also carries the WP-10 Auditor pack: rather than a wholly
// separate export type, the same CSV includes a clearly labelled
// "Provenance / audit metadata" section (fund identity, mode, holding/member
// counts, reconciliation variance, generated-at) — structured metadata only,
// explicitly never a raw source document, matching the PO lock verbatim
// ("Accountant/auditor export is structured data plus minimal provenance.
// No raw-document evidence vault.").
// ---------------------------------------------------------------------------

import type { SmsfFundReportBundle } from './smsfReportData';
import type { SmsfReportingPeriod } from '@/lib/engines/smsf/smsfReportingPeriod';

/**
 * CSV formula-injection guard (OWASP CSV Injection mitigation), applied ONLY
 * to free-text label fields — never to numeric amount fields, which is what
 * keeps a legitimate negative number (e.g. "-1500.00") from being corrupted:
 * a plain numeric cell is never interpreted as a formula by spreadsheet
 * software regardless of a leading "-", so numeric fields in this export are
 * never passed through this function at all (see buildSmsfAccountantExportCsv
 * below — only name/label/notes-style strings are).
 */
export function csvSafeLabel(value: string): string {
  if (/^[=+\-@\t\r]/.test(value)) return `'${value}`;
  return value;
}

/** RFC 4180 field quoting — applied to every field regardless of type. */
function csvField(value: string | number): string {
  const str = typeof value === 'number' ? String(value) : value;
  if (/[",\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

function csvRow(fields: (string | number)[]): string {
  return fields.map(csvField).join(',') + '\r\n';
}

export function buildSmsfAccountantExportCsv(bundle: SmsfFundReportBundle, period: SmsfReportingPeriod): string {
  const money = (n: number) => Math.round(n * 100) / 100;
  let out = '';

  out += csvRow(['SMSF Accountant / Auditor Export']);
  out += csvRow(['Fund name', csvSafeLabel(bundle.fund.fund_name)]);
  out += csvRow(['Reporting period', period.label, period.startDate, period.endDate]);
  out += csvRow(['Currency', bundle.fund.currency_code]);
  out += csvRow(['Mode', bundle.fund.mode]);
  out += csvRow([]);

  out += csvRow(['Profit & Loss (monthly recurring rate)']);
  out += csvRow(['Operating income', money(bundle.pnl.operatingIncomeMonthly)]);
  out += csvRow(['Operating expenses (excl. loan principal)', money(bundle.pnl.operatingExpensesMonthly)]);
  out += csvRow(['  of which: expense items', money(bundle.pnl.operatingExpenseItemsMonthly)]);
  out += csvRow(['  of which: estimated loan interest', money(bundle.pnl.estimatedLoanInterestMonthly)]);
  out += csvRow(['Net operating result', money(bundle.pnl.netOperatingResultMonthly)]);
  out += csvRow(['Capital movements', 'Not modelled — holdings carry no transaction history in this release']);
  out += csvRow([]);

  out += csvRow(['Cash Flow (monthly recurring rate)']);
  out += csvRow(['Operating income (inflow)', money(bundle.cashFlow.inflows.operatingIncomeMonthly)]);
  out += csvRow(['Contributions (inflow)', money(bundle.cashFlow.inflows.contributionsMonthly)]);
  out += csvRow(['Total inflow', money(bundle.cashFlow.inflows.totalMonthly)]);
  out += csvRow(['Operating expense items (outflow)', money(bundle.cashFlow.outflows.operatingExpenseItemsMonthly)]);
  out += csvRow(['Debt service — full repayment (outflow)', money(bundle.cashFlow.outflows.debtServiceMonthly)]);
  out += csvRow(['  of which: estimated interest', money(bundle.cashFlow.debtServiceBreakdown.estimatedInterestMonthly)]);
  out += csvRow(['  of which: estimated principal', money(bundle.cashFlow.debtServiceBreakdown.estimatedPrincipalMonthly)]);
  out += csvRow(['Total outflow', money(bundle.cashFlow.outflows.totalMonthly)]);
  out += csvRow(['Net cash flow', money(bundle.cashFlow.netCashFlowMonthly)]);
  out += csvRow([]);

  out += csvRow(['Contributions']);
  out += csvRow(['Employer contribution', money(bundle.contributions.employerContributionMonthly)]);
  out += csvRow(['Personal contribution', money(bundle.contributions.personalContributionMonthly)]);
  out += csvRow(['Total contribution', money(bundle.contributions.totalContributionMonthly)]);
  out += csvRow(['Spouse / rollover contributions', 'Not modelled in this release']);
  out += csvRow([]);

  out += csvRow(['Balance Reconciliation']);
  if (bundle.provenance.activeHoldingCount === 0) {
    out += csvRow(['Detailed Holdings has not been set up for this fund yet — nothing to reconcile against Summary Mode']);
  } else {
    out += csvRow(['Detailed net value', bundle.reconciliation.detailedNetValue ?? 'N/A']);
    out += csvRow(['Summary balance', bundle.reconciliation.summaryBalance ?? 'N/A']);
    out += csvRow(['Variance', bundle.reconciliation.variance ?? 'N/A']);
  }
  out += csvRow([]);

  out += csvRow(['Provenance / audit metadata (structured only — no source documents included)']);
  out += csvRow(['Active holdings', bundle.provenance.activeHoldingCount]);
  out += csvRow(['Active members', bundle.provenance.activeMemberCount]);
  out += csvRow(['Generated at (UTC)', bundle.provenance.generatedAt]);

  return out;
}

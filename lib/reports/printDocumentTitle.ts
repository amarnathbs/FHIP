/**
 * The document title of every report PRINT view (PO observation 20-10-2026: every "Save as PDF" proposed the same file name,
 * "FHIP _ Financial Health.pdf", because Chrome uses the page <title> and every print page carried the app-wide
 * "FHIP | Financial Health").
 *
 * The title is the saved file's default name, so it is:
 *  - per report and per period, the month in WORDS ("October 2026", "20 October 2026"), so it cannot be misread as dd/mm or mm/dd;
 *  - file-name safe: none of \ / : * ? " < > | (Windows rejects them; Chrome would replace them with "_" and leave an ugly name);
 *  - built only from the report's own data (its month, its as-at date, its version): nothing is invented. When a period is not
 *    available the title falls back to the report name (and the as-at date when there is one), never to a made-up month.
 *
 * Pure (no React, no globals) so the formats are unit-tested for sample data. The client component that applies a title before the
 * print dialog opens is components/reports/PrintDocumentTitle.tsx; the naming rule lives here only.
 */

export const PRINT_TITLE_PREFIX = 'FHIP';
/** The app-wide fallback title that must never be the title of a print page (it makes every saved PDF the same name). */
export const GENERIC_APP_TITLE = 'FHIP | Financial Health';

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] as const;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Characters a Windows file name cannot contain (plus control characters). */
const UNSAFE_FILE_NAME_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g;
const HAS_UNSAFE_FILE_NAME_CHAR = /[\\/:*?"<>|\u0000-\u001f]/;

export type PrintTitleCurrency = 'AUD' | 'INR';

const ZONE_BY_CURRENCY: Record<PrintTitleCurrency, string> = { AUD: 'Australia/Sydney', INR: 'Asia/Kolkata' };

/** Makes free text safe to appear in a file name: unsafe characters become a space, runs of space collapse, no trailing dot or space. */
export function fileNameSafe(text: string): string {
  return text
    .replace(UNSAFE_FILE_NAME_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
}

interface YMD {
  year: number;
  month: number; // 1-12
  day: number;
}

/**
 * Year, month and day of a date value. A date-only string (YYYY-MM-DD, which is how the app stores every report month and as-at date)
 * is split directly, never parsed through Date, so a server in any timezone gives the same day. A full timestamp is read in the
 * reporting currency's home timezone (AUD: Sydney, INR: Kolkata), so a report built just after midnight at home is not named for the day before.
 */
export function readYmd(value: string | null | undefined, currency: PrintTitleCurrency = 'AUD'): YMD | null {
  if (!value) return null;
  const m = DATE_ONLY.exec(value.trim());
  if (m) {
    const ymd = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
    return ymd.month >= 1 && ymd.month <= 12 && ymd.day >= 1 && ymd.day <= 31 ? ymd : null;
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: ZONE_BY_CURRENCY[currency], year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    const ymd = { year: get('year'), month: get('month'), day: get('day') };
    return Number.isFinite(ymd.year) && Number.isFinite(ymd.month) && Number.isFinite(ymd.day) ? ymd : null;
  } catch {
    return null;
  }
}

/** "October 2026", or null when the value is not a date. */
export function monthYearInWords(value: string | null | undefined, currency: PrintTitleCurrency = 'AUD'): string | null {
  const ymd = readYmd(value, currency);
  return ymd ? `${MONTH_NAMES[ymd.month - 1]} ${ymd.year}` : null;
}

/** "20 October 2026" (day first, month in words), or null when the value is not a date. */
export function dayMonthYearInWords(value: string | null | undefined, currency: PrintTitleCurrency = 'AUD'): string | null {
  const ymd = readYmd(value, currency);
  return ymd ? `${ymd.day} ${MONTH_NAMES[ymd.month - 1]} ${ymd.year}` : null;
}

/** "FHIP <report name> - <part> - <part>", file-name safe. Empty parts are skipped. */
export function composePrintTitle(reportName: string, parts: ReadonlyArray<string | null | undefined> = []): string {
  const rest = parts.filter((p): p is string => Boolean(p && p.trim()));
  return fileNameSafe([`${PRINT_TITLE_PREFIX} ${reportName}`, ...rest].join(' - '));
}

// ---------------------------------------------------------------------------------------------------------------------
// One builder per print page
// ---------------------------------------------------------------------------------------------------------------------

/** The names of the report types the report print route can show (lib/services/reportsData.ts ReportTypeCode). */
export const REPORT_TYPE_PRINT_NAMES: Readonly<Record<string, string>> = {
  monthly_financial_health: 'Monthly Report',
  financial_health_score: 'Financial Health Score Report',
  goal_progress: 'Goal Progress Report',
  net_worth: 'Net Worth Report',
};

export interface ReportPrintTitleInput {
  reportTypeCode: string | null | undefined;
  /** The report's month, YYYY-MM-DD (reports.report_month). */
  reportMonth: string | null | undefined;
  /** The report's as-at date, YYYY-MM-DD (reports.as_of_date); only used when the month is missing. */
  asOfDate?: string | null;
  /** reports.version_number; a revision (2 or more) is named so it does not share the first version's file name. */
  versionNumber?: number | null;
  currency?: PrintTitleCurrency;
}

/** app/(print)/reports/[id]/print: "FHIP Monthly Report - October 2026"; a revision: "FHIP Monthly Report - October 2026 (version 2)". */
export function reportPrintTitle(i: ReportPrintTitleInput): string {
  const name = (i.reportTypeCode && REPORT_TYPE_PRINT_NAMES[i.reportTypeCode]) || 'Report';
  const currency = i.currency ?? 'AUD';
  const period = monthYearInWords(i.reportMonth, currency) ?? dayMonthYearInWords(i.asOfDate, currency);
  const version = typeof i.versionNumber === 'number' && Number.isInteger(i.versionNumber) && i.versionNumber > 1 ? `(version ${i.versionNumber})` : null;
  return composePrintTitle(name, [[period, version].filter(Boolean).join(' ') || null]);
}

export interface NetWorthStatementPrintTitleInput {
  /** The statement's as-at date, YYYY-MM-DD (NetWorthStatementSet.asAt). */
  asAt: string | null | undefined;
  /**
   * Which statement is printed, when it is not the personal one: 'Family', 'All statements', or an entity's own name.
   * null/undefined for the personal statement, so the common file name is the plain one.
   */
  viewLabel?: string | null;
  currency?: PrintTitleCurrency;
}

/** app/(print)/reports/net-worth-statement/print: "FHIP Net Worth Statement - 20 October 2026"; Family: "FHIP Net Worth Statement - Family - 20 October 2026". */
export function netWorthStatementPrintTitle(i: NetWorthStatementPrintTitleInput): string {
  return composePrintTitle('Net Worth Statement', [i.viewLabel?.trim() || null, dayMonthYearInWords(i.asAt, i.currency ?? 'AUD')]);
}

/** Which Net Worth Statement view is printed, as a file-name part: null for the personal statement (the plain name), else 'Family', 'All statements' or the entity's own name. */
export function netWorthStatementViewLabel(view: 'personal' | 'family' | 'all' | { entity: string }, entities: ReadonlyArray<{ entityId: string; name: string }>): string | null {
  if (view === 'personal') return null;
  if (view === 'family') return 'Family';
  if (view === 'all') return 'All statements';
  return entities.find((e) => e.entityId === view.entity)?.name ?? null;
}

export interface ForecastReportPrintTitleInput {
  /** When the report was built (ForecastReportData.generatedAt); the report has no other period of its own. */
  generatedAt: string | null | undefined;
  currency?: PrintTitleCurrency;
}

/** app/(print)/forecast/report/print: "FHIP Consolidated Forecast Report - October 2026". */
export function forecastReportPrintTitle(i: ForecastReportPrintTitleInput): string {
  return composePrintTitle('Consolidated Forecast Report', [monthYearInWords(i.generatedAt, i.currency ?? 'AUD')]);
}

/** True when the title is acceptable as a saved file name: not generic, starts "FHIP ", none of the characters Windows rejects, no trailing dot or space. */
export function isPrintTitleFileNameSafe(title: string): boolean {
  return title.startsWith(`${PRINT_TITLE_PREFIX} `) && title !== GENERIC_APP_TITLE && !HAS_UNSAFE_FILE_NAME_CHAR.test(title) && !/[. ]$/.test(title);
}

/** The slice of `document` the title setter needs, so it can be tested with a plain object. */
export interface TitleDocumentLike {
  title: string;
}

/**
 * Sets the page title to the print title. The print dialog (and Chrome's proposed file name) reads document.title when it OPENS, so this
 * runs when the page mounts and again immediately before every window.print() (PrintTabOptions.beforePrint). Returns true when it changed anything.
 */
export function applyPrintDocumentTitle(doc: TitleDocumentLike, title: string): boolean {
  if (!title || doc.title === title) return false;
  doc.title = title;
  return true;
}

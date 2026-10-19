// The document title of the Fund analytics print page. A browser proposes the page title as the file name of "Save as PDF" and prints it in its own
// header line, so every report used to be saved as the same "FHIP _ Financial Health.pdf" (PO 19-10-2026). The title now names the report: its as-at month
// in WORDS (never a numeric date, which reads differently in India and Australia) and its version number, and uses no character a file name cannot hold.
export const FUND_ANALYTICS_TITLE_FALLBACK = 'FHIP Fund Analytics';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] as const;

/** "FHIP Fund Analytics - October 2026 - Version 3". `asOfDate` is the report's own as-at date (YYYY-MM-DD, read as written: no time zone shifts the month). Falls back to the plain name when either part is missing or malformed. */
export function fundAnalyticsPrintTitle(asOfDate: string | null | undefined, versionNumber: number | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-\d{2}/.exec(asOfDate ?? '');
  const month = m ? MONTHS[Number(m[2]) - 1] : undefined;
  if (!m || !month || !Number.isInteger(versionNumber) || (versionNumber as number) < 1) return FUND_ANALYTICS_TITLE_FALLBACK;
  return `${FUND_ANALYTICS_TITLE_FALLBACK} - ${month} ${m[1]} - Version ${versionNumber}`;
}

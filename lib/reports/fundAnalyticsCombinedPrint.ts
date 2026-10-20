// ONE PDF FOR A SET OF FUND ANALYTICS REPORTS (PO decision 20-10-2026). "Generate all my funds" makes several reports (at most 10 funds each); the combined
// print page (/reports/fund-analytics/print?ids=<id1>,<id2>) renders them one after the other in a single print job, so the browser's "Save as PDF" writes ONE
// file. The saved reports, their figures and their text are never changed: each report keeps its own summary, notes and its own comparison (funds are compared
// only within the report they belong to, and the document says so once, at the start).
//
// This module is PURE: the rules for the address, the title, the one-line explanation and the per-report page rules, so they are unit-tested.
import { fundAnalyticsPrintTitle, FUND_ANALYTICS_TITLE_FALLBACK } from '@/lib/reports/fundAnalyticsPrintTitle';
import { fileNameSafe } from '@/lib/reports/printDocumentTitle';

/** The most reports one combined document may hold (4 reports = up to 40 funds; the page refuses more, whatever the address says). */
export const COMBINED_MAX_REPORTS = 4;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Reads `?ids=a,b,c`. Returns the ids in the order given (a repeated id counts once), or null = REFUSE: nothing given, a value that is not an id, an empty
 * entry, a repeated query parameter (`ids=..&ids=..`), or more than COMBINED_MAX_REPORTS distinct ids. A refusal is the same 404 as an unknown report, so
 * the address never reveals whether an id exists.
 */
export function parseCombinedIds(raw: string | string[] | undefined | null): string[] | null {
  if (typeof raw !== 'string') return null;
  const parts = raw.split(',').map((p) => p.trim());
  if (parts.length === 0 || parts.some((p) => !UUID.test(p))) return null;
  const ids = [...new Set(parts.map((p) => p.toLowerCase()))];
  return ids.length >= 1 && ids.length <= COMBINED_MAX_REPORTS ? ids : null;
}

/** The address of the combined print page (the person's own tab; the viewer's time zone travels along like on the single report). */
export function combinedPrintHref(reportIds: readonly string[], timeZone?: string | null): string {
  return `/reports/fund-analytics/print?ids=${reportIds.map((id) => encodeURIComponent(id)).join(',')}&print=1${timeZone ? `&tz=${encodeURIComponent(timeZone)}` : ''}`;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] as const;

export function versionsPhrase(versions: readonly number[]): string {
  const v = [...new Set(versions)].sort((a, b) => a - b).map(String);
  return v.length === 1 ? `Version ${v[0]}` : `Versions ${v.length === 2 ? v.join(' and ') : `${v.slice(0, -1).join(', ')} and ${v[v.length - 1]}`}`;
}

export interface CombinedTitlePart {
  asOfDate: string | null | undefined;
  versionNumber: number | null | undefined;
}

/**
 * "FHIP Fund Analytics - October 2026 - Versions 4 and 5" (the default file name of "Save as PDF"). The month is the latest as-at month of the reports, in WORDS;
 * the versions are listed in ascending order. One report gives the single report's own title. File-name safe; any missing or malformed part falls back to the
 * plain name, never to a made-up month.
 */
export function combinedPrintTitle(parts: readonly CombinedTitlePart[]): string {
  if (parts.length === 0) return FUND_ANALYTICS_TITLE_FALLBACK;
  if (parts.length === 1) return fundAnalyticsPrintTitle(parts[0].asOfDate, parts[0].versionNumber);
  const dates = parts.map((p) => /^(\d{4})-(\d{2})-\d{2}/.exec(p.asOfDate ?? ''));
  const versions = parts.map((p) => p.versionNumber);
  if (dates.some((d) => !d || !MONTHS[Number(d[2]) - 1]) || versions.some((v) => !Number.isInteger(v) || (v as number) < 1)) return FUND_ANALYTICS_TITLE_FALLBACK;
  const latest = (dates as RegExpExecArray[]).map((d) => `${d[1]}-${d[2]}`).sort().slice(-1)[0];
  const [year, month] = latest.split('-');
  return fileNameSafe(`${FUND_ANALYTICS_TITLE_FALLBACK} - ${MONTHS[Number(month) - 1]} ${year} - ${versionsPhrase(versions as number[])}`);
}

/** The one line at the start of a combined document. Plain: the figures of a report are not mixed with another report's. */
export function combinedIntroLine(reportCount: number, fundCount: number): string {
  return `This document combines ${reportCount} reports covering your ${fundCount} fund${fundCount === 1 ? '' : 's'}. Funds are compared only within the same report.`;
}

/** Plain text only: the value goes into a CSS string (same rule as the single document's running header). */
const cssText = (t: string): string => t.replace(/[<>"'{};\\\r\n]/g, ' ').replace(/\s+/g, ' ').trim();

/** The name of the named page of report `n` (1-based) in a combined document; `fa0` is the front section. */
export const combinedPageName = (n: number): string => `fa${n}`;

const BOX_FONT = "font-family:Inter,'Segoe UI',Arial,sans-serif;font-size:7.5pt;color:#5b677a;";

function pageRule(name: string, rightBox: string): string {
  return (
    `@page ${name}{size:A4;margin:22mm 16mm 20mm 16mm;` +
    `@top-left{content:'Fund analytics report';${BOX_FONT}vertical-align:bottom;padding-bottom:2.5mm}` +
    `@top-right{content:"${cssText(rightBox)}";${BOX_FONT}vertical-align:bottom;padding-bottom:2.5mm}` +
    `@bottom-left{content:'Financial Health Intelligence Platform';${BOX_FONT}vertical-align:top;padding-top:2.5mm}` +
    `@bottom-right{content:'Page ' counter(page) ' of ' counter(pages);${BOX_FONT}vertical-align:top;padding-top:2.5mm}}`
  );
}

/**
 * The print rules of a combined document: one NAMED PAGE per section, so each section starts on a fresh page and carries its own running header (a page margin
 * box cannot read a value that changes part-way through a document): `fa0` = the front section (header: "Versions 4 and 5"), `fa1`, `fa2`, ... = the reports'
 * fund pages (header: that report's own version line). The page counter is the document's: "Page n of N" runs across all of it. Size, margins and the other margin
 * boxes are exactly those of `@page fa` in app/globals.css (a unit test compares the two).
 */
export function combinedPageRulesCss(frontLine: string, versionLines: readonly string[]): string {
  const rules =
    pageRule(combinedPageName(0), frontLine) +
    '.fa-combined-front{page:fa0}' +
    versionLines.map((line, i) => `${pageRule(combinedPageName(i + 1), line)}.fa-combined-part-${i + 1}{page:${combinedPageName(i + 1)};break-before:page;page-break-before:always}`).join('');
  return `@media print{${rules}}`;
}

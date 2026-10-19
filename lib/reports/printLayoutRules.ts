// Rules for a printed report PDF, evaluated on page metrics read from the PDF itself (scripts/print/printLayoutCheck.ts). Pure: it takes
// numbers and text positions and returns findings, so the rules are unit-tested (tests/unit/reportPrintLayoutRules.test.ts) with the old layout's
// real metrics as the negative control, and the same code judges the real PDFs.
//
// Origin: Product Owner 18-10-2026, "so much blank space and formatting is also not correct": pages 15 to 60 percent full, a table's labels on one
// page and its values on the next, landscape pages in a portrait report, the browser's own header and footer on every page, tiny charts.

export interface PdfTextItem {
  str: string;
  x: number;
  /** Distance from the TOP of the page, in points. */
  y: number;
  /** Font size in points. */
  size: number;
}

export interface PdfPageMetrics {
  page: number;
  widthPt: number;
  heightPt: number;
  landscape: boolean;
  /** How far down the content band the last ink reaches: 1 = to the bottom, 0.5 = the bottom half is empty. */
  filledFrac: number;
  items: PdfTextItem[];
}

export interface RowPair {
  /** Text of the row's name, e.g. "Savings rate". */
  label: string;
  /** Text of the row's value, e.g. "9.9%". */
  value: string;
}

export interface PrintLayoutRules {
  minPages: number;
  maxPages: number;
  /** Every page except the last must be filled at least this far, unless the next page starts a chapter in `chapterStartHeadings`. */
  minFilledFrac: number;
  /** Headings that may legitimately start a fresh page, so the page before them may end early. */
  chapterStartHeadings: string[];
  /** No text smaller than this (points), margin text excluded. */
  minFontPt: number;
  /** Rows whose label and value must be printed on the SAME page and the same line. */
  rowPairs: RowPair[];
  /** How far apart, vertically, a row's name and its value may sit (a row can have a second caption line under its name). */
  rowTolerancePt: number;
  /** The margin band (mm) holding running headers and footers; its text is not part of the content. */
  marginBandMm: number;
  /** Text that must NOT appear anywhere on a page (e.g. a numeric year-first date). */
  forbiddenText: { name: string; pattern: RegExp }[];
  /** Text that must not appear in the margin band: the browser's own header and footer (date and time, address, page title). */
  forbiddenInMargins: { name: string; pattern: RegExp }[];
  /** When true, every page must carry "Page n of N" in its footer band. */
  requirePageNumbers: boolean;
}

export interface PrintLayoutFinding {
  rule: 'page-count' | 'landscape' | 'blank-space' | 'row-split' | 'font-size' | 'forbidden-text' | 'browser-header-footer' | 'page-numbers';
  page?: number;
  detail: string;
}

const MM_TO_PT = 72 / 25.4;

export const DEFAULT_FORBIDDEN_TEXT: PrintLayoutRules['forbiddenText'] = [
  { name: 'year-first (ISO) date', pattern: /\b(19|20)\d{2}-\d{2}-\d{2}\b/ },
];

/** What Chrome prints in the margins when it draws its own header and footer: date and time, the page title, the address, "n/N". */
export const BROWSER_HEADER_FOOTER: PrintLayoutRules['forbiddenInMargins'] = [
  { name: 'date and time', pattern: /\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4},?\s+\d{1,2}:\d{2}/ },
  { name: 'page title', pattern: /FHIP \| Financial Health/ },
  { name: 'address', pattern: /(https?|file):\/\//i },
  { name: 'page counter n/N', pattern: /^\s*\d+\s*\/\s*\d+\s*$/ },
];

function lineText(items: PdfTextItem[]): string {
  return items.map((i) => i.str).join(' ');
}

function inMargin(item: PdfTextItem, page: PdfPageMetrics, bandMm: number): boolean {
  const band = bandMm * MM_TO_PT;
  return item.y < band || item.y > page.heightPt - band;
}

/** The first line of a page's content (the topmost non-margin text, joined across the items on that line). */
export function firstContentLine(page: PdfPageMetrics, bandMm: number): string {
  const body = page.items.filter((i) => !inMargin(i, page, bandMm));
  if (body.length === 0) return '';
  const top = Math.min(...body.map((i) => i.y));
  return lineText(body.filter((i) => Math.abs(i.y - top) < 3).sort((a, b) => a.x - b.x)).trim();
}

export function evaluatePrintLayout(pages: PdfPageMetrics[], rules: PrintLayoutRules): PrintLayoutFinding[] {
  const out: PrintLayoutFinding[] = [];
  if (pages.length < rules.minPages || pages.length > rules.maxPages) {
    out.push({ rule: 'page-count', detail: `${pages.length} pages; expected ${rules.minPages} to ${rules.maxPages}` });
  }

  for (const p of pages) if (p.landscape) out.push({ rule: 'landscape', page: p.page, detail: `page ${p.page} is landscape (${Math.round(p.widthPt)} x ${Math.round(p.heightPt)} pt) in a portrait report` });

  pages.forEach((p, i) => {
    if (i === pages.length - 1) return;
    if (p.filledFrac >= rules.minFilledFrac) return;
    const next = pages[i + 1];
    const nextFirst = firstContentLine(next, rules.marginBandMm);
    if (rules.chapterStartHeadings.some((h) => nextFirst.startsWith(h))) return;
    out.push({ rule: 'blank-space', page: p.page, detail: `page ${p.page} is only ${(p.filledFrac * 100).toFixed(0)}% full (minimum ${(rules.minFilledFrac * 100).toFixed(0)}%) and the next page does not start a chapter` });
  });

  // A row's name and its value must be on the same page and the same line (a table split across pages left names on one page and values on the next).
  for (const pair of rules.rowPairs) {
    const labelPages = pages.filter((p) => p.items.some((i) => i.str.includes(pair.label)));
    if (labelPages.length === 0) {
      out.push({ rule: 'row-split', detail: `row "${pair.label}" is not printed at all` });
      continue;
    }
    const together = labelPages.some((p) =>
      p.items.filter((i) => i.str.includes(pair.label)).some((l) => p.items.some((v) => v !== l && v.str.includes(pair.value) && Math.abs(v.y - l.y) <= rules.rowTolerancePt && v.x > l.x)),
    );
    if (!together) out.push({ rule: 'row-split', page: labelPages[0].page, detail: `row "${pair.label}": its value "${pair.value}" is not on the same line of the same page` });
  }

  for (const p of pages) {
    for (const i of p.items) {
      if (inMargin(i, p, rules.marginBandMm)) continue;
      // A superscript marker (a dagger, a footnote letter) is deliberately smaller than its line and is not text a person reads on its own.
      if (i.size < rules.minFontPt - 0.05 && i.str.trim().length > 2) {
        out.push({ rule: 'font-size', page: p.page, detail: `"${i.str.slice(0, 40)}" is ${i.size.toFixed(1)} pt (minimum ${rules.minFontPt} pt)` });
        break; // one finding per page is enough
      }
    }
    const text = p.items.map((i) => i.str).join('\n');
    for (const f of rules.forbiddenText) if (f.pattern.test(text)) out.push({ rule: 'forbidden-text', page: p.page, detail: `${f.name} on page ${p.page}` });
    const margin = p.items.filter((i) => inMargin(i, p, rules.marginBandMm));
    for (const f of rules.forbiddenInMargins) {
      if (margin.some((i) => f.pattern.test(i.str))) out.push({ rule: 'browser-header-footer', page: p.page, detail: `${f.name} printed in the margin of page ${p.page}` });
    }
    if (rules.requirePageNumbers) {
      const want = `Page ${p.page} of ${pages.length}`;
      const footer = margin.map((i) => i.str).join(' ').replace(/\s+/g, ' ');
      if (!footer.includes(want)) out.push({ rule: 'page-numbers', page: p.page, detail: `"${want}" is missing from the margins of page ${p.page}` });
    }
  }
  return out;
}

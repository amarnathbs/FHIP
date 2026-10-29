/**
 * Bank PDF Statement Engine: text WITH POSITIONS (30-10-2026).
 *
 * `textExtraction.ts` flattens every page to lines of text, which is all most layouts need. A statement that prints Debits, Credits
 * and Balance in separate COLUMNS loses exactly the information that matters once flattened: an amount's column IS its direction.
 * This module returns every word-run on a page with its x / y coordinates so a layout-specific reader (see
 * `nabClassicPositional.ts`) can tell a debit from a credit by where the amount sits, not by guessing.
 *
 * Same dependency, same trust boundary as `textExtraction.ts`: `pdf-parse` (pdf.js), in this server process, on bytes already in
 * memory; nothing leaves the server; nothing is logged; the parser is always released. It does NOT classify, mask or persist.
 *
 * `pdf-parse` does not expose the pdf.js document publicly, but its (TypeScript-private) `load()` is how its own `getText()` obtains
 * it. This is the one place that reaches for it, behind a narrow structural type, and it FAILS CLOSED: if the shape is not what is
 * expected the result is `ok: false` and the caller falls back to the text path exactly as before.
 *
 * Coordinates: `x` / `right` run left to right and `y` runs TOP to BOTTOM in the page's visible orientation (so a larger y is lower
 * on the page). A rotated page is refused (`ok: false`), never guessed at.
 */

import { PDFParse, PasswordException } from 'pdf-parse';
import { DeadlineExceededError, deadlineBudget } from '@/lib/shared/withDeadline';
import { PDF_EXTRACTION_TIMEOUT_MS, PDF_MAX_PAGES } from './constants';

export interface PositionedWord {
  /** Left edge. */
  x: number;
  /** Right edge (x + width). */
  right: number;
  /** Baseline, measured from the top of the page. */
  y: number;
  height: number;
  text: string;
}

export interface PositionedPage {
  /** 1-based. */
  pageNumber: number;
  width: number;
  height: number;
  words: PositionedWord[];
}

export type PositionedExtractionResult =
  | { ok: true; pages: PositionedPage[] }
  | { ok: false; reason: 'unavailable' | 'rotated_page' | 'page_limit_exceeded' | 'password' | 'timeout' | 'error' };

interface PdfJsTextItem {
  str?: unknown;
  transform?: unknown;
  width?: unknown;
  height?: unknown;
}
interface PdfJsViewport {
  width: number;
  height: number;
  convertToViewportPoint(x: number, y: number): [number, number];
}
interface PdfJsPage {
  rotate?: number;
  getViewport(params: { scale: number }): PdfJsViewport;
  getTextContent(): Promise<{ items: PdfJsTextItem[] }>;
  cleanup?(): void;
}
interface PdfJsDocument {
  numPages: number;
  getPage(n: number): Promise<PdfJsPage>;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export async function extractPositionedPdfPages(
  bytes: Uint8Array,
  password?: string,
  options: { timeoutMs?: number } = {},
): Promise<PositionedExtractionResult> {
  let parser: PDFParse | null = null;
  let timedOut = false;
  const budget = deadlineBudget(options.timeoutMs ?? PDF_EXTRACTION_TIMEOUT_MS);
  try {
    // pdf.js TRANSFERS (detaches) the buffer it is given; a copy keeps the caller's bytes usable after this read.
    parser = new PDFParse({ data: bytes.slice(), password: password || undefined });
    const load = (parser as unknown as { load?: () => Promise<PdfJsDocument> }).load;
    if (typeof load !== 'function') return { ok: false, reason: 'unavailable' };
    const doc = await budget.run(load.call(parser), 'PDF load');
    if (!doc || !finite(doc.numPages) || typeof doc.getPage !== 'function') return { ok: false, reason: 'unavailable' };
    if (doc.numPages > PDF_MAX_PAGES) return { ok: false, reason: 'page_limit_exceeded' };

    const pages: PositionedPage[] = [];
    for (let n = 1; n <= doc.numPages; n += 1) {
      const page = await budget.run(doc.getPage(n), 'PDF page');
      if (page.rotate && page.rotate % 360 !== 0) return { ok: false, reason: 'rotated_page' };
      const viewport = page.getViewport({ scale: 1 });
      const content = await budget.run(page.getTextContent(), 'PDF text positions');
      const words: PositionedWord[] = [];
      for (const item of content.items) {
        if (typeof item.str !== 'string' || item.str.trim() === '') continue;
        const t = item.transform;
        if (!Array.isArray(t) || t.length < 6 || !finite(t[4]) || !finite(t[5]) || !finite(item.width)) continue;
        const [x, y] = viewport.convertToViewportPoint(t[4], t[5]);
        if (!finite(x) || !finite(y)) continue;
        words.push({ x, right: x + item.width, y, height: finite(item.height) ? item.height : 0, text: item.str });
      }
      page.cleanup?.();
      pages.push({ pageNumber: n, width: viewport.width, height: viewport.height, words });
    }
    return { ok: true, pages };
  } catch (err) {
    if (err instanceof DeadlineExceededError) {
      timedOut = true;
      return { ok: false, reason: 'timeout' };
    }
    if (err instanceof PasswordException) return { ok: false, reason: 'password' };
    return { ok: false, reason: 'error' };
  } finally {
    if (parser && timedOut) void parser.destroy().catch(() => undefined);
    else if (parser) await parser.destroy().catch(() => undefined);
  }
}

// NAV2 Stage 2 -- the deterministic readers of the three RBI HTML pages the weekly risk-free refresh uses. PURE: a string in,
// a typed reading out, no network, no clock, no DOM library (the pages are read as table rows of text).
//
//   * the press-release MONTH LISTING   -> dated links (prid + title)
//   * a "Treasury Bills: Full Auction Result" release -> date, release number, 91-day cut-off price and yield (YTM)
//   * the weekly NSDP page (BS_NSDPDisplay.aspx?param=4) -> the latest week's 91-day T-bill (primary) yield and policy repo rate
//
// FAIL SAFE BY CONSTRUCTION. A reader returns null (or an `unavailable` reading) the moment the page does not look exactly like
// what it expects: a missing header, a different title, a column that is not labelled "91-Day", a cell that is neither a number nor
// a dash. It never guesses a column by position alone, so a layout change becomes a null (and then a review item), never a wrong
// number. The release reader keeps the page's own title check: only "Treasury Bills: Full Auction Result" is accepted (the sibling
// short-form "cut-off" release is deliberately not used).
//
// STATUS OF THE LAYOUT KNOWLEDGE (honest): written from saved copies of the live pages as seen on 03-10-2026. The test fixtures are
// SYNTHETIC pages of the same structure (no RBI page is committed). The pages have NOT been re-read live by this code; the first
// DEV dry run is the check (Stage 3).

import type { NsdpReading, ParsedAuction } from '@/lib/engines/nav2/riskFreeRefreshGate';

export const RBI_HTML_READER_VERSION = 'rbi-html-readers-v1';
export const AUCTION_RESULT_TITLE = 'Treasury Bills: Full Auction Result';

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: "'", lsquo: "'", ndash: '-', mdash: '-', rupee: '₹' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, g: string) => {
    if (g[0] === '#') {
      const code = g[1] === 'x' || g[1] === 'X' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[g.toLowerCase()] ?? m;
  });
}

/** The page as lines of cells: one line per table row, cells joined by " | ", tags and scripts removed, entities decoded. */
export function htmlToRows(html: string): string[] {
  const noScripts = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
  const marked = noScripts
    .replace(/<\/t[dh]\s*>/gi, ' \u0001 ')
    .replace(/<\/tr\s*>|<br\s*\/?>|<\/p\s*>|<\/div\s*>|<\/h[1-6]\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(marked)
    .split('\n')
    .map((line) => {
      const parts = line.split('\u0001').map((c) => c.replace(/\s+/g, ' ').trim());
      while (parts.length > 0 && parts[parts.length - 1] === '') parts.pop(); // the text after the last </td> is not a cell
      return parts.join(' | ');
    })
    .filter((l) => l.replace(/[\s|]/g, '') !== '');
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n: number): string => String(n).padStart(2, '0');

function realDate(y: number, m: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? `${y}-${pad(m)}-${pad(d)}` : null;
}

/** "Sep 30, 2026" / "September 30, 2026" -> ISO, or null. */
export function parseRbiDate(raw: string): string | null {
  const m = /([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/.exec(raw);
  if (!m) return null;
  const mon = MONTHS[m[1].toLowerCase().slice(0, m[1].toLowerCase().startsWith('sept') ? 4 : 3)];
  return mon ? realDate(Number(m[3]), mon, Number(m[2])) : null;
}

// ---------------------------------------------------------------------------
// Month listing
// ---------------------------------------------------------------------------
export interface ListingItem {
  date: string;
  prid: string;
  title: string;
}

export function parseMonthListing(html: string): ListingItem[] {
  const tokens: Array<{ pos: number; kind: 'date' | 'link'; date?: string; prid?: string; title?: string }> = [];
  const header = /class\s*=\s*["']?tableheader["']?[^>]*>\s*(?:<b>)?\s*([A-Z][a-z]{2,8}\.? \d{1,2}, \d{4})/g;
  for (let m = header.exec(html); m; m = header.exec(html)) {
    const d = parseRbiDate(m[1]);
    if (d) tokens.push({ pos: m.index, kind: 'date', date: d });
  }
  const link = /href\s*=\s*["']?(?:\.\/)?BS_PressReleaseDisplay\.aspx\?prid=(\d+)["']?[^>]*>([^<]+)<\/a>/gi;
  for (let m = link.exec(html); m; m = link.exec(html)) tokens.push({ pos: m.index, kind: 'link', prid: m[1], title: decodeEntities(m[2]).replace(/\s+/g, ' ').trim() });
  tokens.sort((a, b) => a.pos - b.pos);
  const out: ListingItem[] = [];
  let current: string | null = null;
  for (const t of tokens) {
    if (t.kind === 'date') current = t.date as string;
    else if (current) out.push({ date: current, prid: t.prid as string, title: t.title as string });
  }
  return out;
}

/** The hidden form fields of the listing page (needed to request another month through the page's own archive form). */
export function parseHiddenFields(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /<input[^>]*type\s*=\s*["']hidden["'][^>]*>/gi;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const name = /name\s*=\s*["']([^"']+)["']/i.exec(m[0])?.[1];
    const value = /value\s*=\s*["']([^"']*)["']/i.exec(m[0])?.[1] ?? '';
    if (name) out[name] = decodeEntities(value);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The auction result release
// ---------------------------------------------------------------------------
const dash = /^[-–—]+$|^nil$|^n\.?a\.?$|^$/i;

function cells(row: string): string[] {
  return row.split(' | ').map((c) => c.trim());
}

/**
 * Reads "Treasury Bills: Full Auction Result". Returns null on any structural surprise (so the caller falls back to the AI
 * reading and, failing both, to a review item). `noAcceptedBids` is set ONLY when the 91-day cut-off cells are explicit dashes
 * AND the page carries no yield for that column.
 */
export function parseAuctionResultHtml(html: string): ParsedAuction | null {
  const rows = htmlToRows(html);
  if (!rows.some((r) => cells(r).includes(AUCTION_RESULT_TITLE))) return null;

  const dateRow = rows.find((r) => /\bDate\s*:\s*[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4}/.test(r));
  const auctionDate = dateRow ? parseRbiDate(/Date\s*:\s*(.+)$/.exec(dateRow)?.[1] ?? '') : null;
  const releaseNumber = /Press Release\s*:\s*(\d{4}-\d{4}\/\d+)/.exec(rows.join('\n'))?.[1] ?? null;

  // The column is found by its LABEL, never by position.
  const headerIdx = rows.findIndex((r) => /Auction Results/i.test(r) && /91[\s-]*Day/i.test(r));
  if (headerIdx < 0) return null;
  const header = cells(rows[headerIdx]);
  const col91 = header.findIndex((c) => /^91[\s-]*Day$/i.test(c));
  if (col91 < 0) return null;
  const labelCols = header.findIndex((c) => /Auction Results/i.test(c));
  // Figure columns are aligned from the RIGHT edge of a row: a data row may or may not carry its numeral / label cells, and a blank
  // figure cell must keep its position (never shift the next column into it).
  const nCols = header.length - (labelCols + 1);
  const k = col91 - labelCols - 1;
  if (nCols < 1 || k < 0) return null;
  const figure = (row: string[]): string | undefined => (row.length >= nCols ? row[row.length - nCols + k] : undefined);

  const priceIdx = rows.findIndex((r, i) => i > headerIdx && /Cut-off price/i.test(r));
  if (priceIdx < 0) return null;
  const priceCell = figure(cells(rows[priceIdx]));
  const ytmCell = rows[priceIdx + 1] ? figure(cells(rows[priceIdx + 1])) : undefined;
  if (priceCell === undefined) return null;

  const num = (s: string | undefined): number | null => {
    const m = /(\d+(?:\.\d+)?)/.exec((s ?? '').replace(/,/g, ''));
    return m ? Number(m[1]) : null;
  };

  if (dash.test(priceCell.trim())) {
    // Explicit dash: no accepted bids IF the yield cell is also empty / a dash. Anything else is a surprise.
    const ytm = ytmCell === undefined ? '' : ytmCell.replace(/\(|\)|YTM\s*:/gi, '').trim();
    if (dash.test(ytm)) return { releaseNumber, title: AUCTION_RESULT_TITLE, auctionDate, cutoffPrice: null, cutoffYieldPercent: null, noAcceptedBids: true };
    return null;
  }
  const price = num(priceCell);
  const ytm = ytmCell === undefined ? null : num(/YTM\s*:\s*([\d.]+)/i.exec(ytmCell)?.[1] ?? '');
  if (price === null || !(price > 0 && price < 100)) return null;
  if (ytm === null) return null;
  return { releaseNumber, title: AUCTION_RESULT_TITLE, auctionDate, cutoffPrice: price, cutoffYieldPercent: ytm, noAcceptedBids: false };
}

/** The text of the result table only (what the AI reader is shown): the rows from the date line to the end of the auction table. */
export function auctionTextForAi(html: string): string {
  const rows = htmlToRows(html);
  const start = rows.findIndex((r) => /\bDate\s*:/.test(r));
  const from = start >= 0 ? start : 0;
  const end = rows.findIndex((r, i) => i > from && /Press Release\s*:/.test(r));
  return rows.slice(from, end > from ? end + 1 : from + 40).join('\n').slice(0, 6000);
}

// ---------------------------------------------------------------------------
// NSDP weekly page
// ---------------------------------------------------------------------------
const monthDayRe = /^([A-Z][a-z]{2})\.?\s+(\d{1,2})$/;

/**
 * Reads the LATEST week of the weekly NSDP page: the last "Item/Week Ended" date column, and the same column of the
 * "91-Day Treasury Bill (Primary) Yield" and "Policy Repo Rate" rows. `unavailable` on any surprise.
 */
export function parseNsdpHtml(html: string): NsdpReading {
  const rows = htmlToRows(html);
  const yieldIdx = rows.findIndex((r) => /^91[\s-]*Day Treasury Bill \(Primary\) Yield\b/i.test(r));
  const repoIdx = rows.findIndex((r) => /^Policy Repo Rate\b/i.test(r));
  if (yieldIdx < 0 && repoIdx < 0) return { state: 'unavailable' };
  const anchor = yieldIdx >= 0 ? yieldIdx : repoIdx;

  // The nearest PRECEDING pair of header rows: a row of "Mon. d" tokens, and the row of year labels above it.
  let dateRowIdx = -1;
  for (let i = anchor - 1; i >= 0; i--) {
    const c = cells(rows[i]);
    if (c.filter((x) => monthDayRe.test(x)).length >= 2) {
      dateRowIdx = i;
      break;
    }
  }
  if (dateRowIdx < 0) return { state: 'unavailable' };
  const dateCells = cells(rows[dateRowIdx]).filter((x) => monthDayRe.test(x));
  const years = rows
    .slice(Math.max(0, dateRowIdx - 3), dateRowIdx)
    .flatMap((r) => cells(r))
    .map((x) => /^(20\d{2})$/.exec(x)?.[1])
    .filter((x): x is string => !!x)
    .map(Number);
  if (years.length === 0) return { state: 'unavailable' };
  const year = Math.max(...years);
  const last = monthDayRe.exec(dateCells[dateCells.length - 1]);
  if (!last) return { state: 'unavailable' };
  const weekEnded = realDate(year, MONTHS[last[1].toLowerCase()] ?? 0, Number(last[2]));
  if (!weekEnded) return { state: 'unavailable' };

  const lastNumber = (idx: number): number | null => {
    if (idx < 0) return null;
    const c = cells(rows[idx]).slice(1);
    if (c.length < dateCells.length) return null;
    const v = c[c.length - 1];
    return /^\d+(\.\d+)?$/.test(v) ? Number(v) : null;
  };
  const y = lastNumber(yieldIdx);
  const r = lastNumber(repoIdx);
  if (y === null && r === null) return { state: 'unavailable' };
  return { state: 'value', weekEnded, yield91dPercent: y, policyRepoPercent: r };
}

// Test-only helper: builds a SYNTHETIC multi-page statement PDF laid out like a real NAB Classic Banking statement -- the same column
// GEOMETRY (Date / Particulars / Debits / Credits / Balance as columns; amounts right-aligned under their heading; Cr / Dr suffix
// beside the balance), a date printed only on the first transaction of a day, a balance printed only on the last transaction of a
// day, multi-line particulars ending in a dotted leader and the amount, Brought forward / Carried forward lines, a free-text notice,
// a page footer, vertical margin text, and small-print terms on the last page. No real name, number or amount appears anywhere: every
// string below is invented.
//
// It writes the PDF by hand (no library): one Helvetica font, one text-showing operator per word-run, absolute positions. Right-aligned
// text is placed with the standard Helvetica widths so its right edge lands on the column edge, as a bank's layout engine does.

const HELV: Record<string, number> = {
  ' ': 278, '!': 278, '"': 355, '#': 556, $: 556, '%': 889, '&': 667, "'": 191, '(': 333, ')': 333, '*': 389, '+': 584, ',': 278, '-': 333, '.': 278, '/': 278,
  '0': 556, '1': 556, '2': 556, '3': 556, '4': 556, '5': 556, '6': 556, '7': 556, '8': 556, '9': 556, ':': 278, ';': 278, '<': 584, '=': 584, '>': 584, '?': 556,
  '@': 1015, A: 667, B: 667, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278, J: 500, K: 667, L: 556, M: 833, N: 722, O: 778, P: 667, Q: 778, R: 722,
  S: 667, T: 611, U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611, '[': 278, '\\': 278, ']': 278, '^': 469, _: 556, '`': 333,
  a: 556, b: 556, c: 500, d: 556, e: 556, f: 278, g: 556, h: 556, i: 222, j: 222, k: 500, l: 222, m: 833, n: 556, o: 556, p: 556, q: 556, r: 333, s: 500, t: 278,
  u: 556, v: 500, w: 722, x: 500, y: 500, z: 500, '{': 334, '|': 260, '}': 334, '~': 584,
};
export function textWidth(text: string, size: number): number {
  let w = 0;
  for (const ch of text) w += (HELV[ch] ?? 556) / 1000;
  return w * size;
}

interface Item {
  x: number;
  y: number; // from the TOP of the page
  size: number;
  text: string;
}
type Page = Item[];

const PAGE_W = 595;
const PAGE_H = 842;

function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function pdfFromPages(pages: Page[]): Buffer {
  const objs = new Map<number, string>();
  const pageNums: number[] = [];
  let next = 3;
  const contentNums: number[] = [];
  for (let i = 0; i < pages.length; i += 1) {
    pageNums.push(next++);
    contentNums.push(next++);
  }
  const fontNum = next++;
  objs.set(1, '<< /Type /Catalog /Pages 2 0 R >>');
  objs.set(2, `<< /Type /Pages /Kids [${pageNums.map((n) => `${n} 0 R`).join(' ')}] /Count ${pages.length} >>`);
  pages.forEach((items, i) => {
    // pdf.js joins consecutive runs on one line into a single item when they share a font; a real statement's cells come out as
    // separate items, so adjacent runs here alternate between two names for the same face.
    const stream = items.map((it, k) => `BT /F${1 + (k % 2)} ${it.size} Tf 1 0 0 1 ${it.x.toFixed(2)} ${(PAGE_H - it.y).toFixed(2)} Tm (${esc(it.text)}) Tj ET`).join('\n');
    objs.set(pageNums[i], `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Contents ${contentNums[i]} 0 R /Resources << /Font << /F1 ${fontNum} 0 R /F2 ${fontNum} 0 R >> >> >>`);
    objs.set(contentNums[i], `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
  });
  objs.set(fontNum, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let n = 1; n < next; n += 1) {
    offsets[n] = Buffer.byteLength(out, 'latin1');
    out += `${n} 0 obj\n${objs.get(n)}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${next}\n0000000000 65535 f \n`;
  for (let n = 1; n < next; n += 1) out += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${next} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

export interface NabEntry {
  /** Printed ONLY on the first transaction of a day. */
  date?: string;
  /** Columns of the first particulars line, e.g. ['Online', '1234567890', 'Linked Acc Trns']. Omit for a single-line transaction. */
  head?: string[];
  /** The text before the dotted leader on the amount line, e.g. 'Sample Payee'. */
  payee: string;
  side: 'debit' | 'credit';
  amount: number;
  /** Print the running balance on this line. */
  balance?: boolean;
  /** A 3-line transaction: an extra middle line. */
  middle?: string;
  /** A narrative row (no amount) printed AFTER this entry, carrying the running balance, like a rate note. */
  rateNoteAfter?: string;
}

export interface NabSpec {
  opening: number;
  entries: NabEntry[];
  /** Entries per page (a page also carries Brought forward / Carried forward). Default 12. */
  perPage?: number;
  /** The date text printed on the opening Brought forward line and the notice. */
  startDate?: string;
  statementStarts?: string;
  statementEnds?: string;
  /** Print the free-text notice after the first Brought forward line. */
  notice?: boolean;
  /** Print Debits and Credits headings the wrong way round (a negative control). */
  swapHeadings?: boolean;
  /** Print every amount under the OPPOSITE column to the one its balance implies (a negative control: the direction is the column). */
  amountsInOppositeColumns?: boolean;
  /** Omit the column header line from every page. */
  omitHeader?: boolean;
  /** Print "Total debits / credits" in the summary this far from the truth (cents). */
  totalsOffCents?: number;
  /** Print this closing balance in the summary instead of the true one. */
  closingOverride?: number;
  /** Print this balance (not the true one) on the Nth entry's line (1-based) -- an off-by-one-cent control. */
  wrongBalanceOnEntry?: { entry: number; balance: number };
  /** Shift the amounts of ONE entry (1-based) away from its column by this many points (an amount the columns cannot place). */
  misplaceAmountOnEntry?: { entry: number; dx: number };
}

export interface NabExpectedRow {
  dateIso: string;
  datePrinted: boolean;
  description: string;
  amount: number;
  side: 'debit' | 'credit';
  balance: number | null;
}

export interface BuiltNab {
  pdf: Buffer;
  expected: NabExpectedRow[];
  summary: { opening: number; closing: number; totalDebits: number; totalCredits: number };
  pageCount: number;
  /** Expected counts of excluded lines. */
  broughtForwardLines: number;
  carriedForwardLines: number;
}

const MONTHS: Record<string, string> = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
function toIso(d: string): string {
  const [dd, mon, yy] = d.split(' ');
  return `${yy}-${MONTHS[mon]}-${dd.padStart(2, '0')}`;
}
export function money(n: number): string {
  const [i, f] = Math.abs(n).toFixed(2).split('.');
  return `${i.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${f}`;
}
const r2 = (n: number) => Math.round(n * 100) / 100;

export function buildNabClassicPdf(spec: NabSpec): BuiltNab {
  const perPage = spec.perPage ?? 12;
  const startDate = spec.startDate ?? '04 Mar 2024';
  const pages: Page[] = [];
  const expected: NabExpectedRow[] = [];
  const geom = (pageIndex: number) => ({
    // the real statement shifts its columns by about two points between pages 1 and 2
    dateX: pageIndex === 0 ? 38.1 : 40,
    partX: pageIndex === 0 ? 100.8 : 103,
    debitRight: pageIndex === 0 ? 394.2 : 396,
    creditRight: pageIndex === 0 ? 465.3 : 467,
    balanceRight: pageIndex === 0 ? 548.4 : 550,
  });

  let balance = spec.opening;
  let totalDebits = 0;
  let totalCredits = 0;
  let entryNo = 0;
  let cursor = 0;
  let pageIndex = 0;
  let broughtForwardLines = 0;
  let carriedForwardLines = 0;
  let dateInForce = startDate;
  const totalPages = Math.max(1, Math.ceil(spec.entries.length / perPage));
  const entryPrintedBalance = new Map<number, number>();

  while (cursor < spec.entries.length || pageIndex === 0) {
    const g = geom(pageIndex);
    const items: Page = [];
    const put = (x: number, y: number, text: string, size = 10) => items.push({ x, y, size, text });
    const putRight = (right: number, y: number, text: string, size = 10) => items.push({ x: right - textWidth(text, size), y, size, text });
    let y: number;

    if (pageIndex === 0) {
      put(309, 40, 'NAB Classic Banking', 11);
      put(360, 120, 'Opening balance');
      put(360, 131, 'Total debits');
      put(360, 142, 'Total credits');
      put(360, 153, 'Closing balance');
      // values are filled after the ledger is computed (see below); placeholders keep the order
      put(360, 200, `Statement starts ${spec.statementStarts ?? '4 March 2024'}`, 10);
      put(360, 211, 'Statement ends', 10);
      put(436.8, 211, spec.statementEnds ?? '1 June 2024', 10);
      put(309, 240, 'BSB number', 9);
      put(394, 240, '123-456', 9);
      put(309, 252, 'Account number', 9);
      put(394, 252, '12-345-6789', 9);
      put(38.1, 300, 'Transaction Details', 11);
      y = 314;
    } else {
      put(40, 40, 'Transaction Details (continued)', 11);
      y = 54;
    }
    const headerY = y;
    if (!spec.omitHeader) {
      put(g.dateX, y, 'Date');
      put(g.partX, y, 'Particulars');
      putRight(g.debitRight, y, spec.swapHeadings ? 'Credits' : 'Debits');
      putRight(g.creditRight, y, spec.swapHeadings ? 'Debits' : 'Credits');
      putRight(g.balanceRight, y, 'Balance');
    }
    y += 12;

    // Brought forward
    const bf = (balance: number) => {
      if (pageIndex === 0) put(g.dateX + 1, y, startDate);
      put(g.partX, y, 'Brought forward');
      const text = `${money(balance)}`;
      putRight(g.balanceRight - 12.6, y, text);
      put(g.balanceRight - 6.9, y, balance < 0 ? 'Dr' : 'Cr');
      broughtForwardLines += 1;
      y += 11.1;
    };
    bf(balance);

    if (pageIndex === 0 && spec.notice) {
      put(g.dateX + 1, y, startDate);
      put(g.partX, y, 'As a result of changes to our fees, some customers will be charged a new fee', 10);
      y += 11.1;
      put(g.partX, y, 'for a service they do not use. You are not affected if you do nothing and your', 10);
      y += 11.1;
      put(g.partX, y, 'account stays as it is. See the notice at nab.example/notice.', 10);
      y += 11.1;
    }

    let onPage = 0;
    while (cursor < spec.entries.length && onPage < perPage) {
      const e = spec.entries[cursor];
      cursor += 1;
      entryNo += 1;
      onPage += 1;
      const delta = e.side === 'credit' ? e.amount : -e.amount;
      balance = r2(balance + delta);
      if (e.side === 'debit') totalDebits = r2(totalDebits + e.amount);
      else totalCredits = r2(totalCredits + e.amount);
      const datePrinted = Boolean(e.date);
      if (e.date) dateInForce = e.date;
      const lines: Array<() => void> = [];
      const head = e.head;
      const amountText = money(e.amount);
      const printed = spec.wrongBalanceOnEntry?.entry === entryNo ? spec.wrongBalanceOnEntry.balance : balance;
      const dx = spec.misplaceAmountOnEntry?.entry === entryNo ? spec.misplaceAmountOnEntry.dx : 0;
      const descParts: string[] = [];
      const firstLine = () => {
        if (e.date) put(g.dateX + 1, y, e.date);
        if (head) {
          let x = g.partX;
          head.forEach((h, i) => {
            put(x, y, h);
            descParts.push(h);
            x += textWidth(h, 10) + (i === 0 ? 10 : 10);
          });
        }
        y += 11.1;
      };
      const amountLine = () => {
        const placeAs = spec.amountsInOppositeColumns ? (e.side === 'debit' ? 'credit' : 'debit') : e.side;
        const target = placeAs === 'debit' ? g.debitRight : g.creditRight;
        const dot = textWidth('.', 10);
        if (placeAs === 'debit') {
          const used = textWidth(`${e.payee} `, 10) + textWidth(` ${amountText}`, 10);
          const n = Math.max(3, Math.floor((target - g.partX - used) / dot));
          put(g.partX, y, `${e.payee} ${'.'.repeat(n)} ${amountText}`);
          if (dx) items[items.length - 1].x += dx;
        } else {
          const n1 = Math.max(3, Math.floor((437 - g.partX - textWidth(`${e.payee} `, 10)) / dot));
          put(g.partX, y, `${e.payee} ${'.'.repeat(n1)}`);
          const tail = `${'.'.repeat(18)} ${amountText}`;
          putRight(target + dx, y, tail);
        }
        descParts.push(e.payee);
        if (e.balance) {
          putRight(g.balanceRight - 12.6, y, money(printed));
          put(g.balanceRight - 6.9, y, printed < 0 ? 'Dr' : 'Cr');
          entryPrintedBalance.set(entryNo, printed);
        }
        y += 11.1;
      };
      if (head) lines.push(firstLine);
      else if (e.date) {
        lines.push(() => {
          // a single-line transaction still carries its date on that line
          put(g.dateX + 1, y, e.date as string);
        });
      }
      if (e.middle) {
        lines.push(() => {
          put(g.partX, y, e.middle as string);
          descParts.push(e.middle as string);
          y += 11.1;
        });
      }
      lines.forEach((l) => l());
      amountLine();
      expected.push({
        dateIso: toIso(dateInForce),
        datePrinted,
        description: descParts.join(' '),
        amount: e.amount,
        side: e.side,
        balance: e.balance ? printed : null,
      });
      if (e.rateNoteAfter) {
        put(g.dateX + 1, y, dateInForce);
        put(g.partX, y, e.rateNoteAfter);
        putRight(g.balanceRight - 12.6, y, money(balance));
        put(g.balanceRight - 6.9, y, balance < 0 ? 'Dr' : 'Cr');
        y += 11.1;
      }
    }

    const last = cursor >= spec.entries.length;
    if (!last) {
      put(g.partX, y + 4, 'Carried forward');
      putRight(g.balanceRight - 12.6, y + 4, money(balance));
      put(g.balanceRight - 6.9, y + 4, balance < 0 ? 'Dr' : 'Cr');
      carriedForwardLines += 1;
    } else {
      // small-print terms after the table on the last page (smaller than the table's type)
      put(71, y + 30, 'Interest is calculated on the daily closing balance and credited at the end of each month.', 9);
      put(79, y + 40, 'fees may apply to some services, see the fee guide or call us for the current amounts.', 9);
      put(41, y + 60, 'Standard fee $9.99 per month, waived when you deposit $2,000.00 or more each month.', 8);
    }
    // vertical margin text and a large stray glyph in the margin (neither is part of any line of the table)
    for (let k = 0; k < 6; k += 1) items.push({ x: 22.5, y: headerY + 40 + k * 3.3, size: 3.3, text: String(k) });
    items.push({ x: 30, y: headerY + 60, size: 20, text: ')' });
    // footer
    put(38.1, 807, `Statement number ${pageIndex + 1}`, 8);
    put(141.9, 807, 'National Australia Bank Limited ABN 12 345 678 901 AFSL and Australian Credit Licence 123456', 8);
    put(501, 807, `Page ${pageIndex + 1} of ${totalPages}`, 8);
    pages.push(items);
    pageIndex += 1;
    if (pageIndex > 60) throw new Error('too many pages');
  }

  const closing = balance;
  // summary box values (page 1)
  const first = pages[0];
  const sumRight = 529;
  const addSum = (yy: number, v: number, side = true) => {
    const t = `$${money(v)}`;
    first.push({ x: sumRight - textWidth(t, 10), y: yy, size: 10, text: t });
    if (side) first.push({ x: 536.1, y: yy, size: 10, text: v < 0 ? 'Dr' : 'Cr' });
  };
  addSum(120, spec.opening);
  addSum(131, r2(totalDebits + (spec.totalsOffCents ?? 0) / 100), false);
  addSum(142, totalCredits, false);
  addSum(153, spec.closingOverride ?? closing);

  void entryPrintedBalance;
  return {
    pdf: pdfFromPages(pages),
    expected,
    summary: { opening: spec.opening, closing: spec.closingOverride ?? closing, totalDebits, totalCredits },
    pageCount: pages.length,
    broughtForwardLines,
    carriedForwardLines,
  };
}

/** A realistic ledger: a mix of 3-line, 2-line and single-line transactions, debits and credits, a date on the first transaction of
 * each day, a balance on the last transaction of each day. All names and numbers are invented. */
export function sampleLedger(count: number, startDay = 10): NabEntry[] {
  const payees = ['Sample Payee One', 'Sample Payee Two', 'Example Energy Co', 'Demo Grocer', 'Test Transfer Out', 'Sample Employer Pty Ltd'];
  const entries: NabEntry[] = [];
  let day = startDay;
  for (let i = 0; i < count; i += 1) {
    const firstOfDay = i % 3 === 0;
    if (firstOfDay) day += 1;
    const lastOfDay = i % 3 === 2 || i === count - 1;
    const side: 'debit' | 'credit' = i % 4 === 3 ? 'credit' : 'debit';
    const amount = r2(12.34 + ((i * 37) % 900) + (i % 5) * 0.11);
    const kind = i % 3;
    entries.push({
      date: firstOfDay ? `${String(day).padStart(2, '0')} Mar 2024` : undefined,
      head: kind === 0 ? ['Online', String(1000000000 + i * 7919), 'Linked Acc Trns'] : kind === 1 ? ['Direct Debit', String(2000000000 + i * 104729)] : undefined,
      payee: payees[i % payees.length],
      side,
      amount,
      balance: lastOfDay,
      middle: kind === 1 && i % 6 === 1 ? 'Ref 654321' : undefined,
    });
  }
  return entries;
}

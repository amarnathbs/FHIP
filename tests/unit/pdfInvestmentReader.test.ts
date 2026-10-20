/**
 * Australian investment PDF reader (layouts HOLD-1 and TXN-1) over the real corpus PDFs: real PDF bytes -> the real local text
 * extractor -> the certified reader. The expected values come from scripts/pdf_routes_corpus.ts (hand-computed); nothing is read
 * back from the reader. The documents the reader cannot or must not read fail LEGITIMATELY (it is not weakened to force the AI).
 */
import { describe, expect, it } from 'vitest';
import { INVESTMENT_DOCS, buildCorpusPdf, type InvestmentDoc } from '../../scripts/pdf_routes_corpus';
import { readStatementPdf, type PdfStatementText } from '@/lib/financial-data-hub/pdf-statements';
import { readAuInvestmentPdf, type AuInvestmentPdfReadOk } from '@/lib/financial-data-hub/investment/pdfStatement';
import { reconcileAuStatementTotals } from '@/lib/financial-data-hub/investment/statementTotals';
import { AU_STATEMENT_TRANSACTION_TYPES } from '@/lib/financial-data-hub/investment/types';

const doc = (id: string): InvestmentDoc => INVESTMENT_DOCS.find((d) => d.id === id)!;
const kindOf = (d: InvestmentDoc): 'portfolio' | 'transaction' => d.declared.statement_kind as 'portfolio' | 'transaction';

async function textOf(d: InvestmentDoc): Promise<PdfStatementText> {
  const text = await readStatementPdf(new Uint8Array(buildCorpusPdf(d)));
  if (!text.ok) throw new Error(`text extraction failed for ${d.id}`);
  return text;
}

async function readDoc(d: InvestmentDoc) {
  const text = await textOf(d);
  return { text, result: readAuInvestmentPdf({ text, currencyCode: 'AUD', kind: kindOf(d) }) };
}

async function readOk(id: string): Promise<AuInvestmentPdfReadOk> {
  const { result } = await readDoc(doc(id));
  if (!result.ok) throw new Error(`${id} was not read: ${result.kind} ${result.detail ?? ''}`);
  return result;
}

/** A decimal string without trailing zeros, so `500.0000` and the corpus number `500` compare as the same decimal. */
function dec(s: string | number | undefined | null): string | null {
  if (s === undefined || s === null) return null;
  const str = String(s);
  return str.includes('.') ? str.replace(/0+$/, '').replace(/\.$/, '') : str;
}

/** Rebuilds a page-tagged text from edited lines (the mutation controls). */
function rebuild(text: PdfStatementText, edit: (lines: string[]) => string[]): PdfStatementText {
  const lines = edit(text.lines.map((l) => l.text));
  const pdfLines = lines.map((t) => ({ page: 1, text: t }));
  return { ok: true, pageCount: 1, pages: [lines.join('\n')], lines: pdfLines, text: lines.join('\n') };
}

function reconcile(r: AuInvestmentPdfReadOk) {
  const ex = r.extraction;
  return reconcileAuStatementTotals({
    currencyCode: ex.currencyCode,
    positionMarketValues: ex.positions.map((p) => p.marketValue ?? null),
    cashBalance: ex.cashBalance ?? null,
    closingPortfolioValue: ex.closingPortfolioValue ?? null,
  });
}

const READ_IDS = ['AI-01', 'AI-02', 'AI-04', 'AI-05', 'AI-06'];

describe('investment reader: the documents the certified layouts cover', () => {
  for (const id of READ_IDS) {
    const d = doc(id);
    const e = d.expected!;

    it(`${id} is read line for line and header for header`, async () => {
      const r = await readOk(id);
      const ex = r.extraction;
      expect(r.layout).toBe(e.kind === 'holdings' ? 'HOLD-1' : 'TXN-1');
      expect(ex.statementType).toBe(e.kind === 'holdings' ? 'broker_holdings_statement' : 'broker_transaction_statement');
      expect(ex.parserName).toBe(e.kind === 'holdings' ? 'fdh_pdf_au_holdings_1' : 'fdh_pdf_au_transactions_1');
      expect(ex.parserVersion).toBe('1.0.0');
      expect(ex.extractionConfidence).toBe(0.95);
      expect(ex.country).toBe('AU');
      expect(ex.currencyCode).toBe('AUD');
      expect(ex.institutionName).toBe(e.institution);
      expect(ex.maskedAccountIdentifier).toBe(`****${e.last4}`);

      if (e.kind === 'holdings') {
        expect(ex.statementDate).toBe(e.date);
        expect(dec(ex.cashBalance)).toBe(dec(e.cash));
        expect(dec(ex.closingPortfolioValue)).toBe(dec(e.printedTotal));
        expect(ex.transactions).toEqual([]);
        expect(
          ex.positions.map((p) => ({
            code: p.tickerRaw, name: p.securityNameRaw, quantity: dec(p.quantity), price: dec(p.unitPrice), value: dec(p.marketValue), date: p.valuationDate, currency: p.currencyCode,
          })),
        ).toEqual(
          e.holdings.map((h) => ({ code: h.code, name: h.name, quantity: dec(h.quantity), price: dec(h.price), value: dec(h.value), date: e.date, currency: 'AUD' })),
        );
      } else {
        expect(ex.statementPeriodStart).toBe(e.periodStart);
        expect(ex.statementPeriodEnd).toBe(e.periodEnd);
        expect(ex.positions).toEqual([]);
        expect(ex.closingPortfolioValue).toBeUndefined();
        expect(ex.cashBalance).toBeUndefined();
        expect(
          ex.transactions.map((t) => ({
            date: t.tradeDate, type: t.transactionType, code: t.tickerRaw ?? null, quantity: dec(t.quantity), price: dec(t.unitPrice), brokerage: dec(t.brokerageRaw), amount: dec(t.amount),
          })),
        ).toEqual(
          e.transactions.map((t) => ({ date: t.date, type: t.type, code: t.code, quantity: dec(t.quantity), price: dec(t.price), brokerage: dec(t.brokerage), amount: dec(t.amount) })),
        );
        // The type vocabulary is the existing closed one.
        for (const t of ex.transactions) expect(AU_STATEMENT_TRANSACTION_TYPES).toContain(t.transactionType);
      }
    });

    it(`${id}: the existing certified totals check gives the expected verdict (${d.route.reconciliation})`, async () => {
      const r = await readOk(id);
      const totals = reconcile(r);
      expect(totals.status).toBe(d.route.reconciliation);
      if (id === 'AI-04') {
        // Read AS PRINTED: the wrong value is kept, the line check is counted, and nothing certifies.
        expect(r.lineChecksFailed).toBeGreaterThanOrEqual(1);
        expect(r.extraction.warnings).toContain('value_not_quantity_times_price_GRV');
        expect(r.extraction.warnings).toContain('holdings_total_mismatch');
        expect(totals.holdingsMinor).toBe(997000);
        expect(totals.closingMinor).toBe(1025000);
      } else {
        expect(r.lineChecksFailed).toBe(0);
        expect(r.extraction.warnings).toEqual([]);
      }
      // Certified = reconciled with no warning and no failed line check.
      const certified = totals.status === 'reconciled' && r.extraction.warnings.length === 0 && r.lineChecksFailed === 0;
      expect(certified).toBe(d.route.outcome === 'certified');
    });
  }

  it('AI-04 keeps the page figures exactly as printed (3,570.00 is not corrected to 3,750.00)', async () => {
    const r = await readOk('AI-04');
    expect(r.extraction.positions.map((p) => p.marketValue)).toEqual(['3570.00', '6400.00']);
  });

  it('AI-02 carries the brokerage per line, an empty cell as absent, and no invented cash or total', async () => {
    const r = await readOk('AI-02');
    const t = r.extraction.transactions;
    expect(t.map((x) => x.brokerageRaw)).toEqual(['19.95', '19.95', undefined, '19.95', undefined]);
    expect(t[2].quantity).toBeUndefined();
    expect(t[4].tickerRaw).toBeUndefined();
    expect(t.map((x) => x.sourceRowNumber)).toEqual([1, 2, 3, 4, 5]);
    expect(r.notes.summaryLinesExcluded).toBe(3);
  });

  it('AI-06 keeps both identical KLM rows and skips the subtotal, cash, total and Note lines', async () => {
    const r = await readOk('AI-06');
    expect(r.extraction.positions.map((p) => p.tickerRaw)).toEqual(['KLM', 'KLM', 'NOP']);
    expect(r.extraction.positions.filter((p) => p.marketValue === '3300.00')).toHaveLength(2);
    expect(r.notes.summaryLinesExcluded).toBe(3);
    expect(r.notes.footnotesSkipped).toBe(1);
    expect(dec(r.extraction.cashBalance)).toBe('900');
    expect(dec(r.extraction.closingPortfolioValue)).toBe('12000');
  });

  it('AI-05: the repeated header, the continued markers and the institution repeat are page markers, all seven holdings are read', async () => {
    const r = await readOk('AI-05');
    expect(r.extraction.positions).toHaveLength(7);
    expect(r.notes.pageMarkersSkipped).toBe(4);
  });
});

describe('investment reader: legitimate failures (never forced, never guessed)', () => {
  it('AI-03 (one labelled block per holding, no table) is a layout the certified reader cannot read', async () => {
    const { result } = await readDoc(doc('AI-03'));
    expect(result).toMatchObject({ ok: false, kind: 'layout_unsupported' });
  });
  it('AI-07 (a superannuation statement) is not this class', async () => {
    const { result } = await readDoc(doc('AI-07'));
    expect(result).toMatchObject({ ok: false, kind: 'not_this_class' });
  });
  it('AI-08 (two HINs, two tables, two totals) is refused as multiple accounts', async () => {
    const { result } = await readDoc(doc('AI-08'));
    expect(result).toMatchObject({ ok: false, kind: 'multiple_accounts' });
  });
  it('every document the corpus says the certified reader cannot read fails with exactly the expected kind', async () => {
    for (const d of INVESTMENT_DOCS.filter((x) => x.route.deterministic !== 'reads')) {
      const { result } = await readDoc(d);
      expect(result, d.id).toMatchObject({ ok: false, kind: d.route.deterministic });
    }
  });
  it('every document the corpus says the certified reader reads is read', async () => {
    for (const d of INVESTMENT_DOCS.filter((x) => x.route.deterministic === 'reads')) {
      const { result } = await readDoc(d);
      expect(result.ok, d.id).toBe(true);
    }
  });
});

describe('investment reader: mutation controls (each edit must change the outcome)', () => {
  it('an unknown row inside a holdings table is unread_lines, not a dropped line', async () => {
    const text = rebuild(await textOf(doc('AI-01')), (l) => {
      const i = l.findIndex((x) => x.startsWith('Cash balance'));
      return [...l.slice(0, i), 'ZZZ Mystery Holding with no figures', ...l.slice(i)];
    });
    expect(readAuInvestmentPdf({ text, currencyCode: 'AUD', kind: 'portfolio' })).toMatchObject({ ok: false, kind: 'unread_lines' });
  });

  it('a holdings row with an unreadable price is unread_lines', async () => {
    const text = rebuild(await textOf(doc('AI-01')), (l) => l.map((x) => (x.startsWith('BMT ') ? 'BMT Bellmouth Index ETF 1,200.0000 98.75x 118,500.00' : x)));
    expect(readAuInvestmentPdf({ text, currencyCode: 'AUD', kind: 'portfolio' })).toMatchObject({ ok: false, kind: 'unread_lines' });
  });

  it('an unknown line inside a transactions table is unread_lines, and so is an unknown transaction type', async () => {
    const base = await textOf(doc('AI-02'));
    const extra = rebuild(base, (l) => {
      const i = l.findIndex((x) => x.startsWith('Total buys'));
      return [...l.slice(0, i), 'Adjustment of something unspecified', ...l.slice(i)];
    });
    expect(readAuInvestmentPdf({ text: extra, currencyCode: 'AUD', kind: 'transaction' })).toMatchObject({ ok: false, kind: 'unread_lines' });
    const badType = rebuild(base, (l) => l.map((x) => (x.startsWith('15/07/2026') ? '15/07/2026 BONUS CNP - - - 127.50' : x)));
    expect(readAuInvestmentPdf({ text: badType, currencyCode: 'AUD', kind: 'transaction' })).toMatchObject({ ok: false, kind: 'unread_lines' });
  });

  it('removing the table header is layout_unsupported (AI-01 and AI-02)', async () => {
    const h = rebuild(await textOf(doc('AI-01')), (l) => l.filter((x) => !x.startsWith('Code Security')));
    expect(readAuInvestmentPdf({ text: h, currencyCode: 'AUD', kind: 'portfolio' })).toMatchObject({ ok: false, kind: 'layout_unsupported' });
    const t = rebuild(await textOf(doc('AI-02')), (l) => l.filter((x) => !x.startsWith('Date Type')));
    expect(readAuInvestmentPdf({ text: t, currencyCode: 'AUD', kind: 'transaction' })).toMatchObject({ ok: false, kind: 'layout_unsupported' });
  });

  it('a 0.02 change to a holding value trips the value check and the line-check counter', async () => {
    const text = rebuild(await textOf(doc('AI-01')), (l) => l.map((x) => x.replace('ARX Arrowroot Industries Limited 500.0000 18.4200 9,210.00', 'ARX Arrowroot Industries Limited 500.0000 18.4200 9,210.02')));
    const r = readAuInvestmentPdf({ text, currencyCode: 'AUD', kind: 'portfolio' });
    if (!r.ok) throw new Error('not read');
    expect(r.extraction.warnings).toContain('value_not_quantity_times_price_ARX');
    expect(r.lineChecksFailed).toBe(1);
    expect(reconcile(r).status).toBe('variance');
  });

  it('the rounding rule is exactly 0.01: a one-cent difference on a value is accepted, two cents is not', async () => {
    const oneCent = rebuild(await textOf(doc('AI-01')), (l) => l.map((x) => x.replace('DLK Delphic Global Fund 2,345.6789 1.8750 4,398.15', 'DLK Delphic Global Fund 2,345.6789 1.8750 4,398.16')));
    const r1 = readAuInvestmentPdf({ text: oneCent, currencyCode: 'AUD', kind: 'portfolio' });
    if (!r1.ok) throw new Error('not read');
    expect(r1.lineChecksFailed).toBe(0);
    // ... but the exact total check still sees the cent.
    expect(r1.extraction.warnings).toContain('holdings_total_mismatch');
    expect(reconcile(r1).status).toBe('variance');
  });

  it('a 0.01 change to the printed total makes the existing totals check a variance', async () => {
    const text = rebuild(await textOf(doc('AI-01')), (l) => l.map((x) => (x.startsWith('Total portfolio value') ? 'Total portfolio value: $137,021.66' : x)));
    const r = readAuInvestmentPdf({ text, currencyCode: 'AUD', kind: 'portfolio' });
    if (!r.ok) throw new Error('not read');
    expect(reconcile(r).status).toBe('variance');
    expect(r.extraction.warnings).toContain('holdings_total_mismatch');
  });

  it('a holdings statement without a printed total is insufficient_data, with no total or cash invented', async () => {
    const text = rebuild(await textOf(doc('AI-01')), (l) => l.filter((x) => !x.startsWith('Total portfolio value') && !x.startsWith('Cash balance')));
    const r = readAuInvestmentPdf({ text, currencyCode: 'AUD', kind: 'portfolio' });
    if (!r.ok) throw new Error('not read');
    expect(r.extraction.closingPortfolioValue).toBeUndefined();
    expect(r.extraction.cashBalance).toBeUndefined();
    expect(reconcile(r).status).toBe('insufficient_data');
  });

  it('the optional Cost base column is read and validated, and a row that lacks it is unread_lines', async () => {
    const withCost = rebuild(await textOf(doc('AI-04')), (l) =>
      l.map((x) => {
        if (x.startsWith('Code Security')) return 'Code Security Quantity Price Value Cost base';
        if (x.startsWith('GRV ')) return `${x} 3,000.00`;
        if (x.startsWith('HLM ')) return `${x} 5,000.00`;
        return x;
      }),
    );
    const ok = readAuInvestmentPdf({ text: withCost, currencyCode: 'AUD', kind: 'portfolio' });
    if (!ok.ok) throw new Error('not read');
    expect(ok.extraction.positions.map((p) => p.marketValue)).toEqual(['3570.00', '6400.00']);
    expect(ok.notes.costBaseValuesNotStored).toBe(2);
    const missing = rebuild(withCost, (l) => l.map((x) => (x.startsWith('HLM ') ? x.replace(' 5,000.00', '') : x)));
    expect(readAuInvestmentPdf({ text: missing, currencyCode: 'AUD', kind: 'portfolio' })).toMatchObject({ ok: false, kind: 'unread_lines' });
  });

  it('a holdings text read as a transaction statement (and the reverse) is layout_unsupported, never re-typed', async () => {
    const hold = await textOf(doc('AI-01'));
    const txn = await textOf(doc('AI-02'));
    expect(readAuInvestmentPdf({ text: hold, currencyCode: 'AUD', kind: 'transaction' })).toMatchObject({ ok: false, kind: 'layout_unsupported', detail: 'kind_mismatch' });
    expect(readAuInvestmentPdf({ text: txn, currencyCode: 'AUD', kind: 'portfolio' })).toMatchObject({ ok: false, kind: 'layout_unsupported', detail: 'kind_mismatch' });
  });

  it('a transaction line that does not follow from units, price and brokerage is counted and warned, and the printed total disagrees', async () => {
    const text = rebuild(await textOf(doc('AI-02')), (l) => l.map((x) => x.replace('9,829.95', '9,830.00')));
    const r = readAuInvestmentPdf({ text, currencyCode: 'AUD', kind: 'transaction' });
    if (!r.ok) throw new Error('not read');
    expect(r.lineChecksFailed).toBe(1);
    expect(r.extraction.warnings).toContain('line_arithmetic_fails_row_1');
    expect(r.extraction.warnings).toContain('printed_total_mismatch_buys');
    // The line is kept as printed.
    expect(r.extraction.transactions[0].amount).toBe('9830.00');
  });

  it('a 0.01 change to a printed transaction total is a visible warning without a failed line check', async () => {
    const text = rebuild(await textOf(doc('AI-02')), (l) => l.map((x) => (x.startsWith('Total sells') ? 'Total sells: $3,760.06' : x)));
    const r = readAuInvestmentPdf({ text, currencyCode: 'AUD', kind: 'transaction' });
    if (!r.ok) throw new Error('not read');
    expect(r.lineChecksFailed).toBe(0);
    expect(r.extraction.warnings).toEqual(['printed_total_mismatch_sells']);
  });

  it('printed transaction totals on one line are read the same as on separate lines', async () => {
    const text = rebuild(await textOf(doc('AI-02')), (l) => {
      const i = l.findIndex((x) => x.startsWith('Total buys'));
      return [...l.slice(0, i), 'Total buys: $11,549.90 Total sells: $3,760.05 Total brokerage: $59.85'];
    });
    const r = readAuInvestmentPdf({ text, currencyCode: 'AUD', kind: 'transaction' });
    if (!r.ok) throw new Error('not read');
    expect(r.extraction.warnings).toEqual([]);
    expect(r.notes.summaryLinesExcluded).toBe(3);
  });

  it('a printed currency code that is not the declared one is a warning', async () => {
    const text = rebuild(await textOf(doc('AI-01')), (l) => l.map((x) => (x.startsWith('Valuation date') ? `${x} (values in USD)` : x)));
    const r = readAuInvestmentPdf({ text, currencyCode: 'AUD', kind: 'portfolio' });
    if (!r.ok) throw new Error('not read');
    expect(r.extraction.warnings).toContain('printed_currency_differs_from_declared');
  });

  it('a second, different HIN with one table does not hide: the identifier ambiguity is a warning that forces review', async () => {
    const text = rebuild(await textOf(doc('AI-01')), (l) => l.map((x) => (x.startsWith('Phone:') ? 'Joint holder HIN: X0000 9999' : x)));
    const r = readAuInvestmentPdf({ text, currencyCode: 'AUD', kind: 'portfolio' });
    if (!r.ok) throw new Error('not read');
    expect(r.extraction.warnings).toContain('multiple_account_identifiers');
  });

  it('only the last four characters of the HIN are ever kept', async () => {
    const r = await readOk('AI-01');
    expect(JSON.stringify(r.extraction)).not.toMatch(/X0000|00004417/);
    expect(r.extraction.maskedAccountIdentifier).toBe('****4417');
  });
});

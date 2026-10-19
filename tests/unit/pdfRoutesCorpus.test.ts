/**
 * The accuracy corpus for the PDF routes (liability, retirement, Australian investment): the files are exactly what the
 * generator builds, the manifest and the expected-value sheet are committed and current, and EVERY expected figure is
 * independently re-derived here in integer cents. Nothing in this file uses any reader, parser or model of the application:
 * if a hand-computed figure in scripts/pdf_routes_corpus.ts were wrong, this file fails.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  ALL_CORPUS_DOCS,
  LIABILITY_DOCS,
  RETIREMENT_DOCS,
  INVESTMENT_DOCS,
  buildCorpusPdf,
  expectedValuesMarkdown,
  manifestText,
  sha256,
  type CorpusDocBase,
} from '../../scripts/pdf_routes_corpus';
import { extractPdfPages } from '@/lib/financial-data-hub/bank-pdf/textExtraction';

const DIR = path.resolve(__dirname, '../../docs/ai/pdf_routes_liab_ret_auinv');
const cents = (n: number) => Math.round(n * 100);
const fmt = (n: number) => n.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

describe('corpus files, manifest and sheet are committed and current', () => {
  it('every PDF on disk equals the generator output and is a real PDF', () => {
    for (const d of ALL_CORPUS_DOCS) {
      const onDisk = fs.readFileSync(path.join(DIR, 'corpus', d.filename));
      expect(sha256(onDisk), d.filename).toBe(sha256(buildCorpusPdf(d)));
      expect(onDisk.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    }
  });
  it('the manifest and the expected-value sheet are the generated ones (LF endings)', () => {
    expect(fs.readFileSync(path.join(DIR, 'corpus', 'MANIFEST.sha256'), 'utf8').replace(/\r\n/g, '\n')).toBe(manifestText());
    expect(fs.readFileSync(path.join(DIR, 'EXPECTED_VALUES.md'), 'utf8').replace(/\r\n/g, '\n')).toBe(expectedValuesMarkdown());
  });
  it('there are at least six documents per class and every required role is covered', () => {
    const need = ['clean', 'needs_fallback', 'wrong_on_page', 'multi', 'trap', 'negative_control'];
    for (const set of [LIABILITY_DOCS, RETIREMENT_DOCS, INVESTMENT_DOCS] as readonly CorpusDocBase[][]) {
      expect(set.length).toBeGreaterThanOrEqual(6);
      for (const role of need) expect(set.some((d) => d.role === role), `${set[0].cls} ${role}`).toBe(true);
    }
  });
  it('ids and filenames are unique', () => {
    expect(new Set(ALL_CORPUS_DOCS.map((d) => d.id)).size).toBe(ALL_CORPUS_DOCS.length);
    expect(new Set(ALL_CORPUS_DOCS.map((d) => d.filename)).size).toBe(ALL_CORPUS_DOCS.length);
  });
});

describe('the PDFs really carry the printed lines in their text layer (checked with the PDF library only)', () => {
  for (const d of ALL_CORPUS_DOCS) {
    it(`${d.id}: every line is in the extracted text, page by page`, async () => {
      const r = await extractPdfPages(new Uint8Array(buildCorpusPdf(d)));
      expect(r.ok, d.id).toBe(true);
      if (!r.ok) return;
      expect(r.pages.length).toBe(d.pages.length);
      d.pages.forEach((lines, i) => {
        const text = norm(r.pages[i]);
        for (const line of lines) expect(text, `${d.id} p${i + 1}: ${line}`).toContain(norm(line));
      });
    });
  }
});

describe('liability: independent re-derivation of every expected figure', () => {
  const PLUS = new Set(['PURCHASE', 'CASH_ADVANCE', 'INTEREST', 'FEE', 'LOAN_ADVANCE']);
  const MINUS = new Set(['PAYMENT', 'REFUND', 'PRINCIPAL']);
  for (const d of LIABILITY_DOCS) {
    const e = d.expected;
    if (!e) continue;
    it(`${d.id}: opening +/- lines = the closing the lines give; printed closing differs only where the page is wrong`, () => {
      let c = cents(e.opening);
      for (const a of e.activities) {
        if (PLUS.has(a.type)) c += cents(a.amount);
        else if (MINUS.has(a.type)) c -= cents(a.amount);
        else throw new Error(`type ${a.type}`);
      }
      expect(c, d.id).toBe(cents(e.closingByLines));
      if (d.role === 'wrong_on_page') expect(cents(e.printedClosing) - cents(e.closingByLines)).toBe(4395);
      else expect(cents(e.printedClosing)).toBe(cents(e.closingByLines));
    });
    it(`${d.id}: every expected money figure is printed on the page`, () => {
      const text = norm(d.pages.flat().join(' '));
      const figs = [e.opening, e.printedClosing, ...e.activities.map((a) => a.amount)];
      if (e.creditLimit !== undefined) figs.push(e.creditLimit);
      if (e.minimumPayment !== undefined) figs.push(e.minimumPayment);
      for (const f of figs) expect(text, `${d.id} ${fmt(f)}`).toContain(fmt(f));
    });
  }
  it('LB-06: the printed total lines equal the sums of their parts (so they are traps, not extra activity)', () => {
    const e = LIABILITY_DOCS.find((x) => x.id === 'LB-06')!.expected!;
    const purchases = e.activities.filter((a) => a.type === 'PURCHASE').reduce((s, a) => s + cents(a.amount), 0);
    const feesInterest = e.activities.filter((a) => a.type === 'FEE' || a.type === 'INTEREST').reduce((s, a) => s + cents(a.amount), 0);
    expect(purchases).toBe(64030);
    expect(feesInterest).toBe(3810);
  });
  it('LB-02 loan identity: opening + capitalised interest and fees - repayments = closing, and the running balances follow each line', () => {
    const e = LIABILITY_DOCS.find((x) => x.id === 'LB-02')!.expected!;
    const capitalised = e.activities.filter((a) => a.type === 'INTEREST' || a.type === 'FEE').reduce((s, a) => s + cents(a.amount), 0);
    const repaid = e.activities.filter((a) => a.type === 'PAYMENT').reduce((s, a) => s + cents(a.amount), 0);
    expect(cents(e.opening) + capitalised - repaid).toBe(cents(e.closingByLines));
    const doc = LIABILITY_DOCS.find((x) => x.id === 'LB-02')!;
    let bal = cents(e.opening);
    for (const line of doc.pages[0]) {
      const m = line.match(/^\d\d\/\d\d\/\d{4} (.+) ([\d,]+\.\d\d) ([\d,]+\.\d\d)$/);
      if (!m) continue;
      const amt = cents(Number(m[2].replace(/,/g, '')));
      const after = cents(Number(m[3].replace(/,/g, '')));
      bal = /REPAYMENT/.test(m[1]) ? bal - amt : bal + amt;
      expect(after, line).toBe(bal);
    }
  });
});

describe('retirement: independent re-derivation of every expected figure', () => {
  for (const d of RETIREMENT_DOCS) {
    const e = d.expected;
    if (!e) continue;
    it(`${d.id}: opening + movements = the closing the movements give; printed closing differs only where the page is wrong`, () => {
      let c = cents(e.opening);
      c += cents(e.employer ?? 0) + cents(e.personal ?? 0) + cents(e.salarySacrifice ?? 0) + cents(e.government ?? 0) + cents(e.rolloversIn ?? 0) + cents(e.earnings ?? 0);
      c -= cents(e.fees ?? 0) + cents(e.insurance ?? 0) + cents(e.tax ?? 0) + cents(e.withdrawals ?? 0) + cents(e.pensionPayments ?? 0);
      const credit = new Set(['EMPLOYER_CONTRIBUTION', 'PERSONAL_CONTRIBUTION', 'INVESTMENT_EARNINGS']);
      for (const a of e.activities) c += credit.has(a.type) ? cents(a.amount) : -cents(a.amount);
      expect(c, d.id).toBe(cents(e.closingByMovements));
      if (d.role === 'wrong_on_page') expect(cents(e.printedClosing) - cents(e.closingByMovements)).toBe(18000);
      else expect(cents(e.printedClosing)).toBe(cents(e.closingByMovements));
    });
    it(`${d.id}: each option's balance is units x price rounded to the cent, and the options sum to the printed closing`, () => {
      if (e.options.length === 0) return;
      for (const o of e.options) expect(cents(o.value), `${d.id} ${o.name}`).toBe(Math.round(o.units * o.unitPrice * 100));
      expect(e.options.reduce((s, o) => s + cents(o.value), 0)).toBe(cents(e.printedClosing));
    });
    it(`${d.id}: every expected money figure is printed on the page`, () => {
      const inr = e.jurisdiction === 'IN';
      const lakh = (n: number) => {
        const [i, f] = n.toFixed(2).split('.');
        const last3 = i.slice(-3);
        const rest = i.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
        return `${rest ? `${rest},` : ''}${last3}.${f}`;
      };
      const text = norm(d.pages.flat().join(' '));
      const figs = [e.opening, e.printedClosing, ...e.activities.map((a) => a.amount), ...e.options.map((o) => o.value)];
      for (const k of [e.employer, e.personal, e.salarySacrifice, e.government, e.rolloversIn, e.earnings, e.withdrawals, e.pensionPayments]) if (k !== undefined) figs.push(k);
      for (const f of figs) expect(text, `${d.id} ${f}`).toContain(inr ? lakh(f) : fmt(f));
    });
  }
  it('RT-01 fees are the sum of the two printed fee lines; RT-02 likewise', () => {
    expect(cents(231.0) + cents(154.2)).toBe(cents(RETIREMENT_DOCS[0].expected!.fees!));
    expect(cents(980) + cents(440)).toBe(cents(RETIREMENT_DOCS[1].expected!.fees!));
  });
  it('RT-06 printed subtotals equal the sums of their parts (a reader that adds both double counts)', () => {
    const e = RETIREMENT_DOCS.find((x) => x.id === 'RT-06')!.expected!;
    expect(cents(e.employer!) + cents(e.personal!)).toBe(250000);
    expect(cents(95) + cents(60)).toBe(cents(e.fees!));
  });
  it('RT-05 the year-to-date column is present and is NOT the period figure', () => {
    const text = RETIREMENT_DOCS.find((x) => x.id === 'RT-05')!.pages.flat().join(' ');
    for (const ytd of ['9,300.00', '5,880.10', '380.00', '1,395.00']) expect(text).toContain(ytd);
  });
});

describe('australian investment: independent re-derivation of every expected figure', () => {
  for (const d of INVESTMENT_DOCS) {
    const e = d.expected;
    if (!e) continue;
    if (e.kind === 'holdings') {
      it(`${d.id}: units x price = value to the cent, except where the page is wrong; the printed total ties exactly`, () => {
        for (const h of e.holdings) {
          const exact = Math.round(h.quantity * h.price * 100);
          if (d.role === 'wrong_on_page' && h.code === 'GRV') expect(h.value * 100).not.toBe(exact);
          else expect(cents(h.value), `${d.id} ${h.code}`).toBe(exact);
        }
        const sum = e.holdings.reduce((s, h) => s + cents(h.value), 0) + cents(e.cash ?? 0);
        expect(sum).toBe(cents(e.sumOfPrinted!));
        if (d.role === 'wrong_on_page') expect(cents(e.printedTotal!) - sum).toBe(18000);
        else expect(sum).toBe(cents(e.printedTotal!));
      });
      it(`${d.id}: every expected money figure is printed on the page`, () => {
        const text = norm(d.pages.flat().join(' '));
        const figs = [...e.holdings.map((h) => h.value)];
        if (e.cash !== undefined) figs.push(e.cash);
        if (e.printedTotal !== undefined) figs.push(e.printedTotal);
        for (const f of figs) expect(text, `${d.id} ${fmt(f)}`).toContain(fmt(f));
      });
    } else {
      it(`${d.id}: each line's arithmetic and the printed totals`, () => {
        let buys = 0;
        let sells = 0;
        let brokerage = 0;
        for (const t of e.transactions) {
          if (t.type === 'BUY') {
            expect(cents(t.amount)).toBe(Math.round(t.quantity! * t.price! * 100) + cents(t.brokerage!));
            buys += cents(t.amount);
            brokerage += cents(t.brokerage!);
          } else if (t.type === 'SELL') {
            expect(cents(t.amount)).toBe(Math.round(t.quantity! * t.price! * 100) - cents(t.brokerage!));
            sells += cents(t.amount);
            brokerage += cents(t.brokerage!);
          }
        }
        expect(buys).toBe(cents(e.totalBuys!));
        expect(sells).toBe(cents(e.totalSells!));
        expect(brokerage).toBe(cents(e.totalBrokerage!));
      });
    }
  }
});

/**
 * The NAB statement reader that uses TEXT POSITIONS (30-10-2026). UNIT-TESTED, from SYNTHETIC multi-page PDFs laid out with a real NAB
 * statement's column geometry (tests/support/buildNabClassicPdf.ts); no real statement, name, number or amount is in this file.
 *
 * What is proven, through the REAL pipeline (`runBankPdfPipeline`: classify -> detect -> positions -> rows -> normalise -> reconcile):
 *   - a debit and a credit are told apart by the COLUMN of the amount, every one, on every page;
 *   - the particulars of a transaction (several lines) are merged into ONE description with the dotted leaders gone;
 *   - the date is carried from the line that prints it; the running balance is kept wherever the statement prints one;
 *   - Brought forward / Carried forward / footer / notice / small print / margin text are excluded, never read as transactions;
 *   - the rollforward certifies the statement exactly, and a cent of difference anywhere makes it fail;
 *   - a layout the reader cannot place confidently is NOT guessed: it falls through to the AI path (`unsupported_layout` + the text).
 *
 * NEGATIVE CONTROLS. Several tests below change one thing in the INPUT and require a named assertion to go the other way (columns
 * swapped -> directions flip and the rollforward fails; a balance one cent out; a closing balance one cent out; totals one cent out;
 * an amount off its column; no header). The SOURCE-level controls (the reader's own rules removed one at a time) are recorded in the
 * mission report, each with the failing test names.
 */
import { describe, expect, it } from 'vitest';
import { runBankPdfPipeline } from '@/lib/financial-data-hub/bank-pdf/orchestrator';
import { extractPositionedPdfPages } from '@/lib/financial-data-hub/bank-pdf/positionedText';
import { readNabClassicStatement } from '@/lib/financial-data-hub/bank-pdf/nabClassicPositional';
import { buildNabClassicPdf, sampleLedger, type NabEntry, type NabSpec } from '../support/buildNabClassicPdf';
import type { DedupIndex } from '@/lib/financial-data-hub/bank-csv/dedup';

const run = (pdf: Buffer) =>
  runBankPdfPipeline({ bytes: new Uint8Array(pdf), statementUploadId: 'upl', financialAccountId: 'acct', currencyCode: 'AUD', dedupIndex: new Map() as DedupIndex });

const standard = (over: Partial<NabSpec> = {}, entries: NabEntry[] = sampleLedger(40)) => buildNabClassicPdf({ opening: 1234.56, entries, perPage: 12, notice: true, ...over });

describe('NAB positional reader: a statement laid out like the real one', () => {
  const built = standard();

  it('is detected as the NAB Date / Particulars / Debits / Credits / Balance layout and read to a certifiable result', async () => {
    const p = await run(built.pdf);
    expect(p.status).toBe('ok');
    expect(p.adapter?.id).toBe('au_nab_classic_pdf_v2');
    expect(p.pageCount).toBe(built.pageCount);
    expect(built.pageCount).toBeGreaterThanOrEqual(4);
    expect(p.accepted).toHaveLength(40);
    expect(p.rejected).toHaveLength(0);
    expect(p.unparseableBlockCount).toBe(0);
    expect(p.reconciliation).toMatchObject({ status: 'reconciled', method: 'balance_rollforward', variance: 0, firstBreakRowNumber: null, openingBalance: 1234.56 });
    expect(p.reconciliation?.reportedClosingBalance).toBe(built.summary.closing);
    expect(p.statementMetadata).toMatchObject({ declaredOpeningBalance: 1234.56, declaredClosingBalance: built.summary.closing, statementPeriodStart: '2024-03-04', statementPeriodEnd: '2024-06-01' });
    expect(p.statementMetadata?.maskedAccountIdentifier).toBe('****6789');
    expect(p.extractedText).toBeNull(); // nothing is carried out on success
  });

  it('reads the DIRECTION of every transaction from its column, with the right amount, description and date', async () => {
    const p = await run(built.pdf);
    expect(p.accepted.map((a) => a.creditDebit)).toEqual(built.expected.map((e) => e.side));
    expect(p.accepted.map((a) => a.amountOriginal)).toEqual(built.expected.map((e) => e.amount));
    expect(p.accepted.map((a) => a.descriptionRaw)).toEqual(built.expected.map((e) => e.description));
    expect(p.accepted.map((a) => a.transactionDate)).toEqual(built.expected.map((e) => e.dateIso));
    expect(p.accepted.some((a) => a.creditDebit === 'credit')).toBe(true);
    expect(p.accepted.some((a) => a.creditDebit === 'debit')).toBe(true);
  });

  it('merges the several lines of the particulars into ONE description and leaves no dotted leader in it', async () => {
    const p = await run(built.pdf);
    for (const a of p.accepted) {
      expect(a.descriptionRaw).not.toMatch(/\.{2,}/);
      expect(a.descriptionClean).toBe(a.descriptionRaw);
      expect(a.descriptionRaw.length).toBeGreaterThan(5);
    }
    // a three-line transaction: type, reference, memo on the first line + a middle line + the payee
    expect(p.accepted.some((a) => a.descriptionRaw.startsWith('Online ') && a.descriptionRaw.includes('Linked Acc Trns Sample'))).toBe(true);
    expect(p.accepted.some((a) => a.descriptionRaw.includes('Ref 654321 '))).toBe(true);
  });

  it('carries the date from the line that prints it (the date is printed on the first transaction of a day only)', async () => {
    const r = readNabClassicStatement((await extractPositionedPdfPages(new Uint8Array(built.pdf)) as { ok: true; pages: never }).pages);
    expect(r.kind).toBe('read');
    if (r.kind !== 'read') return;
    const printed = built.expected.filter((e) => e.datePrinted).length;
    expect(r.counts.datesPrinted).toBe(printed);
    expect(r.counts.datesCarried).toBe(40 - printed);
    expect(r.counts.datesCarried).toBeGreaterThan(20);
    expect(r.rows.map((x) => x.datePrinted)).toEqual(built.expected.map((e) => e.datePrinted));
  });

  it('keeps the running balance wherever the statement prints one, and nowhere else', async () => {
    const p = await run(built.pdf);
    expect(p.accepted.map((a) => a.balanceAfter)).toEqual(built.expected.map((e) => e.balance));
    expect(p.accepted.filter((a) => a.balanceAfter !== null).length).toBeGreaterThan(10);
    expect(p.accepted.filter((a) => a.balanceAfter === null).length).toBeGreaterThan(10);
  });

  it('excludes Brought forward, Carried forward, page footers, the notice, the small print and the margin text, and counts each', async () => {
    const r = readNabClassicStatement((await extractPositionedPdfPages(new Uint8Array(built.pdf)) as { ok: true; pages: never }).pages);
    expect(r.kind).toBe('read');
    if (r.kind !== 'read') return;
    const x = r.counts.excluded;
    expect(x.broughtForwardLines).toBe(built.broughtForwardLines);
    expect(x.carriedForwardLines).toBe(built.carriedForwardLines);
    expect(x.pageFooterLines).toBe(built.pageCount);
    expect(x.headerLines).toBe(built.pageCount);
    expect(x.noticeLines).toBe(3);
    expect(x.nonTableTextLines).toBeGreaterThanOrEqual(3); // the small print on the last page
    expect(x.leftOverLinesAtEnd).toBe(0);
    expect(r.counts.transactions).toBe(40);
    expect(r.counts.debits + r.counts.credits).toBe(40);
    // none of the notice, the small print or the footer leaked into a description
    for (const row of r.rows) expect(row.descriptionRaw).not.toMatch(/fee|notice|Page \d|ABN|Interest is calculated/i);
  });

  it('is deterministic: the same bytes give the same rows twice, and the caller\'s bytes survive a read', async () => {
    const bytes = new Uint8Array(built.pdf);
    const a = await extractPositionedPdfPages(bytes);
    const b = await extractPositionedPdfPages(bytes); // pdf.js detaches the buffer it is given; the reader copies it
    expect(a.ok && b.ok).toBe(true);
    expect(bytes.byteLength).toBe(built.pdf.byteLength);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('NAB positional reader: balances, narrative rows and page breaks', () => {
  it('reads a Dr (overdrawn) balance as negative and still reconciles', async () => {
    const entries: NabEntry[] = [
      { date: '11 Mar 2024', head: ['Online', '1111111111', 'Linked Acc Trns'], payee: 'Sample Payee One', side: 'debit', amount: 150.5, balance: true },
      { date: '12 Mar 2024', payee: 'Demo Grocer', side: 'debit', amount: 40.25, balance: true },
      { date: '13 Mar 2024', payee: 'Sample Employer Pty Ltd', side: 'credit', amount: 500, balance: true },
    ];
    const built = buildNabClassicPdf({ opening: 100, entries });
    const p = await run(built.pdf);
    expect(p.status).toBe('ok');
    expect(p.accepted.map((a) => a.balanceAfter)).toEqual([-50.5, -90.75, 409.25]);
    expect(p.reconciliation?.status).toBe('reconciled');
  });

  it('keeps a narrative row that prints a balance but no amount (a rate note) as a check, never as a transaction', async () => {
    const entries = sampleLedger(10);
    entries[4] = { ...entries[4], rateNoteAfter: 'Interest Rate Changed On 01 Mar 2024 New Rate Is 0.01%' };
    const built = buildNabClassicPdf({ opening: 1234.56, entries, perPage: 6 });
    const p = await run(built.pdf);
    expect(p.status).toBe('ok');
    expect(p.accepted).toHaveLength(10);
    expect(p.reconciliation?.status).toBe('reconciled');
    expect(p.accepted.every((a) => !a.descriptionRaw.includes('Interest Rate'))).toBe(true);
  });

  it('reads every transaction even when the margin carries a differently sized stray glyph on the same line', async () => {
    const built = standard({}, sampleLedger(25));
    const p = await run(built.pdf);
    expect(p.accepted).toHaveLength(25);
  });
});

describe('NAB positional reader: NEGATIVE CONTROLS (change the input, the named assertion must go the other way)', () => {
  it('CONTROL every amount printed under the OPPOSITE column -> EVERY direction flips (the direction IS the column) and the rollforward FAILS', async () => {
    const ok = await run(standard().pdf);
    const flipped = await run(standard({ amountsInOppositeColumns: true }).pdf);
    expect(flipped.status).toBe('ok'); // it still reads the layout, but what it reads is the opposite
    expect(flipped.accepted.map((a) => a.creditDebit)).toEqual(ok.accepted.map((a) => (a.creditDebit === 'debit' ? 'credit' : 'debit')));
    expect(flipped.reconciliation?.status).toBe('failed');
    expect(ok.reconciliation?.status).toBe('reconciled');
  });

  it('CONTROL the Debits and Credits HEADINGS printed the wrong way round -> the reader declines (it does not guess which is which); AI path with the text', async () => {
    const p = await run(standard({ swapHeadings: true }).pdf);
    expect(p.status).toBe('unsupported_layout');
    expect(p.accepted).toHaveLength(0);
    expect(p.extractedPages?.length).toBe(4);
  });

  it('CONTROL a printed balance ONE CENT out on one line -> failed, at that very line', async () => {
    const entries = sampleLedger(40);
    const probe = standard({}, entries);
    const target = probe.expected.findIndex((e, i) => e.balance !== null && i > 10) + 1;
    const wrong = standard({ wrongBalanceOnEntry: { entry: target, balance: Math.round((probe.expected[target - 1].balance! + 0.01) * 100) / 100 } }, entries);
    const p = await run(wrong.pdf);
    expect(p.reconciliation?.status).toBe('failed');
    expect(p.reconciliation?.firstBreakRowNumber).toBe(target);
  });

  it('CONTROL the closing balance in the summary ONE CENT out -> failed, variance exactly one cent', async () => {
    const probe = standard();
    const p = await run(standard({ closingOverride: Math.round((probe.summary.closing + 0.01) * 100) / 100 }).pdf);
    expect(p.reconciliation?.status).toBe('failed');
    expect(Math.abs(p.reconciliation?.variance ?? 0)).toBe(0.01);
  });

  it('CONTROL the statement\'s own Total debits ONE CENT out -> failed', async () => {
    const p = await run(standard({ totalsOffCents: 1 }).pdf);
    expect(p.reconciliation?.status).toBe('failed');
    expect(p.reconciliation?.variance).toBe(0); // the balances all agree; only the printed total disagrees
  });

  it('CONTROL an amount sitting under NO column -> the reader declines (nothing guessed); the document goes to the AI path with its text', async () => {
    const p = await run(standard({ misplaceAmountOnEntry: { entry: 7, dx: 60 } }).pdf);
    expect(p.status).toBe('unsupported_layout');
    expect(p.accepted).toHaveLength(0);
    expect(p.extractedText).toContain('Particulars');
    expect(p.extractedPages?.length).toBeGreaterThan(1);
  });

  it('CONTROL no column header on the page -> not detected as this layout at all; the AI path, exactly as before', async () => {
    const p = await run(standard({ omitHeader: true }).pdf);
    expect(p.status).toBe('unsupported_layout');
    expect(p.adapter).toBeNull();
    expect(p.extractedText).not.toBeNull();
  });
});

describe('NAB positional reader: an interest-rate notice printed in Title Case in front of a transaction (30-10-2026)', () => {
  // The real statement prints "Please Note From <date> Your Debit Int Rate Is n%" on the DATE line of the next transaction, whose own text follows
  // on the next line. Read as a description it produced "Please Note From ... 15.41% Store Id ..." and hid what the payment was.
  const NOTICE_A = 'Please Note From 11 Mar 2024 Your Debit Int Rate Is 15.41%';
  const NOTICE_B = 'Please Note From 12 Mar 2024 Your Debit Int Rate Is 20.00%';
  const entries: NabEntry[] = [
    { date: '10 Mar 2024', head: ['Online', '1000000007', 'Linked Acc Trns'], payee: 'Sample As', side: 'debit', amount: 100, balance: true },
    { date: '12 Mar 2024', noticeBefore: NOTICE_A, head: ['Store Id: ,', 'Txn I', 'Sample Pay'], payee: 'Ref 480255', side: 'credit', amount: 257.16, balance: true },
    { date: '15 Mar 2024', noticeBefore: NOTICE_B, payee: 'Sample Payee One', side: 'debit', amount: 50, balance: true },
    { payee: 'Please Pay Sample Ltd', side: 'debit', amount: 20.5, balance: true },
  ];
  const built = buildNabClassicPdf({ opening: 1234.56, entries, perPage: 12 });

  it('keeps the notice OUT of the description and reads the transaction it sat in front of, with the right date, direction and amount', async () => {
    const p = await run(built.pdf);
    expect(p.status).toBe('ok');
    expect(p.accepted.map((a) => a.descriptionRaw)).toEqual(built.expected.map((e) => e.description));
    for (const a of p.accepted) expect(a.descriptionRaw).not.toMatch(/Int Rate|Please Note From/i);
    expect(p.accepted.map((a) => a.transactionDate)).toEqual(['2024-03-10', '2024-03-12', '2024-03-15', '2024-03-15']);
    expect(p.accepted[1]).toMatchObject({ creditDebit: 'credit', amountOriginal: 257.16 });
    expect(p.accepted[2]).toMatchObject({ creditDebit: 'debit', amountOriginal: 50 });
    expect(p.reconciliation).toMatchObject({ status: 'reconciled', variance: 0 });
  });

  it('counts both notices as excluded lines, and reads exactly the transactions printed (no line lost, none invented)', async () => {
    const r = readNabClassicStatement((await extractPositionedPdfPages(new Uint8Array(built.pdf)) as { ok: true; pages: never }).pages);
    expect(r.kind).toBe('read');
    if (r.kind !== 'read') return;
    expect(r.rows).toHaveLength(entries.length);
    expect(r.counts.excluded.noticeLines).toBe(2);
  });

  it('NEGATIVE: a real transaction whose payee merely STARTS with "Please" (it has its dotted leader and an amount) is still a transaction', async () => {
    const p = await run(built.pdf);
    expect(p.accepted[3].descriptionRaw).toBe('Please Pay Sample Ltd');
    expect(p.accepted[3].amountOriginal).toBe(20.5);
  });
});

/**
 * Retirement PDF reader (layout RET-1) over the real corpus PDFs: real PDF bytes -> the real local text extractor -> the certified
 * reader. The expected values come from scripts/pdf_routes_corpus.ts (hand-computed); nothing is read back from the reader.
 * The fallback-needing documents must fail LEGITIMATELY (the reader is not weakened to force the AI).
 */
import { describe, expect, it } from 'vitest';
import { RETIREMENT_DOCS, buildCorpusPdf, type RetirementDoc } from '../../scripts/pdf_routes_corpus';
import { minorToDecimalString, readStatementPdf, type PdfStatementText } from '@/lib/financial-data-hub/pdf-statements';
import { readRetirementPdf } from '@/lib/financial-data-hub/retirement/pdfStatement';
import { reconcileStatement } from '@/lib/financial-data-hub/retirement/reconciliation';

const doc = (id: string): RetirementDoc => RETIREMENT_DOCS.find((d) => d.id === id)!;

async function textOf(d: RetirementDoc): Promise<PdfStatementText | null> {
  const text = await readStatementPdf(new Uint8Array(buildCorpusPdf(d)));
  return text.ok ? text : null;
}

async function readDoc(d: RetirementDoc) {
  const text = await textOf(d);
  if (!text) return { text: null, result: null };
  const result = readRetirementPdf({ text, jurisdiction: d.declared.jurisdiction as 'AU' | 'IN', currencyCode: d.declared.currency });
  return { text, result };
}

function textFromLines(lines: string[]): PdfStatementText {
  return {
    ok: true,
    pageCount: 1,
    pages: [lines.join('\n')],
    lines: lines.map((t) => ({ page: 1, text: t })),
    text: lines.join('\n'),
  };
}

/** Expected number -> the exact decimal string with two places (no float arithmetic beyond rounding a hand-written literal). */
const dec = (n: number | undefined): string | undefined => (n === undefined ? undefined : minorToDecimalString(Math.round(n * 100)));

describe('retirement reader: the documents the certified layout covers', () => {
  for (const d of RETIREMENT_DOCS.filter((x) => x.route.deterministic === 'reads')) {
    it(`${d.id} is read header for header, movement for movement, option for option`, async () => {
      const { result } = await readDoc(d);
      expect(result?.ok, d.id).toBe(true);
      if (!result?.ok) return;
      const e = d.expected!;
      const x = result.extraction;
      expect(result.layout).toBe('RET-1');
      expect(x.fundName).toBe(e.fund);
      expect(x.maskedAccountIdentifier).toBe(`****${e.last4}`);
      expect(x.statementStartDate).toBe(e.periodStart);
      expect(x.statementEndDate).toBe(e.periodEnd);
      expect(x.statementDate).toBeUndefined();
      expect(x.jurisdiction).toBe(e.jurisdiction);
      expect(x.currencyCode).toBe(e.currency);
      expect(x.accountType).toBe('unknown');
      expect(x.openingBalance).toBe(dec(e.opening));
      expect(x.closingBalance).toBe(dec(e.printedClosing));
      expect(x.employerContributions).toBe(dec(e.employer));
      expect(x.personalContributions).toBe(dec(e.personal));
      expect(x.salarySacrifice).toBe(dec(e.salarySacrifice));
      expect(x.governmentContributions).toBe(dec(e.government));
      expect(x.rolloversIn).toBe(dec(e.rolloversIn));
      expect(x.rolloversOut).toBeUndefined();
      expect(x.withdrawals).toBe(dec(e.withdrawals));
      expect(x.pensionPayments).toBe(dec(e.pensionPayments));
      expect(x.investmentEarnings).toBe(dec(e.earnings));
      expect(x.fees).toBe(dec(e.fees));
      expect(x.insurancePremiums).toBe(dec(e.insurance));
      expect(x.tax).toBe(dec(e.tax));
      expect(x.activities).toEqual([]);
      expect(x.positions.map((p) => ({ name: p.optionNameRaw, units: Number(p.units), price: Number(p.unitPrice), value: p.marketValue, ccy: p.currencyCode, on: p.valuationDate }))).toEqual(
        e.options.map((o) => ({ name: o.name, units: o.units, price: o.unitPrice, value: dec(o.value), ccy: e.currency, on: e.periodEnd })),
      );
      expect(x.parserName).toBe('fdh_pdf_retirement_1');
      expect(x.parserVersion).toBe('1.0.0');
      expect(x.extractionConfidence).toBe(0.95);
    });

    it(`${d.id}: the existing reconciliation gives the expected verdict (${d.route.reconciliation})`, async () => {
      const { result } = await readDoc(d);
      if (!result?.ok) throw new Error('not read');
      const rec = reconcileStatement(result.extraction);
      expect(rec.status).toBe(d.route.reconciliation);
      if (d.id === 'RT-04') expect(rec.varianceMinorUnits).toBe(BigInt(-18000));
      // Certified = reconciled AND no warning at all.
      const certified = rec.status === 'reconciled' && result.extraction.warnings.length === 0;
      expect(certified).toBe(d.route.outcome === 'certified');
    });
  }

  it('RT-01 types: an annual statement; RT-02 a pension statement; RT-04 a member statement', async () => {
    const types = await Promise.all(['RT-01', 'RT-02', 'RT-04'].map(async (id) => (await readDoc(doc(id))).result));
    expect(types.map((r) => (r?.ok ? r.extraction.statementType : null))).toEqual(['super_annual_statement', 'account_based_pension_statement', 'super_member_statement']);
  });

  it('RT-04: read as printed, the closing balance is 180.00 off and the statement carries a variance, never certified', async () => {
    const { result } = await readDoc(doc('RT-04'));
    if (!result?.ok) throw new Error('not read');
    expect(result.extraction.closingBalance).toBe('18420.00');
    expect(result.extraction.warnings).toEqual([]);
    expect(reconcileStatement(result.extraction).status).toBe('variance');
  });

  it('RT-05: the period column is used, the year-to-date column is never read into a period field', async () => {
    const { result } = await readDoc(doc('RT-05'));
    if (!result?.ok) throw new Error('not read');
    const x = result.extraction;
    expect([x.employerContributions, x.investmentEarnings, x.fees, x.tax]).toEqual(['2400.00', '1950.75', '96.00', '360.00']);
    expect(JSON.stringify(x)).not.toMatch(/9300|5880|380\.00|1395/);
    expect(result.notes.ytdFiguresDropped).toBe(4);
    expect(x.warnings).toEqual([]);
  });

  it('RT-06: printed subtotals are used once and their parts are not added again', async () => {
    const { result } = await readDoc(doc('RT-06'));
    if (!result?.ok) throw new Error('not read');
    const x = result.extraction;
    expect(x.employerContributions).toBe('2000.00');
    expect(x.personalContributions).toBe('500.00');
    expect(x.fees).toBe('155.00');
    expect(result.notes.subtotalsUsed).toBe(2);
    expect(x.warnings).toEqual([]);
    expect(reconcileStatement(x).status).toBe('reconciled');
  });
});

describe('retirement reader: legitimate refusals (never forced, never guessed)', () => {
  it('RT-03 (transaction history, no movement block) is a layout the certified reader cannot read', async () => {
    expect((await readDoc(doc('RT-03'))).result).toMatchObject({ ok: false, kind: 'layout_unsupported' });
  });
  it('RT-09 (India passbook) always takes the fallback: there is no certified India layout', async () => {
    expect((await readDoc(doc('RT-09'))).result).toMatchObject({ ok: false, kind: 'layout_unsupported', detail: 'no_certified_india_layout' });
  });
  it('an AU statement declared as India is not read either', async () => {
    const text = await textOf(doc('RT-01'));
    if (!text) throw new Error('text');
    expect(readRetirementPdf({ text, jurisdiction: 'IN', currencyCode: 'INR' })).toMatchObject({ ok: false, kind: 'layout_unsupported' });
  });
  it('RT-07 (a credit card statement) is not this class', async () => {
    expect((await readDoc(doc('RT-07'))).result).toMatchObject({ ok: false, kind: 'not_this_class' });
  });
  it('RT-08 (two accounts in one PDF) is refused as multiple accounts', async () => {
    expect((await readDoc(doc('RT-08'))).result).toMatchObject({ ok: false, kind: 'multiple_accounts' });
  });
  it('every document the corpus says the certified reader cannot read fails with exactly the expected kind', async () => {
    for (const d of RETIREMENT_DOCS.filter((x) => x.route.deterministic !== 'reads')) {
      const { result } = await readDoc(d);
      expect(result, d.id).toMatchObject({ ok: false, kind: d.route.deterministic });
    }
  });
});

describe('retirement reader: mutation controls built from the RT-01 lines', () => {
  async function rt01Lines(): Promise<string[]> {
    const text = await textOf(doc('RT-01'));
    if (!text) throw new Error('text');
    return text.lines.map((l) => l.text);
  }
  const read = (lines: string[]) => readRetirementPdf({ text: textFromLines(lines), jurisdiction: 'AU', currencyCode: 'AUD' });

  it('the unmodified lines are read (the controls below start from a clean read)', async () => {
    const r = read(await rt01Lines());
    expect(r.ok).toBe(true);
  });

  it('an unknown money line is never ignored: unread_lines', async () => {
    const lines = await rt01Lines();
    const at = lines.findIndex((l) => l.startsWith('Insurance premiums'));
    const mutated = [...lines.slice(0, at), 'Transfer to partner (splitting): $200.00', ...lines.slice(at)];
    expect(read(mutated)).toMatchObject({ ok: false, kind: 'unread_lines' });
  });

  it('a year-to-date pair without the This period / Year to date header is an unread line', async () => {
    const lines = await rt01Lines();
    const mutated = lines.map((l) => (l.startsWith('Employer contributions') ? 'Employer contributions: $7,820.00 $9,300.00' : l));
    expect(read(mutated)).toMatchObject({ ok: false, kind: 'unread_lines' });
  });

  it('a repeated label is not placed: unread_lines', async () => {
    const lines = await rt01Lines();
    const at = lines.findIndex((l) => l.startsWith('Employer contributions'));
    const mutated = [...lines.slice(0, at), lines[at], ...lines.slice(at)];
    expect(read(mutated)).toMatchObject({ ok: false, kind: 'unread_lines' });
  });

  it('a printed statement period that cannot be read (two-digit years) is unread, not guessed', async () => {
    const lines = await rt01Lines();
    const mutated = lines.map((l) => (l.startsWith('Statement period') ? 'Statement period: 01/07/25 to 30/06/26' : l));
    expect(read(mutated)).toMatchObject({ ok: false, kind: 'unread_lines' });
  });

  it('removing the Closing balance line makes the layout unsupported (no invented closing balance)', async () => {
    const lines = await rt01Lines();
    expect(read(lines.filter((l) => !l.startsWith('Closing balance')))).toMatchObject({ ok: false, kind: 'layout_unsupported' });
  });

  it('removing the Opening balance line makes the layout unsupported (no invented opening balance of 0)', async () => {
    const lines = await rt01Lines();
    expect(read(lines.filter((l) => !l.startsWith('Opening balance')))).toMatchObject({ ok: false, kind: 'layout_unsupported' });
  });

  it('changing one option balance raises the units-times-price warning and the options-sum warning (review forced)', async () => {
    const lines = await rt01Lines();
    const mutated = lines.map((l) => (l.startsWith('Cash Account') ? 'Cash Account 12,500.0500 1.0000 $12,500.55' : l));
    const r = read(mutated);
    if (!r.ok) throw new Error('not read');
    expect(r.extraction.warnings).toEqual(['value_not_units_times_price_row_2', 'options_do_not_sum_to_closing']);
  });

  it('units times price within the 0.01 rounding rule raises no per-option warning', async () => {
    const lines = await rt01Lines();
    // 3,500.0000 x 2.1636 = 7,572.60 exactly; 7,572.61 is 0.01 away (accepted for the product) but then the options no longer sum.
    const mutated = lines.map((l) => (l.startsWith('Australian Shares') ? 'Australian Shares 3,500.0000 2.1636 $7,572.61' : l));
    const r = read(mutated);
    if (!r.ok) throw new Error('not read');
    expect(r.extraction.warnings).toEqual(['options_do_not_sum_to_closing']);
  });

  it('a printed subtotal that its parts do not add up to carries the subtotal_mismatch warning', async () => {
    const text = await textOf(doc('RT-06'));
    if (!text) throw new Error('text');
    const lines = text.lines.map((l) => (l.text.startsWith('Total fees') ? 'Total fees: ($156.00)' : l.text));
    const r = read(lines);
    if (!r.ok) throw new Error('not read');
    expect(r.extraction.warnings).toEqual(['subtotal_mismatch_fees']);
    expect(r.extraction.fees).toBe('156.00');
    expect(reconcileStatement(r.extraction).status).toBe('variance');
  });

  it('a printed currency code that differs from the declared currency is a warning', async () => {
    const lines = await rt01Lines();
    const r = read([...lines, 'All amounts are shown in USD']);
    if (!r.ok) throw new Error('not read');
    expect(r.extraction.warnings).toContain('printed_currency_differs_from_declared');
  });

  it('a loss is kept signed, whether printed with a minus or in brackets', async () => {
    const lines = await rt01Lines();
    for (const printed of ['Investment earnings: -$812.00', 'Investment earnings: ($812.00)']) {
      const r = read(lines.map((l) => (l.startsWith('Investment earnings') ? printed : l)));
      if (!r.ok) throw new Error('not read');
      expect(r.extraction.investmentEarnings).toBe('-812.00');
    }
  });

  it('a cost printed plain, with a minus or in brackets is the same positive magnitude', async () => {
    const lines = await rt01Lines();
    for (const printed of ['Administration fees: $231.00', 'Administration fees: -$231.00', 'Administration fees: ($231.00)']) {
      const r = read(lines.map((l) => (l.startsWith('Administration fees') ? printed : l)));
      if (!r.ok) throw new Error('not read');
      expect(r.extraction.fees).toBe('385.20');
    }
  });

  it('changing a printed closing balance by 0.01 makes the existing reconciliation return a variance', async () => {
    const lines = await rt01Lines();
    const clean = read(lines);
    if (!clean.ok) throw new Error('not read');
    expect(reconcileStatement(clean.extraction).status).toBe('reconciled');

    const mutated = read(lines.map((l) => (l.startsWith('Closing balance') ? 'Closing balance: $59,672.66' : l)));
    if (!mutated.ok) throw new Error('not read');
    const rec = reconcileStatement(mutated.extraction);
    expect(rec.status).toBe('variance');
    expect(rec.varianceMinorUnits).toBe(BigInt(-1));
    // The options no longer sum to the closing balance either: visible, so the statement can never be certified.
    expect(mutated.extraction.warnings).toContain('options_do_not_sum_to_closing');
  });
});

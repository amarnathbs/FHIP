/**
 * Bank CSV column mapping (28-10-2026) -- the pure logic: detection of an unrecognised layout, header-word suggestions, the rules a
 * complete assignment must satisfy, the live preview, the date styles (including "12:00am Tue 30 June, 2026"), and the whole file read
 * through the SAME pipeline the import uses. All data is synthetic (tests/support/buildPoShapedBankCsv.ts).
 *
 * Evidence label: UNIT-TESTED.
 */
import { describe, expect, it } from 'vitest';
import { detectBankCsvFormat } from '@/lib/financial-data-hub/bank-csv/detection';
import { runBankCsvPipeline } from '@/lib/financial-data-hub/bank-csv/orchestrator';
import { adapterToRowFormat, joinDescriptions, mappingToRowFormat } from '@/lib/financial-data-hub/bank-csv/normalize';
import { dateFormatCandidates, parseDateWithFormat } from '@/lib/financial-data-hub/bank-csv/dateFormats';
import {
  adviseDateFormat,
  checkMapping,
  draftForStyle,
  formatDayFirst,
  mappingProblems,
  suggestMapping,
  toMapRequest,
  type MappingDraft,
} from '@/lib/financial-data-hub/bank-csv/mappingAssist';
import { bankCsvMappingConfirmSchema } from '@/lib/financial-data-hub/validation/bankCsv';
import { buildCustomCsv, buildPoShapedCsv, poShapedDate, UNRECOGNISED_VARIANT } from '../support/buildPoShapedBankCsv';
import type { FdhCsvColumnMapping } from '@/lib/financial-data-hub/domain/types';

function mapFor(bytes: Uint8Array) {
  const det = detectBankCsvFormat(bytes);
  expect(det.parsed).not.toBeNull();
  const { header, rows } = det.parsed!;
  const suggestion = suggestMapping(header, rows);
  return { det, header, rows, suggestion };
}

describe('a layout the importer does not recognise (the production dead end)', () => {
  it('a variant of the PO shape (one column missing) detects as manual_mapping_required, headings read with the byte-order mark stripped', () => {
    const { bytes, header } = buildPoShapedCsv(342, 1, UNRECOGNISED_VARIANT);
    const det = detectBankCsvFormat(bytes);
    expect(det.status).toBe('manual_mapping_required');
    expect(det.adapter).toBeNull();
    expect(det.header).toEqual(header);
    expect(det.parsed?.rows.length).toBe(342);
  });

  it('with no mapping the pipeline reads NOTHING from it (this is the dead end the person hit)', () => {
    const { bytes } = buildPoShapedCsv(60, 1, UNRECOGNISED_VARIANT);
    const result = runBankCsvPipeline({ bytes, statementUploadId: 'doc', financialAccountId: 'acc', currencyCode: 'AUD', dedupIndex: new Map() as never });
    expect(result.accepted).toHaveLength(0);
  });
});

describe('date styles', () => {
  it('reads "12:00am Tue 30 June, 2026" as 30 June 2026 and ignores the time', () => {
    expect(parseDateWithFormat('12:00am Tue 30 June, 2026', 'h:mma ddd D MMMM, YYYY')).toEqual({ ok: true, iso: '2026-06-30' });
    expect(parseDateWithFormat('11:59pm Wed 1 July, 2026', 'h:mma ddd D MMMM, YYYY')).toEqual({ ok: true, iso: '2026-07-01' });
    expect(parseDateWithFormat('9:05am Sat 2 Aug, 2025', 'h:mma ddd D MMMM, YYYY')).toEqual({ ok: true, iso: '2025-08-02' });
  });
  it('refuses what is not that shape or not a real day', () => {
    for (const bad of ['12:00am Tue 31 June, 2026', '12:00am Foo 30 June, 2026', '12:00am Tue 30 Junx, 2026', '13:00am Tue 30 June, 2026', '30 June 2026', '2026-06-30', '12:60am Tue 30 June, 2026']) {
      expect(parseDateWithFormat(bad, 'h:mma ddd D MMMM, YYYY').ok, bad).toBe(false);
    }
  });
  it('reads a month spelled out and the day-first two-digit year, and never a month-first reading of them', () => {
    expect(parseDateWithFormat('30 June 2026', 'D MMMM YYYY').iso).toBe('2026-06-30');
    expect(parseDateWithFormat('30 Jun 2026', 'D MMMM YYYY').iso).toBe('2026-06-30');
    expect(parseDateWithFormat('30/06/26', 'DD/MM/YY').iso).toBe('2026-06-30');
    expect(parseDateWithFormat('06/30/26', 'DD/MM/YY').ok).toBe(false); // month 30 does not exist: refused, not flipped
  });
  it('proves the order when the values do, and refuses to guess when they do not', () => {
    // 13 as the first number can only be a day.
    expect(dateFormatCandidates(['13/02/2026', '01/03/2026']).proven).toBe('DD/MM/YYYY');
    // 01/02/2026 alone is 1 February or 2 January: two readings, nothing chosen.
    const ambiguous = dateFormatCandidates(['01/02/2026', '03/04/2026']);
    expect(ambiguous.proven).toBeNull();
    expect(ambiguous.groups.length).toBeGreaterThan(1);
    // The PO shape has only one reading.
    expect(dateFormatCandidates(['12:00am Tue 30 June, 2026', '12:00am Mon 1 June, 2026']).proven).toBe('h:mma ddd D MMMM, YYYY');
  });
  it('shows dates day-first: dd/mm/yyyy for Australia, dd-mm-yyyy for India, never ISO', () => {
    expect(formatDayFirst('2026-06-30', 'AU')).toBe('30/06/2026');
    expect(formatDayFirst('2026-06-30', 'IN')).toBe('30-06-2026');
    expect(formatDayFirst('2026-06-30', 'AU')).not.toMatch(/2026-06/);
  });
});

describe('suggestions from header words', () => {
  it('pre-selects the right columns for the PO-shaped header, and uses no column twice', () => {
    const { suggestion } = mapFor(buildPoShapedCsv(50, 1, UNRECOGNISED_VARIANT).bytes);
    expect(suggestion.amountStyle).toBe('debit_credit_columns');
    expect(suggestion.draft).toMatchObject({
      transactionDate: 'Effective date',
      postedDate: 'Create date',
      description: 'Description',
      extraDescription: 'Long description',
      debit: 'Debit amount',
      credit: 'Credit amount',
      balance: 'Balance after transfer',
      reference: 'Reference no',
    });
    const used = Object.values(suggestion.draft).filter(Boolean) as string[];
    expect(new Set(used).size).toBe(used.length);
  });

  const variants: Array<{ label: string; shape: 'debit_credit' | 'single_signed' | 'indicator'; names: Parameters<typeof buildCustomCsv>[0]['names']; expectStyle: string; reverse?: boolean; extra?: number }> = [
    { label: 'different names, debit/credit split', shape: 'debit_credit', names: { date: 'Txn Dt', description: 'Narration', debit: 'Withdrawal', credit: 'Deposit', balance: 'Closing Bal' }, expectStyle: 'debit_credit_columns' },
    { label: 'one signed amount column', shape: 'single_signed', names: { date: 'Posted On', description: 'Details', amount: 'Value' }, expectStyle: 'single_signed' },
    { label: 'amount plus DR/CR marker', shape: 'indicator', names: { date: 'Date of transaction', description: 'Particulars', amount: 'Amount', indicator: 'DR/CR' }, expectStyle: 'dr_cr_indicator' },
    { label: 'reordered (last column first)', shape: 'debit_credit', names: { date: 'Txn Dt', description: 'Narration', debit: 'Money out', credit: 'Money in' }, expectStyle: 'debit_credit_columns', reverse: true },
    { label: '27 columns', shape: 'debit_credit', names: { date: 'Txn Dt', description: 'Narration', debit: 'Withdrawal', credit: 'Deposit', balance: 'Closing Bal' }, expectStyle: 'debit_credit_columns', extra: 20 },
  ];
  for (const v of variants) {
    it(`any bank: ${v.label} -> suggestion is right, the preview reads every row, the import reads every row`, () => {
      const built = buildCustomCsv({ count: 40, shape: v.shape, names: v.names, reverse: v.reverse, extraColumns: v.extra });
      const { det, header, rows, suggestion } = mapFor(built.bytes);
      expect(det.status).toBe('manual_mapping_required');
      if (v.extra) expect(header.length).toBeGreaterThanOrEqual(25);
      expect(suggestion.amountStyle).toBe(v.expectStyle);
      const style = suggestion.amountStyle!;
      const advice = adviseDateFormat(header, rows, suggestion.draft.transactionDate);
      expect(advice.proven === 'DD/MM/YYYY' || advice.proven === 'D/M/YYYY').toBe(true);
      expect(mappingProblems(header, suggestion.draft, style, advice.proven)).toEqual([]);
      const check = checkMapping(header, rows, suggestion.draft, style, advice.proven!);
      expect(check.readable).toBe(rows.length);

      // The import itself, from the request body the screen would send.
      const body = toMapRequest(suggestion.draft, style, advice.proven!, ',', { remember: true, allowSharedColumns: false });
      const rowFormat = mappingToRowFormat(body.column_mapping as FdhCsvColumnMapping, style, advice.proven!);
      const result = runBankCsvPipeline({ bytes: built.bytes, statementUploadId: 'd', financialAccountId: 'a', currencyCode: 'AUD', rowFormatOverride: rowFormat, dedupIndex: new Map() as never });
      expect(result.accepted).toHaveLength(40);
      expect(result.rejected).toHaveLength(0);
      const credits = result.accepted.filter((t) => t.creditDebit === 'credit').length;
      expect(credits).toBe(built.rows.filter((r) => r.credit > 0).length);
      const totalOut = result.accepted.filter((t) => t.creditDebit === 'debit').reduce((s, t) => s + t.amountOriginal, 0);
      expect(totalOut).toBeCloseTo(built.rows.reduce((s, r) => s + r.debit, 0), 2);
    });
  }
});

describe('what stops a person continuing (and what does not)', () => {
  const header = ['Txn Dt', 'Narration', 'Withdrawal', 'Deposit', 'Closing Bal'];
  const complete: MappingDraft = { transactionDate: 'Txn Dt', postedDate: null, description: 'Narration', extraDescription: null, amount: null, debit: 'Withdrawal', credit: 'Deposit', drCrIndicator: null, balance: 'Closing Bal', reference: null };

  it('a complete, consistent assignment has no problems', () => {
    expect(mappingProblems(header, complete, 'debit_credit_columns', 'DD/MM/YYYY')).toEqual([]);
  });
  it('each missing required field is named', () => {
    const problems = mappingProblems(header, { ...complete, transactionDate: null, description: null, debit: null, credit: null }, 'debit_credit_columns', 'DD/MM/YYYY');
    expect(problems.map((p) => p.field).sort()).toEqual(['credit', 'debit', 'description', 'transactionDate']);
  });
  it('the amount style and the date style must be chosen', () => {
    expect(mappingProblems(header, complete, null, 'DD/MM/YYYY')[0].field).toBe('amountStyle');
    expect(mappingProblems(header, complete, 'debit_credit_columns', null).map((p) => p.field)).toEqual(['dateFormat']);
  });
  it('one column for two fields is refused unless the person explicitly allows it', () => {
    const twice = { ...complete, balance: 'Withdrawal' };
    expect(mappingProblems(header, twice, 'debit_credit_columns', 'DD/MM/YYYY').some((p) => /already used/.test(p.message))).toBe(true);
    expect(mappingProblems(header, twice, 'debit_credit_columns', 'DD/MM/YYYY', { allowSharedColumns: true })).toEqual([]);
  });
  it('a column that is not in the file, or whose name appears twice, is refused', () => {
    expect(mappingProblems(header, { ...complete, description: 'Nope' }, 'debit_credit_columns', 'DD/MM/YYYY')[0].message).toMatch(/not in this file/);
    const dup = ['Txn Dt', 'Narration', 'Amt', 'Amt'];
    expect(mappingProblems(dup, { ...complete, amount: 'Amt', debit: null, credit: null, balance: null }, 'single_signed', 'DD/MM/YYYY').some((p) => /cannot be told apart/.test(p.message))).toBe(true);
  });
  it('switching the amount style drops the assignments that no longer belong', () => {
    const next = draftForStyle(complete, 'single_signed');
    expect(next.debit).toBeNull();
    expect(next.credit).toBeNull();
  });
});

describe('the preview catches a wrong assignment before the person continues', () => {
  const { bytes } = buildPoShapedCsv(120, 1, UNRECOGNISED_VARIANT);
  const { header, rows, suggestion } = mapFor(bytes);
  const style = suggestion.amountStyle!;

  it('the right assignment reads every row and shows the first rows day-first', () => {
    const check = checkMapping(header, rows, suggestion.draft, style, 'h:mma ddd D MMMM, YYYY');
    expect(check.readable).toBe(120);
    expect(check.warnings).toEqual([]);
    expect(formatDayFirst(check.lines[0].dateIso, 'AU')).toBe('01/07/2025');
    expect(check.lines.some((l) => l.direction === 'credit')).toBe(true);
    expect(check.lines.some((l) => l.direction === 'debit')).toBe(true);
  });
  it('a wrong date style reads nothing and says why, in words', () => {
    const check = checkMapping(header, rows, suggestion.draft, style, 'DD/MM/YYYY');
    expect(check.readable).toBe(0);
    expect(check.warnings[0]).toMatch(/None of the 120 rows/);
    expect(check.warnings[0]).toMatch(/date could not be read with the chosen date style/);
  });
  it('the credit column given as the debit column is caught: money out turns into money in (every line shown the same way)', () => {
    const swapped = { ...suggestion.draft, debit: 'Credit amount', credit: 'Debit amount' };
    const check = checkMapping(header, rows, swapped, style, 'h:mma ddd D MMMM, YYYY');
    // Still readable (every row has one of the two) but the direction is now the opposite of the truth for every line.
    const original = checkMapping(header, rows, suggestion.draft, style, 'h:mma ddd D MMMM, YYYY');
    expect(check.lines[0].direction).not.toBe(original.lines[0].direction);
  });
  it('a text column given as the amount reads nothing', () => {
    const check = checkMapping(header, rows, { ...suggestion.draft, debit: 'Description', credit: 'Long description' }, style, 'h:mma ddd D MMMM, YYYY');
    expect(check.readable).toBe(0);
  });
});

describe('the request the screen sends is exactly what the map route accepts, and what the stored template requires', () => {
  const { bytes } = buildPoShapedCsv(30, 1, UNRECOGNISED_VARIANT);
  const { header, rows, suggestion } = mapFor(bytes);
  const body = toMapRequest(suggestion.draft, suggestion.amountStyle!, 'h:mma ddd D MMMM, YYYY', ',', { remember: true, allowSharedColumns: false });

  it('parses with the route schema', () => {
    const parsed = bankCsvMappingConfirmSchema.safeParse(body);
    expect(parsed.success).toBe(true);
  });
  it('carries EVERY key even when unassigned: the stored template check requires the key "amount" to exist', () => {
    const roundTripped = JSON.parse(JSON.stringify(body.column_mapping)) as Record<string, unknown>;
    expect('amount' in roundTripped).toBe(true);
    expect(roundTripped.amount).toBeNull();
    expect('transaction_date' in roundTripped).toBe(true);
    expect(header.includes(roundTripped.transaction_date as string)).toBe(true);
    expect(rows.length).toBe(30);
  });
  it('the route schema refuses a debit/credit mapping with no debit and no credit column', () => {
    const broken = { ...body, column_mapping: { ...body.column_mapping, debit: null, credit: null } };
    expect(bankCsvMappingConfirmSchema.safeParse(broken).success).toBe(false);
  });
});

describe('long description as extra detail', () => {
  it('follows the description, once, and stands alone when the other is empty', () => {
    expect(joinDescriptions('SYNTH MERCHANT 001', 'Card purchase at Synthetic Merchant 001 AUS')).toBe('SYNTH MERCHANT 001 - Card purchase at Synthetic Merchant 001 AUS');
    expect(joinDescriptions('Coffee', 'Coffee')).toBe('Coffee');
    expect(joinDescriptions('Coffee', 'Coffee shop at the corner')).toBe('Coffee shop at the corner');
    expect(joinDescriptions('', 'Only long')).toBe('Only long');
    expect(joinDescriptions('Only short', '')).toBe('Only short');
  });
  it('the import keeps it as part of the line description', () => {
    const { bytes } = buildPoShapedCsv(5, 1, UNRECOGNISED_VARIANT);
    const { header, rows, suggestion } = mapFor(bytes);
    const body = toMapRequest(suggestion.draft, 'debit_credit_columns', 'h:mma ddd D MMMM, YYYY', ',', { remember: true, allowSharedColumns: false });
    const result = runBankCsvPipeline({ bytes, statementUploadId: 'd', financialAccountId: 'a', currencyCode: 'AUD', rowFormatOverride: mappingToRowFormat(body.column_mapping as FdhCsvColumnMapping, 'debit_credit_columns', 'h:mma ddd D MMMM, YYYY'), dedupIndex: new Map() as never });
    expect(result.accepted[0].descriptionRaw).toContain('SYNTH');
    expect(result.accepted[0].descriptionRaw).toContain('Synthetic Merchant');
    expect(header.length).toBe(10);
    expect(rows.length).toBe(5);
  });
});

describe('the certified layouts are untouched (negative control for "no built-in layout was added")', () => {
  it('a certified-shape header still detects as before and adapters still read it', () => {
    const text = 'Date,Description,Debit,Credit,Balance\n30/06/2026,TEST,10.00,,90.00\n';
    const det = detectBankCsvFormat(new Uint8Array(Buffer.from(text)));
    expect(det.status).toBe('detected');
    expect(det.adapter).not.toBeNull();
    expect(adapterToRowFormat(det.adapter!).dateFormat).toBeDefined();
  });
  it('poShapedDate is the shape under test', () => {
    expect(poShapedDate(new Date(Date.UTC(2026, 5, 30)))).toBe('12:00am Tue 30 June, 2026');
  });
});

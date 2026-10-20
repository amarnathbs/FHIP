/**
 * The provenance guard and the shared parsing primitives of the PDF routes: a model figure counts only if the page prints it (Western AND
 * lakh grouping), a number is never matched inside a longer one, and the day-first date and exact-money rules hold.
 */
import { describe, expect, it } from 'vitest';
import { figureIsPrinted } from '@/lib/aie/adapters/shared/reviewDraft';
import { droppedWarning, keepOnlyPrintedAmounts } from '@/lib/financial-data-hub/pdf-statements/provenance';
import {
  maskedLastFour, minorToDecimalString, multiplyToMinor, parseDateRange, parseExactDecimal, parseMoney, parseStatementDate,
} from '@/lib/financial-data-hub/pdf-statements/lineParse';
import { findPrintedPortfolioTotals } from '@/lib/financial-data-hub/investment/printedTotals';

describe('figureIsPrinted', () => {
  it('accepts plain, Western-grouped and lakh-grouped spellings', () => {
    expect(figureIsPrinted(345210, 'Opening balance Rs. 3,45,210.00')).toBe(true);
    expect(figureIsPrinted(458280, 'Closing balance Rs. 4,58,280.00')).toBe(true);
    expect(figureIsPrinted(1234567.89, 'total 12,34,567.89')).toBe(true);
    expect(figureIsPrinted(59672.65, 'Closing balance: $59,672.65')).toBe(true);
    expect(figureIsPrinted(500, 'PAYMENT 500.00 CR')).toBe(true);
  });
  it('never matches inside a longer number, and an unprinted figure is not printed', () => {
    expect(figureIsPrinted(850, 'value 1,850.00')).toBe(false);
    expect(figureIsPrinted(2000, 'value 12000')).toBe(false);
    expect(figureIsPrinted(77.77, 'FEE 70.00 and 7.77')).toBe(false);
    expect(figureIsPrinted(Number.NaN, 'x')).toBe(false);
  });
});

describe('keepOnlyPrintedAmounts', () => {
  it('keeps printed lines, reports the 1-based positions of invented ones, and names them only by count', () => {
    const items = [{ a: 84.2 }, { a: 99.99 }, { a: 61.35 }, { a: null }];
    const r = keepOnlyPrintedAmounts(items, (x) => x.a, 'GROCER 84.20\nFUEL 61.35');
    expect(r.kept).toEqual([{ a: 84.2 }, { a: 61.35 }]);
    expect(r.droppedPositions).toEqual([2, 4]);
    expect(droppedWarning('ai_lines_not_printed_dropped', r.droppedPositions)).toBe('ai_lines_not_printed_dropped_2');
    expect(droppedWarning('x', [])).toBeNull();
  });
});

describe('dates are day-first and calendar-valid; nothing is guessed', () => {
  it.each([
    ['30/06/2026', '2026-06-30'], ['30-06-2026', '2026-06-30'], ['30.06.2026', '2026-06-30'], ['1 Aug 2026', '2026-08-01'],
    ['01 August 2026', '2026-08-01'], ['29/02/2028', '2028-02-29'], ['05/07/2026', '2026-07-05'],
  ])('%s -> %s', (raw, iso) => expect(parseStatementDate(raw)).toBe(iso));
  it.each(['29/02/2027', '31/04/2026', '13/13/2026', '02 Aug 26', '02 Aug', '2026-08-02', '8/2/26', 'Aug 2 2026', ''])('%s is not read', (raw) => expect(parseStatementDate(raw)).toBeNull());
  it('a month in the second place above 12 is never swapped (no US order is assumed)', () => {
    expect(parseStatementDate('07/13/2026')).toBeNull();
    expect(parseStatementDate('05/07/2026')).toBe('2026-07-05'); // 5 July, never 7 May
  });
  it('a period needs two dates in order', () => {
    expect(parseDateRange('Statement period: 01/07/2026 to 31/07/2026')).toEqual({ start: '2026-07-01', end: '2026-07-31' });
    expect(parseDateRange('from 1 Aug 2026 - 31 Aug 2026')).toEqual({ start: '2026-08-01', end: '2026-08-31' });
    expect(parseDateRange('31/07/2026 to 01/07/2026')).toBeNull();
    expect(parseDateRange('01/07/2026')).toBeNull();
  });
});

describe('exact money', () => {
  it.each([
    ['$1,234.56', 123456], ['1,23,456.78', 12345678], ['Rs. 62,400.00', 6240000], ['-$812.00', -81200], ['($231.00)', -23100], ['500.00', 50000], ['₹21,360.00', 2136000], ['$8,000', 800000],
  ])('%s -> %i minor units', (raw, minor) => expect(parseMoney(raw)?.minor).toBe(minor));
  it('CR and DR are reported, never applied as a sign', () => {
    expect(parseMoney('500.00 CR')).toMatchObject({ minor: 50000, suffix: 'CR', negative: false });
  });
  it.each(['1,299.00*', '12', '1.234,56', '(231.00', '231.00)', '$', 'abc', '1,23', '12.345'])('%s is not an amount', (raw) => expect(parseMoney(raw, { requireDecimals: true })).toBeNull());
  it('a table amount needs exactly two decimals; a header amount may omit them', () => {
    expect(parseMoney('8,000', { requireDecimals: true })).toBeNull();
    expect(parseMoney('8,000')).not.toBeNull();
  });
  it('quantity x price rounds half up in exact arithmetic', () => {
    expect(multiplyToMinor('2345.6789', '1.8750')).toBe(439815);
    expect(multiplyToMinor('300', '12.5')).toBe(375000);
    expect(multiplyToMinor('0.005', '1')).toBe(1);
    expect(multiplyToMinor('0.004', '1')).toBe(0);
    expect(minorToDecimalString(-5)).toBe('-0.05');
    expect(parseExactDecimal('1,250.5')).toBe('1250.5');
    expect(parseExactDecimal('1.1234567')).toBeNull();
  });
  it('identifiers keep their last four digits only and never a full number', () => {
    expect(maskedLastFour('5999 0000 1111 4821')).toBe('****4821');
    expect(maskedLastFour('123')).toBeNull();
    expect(maskedLastFour('X0000 4417')).toBe('****4417');
  });
});

describe('printed portfolio totals (found by label in the text, never from a model)', () => {
  it('finds the total and the cash line; ignores "Total buys" style lines', () => {
    expect(findPrintedPortfolioTotals('Cash account balance: $500.00\nTotal: $26,855.00\nTotal buys: $11,549.90')).toEqual({ closingPortfolioValue: '26855.00', cashBalance: '500.00' });
  });
  it('two different totals are ambiguous and are not used', () => {
    expect(findPrintedPortfolioTotals('Total portfolio value: $100.00\nTotal portfolio value: $200.00').closingPortfolioValue).toBeNull();
  });
});

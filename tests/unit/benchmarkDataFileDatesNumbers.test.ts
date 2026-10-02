// BENCH-1 Phase 2 -- explicit-format date parsing and strict level parsing (pure).
import { describe, it, expect } from 'vitest';
import {
  parseMarketDate,
  parseLevel,
  excelSerialToIsoDate,
  type DateFormatId,
  type NumberLocaleId,
} from '@/lib/services/investment-intelligence/benchmarkData/fileIngest';

const iso = (raw: string | { excelSerial: number }, f: DateFormatId) => {
  const r = parseMarketDate(raw, f, {});
  return r.ok ? r.iso : `ERR:${r.code}`;
};

describe('ambiguous dates are never guessed', () => {
  it('03/04/2024 is 3 April under DD/MM/YYYY and 4 March under MM/DD/YYYY', () => {
    expect(iso('03/04/2024', 'DD/MM/YYYY')).toBe('2024-04-03');
    expect(iso('03/04/2024', 'MM/DD/YYYY')).toBe('2024-03-04');
  });

  it('13/04/2024 is valid day-first and FAILS month-first (no silent fallback to the other order)', () => {
    expect(iso('13/04/2024', 'DD/MM/YYYY')).toBe('2024-04-13');
    expect(iso('13/04/2024', 'MM/DD/YYYY')).toBe('ERR:DATE_NOT_A_CALENDAR_DATE');
    expect(iso('04/13/2024', 'DD/MM/YYYY')).toBe('ERR:DATE_NOT_A_CALENDAR_DATE');
    expect(iso('04/13/2024', 'MM/DD/YYYY')).toBe('2024-04-13');
  });

  it('a date that does not match the selected format is rejected, not reinterpreted', () => {
    expect(iso('2024-03-28', 'DD/MM/YYYY')).toBe('ERR:DATE_FORMAT_INVALID');
    expect(iso('28/03/2024', 'YYYY-MM-DD')).toBe('ERR:DATE_FORMAT_INVALID');
    expect(iso('28-03-2024', 'DD/MM/YYYY')).toBe('ERR:DATE_FORMAT_INVALID');
    expect(iso('28 Mar 2024', 'DD-MMM-YYYY')).toBe('ERR:DATE_FORMAT_INVALID');
  });
});

describe('supported text formats', () => {
  it.each<[string, DateFormatId, string]>([
    ['2024-03-28', 'YYYY-MM-DD', '2024-03-28'],
    [' 2024-03-28 ', 'YYYY-MM-DD', '2024-03-28'],
    ['28/03/2024', 'DD/MM/YYYY', '2024-03-28'],
    ['3/4/2024', 'DD/MM/YYYY', '2024-04-03'],
    ['28-03-2024', 'DD-MM-YYYY', '2024-03-28'],
    ['28-Mar-2024', 'DD-MMM-YYYY', '2024-03-28'],
    ['28-MAR-2024', 'DD-MMM-YYYY', '2024-03-28'],
    ['28-march-2024', 'DD-MMM-YYYY', '2024-03-28'],
    ['02-January-2024', 'DD-MMM-YYYY', '2024-01-02'],
    ['28 Mar 2024', 'DD MMM YYYY', '2024-03-28'],
    ['5 sep 2024', 'DD MMM YYYY', '2024-09-05'],
    ['31 December 2023', 'DD MMM YYYY', '2023-12-31'],
  ])('%s as %s -> %s', (raw, fmt, expected) => {
    expect(iso(raw, fmt)).toBe(expected);
  });

  it('accepts only English 3-letter or full month names', () => {
    expect(iso('28-Sept-2024', 'DD-MMM-YYYY')).toBe('ERR:DATE_MONTH_NAME_INVALID');
    expect(iso('28-Marc-2024', 'DD-MMM-YYYY')).toBe('ERR:DATE_MONTH_NAME_INVALID');
    expect(iso('28-constructor-2024', 'DD-MMM-YYYY')).toBe('ERR:DATE_MONTH_NAME_INVALID');
    expect(iso('28-Mär-2024', 'DD-MMM-YYYY')).toBe('ERR:DATE_MONTH_NAME_INVALID');
  });
});

describe('real calendar validation', () => {
  it.each<[string, DateFormatId, boolean]>([
    ['2024-02-29', 'YYYY-MM-DD', true],
    ['2023-02-29', 'YYYY-MM-DD', false],
    ['2000-02-29', 'YYYY-MM-DD', true],
    ['1900-02-29', 'YYYY-MM-DD', false],
    ['2100-02-29', 'YYYY-MM-DD', false],
    ['2024-04-31', 'YYYY-MM-DD', false],
    ['2024-13-01', 'YYYY-MM-DD', false],
    ['2024-00-10', 'YYYY-MM-DD', false],
    ['2024-01-00', 'YYYY-MM-DD', false],
    ['31/02/2024', 'DD/MM/YYYY', false],
    ['30/04/2024', 'DD/MM/YYYY', true],
    ['31 Nov 2024', 'DD MMM YYYY', false],
  ])('%s (%s) valid=%s', (raw, fmt, valid) => {
    expect(parseMarketDate(raw, fmt, {}).ok).toBe(valid);
  });

  it('rejects two-digit years', () => {
    expect(iso('03/04/24', 'DD/MM/YYYY')).toBe('ERR:DATE_TWO_DIGIT_YEAR');
    expect(iso('28-Mar-24', 'DD-MMM-YYYY')).toBe('ERR:DATE_TWO_DIGIT_YEAR');
    expect(iso('28 Mar 24', 'DD MMM YYYY')).toBe('ERR:DATE_TWO_DIGIT_YEAR');
  });

  it('rejects empty and whitespace-only dates', () => {
    expect(iso('', 'YYYY-MM-DD')).toBe('ERR:DATE_EMPTY');
    expect(iso('   ', 'DD/MM/YYYY')).toBe('ERR:DATE_EMPTY');
  });
});

describe('market dates are calendar dates, not UTC timestamps', () => {
  it.each([
    '2024-03-28T00:00:00Z',
    '2024-03-28T00:00:00.000Z',
    '2024-03-28T00:00:00+05:30',
    '2024-03-28 15:30',
    '2024-03-28 15:30:00',
    '2024-03-28T00Z',
    '2024-03-28Z',
    '2024-03-28+05:30',
  ])('rejects %s with DATE_IS_TIMESTAMP (never truncates it)', (raw) => {
    const r = parseMarketDate(raw, 'YYYY-MM-DD', {});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('DATE_IS_TIMESTAMP');
      expect(r.message).toContain('not UTC timestamps');
    }
  });

  it('rejects a time component under the other text formats too', () => {
    expect(iso('28/03/2024 10:00', 'DD/MM/YYYY')).toBe('ERR:DATE_IS_TIMESTAMP');
    expect(iso('28 Mar 2024 10:00', 'DD MMM YYYY')).toBe('ERR:DATE_IS_TIMESTAMP');
  });
});

describe('Excel date systems', () => {
  it('maps well-known serials in the 1900 system', () => {
    expect(excelSerialToIsoDate(1, false)).toBe('1900-01-01');
    expect(excelSerialToIsoDate(59, false)).toBe('1900-02-28');
    expect(excelSerialToIsoDate(61, false)).toBe('1900-03-01');
    expect(excelSerialToIsoDate(25569, false)).toBe('1970-01-01');
    expect(excelSerialToIsoDate(36526, false)).toBe('2000-01-01');
    expect(excelSerialToIsoDate(44927, false)).toBe('2023-01-01');
    expect(excelSerialToIsoDate(45000, false)).toBe('2023-03-15');
    expect(excelSerialToIsoDate(2958465, false)).toBe('9999-12-31');
  });

  it('serial 60 is the non-existent 1900-02-29 (Lotus leap-year bug)', () => {
    expect(excelSerialToIsoDate(60, false)).toBeNull();
    const r = parseMarketDate({ excelSerial: 60 }, 'excel_1900', {});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('DATE_SERIAL_INVALID');
      expect(r.message).toContain('1900-02-29');
    }
  });

  it('the same serial is four years and a day apart in the 1904 system', () => {
    expect(excelSerialToIsoDate(45000, false)).toBe('2023-03-15');
    expect(excelSerialToIsoDate(45000, true)).toBe('2027-03-16');
    expect(excelSerialToIsoDate(24107, true)).toBe('1970-01-01');
    expect(excelSerialToIsoDate(1, true)).toBe('1904-01-02');
    expect(iso({ excelSerial: 45000 }, 'excel_1900')).toBe('2023-03-15');
    expect(iso({ excelSerial: 45000 }, 'excel_1904')).toBe('2027-03-16');
    expect(iso('45000', 'excel_1900')).toBe('2023-03-15');
    expect(iso('45000', 'excel_1904')).toBe('2027-03-16');
  });

  it('rejects out-of-range, fractional and non-finite serials', () => {
    for (const s of [0, -1, 2958466, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(excelSerialToIsoDate(s, false), String(s)).toBeNull();
    }
    expect(excelSerialToIsoDate(2957003, true)).toBe('9999-12-31');
    expect(excelSerialToIsoDate(2957004, true)).toBeNull();
    expect(excelSerialToIsoDate(45000.5, false)).toBeNull();
    expect(iso({ excelSerial: 45000.5 }, 'excel_1900')).toBe('ERR:DATE_IS_TIMESTAMP');
    expect(iso({ excelSerial: 0 }, 'excel_1900')).toBe('ERR:DATE_SERIAL_INVALID');
    expect(iso({ excelSerial: Number.NaN }, 'excel_1900')).toBe('ERR:DATE_SERIAL_INVALID');
  });

  it('serials are accepted ONLY under an Excel date format', () => {
    expect(iso({ excelSerial: 45000 }, 'YYYY-MM-DD')).toBe('ERR:DATE_FORMAT_MISMATCH');
    expect(iso({ excelSerial: 45000 }, 'DD/MM/YYYY')).toBe('ERR:DATE_FORMAT_MISMATCH');
    expect(iso('45000', 'YYYY-MM-DD')).toBe('ERR:DATE_NUMERIC_UNDER_TEXT_FORMAT');
    expect(iso('45000', 'DD/MM/YYYY')).toBe('ERR:DATE_NUMERIC_UNDER_TEXT_FORMAT');
    expect(iso('20240328', 'YYYY-MM-DD')).toBe('ERR:DATE_NUMERIC_UNDER_TEXT_FORMAT');
    expect(iso('2024-03-28', 'excel_1900')).toBe('ERR:DATE_NOT_SERIAL');
  });
});

// ------------------------------------------------------------------ levels ---

const lv = (raw: string | number, loc: NumberLocaleId) => {
  const r = parseLevel(raw, loc);
  return r.ok ? { value: r.value, text: r.text } : `ERR:${r.code}`;
};

describe('parseLevel -- shared rejections (every locale)', () => {
  const locales: NumberLocaleId[] = ['plain', 'en', 'in', 'eu'];
  const rejects: Array<[string, string]> = [
    ['5%', 'VALUE_IS_PERCENT'],
    ['-0.5 %', 'VALUE_IS_PERCENT'],
    ['12.5%', 'VALUE_IS_PERCENT'],
    ['NaN', 'VALUE_NOT_FINITE'],
    ['nan', 'VALUE_NOT_FINITE'],
    ['Infinity', 'VALUE_NOT_FINITE'],
    ['-Infinity', 'VALUE_NOT_FINITE'],
    ['inf', 'VALUE_NOT_FINITE'],
    ['1e5', 'VALUE_SCIENTIFIC'],
    ['1E+5', 'VALUE_SCIENTIFIC'],
    ['2.5e-3', 'VALUE_SCIENTIFIC'],
    ['-1e5', 'VALUE_SCIENTIFIC'],
    ['+100', 'VALUE_LEADING_PLUS'],
    ['100.', 'VALUE_BAD_FORMAT'],
    ['.5', 'VALUE_BAD_FORMAT'],
    ['007', 'VALUE_BAD_FORMAT'],
    ['₹1000', 'VALUE_HAS_CURRENCY'],
    ['$1000', 'VALUE_HAS_CURRENCY'],
    ['€10', 'VALUE_HAS_CURRENCY'],
    ['Rs 100', 'VALUE_HAS_CURRENCY'],
    ['INR1000', 'VALUE_HAS_CURRENCY'],
    ['USD 5', 'VALUE_HAS_CURRENCY'],
    ['(100)', 'VALUE_PARENTHESES_NEGATIVE'],
    ['(100.5)', 'VALUE_PARENTHESES_NEGATIVE'],
    ['', 'VALUE_EMPTY'],
    ['   ', 'VALUE_EMPTY'],
    ['-', 'VALUE_PLACEHOLDER'],
    ['--', 'VALUE_PLACEHOLDER'],
    ['N/A', 'VALUE_PLACEHOLDER'],
    ['n/a', 'VALUE_PLACEHOLDER'],
    ['NA', 'VALUE_PLACEHOLDER'],
    ['null', 'VALUE_PLACEHOLDER'],
    ['None', 'VALUE_PLACEHOLDER'],
    ['#N/A', 'VALUE_PLACEHOLDER'],
    ['#VALUE!', 'VALUE_PLACEHOLDER'],
    ['=1+1', 'VALUE_FORMULA_LIKE'],
    ['=HYPERLINK("http://x")', 'VALUE_FORMULA_LIKE'],
    ['@SUM(A1:A2)', 'VALUE_FORMULA_LIKE'],
    ['-cmd|calc', 'VALUE_NOT_NUMERIC'],
    ['abc', 'VALUE_NOT_NUMERIC'],
    ['12abc', 'VALUE_NOT_NUMERIC'],
    ['1.2.3', 'VALUE_BAD_FORMAT'],
    ['1.1234567', 'VALUE_TOO_PRECISE'],
    ['1000000000000', 'VALUE_TOO_LARGE'],
    ['9'.repeat(70), 'VALUE_BAD_FORMAT'],
  ];
  for (const loc of locales) {
    it.each(rejects)(`[${loc}] rejects %j with %s`, (raw, code) => {
      // eu uses ',' as the decimal separator, so decimal-containing inputs differ; skip those that are locale-shaped.
      const input = loc === 'eu' ? raw.replace(/\./g, ',') : raw;
      const r = parseLevel(input, loc);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        if (loc === 'eu' && raw === '1.2.3') expect(['VALUE_BAD_FORMAT', 'VALUE_BAD_GROUPING']).toContain(r.code);
        else expect(r.code).toBe(code);
      }
    });
  }

  it('the percent message says an index LEVEL is required', () => {
    const r = parseLevel('5%', 'plain');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('index LEVEL is required, not a percentage return');
  });
});

describe('parseLevel -- locale grammars', () => {
  it('plain: no grouping at all', () => {
    expect(lv('12345.67', 'plain')).toEqual({ value: 12345.67, text: '12345.67' });
    expect(lv('0.5', 'plain')).toEqual({ value: 0.5, text: '0.5' });
    expect(lv('100', 'plain')).toEqual({ value: 100, text: '100' });
    expect(lv('12,345.67', 'plain')).toBe('ERR:VALUE_BAD_GROUPING');
    expect(lv('1,234', 'plain')).toBe('ERR:VALUE_BAD_GROUPING');
    expect(lv('1.234,56', 'plain')).toBe('ERR:VALUE_BAD_FORMAT');
  });

  it('en: groups of three with commas (grouping optional)', () => {
    expect(lv('12,345.67', 'en')).toEqual({ value: 12345.67, text: '12345.67' });
    expect(lv('1,234,567', 'en')).toEqual({ value: 1234567, text: '1234567' });
    expect(lv('12345.67', 'en')).toEqual({ value: 12345.67, text: '12345.67' });
    expect(lv('1,23,456.78', 'en')).toBe('ERR:VALUE_BAD_GROUPING');
    expect(lv('1234,567', 'en')).toBe('ERR:VALUE_BAD_GROUPING');
    expect(lv('12,34', 'en')).toBe('ERR:VALUE_BAD_GROUPING');
    expect(lv('1.234,56', 'en')).toBe('ERR:VALUE_BAD_FORMAT');
  });

  it('in: Indian grouping (3 then 2s); Western grouping is NOT accepted under it', () => {
    expect(lv('1,23,456.78', 'in')).toEqual({ value: 123456.78, text: '123456.78' });
    expect(lv('12,34,567', 'in')).toEqual({ value: 1234567, text: '1234567' });
    expect(lv('12,345', 'in')).toEqual({ value: 12345, text: '12345' });
    expect(lv('123456.78', 'in')).toEqual({ value: 123456.78, text: '123456.78' });
    expect(lv('123,456', 'in')).toBe('ERR:VALUE_BAD_GROUPING');
    expect(lv('1,234,567', 'in')).toBe('ERR:VALUE_BAD_GROUPING');
    expect(lv('1,2,345', 'in')).toBe('ERR:VALUE_BAD_GROUPING');
  });

  it('eu: dots group, comma is the decimal separator', () => {
    expect(lv('12.345,67', 'eu')).toEqual({ value: 12345.67, text: '12345.67' });
    expect(lv('1.234', 'eu')).toEqual({ value: 1234, text: '1234' });
    expect(lv('1,5', 'eu')).toEqual({ value: 1.5, text: '1.5' });
    expect(lv('1234,5', 'eu')).toEqual({ value: 1234.5, text: '1234.5' });
    expect(lv('1,234.56', 'eu')).toBe('ERR:VALUE_BAD_FORMAT');
    expect(lv('12.34.567', 'eu')).toBe('ERR:VALUE_BAD_GROUPING');
  });

  it('the same text means different numbers under different locales (no inference)', () => {
    expect(lv('1,234', 'en')).toEqual({ value: 1234, text: '1234' });
    expect(lv('1,234', 'eu')).toEqual({ value: 1.234, text: '1.234' });
    expect(lv('1.234', 'en')).toEqual({ value: 1.234, text: '1.234' });
    expect(lv('1.234', 'eu')).toEqual({ value: 1234, text: '1234' });
  });
});

describe('parseLevel -- precision, range and numbers', () => {
  it('canonical text has no grouping and no trailing zeros', () => {
    expect(lv('1,234.500', 'en')).toEqual({ value: 1234.5, text: '1234.5' });
    expect(lv('1000.00', 'plain')).toEqual({ value: 1000, text: '1000' });
    expect(lv('0.000001', 'plain')).toEqual({ value: 0.000001, text: '0.000001' });
  });

  it('allows at most 6 decimals and values below 1e12', () => {
    expect(lv('1.123456', 'plain')).toEqual({ value: 1.123456, text: '1.123456' });
    expect(lv('1.1234560', 'plain')).toEqual({ value: 1.123456, text: '1.123456' });
    expect(lv('1.1234567', 'plain')).toBe('ERR:VALUE_TOO_PRECISE');
    const edge = parseLevel('999999999999.999999', 'plain');
    expect(edge.ok && edge.text).toBe('999999999999.999999');
    expect(lv('1000000000000', 'plain')).toBe('ERR:VALUE_TOO_LARGE');
  });

  it('parses zero and negatives (the validator rejects them as non-positive)', () => {
    expect(lv('0', 'plain')).toEqual({ value: 0, text: '0' });
    expect(lv('-0', 'plain')).toEqual({ value: 0, text: '0' });
    expect(lv('-5.25', 'plain')).toEqual({ value: -5.25, text: '-5.25' });
    expect(lv('-1,234.5', 'en')).toEqual({ value: -1234.5, text: '-1234.5' });
  });

  it('accepts JS numbers (XLSX numeric cells) and rejects non-finite / over-precise ones', () => {
    expect(lv(23456.7, 'plain')).toEqual({ value: 23456.7, text: '23456.7' });
    expect(lv(1000, 'eu')).toEqual({ value: 1000, text: '1000' });
    expect(lv(Number.NaN, 'plain')).toBe('ERR:VALUE_NOT_FINITE');
    expect(lv(Number.POSITIVE_INFINITY, 'plain')).toBe('ERR:VALUE_NOT_FINITE');
    expect(lv(Number.NEGATIVE_INFINITY, 'plain')).toBe('ERR:VALUE_NOT_FINITE');
    expect(lv(1e-7, 'plain')).toBe('ERR:VALUE_TOO_PRECISE');
    expect(lv(1.1234567, 'plain')).toBe('ERR:VALUE_TOO_PRECISE');
    expect(lv(1e12, 'plain')).toBe('ERR:VALUE_TOO_LARGE');
  });

  it('is linear on hostile long whitespace (no regex backtracking)', () => {
    const t0 = Date.now();
    parseLevel(' '.repeat(2_000_000) + 'x', 'plain');
    parseLevel('1' + ' '.repeat(2_000_000) + 'x', 'en');
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe('a rejected date is named day-first (dd-mm-yyyy), never ISO or month-first (PO rule, Document2 findings #8/#19)', () => {
  it('an impossible day reads dd-mm-yyyy whichever file format was chosen', () => {
    const iso8601 = parseMarketDate('2023-02-29', 'YYYY-MM-DD', {});
    expect(iso8601.ok).toBe(false);
    if (!iso8601.ok) expect(iso8601.message).toBe('29-02-2023 is not a real calendar date.');
    const us = parseMarketDate('02/31/2024', 'MM/DD/YYYY', {});
    expect(us.ok).toBe(false);
    if (!us.ok) expect(us.message).toBe('31-02-2024 is not a real calendar date.');
    const dmy = parseMarketDate('31/04/2024', 'DD/MM/YYYY', {});
    if (!dmy.ok) expect(dmy.message).toBe('31-04-2024 is not a real calendar date.');
  });
});

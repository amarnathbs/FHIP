// Market-index CSV parser: recorded-fixture parsing (SYNTHETIC files in the
// public layouts — see the parser header for what is and is not verified) and
// the validation rules, each with a named failing assertion if the rule breaks.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseIndexCsv, parseIndexDate, parseIndexValue, readCsv, OUTLIER_REJECT_FRACTION } from '@/lib/services/investment-intelligence/marketIndex/indexCsvParser';
import { MARKET_INDEX_KEYS } from '@/lib/config/investment-intelligence/marketIndexConfig';

const FIX = path.resolve(__dirname, '..', 'fixtures', 'market-index');
const read = (f: string) => fs.readFileSync(path.join(FIX, f), 'utf8');
const TODAY = '2026-10-01';
const NIFTY = MARKET_INDEX_KEYS.NIFTY_50;
const SENSEX = MARKET_INDEX_KEYS.SENSEX;

describe('recorded-fixture parsing', () => {
  it('niftyindices.com layout: keeps only the selected index, parses "dd Mon yyyy"', () => {
    const a = parseIndexCsv(read('niftyindices_layout.csv'), NIFTY, TODAY);
    expect(a.layout).toBe('niftyindices');
    expect(a.accepted.map((r) => [r.date, r.close])).toEqual([
      ['2024-03-01', 22338.75],
      ['2024-03-04', 22405.6],
      ['2024-03-05', 22356.3],
      ['2024-03-06', 22339.05],
    ]);
    expect(a.otherIndexRowsIgnored).toBe(1); // Nifty Bank
    expect(a.rejected).toEqual([]);
  });
  it('NSE ind_close_all layout: picks the Nifty 50 row out of the all-index file, dd-mm-yyyy', () => {
    const a = parseIndexCsv(read('nse_ind_close_all_06032024.csv'), NIFTY, TODAY);
    expect(a.layout).toBe('nse_ind_close_all');
    expect(a.accepted).toEqual([{ rowNumber: 1, date: '2024-03-06', close: 22339.05 }]);
    expect(a.otherIndexRowsIgnored).toBe(2);
  });
  it('BSE archive layout: "dd-MONTH-yyyy", quoted fields and thousands separators', () => {
    const a = parseIndexCsv(read('bse_archive_layout.csv'), SENSEX, TODAY);
    expect(a.layout).toBe('bse_archive');
    expect(a.accepted.map((r) => [r.date, r.close])).toEqual([
      ['2024-03-01', 73745.35],
      ['2024-03-04', 73872.29],
      ['2024-03-05', 73667.96],
      ['2024-03-06', 73502.64],
    ]);
  });
});

describe('rejection and hold-back rules (each names the code it must produce)', () => {
  const a = parseIndexCsv(read('messy.csv'), NIFTY, TODAY);
  const codes = Object.fromEntries(a.rejected.map((r) => [r.rowNumber, r.code]));

  it('identical duplicate rows are collapsed, not rejected', () => {
    expect(a.identicalDuplicatesCollapsed).toBe(1);
    expect(a.accepted.filter((r) => r.date === '2024-03-05')).toHaveLength(1);
  });
  it('conflicting duplicate dates: EVERY row of that date is rejected (conflicting_duplicate)', () => {
    expect(a.rejected.filter((r) => r.code === 'conflicting_duplicate')).toHaveLength(2);
    expect(a.accepted.some((r) => r.date === '2024-03-06')).toBe(false);
  });
  it('a "-" close is rejected as bad_value (no close published)', () => {
    expect(codes[6]).toBe('bad_value');
  });
  it('an impossible calendar date is rejected as bad_date', () => {
    expect(a.rejected.find((r) => r.raw.startsWith('2024-13-45'))!.code).toBe('bad_date');
  });
  it('a future date is rejected as future_date', () => {
    expect(a.rejected.find((r) => r.raw.startsWith('2999-01-01'))!.code).toBe('future_date');
  });
  it('a non-numeric value is rejected as bad_value', () => {
    expect(a.rejected.find((r) => r.raw.startsWith('2024-03-11'))!.code).toBe('bad_value');
  });
  it('a spike against BOTH neighbours is rejected as outlier (a 5x typo)', () => {
    const o = a.rejected.find((r) => r.code === 'outlier')!;
    expect(o).toBeDefined();
    expect(o.reason).toContain('2024-03-13');
    expect(a.accepted.some((r) => r.date === '2024-03-13')).toBe(false);
    expect(OUTLIER_REJECT_FRACTION).toBe(0.25);
  });
  it('a Saturday row is HELD BACK (not accepted, not rejected) so a special session needs an explicit decision', () => {
    expect(a.weekendHeldBack.map((r) => r.date)).toEqual(['2024-03-09']);
    expect(a.accepted.some((r) => r.date === '2024-03-09')).toBe(false);
    expect(a.rejected.some((r) => r.raw.includes('2024-03-09'))).toBe(false);
  });
  it('the usable weekday rows are exactly the clean ones, ascending', () => {
    expect(a.accepted.map((r) => r.date)).toEqual(['2024-03-04', '2024-03-05', '2024-03-12', '2024-03-14']);
  });
});

describe('file-level refusals', () => {
  it('a header with no date or no close column is rejected with the columns found', () => {
    const a = parseIndexCsv('Foo,Bar\n1,2\n', NIFTY, TODAY);
    expect(a.fileRejected).toBe(true);
    expect(a.fileRejectionReason).toContain('Found: Foo, Bar');
  });
  it('a file that does not contain the selected index is rejected, naming what it does contain (wrong_index)', () => {
    const a = parseIndexCsv(read('niftyindices_layout.csv'), SENSEX, TODAY);
    expect(a.fileRejected).toBe(true);
    expect(a.fileRejectionReason).toMatch(/Nifty 50/);
    expect(a.rejected[0].code).toBe('wrong_index');
    expect(a.accepted).toEqual([]);
  });
  it('a value outside the index plausibility band is rejected (out_of_range): a Nifty-sized number cannot be loaded as ... a 3-digit typo', () => {
    const a = parseIndexCsv('date,close\n2024-03-04,12.5\n', NIFTY, TODAY);
    expect(a.rejected[0].code).toBe('out_of_range');
  });
  it('an empty file and an oversize row count are refused', () => {
    expect(parseIndexCsv('', NIFTY, TODAY).fileRejected).toBe(true);
    const big = 'date,close\n' + Array.from({ length: 20_001 }, () => '2024-03-04,22000').join('\n');
    expect(parseIndexCsv(big, NIFTY, TODAY).fileRejectionReason).toMatch(/limit is 20000/);
  });
  it('month-first US dates are not interpreted: 03/25/2024 is rejected, never read as 25 March', () => {
    const a = parseIndexCsv('date,close\n03/25/2024,22000\n', NIFTY, TODAY);
    expect(a.accepted).toEqual([]);
    expect(a.rejected[0].code).toBe('bad_date');
  });
});

describe('primitives', () => {
  it('dates', () => {
    expect(parseIndexDate('2024-02-29')).toBe('2024-02-29');
    expect(parseIndexDate('2023-02-29')).toBeNull();
    expect(parseIndexDate('02-01-2024')).toBe('2024-01-02');
    expect(parseIndexDate('2 Jan 2024')).toBe('2024-01-02');
    expect(parseIndexDate('02-Sept-2024')).toBe('2024-09-02');
    expect(parseIndexDate('02/01/24')).toBeNull();
  });
  it('values', () => {
    expect(parseIndexValue('73,651.35')).toBe(73651.35);
    expect(parseIndexValue('1,23,456.7')).toBe(123456.7);
    expect(parseIndexValue('1,2')).toBeNull();
    expect(parseIndexValue('-')).toBeNull();
    expect(parseIndexValue('')).toBeNull();
    expect(parseIndexValue('22.')).toBeNull();
    expect(parseIndexValue('-5')).toBeNull();
  });
  it('csv reader handles quotes, escaped quotes, CRLF and a BOM', () => {
    expect(readCsv('﻿a,"b,c","d""e"\r\n1,2,3\r\n')).toEqual([['a', 'b,c', 'd"e'], ['1', '2', '3']]);
  });
});

/**
 * R7 — Bank CSV Engine independent certification: CSV syntax/encoding/
 * delimiter (spec section 64, cases R7-TC001 to R7-TC020) plus the
 * amount/date atoms cases R7-TC041-R7-TC050 draw on.
 */
import { describe, expect, it } from 'vitest';
import {
  CsvIntakeError,
  decodeCsvBytes,
  detectDelimiter,
  findHeaderRowIndex,
  parseCsvSafe,
  sanitizeForCsvExport,
} from '@/lib/financial-data-hub/bank-csv/csv';
import { CSV_MAX_COLUMNS, CSV_MAX_FIELD_LENGTH, CSV_MAX_ROWS } from '@/lib/financial-data-hub/bank-csv/constants';

function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

describe('R7-TC001-005 — encoding detection', () => {
  it('R7-TC001 plain UTF-8 with no BOM decodes unchanged', () => {
    const { text, encoding } = decodeCsvBytes(bytes('Date,Description,Amount\n2026-01-01,Coffee,4.50\n'));
    expect(encoding).toBe('utf-8');
    expect(text).toContain('Coffee');
  });

  it('R7-TC002 UTF-8 BOM is detected and stripped', () => {
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('Date,Description,Amount\n')]);
    const { text, encoding } = decodeCsvBytes(new Uint8Array(withBom));
    expect(encoding).toBe('utf-8-bom');
    expect(text.charCodeAt(0)).not.toBe(0xfeff);
    expect(text.startsWith('Date')).toBe(true);
  });

  it('R7-TC003 legacy single-byte (latin1/CP1252) export is detected via replacement-character heuristic', () => {
    // "café" written directly in latin1 bytes (0xE9 = é) — decoding this as
    // strict UTF-8 would corrupt the é into replacement characters.
    const latin1Bytes = Buffer.from('Date,Description,Amount\n2026-01-01,Café,4.50\n', 'latin1');
    const { encoding, text } = decodeCsvBytes(new Uint8Array(latin1Bytes));
    expect(encoding).toBe('latin1');
    expect(text).toContain('Café');
  });

  it('R7-TC004 UTF-8 multi-byte characters (e.g. ₹) decode correctly, not misdetected as legacy', () => {
    const { encoding, text } = decodeCsvBytes(bytes('Date,Description,Amount\n2026-01-01,Coffee ₹100,100\n'));
    expect(encoding).toBe('utf-8');
    expect(text).toContain('₹100');
  });

  it('R7-TC005 empty bytes decode to empty text without throwing', () => {
    const { text } = decodeCsvBytes(new Uint8Array(0));
    expect(text).toBe('');
  });
});

describe('R7-TC006-011 — delimiter detection', () => {
  it('R7-TC006 comma-delimited header is detected', () => {
    expect(detectDelimiter(['Date,Description,Amount', '2026-01-01,Coffee,4.50'])).toBe(',');
  });
  it('R7-TC007 semicolon-delimited header is detected', () => {
    expect(detectDelimiter(['Date;Description;Amount', '2026-01-01;Coffee;4.50'])).toBe(';');
  });
  it('R7-TC008 tab-delimited header is detected', () => {
    expect(detectDelimiter(['Date\tDescription\tAmount', '2026-01-01\tCoffee\t4.50'])).toBe('\t');
  });
  it('R7-TC009 pipe-delimited header is detected', () => {
    expect(detectDelimiter(['Date|Description|Amount', '2026-01-01|Coffee|4.50'])).toBe('|');
  });
  it('R7-TC010 inconsistent column counts across lines resolve to null (never guessed)', () => {
    expect(detectDelimiter(['Date,Description,Amount', '2026-01-01,Coffee'])).toBeNull();
  });
  it('R7-TC011 delimiter characters inside quotes are not counted', () => {
    // The description contains a comma inside quotes — must not be mistaken
    // for a 4-column, comma-delimited file.
    expect(detectDelimiter(['Date,Description,Amount', '2026-01-01,"Coffee, Ltd",4.50'])).toBe(',');
  });
});

describe('R7-TC012-016 — header-row detection', () => {
  it('R7-TC012 header on line 0 is found', () => {
    expect(findHeaderRowIndex(['Date,Description,Amount', '2026-01-01,Coffee,4.50'], ',', 25)).toBe(0);
  });
  it('R7-TC013 header after metadata lines is found within scan depth', () => {
    const lines = ['Account: 12345', 'Statement Period: Jan 2026', 'Date,Description,Amount', '2026-01-01,Coffee,4.50'];
    expect(findHeaderRowIndex(lines, ',', 25)).toBe(2);
  });
  it('R7-TC014 a purely numeric first line is not mistaken for a header', () => {
    const lines = ['1,2,3', 'Date,Description,Amount', '2026-01-01,Coffee,4.50'];
    expect(findHeaderRowIndex(lines, ',', 25)).toBe(1);
  });
  it('R7-TC015 no plausible header within scan depth returns null', () => {
    const lines = Array.from({ length: 30 }, () => '1,2,3');
    expect(findHeaderRowIndex(lines, ',', 25)).toBeNull();
  });
  it('R7-TC016 blank lines before the header are skipped', () => {
    const lines = ['', '  ', 'Date,Description,Amount', '2026-01-01,Coffee,4.50'];
    expect(findHeaderRowIndex(lines, ',', 25)).toBe(2);
  });
});

describe('R7-TC017-020 — safe parsing: quotes, embedded commas/newlines, whitespace', () => {
  it('R7-TC017 quoted field with an embedded comma is one field, not two', () => {
    const { header, rows } = parseCsvSafe('Date,Description,Amount\n2026-01-01,"Coffee, Ltd",4.50\n', ',', 0);
    expect(header).toEqual(['Date', 'Description', 'Amount']);
    expect(rows[0]).toEqual(['2026-01-01', 'Coffee, Ltd', '4.50']);
  });
  it('R7-TC018 quoted field with an embedded newline is one field', () => {
    const { rows } = parseCsvSafe('Date,Description,Amount\n2026-01-01,"Coffee\nShop",4.50\n', ',', 0);
    expect(rows[0][1]).toBe('Coffee\nShop');
  });
  it('R7-TC019 escaped double-quote ("") inside a quoted field decodes to a single quote', () => {
    const { rows } = parseCsvSafe('Date,Description,Amount\n2026-01-01,"Bob""s Cafe",4.50\n', ',', 0);
    expect(rows[0][1]).toBe('Bob"s Cafe');
  });
  it('R7-TC020 leading/trailing spaces around fields are trimmed', () => {
    const { rows } = parseCsvSafe('Date,Description,Amount\n 2026-01-01 , Coffee , 4.50 \n', ',', 0);
    expect(rows[0]).toEqual(['2026-01-01', 'Coffee', '4.50']);
  });
});

describe('R7 safe-limit adversarial inputs (spec section 13-14, 131-145 bucket)', () => {
  it('R7-TC131 an unterminated quote fails cleanly rather than hanging or corrupting later rows', () => {
    expect(() => parseCsvSafe('Date,Description,Amount\n2026-01-01,"Coffee,4.50\n', ',', 0)).toThrow(CsvIntakeError);
  });
  it('R7-TC132 a field longer than the safe limit is rejected', () => {
    const huge = 'x'.repeat(CSV_MAX_FIELD_LENGTH + 1);
    expect(() => parseCsvSafe(`Date,Description,Amount\n2026-01-01,${huge},4.50\n`, ',', 0)).toThrow(CsvIntakeError);
  });
  it('R7-TC133 a row with more columns than the safe limit is rejected', () => {
    const wideHeader = Array.from({ length: CSV_MAX_COLUMNS + 1 }, (_, i) => `C${i}`).join(',');
    const wideRow = Array.from({ length: CSV_MAX_COLUMNS + 1 }, () => '1').join(',');
    expect(() => parseCsvSafe(`${wideHeader}\n${wideRow}\n`, ',', 0)).toThrow(CsvIntakeError);
  });
  it('R7-TC134 more data rows than CSV_MAX_ROWS aborts rather than silently truncating', () => {
    const header = 'Date,Description,Amount\n';
    const body = Array.from({ length: CSV_MAX_ROWS + 5 }, (_, i) => `2026-01-01,Row ${i},1.00`).join('\n');
    expect(() => parseCsvSafe(header + body + '\n', ',', 0)).toThrow(CsvIntakeError);
  });
  it('R7-TC135 an empty file is rejected as empty_file, not silently returning zero rows', () => {
    expect(() => parseCsvSafe('', ',', 0)).toThrow(CsvIntakeError);
  });
  it('R7-TC136 a header row index beyond the end of the file is rejected', () => {
    expect(() => parseCsvSafe('Date,Description,Amount\n2026-01-01,Coffee,4.50\n', ',', 10)).toThrow(CsvIntakeError);
  });
});

describe('R7-TC137 — CSV formula-injection export guard (spec section 15)', () => {
  it.each([
    ['=cmd|/c calc', "'=cmd|/c calc"],
    ['+SUM(A1)', "'+SUM(A1)"],
    ['-2+3', "'-2+3"],
    ['@SUM(A1)', "'@SUM(A1)"],
    ['Coffee Shop', 'Coffee Shop'],
  ])('R7-TC137 sanitizeForCsvExport(%j) -> %j', (input, expected) => {
    expect(sanitizeForCsvExport(input)).toBe(expected);
  });
});

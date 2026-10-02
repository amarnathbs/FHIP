// BENCH-1 Phase 2 -- minimal XLSX reader (pure; binary fixtures built in-test).
import { describe, it, expect } from 'vitest';
import {
  listWorkbookSheets,
  readWorksheet,
  formatCodeIsDate,
  columnLetters,
} from '@/lib/services/investment-intelligence/benchmarkData/fileIngest';
import { buildXlsx, buildZip, simpleSheet, type CellSpec } from './support/benchmarkDataFileFixtures';

const codes = (r: { problems: Array<{ code: string }> }) => r.problems.map((p) => p.code);
const kinds = (cells: Array<{ kind: string }>) => cells.map((c) => c.kind);
const SHEET_PART = 'xl/worksheets/sheet1.xml';

const dataRows: CellSpec[][] = [
  ['2024-01-01', 1000],
  ['2024-01-02', 1001.5],
  ['2024-01-03', 1002.25],
];
const basic = () => buildXlsx({ sheets: [simpleSheet('Data', ['date', 'value'], dataRows)] });

describe('listWorkbookSheets', () => {
  it('lists every sheet with state, order and a row count from the dimension', () => {
    const bytes = buildXlsx({
      sheets: [
        { ...simpleSheet('Data', ['date', 'value'], dataRows), dimension: 'A1:B4' },
        { name: 'Notes', rows: [['x']], state: 'hidden' },
        { name: 'Secret', rows: [['y']], state: 'veryHidden' },
      ],
    });
    const r = listWorkbookSheets(bytes);
    expect(r.problems).toEqual([]);
    expect(r.date1904).toBe(false);
    expect(r.sheets.map((s) => [s.name, s.index, s.state])).toEqual([
      ['Data', 0, 'visible'],
      ['Notes', 1, 'hidden'],
      ['Secret', 2, 'veryHidden'],
    ]);
    expect(r.sheets[0].rowCount).toBe(4);
    expect(r.sheets[1].rowCount).toBeNull();
  });

  it('reports the 1904 date system', () => {
    expect(listWorkbookSheets(buildXlsx({ date1904: true, sheets: [simpleSheet('D', ['a'], [])] })).date1904).toBe(true);
  });

  it('returns problems (not exceptions) for garbage', () => {
    const r = listWorkbookSheets(Uint8Array.from([1, 2, 3, 4]));
    expect(r.sheets).toEqual([]);
    expect(r.problems.length).toBeGreaterThan(0);
  });
});

describe('readWorksheet -- sheet selection is explicit', () => {
  it('requires a sheet name and lists the available sheets', () => {
    for (const name of ['', undefined as unknown as string]) {
      const r = readWorksheet(basic(), name);
      expect(codes(r)).toEqual(['SHEET_NAME_REQUIRED']);
      expect(r.problems[0].message).toContain('Data');
      expect(r.rows).toEqual([]);
    }
  });

  it('rejects an unknown sheet name', () => {
    const r = readWorksheet(basic(), 'Sheet1');
    expect(codes(r)).toEqual(['SHEET_NOT_FOUND']);
    expect(r.disclosure.sheetsAvailable).toEqual(['Data']);
  });

  it('refuses a very-hidden sheet but can process a hidden one, disclosing both', () => {
    const bytes = buildXlsx({
      sheets: [
        simpleSheet('Visible', ['date', 'value'], dataRows),
        { ...simpleSheet('Hid', ['date', 'value'], dataRows), state: 'hidden' },
        { ...simpleSheet('Very', ['date', 'value'], dataRows), state: 'veryHidden' },
      ],
    });
    expect(codes(readWorksheet(bytes, 'Very'))).toEqual(['SHEET_VERY_HIDDEN']);
    const hid = readWorksheet(bytes, 'Hid');
    expect(hid.problems).toEqual([]);
    expect(hid.disclosure.processedSheetState).toBe('hidden');
    expect(hid.disclosure.hiddenSheetNames).toEqual(['Hid', 'Very']);
    const vis = readWorksheet(bytes, 'Visible');
    expect(vis.disclosure.sheetProcessed).toBe('Visible');
    expect(vis.disclosure.sheetsAvailable).toEqual(['Visible', 'Hid', 'Very']);
    expect(vis.disclosure.otherSheetsNotProcessed).toEqual(['Hid', 'Very']);
  });
});

describe('readWorksheet -- cell types', () => {
  it('reads shared strings, numbers, header and 1-based row numbers', () => {
    const r = readWorksheet(basic(), 'Data');
    expect(r.problems).toEqual([]);
    expect(r.header).toEqual(['date', 'value']);
    expect(r.headerRow).toBe(1);
    expect(r.rows.map((x) => x.rowNumber)).toEqual([2, 3, 4]);
    expect(r.rows[0].cells.map((c) => c.raw)).toEqual(['2024-01-01', '1000']);
    expect(r.rows[1].cells[1]).toEqual({ raw: '1001.5', kind: 'number', numberValue: 1001.5 });
    expect(r.disclosure.rowsProcessed).toBe(3);
  });

  it('reads inline strings, rich text (ignoring phonetic runs), booleans, errors and empties', () => {
    const bytes = buildXlsx({
      sheets: [
        {
          name: 'S',
          rows: [
            ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
            [{ inline: 'inline text' }, { rich: ['Rich ', 'Text'] }, { bool: true }, { error: '#N/A' }, null, 'x'],
          ],
        },
      ],
    });
    const r = readWorksheet(bytes, 'S');
    const c = r.rows[0].cells;
    expect(c.map((x) => x.raw)).toEqual(['inline text', 'Rich Text', 'TRUE', '#N/A', '', 'x']);
    expect(kinds(c)).toEqual(['string', 'string', 'boolean', 'error', 'empty', 'string']);
  });

  it('places sparse cells by their reference and pads to a uniform width', () => {
    const bytes = buildXlsx({
      sheets: [{ name: 'S', rows: [['a', 'b', 'c'], ['x', null, 'z'], null, [null, 'q']] }],
    });
    const r = readWorksheet(bytes, 'S');
    expect(r.rows.map((x) => x.rowNumber)).toEqual([2, 4]);
    expect(r.rows[0].cells.map((c) => c.raw)).toEqual(['x', '', 'z']);
    expect(r.rows[1].cells.map((c) => c.raw)).toEqual(['', 'q', '']);
  });

  it('handles a header row below a preamble and reports a missing header row', () => {
    const bytes = buildXlsx({
      sheets: [{ name: 'S', rows: [['Report'], ['generated today'], ['date', 'value'], ['2024-01-01', 5]] }],
    });
    const r = readWorksheet(bytes, 'S', { headerRow: 3 });
    expect(r.header).toEqual(['date', 'value']);
    expect(r.rows.map((x) => x.rowNumber)).toEqual([4]);
    expect(codes(readWorksheet(bytes, 'S', { headerRow: 9 }))).toEqual(['HEADER_ROW_MISSING']);
    expect(codes(readWorksheet(bytes, 'S', { headerRow: 0 }))).toEqual(['HEADER_ROW_INVALID']);
  });

  it('reads namespace-prefixed worksheet XML', () => {
    const xml =
      '<?xml version="1.0"?><x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:sheetData>' +
      '<x:row r="1"><x:c r="A1" t="inlineStr"><x:is><x:t>date</x:t></x:is></x:c><x:c r="B1" t="inlineStr"><x:is><x:t>value</x:t></x:is></x:c></x:row>' +
      '<x:row r="2"><x:c r="A2" t="inlineStr"><x:is><x:t>2024-01-01</x:t></x:is></x:c><x:c r="B2"><x:v>12.5</x:v></x:c></x:row>' +
      '</x:sheetData></x:worksheet>';
    const bytes = buildXlsx({ sheets: [simpleSheet('Data', ['a'], [])], extraEntries: [{ name: SHEET_PART, data: xml }] });
    const r = readWorksheet(bytes, 'Data');
    expect(r.problems).toEqual([]);
    expect(r.header).toEqual(['date', 'value']);
    expect(r.rows[0].cells[1].numberValue).toBe(12.5);
  });

  it('decodes the predefined entities and numeric character references', () => {
    const xml =
      '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>A&amp;B &lt;C&gt; &#65;&#x42;</t></is></c></row></sheetData></worksheet>';
    const bytes = buildXlsx({ sheets: [simpleSheet('Data', ['a'], [])], extraEntries: [{ name: SHEET_PART, data: xml }] });
    expect(readWorksheet(bytes, 'Data').header).toEqual(['A&B <C> AB']);
  });
});

describe('readWorksheet -- date cells and date systems', () => {
  it('detects date cells from built-in and custom number formats (and not look-alikes)', () => {
    const bytes = buildXlsx({
      sheets: [
        {
          name: 'S',
          rows: [
            ['h'],
            [
              { date: 45000, style: 1 }, // built-in id 14
              { date: 45000, style: 2 }, // custom dd\-mmm\-yy
              { date: 45000, style: 6 }, // custom yyyy\-mm\-dd
              { num: 45000, style: 3 }, // "day "0.00 -- d/a/y are inside quotes: NOT a date
              { num: 45000, style: 4 }, // 0.00
              { num: 45000, style: 5 }, // [Red]0.0
              45000, // General
            ],
          ],
        },
      ],
    });
    const cells = readWorksheet(bytes, 'S').rows[0].cells;
    expect(kinds(cells)).toEqual(['date', 'date', 'date', 'number', 'number', 'number', 'number']);
    expect(cells[0].numberValue).toBe(45000);
  });

  it('exposes the workbook date system', () => {
    const b1900 = buildXlsx({ sheets: [simpleSheet('S', ['d'], [[{ date: 45000 }]])] });
    const b1904 = buildXlsx({ date1904: true, sheets: [simpleSheet('S', ['d'], [[{ date: 45000 }]])] });
    expect(readWorksheet(b1900, 'S').date1904).toBe(false);
    expect(readWorksheet(b1904, 'S').date1904).toBe(true);
    // The serial is the same number in both files: only the system differs.
    expect(readWorksheet(b1904, 'S').rows[0].cells[0].numberValue).toBe(45000);
  });

  it('formatCodeIsDate classifies number-format codes', () => {
    const dates = ['dd/mm/yyyy', 'd-mmm-yy', 'mmm-yy', 'mmmm', 'd', 'yyyy\\-mm\\-dd', '[$-409]d-mmm-yy', '[Red]dd/mm/yy', 'yy', 'dd/mm/yyyy h:mm'];
    const nots = ['General', '0.00', '#,##0.00', 'h:mm', 'h:mm AM/PM', '[h]:mm:ss', '"day "0.00', '0.0"y"', '@', '[Red]0.0', '0.00E+00', '\\d0'];
    for (const f of dates) expect(formatCodeIsDate(f), f).toBe(true);
    for (const f of nots) expect(formatCodeIsDate(f), f).toBe(false);
  });

  it('columnLetters converts indexes', () => {
    expect([0, 1, 25, 26, 27, 51, 52, 701, 702].map(columnLetters)).toEqual(['A', 'B', 'Z', 'AA', 'AB', 'AZ', 'BA', 'ZZ', 'AAA']);
  });
});

describe('readWorksheet -- formula cells (never evaluated, always reported)', () => {
  it('records EVERY cell with a formula, even one with a cached value', () => {
    const bytes = buildXlsx({
      sheets: [
        {
          name: 'S',
          rows: [
            ['date', 'value', 'note'],
            ['2024-01-01', { formula: 'A1*2', value: 2000 }, { formula: 'CONCAT("a","b")', value: 'ab' }],
            ['2024-01-02', 1001, 'plain'],
            ['2024-01-03', { formula: 'SUM(B2:B3)' }, null],
          ],
        },
      ],
    });
    const r = readWorksheet(bytes, 'S');
    expect(r.formulaCells).toEqual([
      { ref: 'B2', column: 'B', rowNumber: 2 },
      { ref: 'C2', column: 'C', rowNumber: 2 },
      { ref: 'B4', column: 'B', rowNumber: 4 },
    ]);
    // The cached value is still readable but is not trusted: the caller decides.
    expect(r.rows[0].cells[1].numberValue).toBe(2000);
  });

  it('does not report formulas that sit above the header row', () => {
    const bytes = buildXlsx({ sheets: [{ name: 'S', rows: [[{ formula: '1+1', value: 2 }], ['date', 'value'], ['2024-01-01', 1]] }] });
    expect(readWorksheet(bytes, 'S', { headerRow: 2 }).formulaCells).toEqual([]);
  });
});

describe('readWorksheet -- hidden rows are disclosed, never silently ignored', () => {
  const bytes = () =>
    buildXlsx({
      sheets: [
        {
          name: 'S',
          rows: [['date', 'value'], ['2024-01-01', 1], ['2024-01-02', 2], ['2024-01-03', 3], ['2024-01-04', 4]],
          hiddenRows: [3, 5],
        },
      ],
    });

  it('excludes hidden rows by default and lists them', () => {
    const r = readWorksheet(bytes(), 'S');
    expect(r.rows.map((x) => x.rowNumber)).toEqual([2, 4]);
    expect(r.hiddenRowNumbers).toEqual([3, 5]);
    expect(r.disclosure.hiddenRowsSkipped).toEqual([3, 5]);
    expect(r.disclosure.hiddenRowsIncluded).toEqual([]);
    expect(r.disclosure.rowsProcessed).toBe(2);
  });

  it('includes hidden rows on request, flags them and lists them', () => {
    const r = readWorksheet(bytes(), 'S', { includeHiddenRows: true });
    expect(r.rows.map((x) => [x.rowNumber, x.hidden])).toEqual([[2, false], [3, true], [4, false], [5, true]]);
    expect(r.disclosure.hiddenRowsSkipped).toEqual([]);
    expect(r.disclosure.hiddenRowsIncluded).toEqual([3, 5]);
    expect(r.hiddenRowNumbers).toEqual([3, 5]);
  });
});

describe('readWorksheet -- merged cells', () => {
  it('flags merged cells that touch the data area and the header, but allows a banner above the header', () => {
    const data = buildXlsx({ sheets: [{ name: 'S', rows: [['date', 'value'], ['2024-01-01', 1], ['2024-01-02', 2]], merges: ['A3:B3'] }] });
    expect(codes(readWorksheet(data, 'S'))).toEqual(['MERGED_CELLS_IN_DATA']);
    const header = buildXlsx({ sheets: [{ name: 'S', rows: [['date', 'value'], ['2024-01-01', 1]], merges: ['A1:B1'] }] });
    expect(codes(readWorksheet(header, 'S'))).toEqual(['MERGED_HEADER_CELLS']);
    const banner = buildXlsx({ sheets: [{ name: 'S', rows: [['Banner'], ['date', 'value'], ['2024-01-01', 1]], merges: ['A1:B1'] }] });
    expect(readWorksheet(banner, 'S', { headerRow: 2 }).problems).toEqual([]);
  });
});

describe('readWorksheet -- hostile XML and limits', () => {
  const withSheetXml = (xml: string, part = SHEET_PART) =>
    buildXlsx({ sheets: [simpleSheet('Data', ['a'], [])], extraEntries: [{ name: part, data: xml }] });

  it('rejects a DOCTYPE / entity definition in any part (XML_DTD_FORBIDDEN)', () => {
    const laughs =
      '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">]><worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>&lol2;</t></is></c></row></sheetData></worksheet>';
    expect(codes(readWorksheet(withSheetXml(laughs), 'Data'))).toContain('XML_DTD_FORBIDDEN');
    const sst = '<?xml version="1.0"?><!DOCTYPE sst [<!ENTITY a "aaaa">]><sst><si><t>&a;</t></si></sst>';
    expect(codes(readWorksheet(withSheetXml(sst, 'xl/sharedStrings.xml'), 'Data'))).toContain('XML_DTD_FORBIDDEN');
    const wb =
      '<?xml version="1.0"?><!DOCTYPE workbook [<!ENTITY x SYSTEM "file:///etc/passwd">]><workbook><sheets><sheet name="Data" sheetId="1" r:id="rId1" xmlns:r="x"/></sheets></workbook>';
    expect(codes(readWorksheet(withSheetXml(wb, 'xl/workbook.xml'), 'Data'))).toContain('XML_DTD_FORBIDDEN');
  });

  it('rejects an undefined entity reference without expanding it', () => {
    const xml = '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>&xxe;</t></is></c></row></sheetData></worksheet>';
    const r = readWorksheet(withSheetXml(xml), 'Data');
    expect(codes(r)).toContain('XML_ENTITY_FORBIDDEN');
    expect(r.header.join('')).not.toContain('xxe');
  });

  it('reports malformed XML rather than throwing', () => {
    for (const xml of ['<worksheet><sheetData>', '<worksheet></sheetData>', '<worksheet attr=1/>', '<<<>>>', '<worksheet><!-- never closed']) {
      const r = readWorksheet(withSheetXml(xml), 'Data');
      expect(codes(r).some((c) => c.startsWith('XML_')), xml).toBe(true);
    }
  });

  it('enforces the XML size limit', () => {
    const r = readWorksheet(basic(), 'Data', { limits: { maxXmlBytes: 100 } });
    expect(codes(r)).toContain('XML_TOO_LARGE');
  });

  it('enforces the row limit (and stops reading)', () => {
    const rows: CellSpec[][] = Array.from({ length: 50 }, (_, i) => [`2024-01-${String((i % 28) + 1).padStart(2, '0')}`, i + 1]);
    const bytes = buildXlsx({ sheets: [simpleSheet('Data', ['date', 'value'], rows)] });
    const r = readWorksheet(bytes, 'Data', { limits: { maxRows: 10 } });
    expect(codes(r)).toContain('TOO_MANY_ROWS');
    expect(r.rows.length).toBeLessThanOrEqual(10);
    expect(codes(readWorksheet(bytes, 'Data', { limits: { maxRows: 50 } }))).not.toContain('TOO_MANY_ROWS');
  });

  it('returns a problem (not an exception) for a zip bomb and for random corruption', () => {
    const bomb = buildXlsx({
      sheets: [simpleSheet('Data', ['a'], [])],
      extraEntries: [{ name: SHEET_PART, data: new Uint8Array(8 * 1024 * 1024) }],
    });
    expect(codes(readWorksheet(bomb, 'Data'))).toEqual(['ZIP_BOMB_RATIO']);
    expect(codes(listWorkbookSheets(bomb))).toEqual(['ZIP_BOMB_RATIO']);
    let seed = 99;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
    const good = basic();
    for (let i = 0; i < 100; i++) {
      const copy = Uint8Array.from(good);
      for (let k = 0; k < 4; k++) copy[rnd() % copy.length] = rnd() & 0xff;
      expect(() => readWorksheet(copy, 'Data')).not.toThrow();
      expect(() => listWorkbookSheets(copy)).not.toThrow();
    }
  });

  it('refuses a workbook that is not a valid package', () => {
    const notWb = buildZip([{ name: 'readme.txt', data: 'x' }]);
    expect(codes(readWorksheet(notWb, 'Data'))).toContain('XLSX_PART_MISSING');
  });
});

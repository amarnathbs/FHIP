// BENCH-1 Phase 2 -- file inspection and ZIP defences (pure).
import { describe, it, expect } from 'vitest';
import {
  inspectUpload,
  readZipEntries,
  tryReadZipEntries,
  ZipReadError,
  DEFAULT_LIMITS,
} from '@/lib/services/investment-intelligence/benchmarkData/fileIngest';
import {
  buildXlsx,
  buildZip,
  concatBytes,
  simpleSheet,
  storedLocalRecord,
  utf8,
} from './support/benchmarkDataFileFixtures';

const CSV = utf8('date,value\n2024-01-01,1000.00\n');
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const goodXlsx = () => buildXlsx({ sheets: [simpleSheet('Data', ['date', 'value'], [['2024-01-01', 1000]])] });
const codes = (r: { problems: Array<{ code: string }> }) => r.problems.map((p) => p.code);

/** A syntactically valid xlsx skeleton whose sheet part is replaced by `sheetEntry`. */
function xlsxWith(sheetEntry: Parameters<typeof buildZip>[0][number], limitsHint = false) {
  void limitsHint;
  return buildXlsx({ sheets: [simpleSheet('Data', ['date', 'value'], [['2024-01-01', 1000]])], extraEntries: [sheetEntry] });
}

describe('extension allow-list', () => {
  const cases: Array<[string, string]> = [
    ['data.xlsm', 'FILE_EXT_MACRO'],
    ['data.XLSM', 'FILE_EXT_MACRO'],
    ['data.xlsb', 'FILE_EXT_MACRO'],
    ['data.xls', 'FILE_EXT_LEGACY_EXCEL'],
    ['factsheet.pdf', 'FILE_EXT_PDF'],
    ['FACTSHEET.PDF', 'FILE_EXT_PDF'],
    ['data.zip', 'FILE_EXT_ARCHIVE'],
    ['data.xml', 'FILE_EXT_XML'],
    ['data.txt', 'FILE_EXT_UNSUPPORTED'],
    ['data.exe', 'FILE_EXT_UNSUPPORTED'],
    ['data.csv.exe', 'FILE_EXT_UNSUPPORTED'],
    ['data', 'FILE_EXT_UNSUPPORTED'],
    ['.csv', 'FILE_EXT_UNSUPPORTED'],
  ];
  it.each(cases)('rejects %s with %s', (fileName, code) => {
    const r = inspectUpload({ fileName, bytes: CSV });
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain(code);
    expect(r.kind).toBeNull();
  });

  it('accepts .csv / .CSV / .xlsx / .XLSX case-insensitively and with paths', () => {
    expect(inspectUpload({ fileName: 'a.csv', bytes: CSV }).kind).toBe('csv');
    expect(inspectUpload({ fileName: 'C:\\x\\A.CSV', bytes: CSV }).kind).toBe('csv');
    expect(inspectUpload({ fileName: 'A.XLSX', bytes: goodXlsx() }).kind).toBe('xlsx');
  });
});

describe('CSV content, encoding and MIME', () => {
  it('returns decoded text for valid UTF-8 and strips a UTF-8 BOM', () => {
    const withBom = concatBytes(Uint8Array.from([0xef, 0xbb, 0xbf]), CSV);
    const r = inspectUpload({ fileName: 'a.csv', bytes: withBom });
    expect(r.ok).toBe(true);
    expect(r.text?.startsWith('date,value')).toBe(true);
  });

  it('transcodes UTF-16 LE and BE only when a BOM is present', () => {
    const text = 'date,value\n2024-01-01,1000.00\n';
    const le = new Uint8Array(2 + text.length * 2);
    le.set([0xff, 0xfe]);
    const be = new Uint8Array(2 + text.length * 2);
    be.set([0xfe, 0xff]);
    for (let i = 0; i < text.length; i++) {
      le[2 + i * 2] = text.charCodeAt(i);
      be[2 + i * 2 + 1] = text.charCodeAt(i);
    }
    expect(inspectUpload({ fileName: 'a.csv', bytes: le }).text).toBe(text);
    expect(inspectUpload({ fileName: 'a.csv', bytes: be }).text).toBe(text);
    // UTF-16 without a BOM contains NUL bytes and is refused.
    const noBom = le.subarray(2);
    const r = inspectUpload({ fileName: 'a.csv', bytes: noBom });
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain('FILE_ENCODING_INVALID');
  });

  it('rejects invalid UTF-8 (a lone continuation / Latin-1 byte) as FILE_ENCODING_INVALID', () => {
    const r = inspectUpload({ fileName: 'a.csv', bytes: Uint8Array.from([0x64, 0x61, 0x74, 0x65, 0x2c, 0xc3, 0x28, 0x0a]) });
    expect(r.ok).toBe(false);
    expect(codes(r)).toEqual(['FILE_ENCODING_INVALID']);
  });

  it('rejects a NUL byte inside otherwise valid text', () => {
    const r = inspectUpload({ fileName: 'a.csv', bytes: Uint8Array.from([0x61, 0x2c, 0x62, 0x00, 0x0a, 0x31, 0x2c, 0x32]) });
    expect(codes(r)).toContain('FILE_ENCODING_INVALID');
  });

  it('rejects a PDF renamed to .csv (and other disguised binaries) by content', () => {
    const pdf = utf8('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n');
    const r = inspectUpload({ fileName: 'factsheet.csv', bytes: pdf });
    expect(r.ok).toBe(false);
    expect(codes(r)).toEqual(['FILE_CONTENT_MISMATCH']);
    for (const bytes of [
      Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00]),
      Uint8Array.from([0x4d, 0x5a, 0x90, 0x00]),
      Uint8Array.from([0x1f, 0x8b, 0x08, 0x00]),
      goodXlsx(),
    ]) {
      expect(codes(inspectUpload({ fileName: 'x.csv', bytes }))).toEqual(['FILE_CONTENT_MISMATCH']);
    }
  });

  it('rejects a declared MIME type that contradicts the file (csv)', () => {
    for (const mime of ['application/pdf', 'image/png', 'application/zip', XLSX_MIME, 'text/html']) {
      const r = inspectUpload({ fileName: 'a.csv', declaredMime: mime, bytes: CSV });
      expect(r.ok).toBe(false);
      expect(codes(r)).toEqual(['FILE_MIME_MISMATCH']);
    }
  });

  it('accepts generic and CSV-family MIME types (with parameters, any case)', () => {
    for (const mime of [undefined, null, '', 'application/octet-stream', 'text/csv', 'TEXT/CSV; charset=utf-8', 'text/plain', 'application/vnd.ms-excel', 'application/csv']) {
      expect(inspectUpload({ fileName: 'a.csv', declaredMime: mime, bytes: CSV }).ok).toBe(true);
    }
  });

  it('rejects a CSV MIME type on an xlsx and accepts the xlsx / generic ones', () => {
    const x = goodXlsx();
    for (const mime of ['text/csv', 'application/pdf', 'application/vnd.ms-excel', 'text/plain']) {
      const r = inspectUpload({ fileName: 'a.xlsx', declaredMime: mime, bytes: x });
      expect(codes(r)).toEqual(['FILE_MIME_MISMATCH']);
    }
    for (const mime of [XLSX_MIME, 'application/octet-stream', '', null]) {
      expect(inspectUpload({ fileName: 'a.xlsx', declaredMime: mime, bytes: x }).ok).toBe(true);
    }
  });

  it('enforces the byte limit exactly (and rejects empty files)', () => {
    const atLimit = inspectUpload({ fileName: 'a.csv', bytes: utf8('a,b\n1,2\n'), limits: { maxBytes: 8 } });
    expect(atLimit.ok).toBe(true);
    const over = inspectUpload({ fileName: 'a.csv', bytes: utf8('a,b\n1,2\n'), limits: { maxBytes: 7 } });
    expect(codes(over)).toEqual(['FILE_TOO_LARGE']);
    const big = new Uint8Array(DEFAULT_LIMITS.maxBytes + 1).fill(0x61);
    expect(codes(inspectUpload({ fileName: 'a.csv', bytes: big }))).toEqual(['FILE_TOO_LARGE']);
    expect(codes(inspectUpload({ fileName: 'a.csv', bytes: new Uint8Array(0) }))).toEqual(['FILE_EMPTY']);
  });
});

describe('XLSX container checks', () => {
  it('accepts a valid minimal workbook', () => {
    const r = inspectUpload({ fileName: 'a.xlsx', bytes: goodXlsx() });
    expect(r.ok).toBe(true);
    expect(r.kind).toBe('xlsx');
  });

  it('rejects a workbook that contains a macro project', () => {
    const r = inspectUpload({ fileName: 'a.xlsx', bytes: buildXlsx({ sheets: [simpleSheet('D', ['a'], [])], vba: true }) });
    expect(codes(r)).toEqual(['XLSX_MACRO_PRESENT']);
  });

  it('rejects a workbook whose content type is macro-enabled even without vbaProject.bin', () => {
    const r = inspectUpload({ fileName: 'a.xlsx', bytes: buildXlsx({ sheets: [simpleSheet('D', ['a'], [])], macroContentType: true }) });
    expect(codes(r)).toEqual(['XLSX_MACRO_PRESENT']);
  });

  it('rejects an OLE2 / encrypted container named .xlsx', () => {
    const ole = Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(codes(inspectUpload({ fileName: 'a.xlsx', bytes: ole }))).toEqual(['FILE_ENCRYPTED_OR_OLE2']);
  });

  it('rejects non-ZIP bytes and ZIPs that are not workbooks', () => {
    expect(codes(inspectUpload({ fileName: 'a.xlsx', bytes: CSV }))).toEqual(['FILE_CONTENT_MISMATCH']);
    const notWb = buildZip([{ name: 'hello.txt', data: 'hi' }]);
    expect(codes(inspectUpload({ fileName: 'a.xlsx', bytes: notWb }))).toEqual(['XLSX_STRUCTURE_INVALID']);
  });
});

describe('zip-bomb defences', () => {
  const zeros = (mib: number) => new Uint8Array(mib * 1024 * 1024);

  it('rejects an entry with an extreme compression ratio (declared honestly)', () => {
    const bomb = xlsxWith({ name: 'xl/worksheets/sheet1.xml', data: zeros(8) });
    const r = inspectUpload({ fileName: 'a.xlsx', bytes: bomb });
    expect(r.ok).toBe(false);
    expect(codes(r)).toEqual(['ZIP_BOMB_RATIO']);
  });

  it('control: the same archive is accepted once the ratio limit is lifted (so the ratio rule is what rejected it)', () => {
    const bomb = xlsxWith({ name: 'xl/worksheets/sheet1.xml', data: zeros(8) });
    expect(inspectUpload({ fileName: 'a.xlsx', bytes: bomb, limits: { maxZipRatio: Number.POSITIVE_INFINITY } }).ok).toBe(true);
  });

  it('rejects too many entries (default 200 and a custom cap)', () => {
    const many = buildZip([
      { name: '[Content_Types].xml', data: '<x/>' },
      { name: 'xl/workbook.xml', data: '<x/>' },
      ...Array.from({ length: 201 }, (_, i) => ({ name: `f${i}.txt`, data: 'x' })),
    ]);
    expect(codes(inspectUpload({ fileName: 'a.xlsx', bytes: many }))).toEqual(['ZIP_BOMB_TOO_MANY_ENTRIES']);
    const some = buildXlsx({ sheets: [simpleSheet('D', ['a'], [])] });
    expect(inspectUpload({ fileName: 'a.xlsx', bytes: some, limits: { maxZipEntries: 3 } }).ok).toBe(false);
    expect(inspectUpload({ fileName: 'a.xlsx', bytes: some }).ok).toBe(true);
  });

  it('rejects an entry whose declared uncompressed size exceeds the per-entry limit', () => {
    const r = inspectUpload({
      fileName: 'a.xlsx',
      bytes: xlsxWith({ name: 'xl/worksheets/sheet1.xml', data: '<worksheet/>', declaredUncompressedSize: 30 * 1024 * 1024 }),
    });
    expect(codes(r)).toEqual(['ZIP_BOMB_ENTRY_TOO_LARGE']);
  });

  it('rejects when the declared total exceeds the total limit', () => {
    const bytes = buildXlsx({ sheets: [simpleSheet('D', ['a'], [])] });
    const r = inspectUpload({ fileName: 'a.xlsx', bytes, limits: { maxZipUncompressedBytes: 100 } });
    expect(codes(r)).toEqual(['ZIP_BOMB_TOTAL_TOO_LARGE']);
  });

  it('catches a LYING header at inflate time (declares 100 bytes, really inflates to 6 MiB)', () => {
    const lying = xlsxWith({ name: 'xl/worksheets/sheet1.xml', data: zeros(6), declaredUncompressedSize: 100 });
    // The header-only checks (size, ratio) all pass for the declared 100 bytes ...
    const r = inspectUpload({ fileName: 'a.xlsx', bytes: lying });
    // ... so only the inflate-time size enforcement can reject it.
    expect(r.ok).toBe(false);
    expect(codes(r)).toEqual(['ZIP_BOMB_SIZE_MISMATCH']);
  });

  it('rejects an entry that inflates to LESS than declared (inconsistent header)', () => {
    const r = inspectUpload({
      fileName: 'a.xlsx',
      bytes: xlsxWith({ name: 'xl/worksheets/sheet1.xml', data: '<worksheet/>', declaredUncompressedSize: 100 }),
    });
    expect(codes(r)).toEqual(['ZIP_BOMB_SIZE_MISMATCH']);
  });

  it('rejects encrypted entries, unsupported methods and zip64', () => {
    expect(codes(inspectUpload({ fileName: 'a.xlsx', bytes: xlsxWith({ name: 'xl/worksheets/sheet1.xml', data: 'x', flags: 1 }) }))).toEqual(['ZIP_ENCRYPTED']);
    expect(
      codes(
        inspectUpload({
          fileName: 'a.xlsx',
          bytes: xlsxWith({ name: 'xl/worksheets/sheet1.xml', data: 'x', rawCompressed: Uint8Array.from([1, 2, 3]), methodCodeOverride: 12 }),
        }),
      ),
    ).toEqual(['ZIP_UNSUPPORTED_METHOD']);
    const z64 = buildZip([{ name: '[Content_Types].xml', data: '<x/>' }, { name: 'xl/workbook.xml', data: '<x/>' }], { zip64Locator: true });
    expect(codes(inspectUpload({ fileName: 'a.xlsx', bytes: z64 }))).toEqual(['ZIP_BOMB_ZIP64_UNSUPPORTED']);
    const z64b = buildZip([{ name: '[Content_Types].xml', data: '<x/>' }, { name: 'xl/workbook.xml', data: '<x/>' }], { eocdTotalEntries: 0xffff });
    expect(codes(inspectUpload({ fileName: 'a.xlsx', bytes: z64b }))).toEqual(['ZIP_BOMB_ZIP64_UNSUPPORTED']);
  });

  it('rejects path-traversal names and duplicate entry names', () => {
    for (const name of ['../evil.xml', '/abs.xml', 'a/../../b.xml', 'C:\\x.xml', 'a\\b.xml']) {
      const bytes = buildZip([{ name: '[Content_Types].xml', data: '<x/>' }, { name: 'xl/workbook.xml', data: '<x/>' }, { name, data: 'x' }]);
      expect(codes(inspectUpload({ fileName: 'a.xlsx', bytes })), name).toEqual(['ZIP_PATH_TRAVERSAL']);
    }
    const dup = buildZip([{ name: '[Content_Types].xml', data: '<x/>' }, { name: 'xl/workbook.xml', data: '<x/>' }, { name: 'xl/workbook.xml', data: '<y/>' }]);
    expect(codes(inspectUpload({ fileName: 'a.xlsx', bytes: dup }))).toEqual(['ZIP_DUPLICATE_ENTRY']);
  });

  it('rejects a local header that disagrees with the central directory', () => {
    const bytes = buildZip([
      { name: '[Content_Types].xml', data: '<x/>' },
      { name: 'xl/workbook.xml', data: '<x/>', localName: 'xl/other.xml' },
    ]);
    expect(codes(inspectUpload({ fileName: 'a.xlsx', bytes }))).toEqual(['ZIP_INCONSISTENT_HEADER']);
  });

  it('rejects overlapping entries (a second entry whose header lies inside the first entry data)', () => {
    const inner = storedLocalRecord('xl/workbook.xml', '<x/>');
    const outerData = concatBytes(utf8('PREFIX'), inner, utf8('TAIL'));
    const outerName = '[Content_Types].xml';
    const innerStart = 30 + outerName.length + 6;
    const bytes = buildZip(
      [
        { name: outerName, data: outerData, method: 0 },
        { name: 'xl/workbook.xml', data: '<x/>', method: 0 },
      ],
      { forceLocalOffset: (i, real) => (i === 1 ? innerStart : real) },
    );
    const r = inspectUpload({ fileName: 'a.xlsx', bytes });
    expect(codes(r)).toEqual(['ZIP_OVERLAPPING_ENTRIES']);
  });

  it('rejects truncated and garbage archives without throwing', () => {
    const good = goodXlsx();
    expect(codes(inspectUpload({ fileName: 'a.xlsx', bytes: good.subarray(0, good.length - 10) }))).toEqual(['ZIP_INVALID']);
    expect(codes(inspectUpload({ fileName: 'a.xlsx', bytes: Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]) }))).toEqual(['ZIP_INVALID']);
  });

  it('never throws on randomly corrupted workbooks (deterministic fuzz)', () => {
    const good = goodXlsx();
    let seed = 12345;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    for (let i = 0; i < 150; i++) {
      const copy = Uint8Array.from(good);
      const flips = 1 + (rnd() % 6);
      for (let k = 0; k < flips; k++) copy[rnd() % copy.length] = rnd() & 0xff;
      const cut = rnd() % 4 === 0 ? copy.subarray(0, rnd() % copy.length) : copy;
      const r = inspectUpload({ fileName: 'a.xlsx', bytes: cut });
      expect(typeof r.ok).toBe('boolean');
      expect(Array.isArray(r.problems)).toBe(true);
    }
  });
});

describe('readZipEntries', () => {
  it('returns every entry of a valid archive', () => {
    const entries = readZipEntries(goodXlsx());
    expect([...entries.keys()]).toEqual(expect.arrayContaining(['[Content_Types].xml', 'xl/workbook.xml', 'xl/styles.xml']));
    expect(new TextDecoder().decode(entries.get('xl/workbook.xml'))).toContain('<sheets>');
  });

  it('throws a ZipReadError (never a raw error) for unsafe archives and offers a non-throwing form', () => {
    const bomb = buildZip([{ name: 'a.xml', data: new Uint8Array(6 * 1024 * 1024) }]);
    expect(() => readZipEntries(bomb)).toThrow(ZipReadError);
    const t = tryReadZipEntries(bomb);
    expect(t.ok).toBe(false);
    if (!t.ok) expect(t.problems[0].code).toBe('ZIP_BOMB_RATIO');
  });

  it('honours custom limits', () => {
    expect(() => readZipEntries(goodXlsx(), { maxZipEntries: 1 })).toThrow(ZipReadError);
  });
});

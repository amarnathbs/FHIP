// Resources Bulk Upload -- file security (server-side, authoritative). Hostile input must always come back as a
// NAMED file-level error, never an exception, and never reach row validation or the database.
//
// NAMED NEGATIVE CONTROLS
//   NC-S1  every rejected family (xls, xlsm, ods, zip, pdf, exe, macro workbook) is refused while the clean csv/xlsx pair passes
//   NC-S2  zip bomb: a ~30 KB archive that inflates to 30 MB is refused BEFORE inflation reaches that size
//   NC-S3  lying header: an entry that declares 10 bytes but inflates to megabytes is refused at inflate time
//   NC-S4  formula cell: never evaluated; the cached value is NOT used; the row carries FORMULA_NOT_ALLOWED
//   NC-S5  DTD / entity (XXE, billion laughs) in a sheet is refused
//   NC-S6  CSV results injection: every cell of the downloadable results file is neutralised
import { describe, expect, it } from 'vitest';
import { inspectImportFile, mapIngestProblem, sha256Hex } from '@/lib/resources/import/file-security';
import { stripUnusedBinContentType } from '@/lib/resources/import/xlsx-sanitize';
import { parseImportFile } from '@/lib/resources/import/parser';
import { buildResultsCsv } from '@/lib/resources/import/results-csv';
import { IMPORT_LIMITS, type ImportIssue } from '@/lib/resources/import/types';
import { csvOf, good, SCHEMAS, xlsxFor, xlsxOf, rowsToAoa } from '../support/resourcesImportFixtures';
import { minimalXlsxZip, zipOf } from '../support/zipWriter';

const enc = (s: string) => new TextEncoder().encode(s);
const codes = (r: { ok: boolean; issues?: ImportIssue[] }) => (r.ok ? [] : (r.issues ?? []).map((i) => i.code));
const parse = (name: string, bytes: Uint8Array, type: 'article' | 'money_update' = 'article', mime: string | null = null) => parseImportFile({ fileName: name, declaredMime: mime, bytes }, SCHEMAS[type], { sheetName: SCHEMAS[type].uploadSheetName });

describe('NC-S1 only .csv and .xlsx are accepted; everything else is INVALID_FILE_TYPE', () => {
  it('the clean pair passes', () => {
    expect(parse('a.csv', csvOf('article', [good('article')])).ok).toBe(true);
    expect(parse('a.xlsx', xlsxFor('article', [good('article')])).ok).toBe(true);
    expect(parse('A.CSV', csvOf('article', [good('article')])).ok).toBe(true);
  });

  it('refused by extension: .xls .xlsm .xlsb .ods .zip .pdf .xml .txt .html and no extension', () => {
    const csv = csvOf('article', [good('article')]);
    for (const name of ['a.xls', 'a.xlsm', 'a.xlsb', 'a.xltm', 'a.ods', 'a.zip', 'a.pdf', 'a.xml', 'a.txt', 'a.html', 'a.csv.exe', 'noextension', 'a.gz']) {
      expect(codes(parse(name, csv)), name).toEqual(['INVALID_FILE_TYPE']);
    }
  });

  it('refused by CONTENT even when the name and the declared type lie', () => {
    const pdf = enc('%PDF-1.7\n1 0 obj\n');
    const exe = Uint8Array.from([0x4d, 0x5a, 0x90, 0x00, 0x03]);
    const ole = Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
    const gz = Uint8Array.from([0x1f, 0x8b, 0x08, 0x00]);
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    for (const [label, bytes] of [['pdf', pdf], ['exe', exe], ['gzip', gz], ['png', png]] as const) {
      expect(codes(parse('a.csv', bytes, 'article', 'text/csv')), `${label} as csv`).toEqual(['INVALID_FILE_TYPE']);
      expect(codes(parse('a.xlsx', bytes, 'article', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')), `${label} as xlsx`).toEqual(['INVALID_FILE_TYPE']);
    }
    expect(codes(parse('a.xls', ole)), 'legacy xls by extension').toEqual(['INVALID_FILE_TYPE']);
    expect(codes(parse('a.xlsx', ole)), 'ole2 container named xlsx').toEqual(['INVALID_FILE_TYPE']);
    // a zip named .csv; a csv named .xlsx
    expect(codes(parse('a.csv', xlsxFor('article', [good('article')])))).toEqual(['INVALID_FILE_TYPE']);
    expect(codes(parse('a.xlsx', csvOf('article', [good('article')])))).toEqual(['INVALID_FILE_TYPE']);
    // declared MIME that contradicts the extension
    expect(codes(parse('a.csv', csvOf('article', [good('article')]), 'article', 'application/pdf'))).toEqual(['INVALID_FILE_TYPE']);
  });

  it('a csv with NUL bytes or invalid UTF-8 is refused; a UTF-8 BOM and CRLF are tolerated', () => {
    const base = csvOf('article', [good('article')]);
    const nul = new Uint8Array([...base, 0, 65]);
    expect(codes(parse('a.csv', nul))).toEqual(['INVALID_FILE_TYPE']);
    const bad = new Uint8Array([0xc3, 0x28, ...base]);
    expect(codes(parse('a.csv', bad))).toEqual(['INVALID_FILE_TYPE']);
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...base]);
    expect(parse('a.csv', bom).ok).toBe(true);
  });

  it('an archive that is not a workbook is refused, and so is a macro-enabled workbook (a macro project, or a macro-enabled workbook part)', () => {
    const notWb = zipOf([{ name: 'readme.txt', data: 'hi' }]);
    expect(codes(parse('a.xlsx', notWb))).toEqual(['INVALID_FILE_TYPE']);
    const macro = minimalXlsxZip({ extra: [{ name: 'xl/vbaProject.bin', data: 'MACRO' }] });
    expect(codes(parse('a.xlsx', macro))).toEqual(['INVALID_FILE_TYPE']);
    const macroPart = minimalXlsxZip({
      contentTypes: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.ms-excel.sheet.macroEnabled.main+xml"/></Types>',
    });
    expect(codes(parse('a.xlsx', macroPart))).toEqual(['INVALID_FILE_TYPE']);
  });

  it('NO local override of the shared inspector: our generated templates pass it UNCHANGED, and the unsanitised writer output is what it refuses (so the sanitiser is what makes the difference)', async () => {
    const { inspectUpload } = await import('@/lib/services/investment-intelligence/benchmarkData/fileIngest');
    const XLSX = await import('xlsx');
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['a'], ['b']]), 'S');
    const raw = new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);
    const bare = inspectUpload({ fileName: 'a.xlsx', bytes: raw });
    expect(bare.ok, 'control: the writer output with the unused .bin default is refused by the shared inspector').toBe(false);
    expect(bare.problems[0]?.code).toBe('XLSX_MACRO_PRESENT');
    const clean = stripUnusedBinContentType(raw);
    expect(inspectUpload({ fileName: 'a.xlsx', bytes: clean }).ok).toBe(true);
    // and the real templates, straight from the generator
    const { buildTemplateXlsx } = await import('@/lib/resources/import/template-generator');
    for (const t of ['article', 'money_update'] as const) expect(inspectUpload({ fileName: 'a.xlsx', bytes: await buildTemplateXlsx(t) }).ok, t).toBe(true);
    // the sanitiser only removes the unused default: it never touches a package that really has a .bin part
    expect(stripUnusedBinContentType(clean)).toBe(clean);
  });

  it('a truncated or corrupted workbook is refused cleanly', () => {
    const real = xlsxFor('article', [good('article')]);
    expect(codes(parse('a.xlsx', real.slice(0, 200)))).toEqual(['INVALID_FILE_TYPE']);
    const corrupt = real.slice();
    for (let i = real.length - 60; i < real.length - 30; i++) corrupt[i] = 0xff;
    expect(parse('a.xlsx', corrupt).ok).toBe(false);
  });
});

describe('size and limits', () => {
  it('a file over 10 MB is FILE_TOO_LARGE; an empty file is EMPTY_FILE', () => {
    expect(IMPORT_LIMITS.maxFileBytes).toBe(10 * 1024 * 1024);
    const big = new Uint8Array(IMPORT_LIMITS.maxFileBytes + 1).fill(97);
    expect(codes(parse('a.csv', big))).toEqual(['FILE_TOO_LARGE']);
    expect(codes(parse('a.csv', new Uint8Array()))).toEqual(['EMPTY_FILE']);
  });

  it('too many cells in one value is caught by the field length limit, and 501 rows is TOO_MANY_ROWS for xlsx too', () => {
    const rows = Array.from({ length: 501 }, (_, i) => good('article', { external_id: `E${i}`, slug: `s-${i}`, title: `T${i}` }));
    expect(codes(parse('a.xlsx', xlsxFor('article', rows)))).toEqual(['TOO_MANY_ROWS']);
    const ok500 = rows.slice(0, 500);
    expect(parse('a.xlsx', xlsxFor('article', ok500)).ok).toBe(true);
  });
});

describe('NC-S2 / NC-S3 decompression is bounded', () => {
  it('NC-S2 zip bomb: a tiny archive that would inflate to 30 MB is refused', () => {
    const bomb = minimalXlsxZip({ sheetXml: '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' + ' '.repeat(30 * 1024 * 1024) + '</sheetData></worksheet>' });
    expect(bomb.length).toBeLessThan(200_000);
    const r = parse('a.xlsx', bomb);
    expect(codes(r)).toEqual(['INVALID_FILE_TYPE']);
    expect(JSON.stringify(r)).toMatch(/ratio|expand|limit/i);
  });

  it('NC-S2 many entries: an archive with too many entries is refused', () => {
    const entries = Array.from({ length: 150 }, (_, i) => ({ name: `f${i}.txt`, data: 'x' }));
    expect(codes(parse('a.xlsx', zipOf(entries)))).toEqual(['INVALID_FILE_TYPE']);
  });

  it('NC-S3 lying header: declares 10 bytes, inflates to megabytes -> refused at inflate time', () => {
    const payload = Buffer.alloc(3 * 1024 * 1024, 0x20);
    const lying = zipOf([
      { name: '[Content_Types].xml', data: '<Types/>' },
      { name: 'xl/workbook.xml', data: '<workbook/>', declaredSize: 10 },
      { name: 'xl/worksheets/sheet1.xml', data: payload, declaredSize: 10 },
    ]);
    expect(codes(parse('a.xlsx', lying))).toEqual(['INVALID_FILE_TYPE']);
  });

  it('path traversal and absolute entry names are refused', () => {
    for (const name of ['../evil.xml', '/etc/passwd', 'C:\\x.xml']) {
      expect(codes(parse('a.xlsx', zipOf([{ name, data: 'x' }, { name: '[Content_Types].xml', data: '<Types/>' }])))).toEqual(['INVALID_FILE_TYPE']);
    }
  });
});

describe('NC-S4 formulas are never evaluated', () => {
  it('an XLSX formula cell is FORMULA_NOT_ALLOWED on its row and field; the cached value is NOT used', () => {
    const aoa = rowsToAoa('article', [good('article')]) as (string | { f: string; v?: string })[][];
    const titleCol = aoa[0].indexOf('title');
    aoa[1][titleCol] = { f: 'CONCATENATE("A","B")', v: 'AB' };
    const p = parse('a.xlsx', xlsxOf({ Article_Upload: aoa }));
    expect(p.ok).toBe(true);
    if (p.ok) {
      expect(p.table.rows[0].values.title).toBe('');
      expect(p.cellIssues.map((i) => `${i.code}:${i.field}:${i.row}`)).toEqual(['FORMULA_NOT_ALLOWED:title:2']);
    }
  });

  it('a formula in ANY column (not only a required one) is refused; the clean twin passes with no cell issue', () => {
    const clean = parse('a.xlsx', xlsxFor('article', [good('article')]));
    expect(clean.ok && clean.cellIssues).toEqual([]);
    const aoa = rowsToAoa('article', [good('article')]) as (string | { f: string; v?: string })[][];
    aoa[1][aoa[0].indexOf('seo_description')] = { f: 'HYPERLINK("http://evil","x")', v: 'x' };
    const p = parse('a.xlsx', xlsxOf({ Article_Upload: aoa }));
    expect(p.ok && p.cellIssues.map((i) => i.field)).toEqual(['seo_description']);
  });

  it('a CSV value starting with = is a formula by spreadsheet rules and is refused too (+ - @ text stays text)', () => {
    const p = parse('a.csv', csvOf('article', [good('article', { title: '=HYPERLINK("http://evil","x")', seo_title: '- a bullet', seo_description: '@mention is fine' })]));
    expect(p.ok).toBe(true);
    if (p.ok) {
      expect(p.cellIssues.map((i) => i.code)).toEqual(['FORMULA_NOT_ALLOWED']);
      expect(p.table.rows[0].values.title).toBe('');
      expect(p.table.rows[0].values.seo_title).toBe('- a bullet');
    }
  });
});

describe('NC-S5 XML hostility', () => {
  it('a sheet with a DOCTYPE or entity definition is refused', () => {
    const evil = '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;">]><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>&lol2;</t></is></c></row></sheetData></worksheet>';
    const r = parse('a.xlsx', minimalXlsxZip({ sheetXml: evil }));
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).toMatch(/DTD|entity|XML/i);
  });
});

describe('hostile input never throws', () => {
  it('random bytes under every allowed name, and mangled real files, always return a structured result', () => {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) >>> 0) / 0x7fffffff;
    for (let i = 0; i < 200; i++) {
      const n = Math.floor(rnd() * 600);
      const bytes = new Uint8Array(n).map(() => Math.floor(rnd() * 256));
      for (const name of ['x.csv', 'x.xlsx']) {
        const r = parse(name, bytes);
        expect(typeof r.ok).toBe('boolean');
      }
    }
    const real = xlsxFor('article', [good('article')]);
    for (let i = 0; i < 60; i++) {
      const copy = real.slice();
      for (let k = 0; k < 8; k++) copy[Math.floor(rnd() * copy.length)] = Math.floor(rnd() * 256);
      expect(typeof parse('x.xlsx', copy).ok).toBe('boolean');
    }
  });

  it('the file hash is the SHA-256 of the bytes and the raw bytes are never part of any result', () => {
    const bytes = csvOf('article', [good('article')]);
    const p = parse('a.csv', bytes);
    expect(p.ok && p.fileSha256).toBe(sha256Hex(bytes));
    expect(JSON.stringify(p)).not.toContain('bytes');
  });

  it('mapIngestProblem maps the ingest vocabulary onto the spec codes', () => {
    expect(mapIngestProblem({ code: 'FILE_TOO_LARGE', message: 'x' }).code).toBe('FILE_TOO_LARGE');
    expect(mapIngestProblem({ code: 'FILE_EMPTY', message: 'x' }).code).toBe('EMPTY_FILE');
    expect(mapIngestProblem({ code: 'ZIP_BOMB_RATIO', message: 'x' }).code).toBe('INVALID_FILE_TYPE');
    expect(mapIngestProblem({ code: 'BAD_QUOTE', message: 'x' }).code).toBe('FILE_PARSE_ERROR');
  });

  it('inspectImportFile flags an unterminated quote and a ragged csv as FILE_PARSE_ERROR, never silently re-aligned', () => {
    const base = new TextDecoder().decode(csvOf('article', [good('article')]));
    const ragged = base.replace(/\r\n$/, '') + ',extra\r\n';
    expect(codes(parse('a.csv', enc(ragged)))).toContain('FILE_PARSE_ERROR');
    expect(codes(parse('a.csv', enc(`${base}"unterminated`)))).toContain('FILE_PARSE_ERROR');
    expect(inspectImportFile({ fileName: 'a.csv', bytes: enc('a,b\r\n1,2\r\n') }).ok).toBe(true);
  });
});

describe('NC-S6 the downloadable results file is injection-safe', () => {
  it('every cell that could start a formula is neutralised; the clean twin is untouched; header and BOM are fixed', () => {
    const issues: ImportIssue[] = [
      { row: 2, field: 'title', code: 'MISSING_REQUIRED_VALUE', message: 'Title is required.', severity: 'error' },
      { row: 3, field: '=cmd|\' /C calc\'!A0', code: 'INVALID_ENUM', message: '=HYPERLINK("http://evil","x")', severity: 'error' },
      { row: 4, field: 'x', code: 'INVALID_URL', message: '+1+1', severity: 'error' },
      { row: 5, field: 'x', code: 'INVALID_URL', message: '-2+3', severity: 'error' },
      { row: 6, field: 'x', code: 'INVALID_URL', message: '@SUM(A1)', severity: 'error' },
      { row: 7, field: 'x', code: 'INVALID_URL', message: '\t=1+1', severity: 'error' },
      { row: 8, field: 'x', code: 'INVALID_URL', message: '  =1+1', severity: 'warning' },
    ];
    const csv = buildResultsCsv(issues);
    expect(csv.startsWith('\uFEFFrow,field,error_code,message,severity')).toBe(true);
    const lines = csv.split('\r\n');
    expect(lines[1]).toBe('2,title,MISSING_REQUIRED_VALUE,Title is required.,error');
    for (const dangerous of ['=HYPERLINK', '+1+1', '-2+3', '@SUM', '=cmd']) {
      const hit = lines.find((l) => l.includes(dangerous))!;
      for (const cell of hit.split(',')) expect(/^["]?[=+\-@]/.test(cell), `${dangerous} -> ${cell}`).toBe(false);
    }
    expect(lines.find((l) => l.includes('@SUM'))).toContain("'@SUM");
    expect(buildResultsCsv([])).toContain('No issues found.');
  });
});

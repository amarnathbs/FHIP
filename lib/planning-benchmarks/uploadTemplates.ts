// Planning Benchmarks upload templates: CSV and XLSX, both generated from the ONE schema in uploadSchema.ts.
//
// SERVER-ONLY (uses node:zlib). Safe-export rules applied (Admin Standard section 11): generated
// server-side, header on row 1, the version marker on every example row, no stored data is read, every
// text cell passes the formula-injection neutraliser, non-identifying file names, no comment lines in the
// CSV (a comment would corrupt a re-upload).
//
// The XLSX is a minimal, dependency-free workbook (stored text as inline strings, numbers as numbers, no
// formulas, no macros, no external links). Sheet 1 "Data" is the sheet to upload; sheet 2 "Read me" holds
// the version marker, the rules and one row per column. The operator still chooses the sheet explicitly
// when uploading, exactly as for any other workbook.
import { deflateRawSync } from 'node:zlib';
import { columnLetters } from '@/lib/services/investment-intelligence/benchmarkData/fileIngest';
import { safeCell } from './uploadValidate';
import { UNAVAILABLE_LINE, allowedValuesSections, datasetsHeading, readOnLine, type AllowedValues, type ListSection } from './allowedValues';

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
import {
  TEMPLATE_VERSION,
  UPLOAD_RULES,
  UPLOAD_SCHEMA,
  XLSX_DATA_SHEET,
  XLSX_README_SHEET,
  KIND_LABEL,
  KIND_PURPOSE,
  columnGuide,
  columnNames,
  type ColumnDef,
  type UploadKind,
} from './uploadSchema';

export type TemplateFormat = 'csv' | 'xlsx';

export function templateFileName(kind: UploadKind, format: TemplateFormat): string {
  return `planning_benchmarks_${kind}_template.${format}`;
}

const CRLF = '\r\n';

function csvQuote(s: string): string {
  return /[",\r\n]/.test(s) ? `"${s.split('"').join('""')}"` : s;
}

export function buildTemplateCsv(kind: UploadKind): string {
  const names = columnNames(kind);
  const lines = [names.map((n) => csvQuote(safeCell(n))).join(',')];
  for (const ex of UPLOAD_SCHEMA[kind].examples) lines.push(names.map((n) => csvQuote(safeCell(ex[n] ?? ''))).join(','));
  return lines.join(CRLF) + CRLF;
}

// ------------------------------------------------------------------------- Allowed values (companion CSV) ---

export const ALLOWED_VALUES_CSV_NAME = 'planning_benchmarks_allowed_values.csv';

/**
 * The companion "Allowed values (CSV)" download: a CSV has no second sheet, so the same live lists the XLSX
 * Read me prints are offered as their own file. NOT an upload template (it has no template_version column, so
 * it can never be staged). Blocks of: a heading line, a header row and the rows. Every cell passes the
 * formula-injection neutraliser. When the lists cannot be read the file says so, plainly.
 */
export function buildAllowedValuesCsv(allowed: AllowedValues): string {
  const line = (cells: string[]) => cells.map((c) => csvQuote(safeCell(c))).join(',');
  const out: string[] = [line(['Planning Benchmarks upload: allowed values'])];
  if (allowed.state !== 'ok') {
    out.push(line([UNAVAILABLE_LINE]));
    return out.join(CRLF) + CRLF;
  }
  out.push(line([readOnLine(allowed)]));
  for (const s of allowedValuesSections(allowed, 'all')) {
    out.push('');
    out.push(line([s.heading]));
    out.push(line([s.intro]));
    out.push(line(s.columns));
    for (const r of s.rows) out.push(line(r));
  }
  return out.join(CRLF) + CRLF;
}

// ------------------------------------------------------------------------------------------------ XLSX ---

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const enc = new TextEncoder();
const w16 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff];
const w32 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];

function zip(entries: Array<{ name: string; text: string }>): Uint8Array {
  const out: number[] = [];
  const central: number[] = [];
  for (const e of entries) {
    const name = enc.encode(e.name);
    const data = enc.encode(e.text);
    const comp = new Uint8Array(deflateRawSync(data));
    const crc = crc32(data);
    const offset = out.length;
    out.push(...w32(0x04034b50), ...w16(20), ...w16(0), ...w16(8), ...w16(0), ...w16(0x21), ...w32(crc), ...w32(comp.length), ...w32(data.length), ...w16(name.length), ...w16(0));
    out.push(...name);
    for (const b of comp) out.push(b);
    central.push(
      ...w32(0x02014b50), ...w16(20), ...w16(20), ...w16(0), ...w16(8), ...w16(0), ...w16(0x21),
      ...w32(crc), ...w32(comp.length), ...w32(data.length), ...w16(name.length), ...w16(0), ...w16(0), ...w16(0), ...w16(0), ...w32(0), ...w32(offset),
      ...name
    );
  }
  const cdStart = out.length;
  for (const b of central) out.push(b);
  out.push(...w32(0x06054b50), ...w16(0), ...w16(0), ...w16(entries.length), ...w16(entries.length), ...w32(central.length), ...w32(cdStart), ...w16(0));
  return Uint8Array.from(out);
}

function xmlEscape(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

type XCell = { text: string } | { num: number } | { text: string; bold: true } | null;

function sheetXml(rows: XCell[][], widths: number[]): string {
  const cols = widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('');
  const body = rows
    .map((cells, r) => {
      const rowNo = r + 1;
      const cs = cells
        .map((c, i) => {
          if (c === null) return '';
          const ref = `${columnLetters(i)}${rowNo}`;
          if ('num' in c) return `<c r="${ref}"><v>${c.num}</v></c>`;
          const style = 'bold' in c ? ' s="1"' : '';
          return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${xmlEscape(safeCell(c.text))}</t></is></c>`;
        })
        .join('');
      return `<row r="${rowNo}">${cs}</row>`;
    })
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols>${cols}</cols><sheetData>${body}</sheetData></worksheet>`;
}

function exampleCell(def: ColumnDef, value: string): XCell {
  if (value === '') return null;
  if ((def.type === 'number' || def.type === 'integer') && /^-?\d+(\.\d+)?$/.test(value)) return { num: Number(value) };
  return { text: value };
}

/** The Read me rows for the allowed lists: a clear heading per list, a header row, then the rows. Pure. */
export function allowedReadmeRows(kind: UploadKind, allowed: AllowedValues | undefined): XCell[][] {
  const rows: XCell[][] = [[], [{ text: 'Allowed values: what this file may name', bold: true }]];
  if (!allowed || allowed.state !== 'ok') {
    rows.push([{ text: UNAVAILABLE_LINE }]);
    return rows;
  }
  rows.push([{ text: readOnLine(allowed) }]);
  const sections: ListSection[] = allowedValuesSections(allowed, kind);
  for (const s of sections) {
    rows.push([], [{ text: s.heading, bold: true }], [{ text: s.intro }], s.columns.map((c): XCell => ({ text: c, bold: true })));
    for (const r of s.rows) rows.push(r.map((c): XCell => ({ text: c })));
  }
  return rows;
}

export function buildTemplateXlsx(kind: UploadKind, allowed?: AllowedValues): Uint8Array {
  const defs = UPLOAD_SCHEMA[kind].columns;
  const dataRows: XCell[][] = [defs.map((d) => ({ text: d.name, bold: true as const }))];
  for (const ex of UPLOAD_SCHEMA[kind].examples) dataRows.push(defs.map((d) => exampleCell(d, ex[d.name] ?? '')));

  const readme: XCell[][] = [
    [{ text: `Planning Benchmarks upload template: ${KIND_LABEL[kind]}`, bold: true }],
    [{ text: `Template version: ${TEMPLATE_VERSION[kind]}` }],
    [{ text: KIND_PURPOSE[kind] }],
    [{ text: allowed && allowed.state === 'ok' ? `${cap(datasetsHeading(allowed))}. The full lists of datasets, metrics and cohorts you may name are below the column table.` : UNAVAILABLE_LINE }],
    [],
    [{ text: 'Rules', bold: true }],
    ...UPLOAD_RULES.map((r): XCell[] => [{ text: r }]),
    [],
    [{ text: 'Column', bold: true }, { text: 'Required', bold: true }, { text: 'Type', bold: true }, { text: 'Description', bold: true }],
    ...columnGuide(kind).map((g): XCell[] => [{ text: g.name }, { text: g.required }, { text: g.type }, { text: g.description }]),
    [],
    [{ text: `Upload the "${XLSX_DATA_SHEET}" sheet. Delete the example rows first. This "${XLSX_README_SHEET}" sheet is never imported.` }],
    ...allowedReadmeRows(kind, allowed),
  ];

  const files = [
    {
      name: '[Content_Types].xml',
      text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
    },
    {
      name: '_rels/.rels',
      text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    },
    {
      name: 'xl/workbook.xml',
      text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${XLSX_DATA_SHEET}" sheetId="1" r:id="rId1"/><sheet name="${XLSX_README_SHEET}" sheetId="2" r:id="rId2"/></sheets></workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    },
    {
      name: 'xl/styles.xml',
      text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>',
    },
    { name: 'xl/worksheets/sheet1.xml', text: sheetXml(dataRows, defs.map((d) => Math.max(14, Math.min(40, d.name.length + 4)))) },
    { name: 'xl/worksheets/sheet2.xml', text: sheetXml(readme, [34, 16, 30, 70, 24, 30, 24, 22, 40, 40, 40]) },
  ];
  return zip(files);
}

/** `allowed` is the live lists for the XLSX Read me sheet (the CSV template stays header-only: it is imported as is). */
export function buildTemplate(kind: UploadKind, format: TemplateFormat, allowed?: AllowedValues): { body: string | Uint8Array; contentType: string; fileName: string } {
  const fileName = templateFileName(kind, format);
  if (format === 'csv') return { body: buildTemplateCsv(kind), contentType: 'text/csv; charset=utf-8', fileName };
  return { body: buildTemplateXlsx(kind, allowed), contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', fileName };
}

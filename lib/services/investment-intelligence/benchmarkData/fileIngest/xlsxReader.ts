// Minimal strict XLSX reader (zip central directory + inflate with a size cap +
// the small linear XML scanner). It deliberately does NOT use SheetJS: that
// package is unmaintained on npm and carries known CVEs. It reads only what a
// benchmark level history needs and discloses, rather than hides, everything
// it does not process (other sheets, hidden sheets, hidden rows, formulas).
//
// It never evaluates formulas, never follows external links, and refuses any
// XML that carries a DTD or entity definition.
import { openZip, type OpenedZip } from './zipReader';
import { scanXml } from './xmlScanner';
import { resolveLimits, type Problem, type UploadLimits } from './types';

export interface SheetInfo {
  name: string;
  index: number;
  state: 'visible' | 'hidden' | 'veryHidden';
  rowCount: number | null;
}

export type CellKind = 'string' | 'number' | 'date' | 'boolean' | 'empty' | 'error';

export interface XlsxCell {
  raw: string;
  kind: CellKind;
  numberValue?: number;
}

export interface XlsxRow {
  rowNumber: number;
  cells: XlsxCell[];
  hidden: boolean;
}

export interface XlsxDisclosure {
  sheetsAvailable: string[];
  sheetProcessed: string;
  rowsProcessed: number;
  hiddenRowsSkipped: number[];
  hiddenRowsIncluded: number[];
  otherSheetsNotProcessed: string[];
  /** Names of sheets whose state is hidden / veryHidden (a subset of sheetsAvailable). */
  hiddenSheetNames: string[];
  processedSheetState: 'visible' | 'hidden' | 'veryHidden';
}

export interface WorksheetResult {
  sheetName: string;
  date1904: boolean;
  headerRow: number;
  header: string[];
  rows: XlsxRow[];
  formulaCells: Array<{ ref: string; column: string; rowNumber: number }>;
  hiddenRowNumbers: number[];
  disclosure: XlsxDisclosure;
  problems: Problem[];
}

export interface ReadWorksheetOptions {
  headerRow?: number;
  includeHiddenRows?: boolean;
  limits?: Partial<UploadLimits>;
}

const MAX_COLUMNS = 16384;
/** Excel's last representable serial (9999-12-31 in the 1900 system). */
const MAX_SERIAL_1900 = 2958465;
const SERIAL_1904_OFFSET = 1462;
const DAY_MS = 86_400_000;

// ---------------------------------------------------------------- dates ---

/**
 * Converts an Excel serial day number to YYYY-MM-DD, or null when it is not a
 * real calendar date: non-finite, fractional (carries a time-of-day), < 1,
 * beyond 9999-12-31, or serial 60 of the 1900 system (the non-existent
 * 1900-02-29 that Excel inherited from Lotus 1-2-3).
 */
export function excelSerialToIsoDate(serial: number, date1904: boolean): string | null {
  if (typeof serial !== 'number' || !Number.isFinite(serial)) return null;
  if (!Number.isInteger(serial)) return null;
  if (serial < 1 || serial > MAX_SERIAL_1900 - (date1904 ? SERIAL_1904_OFFSET : 0)) return null;
  let epochMs: number;
  if (date1904) {
    epochMs = Date.UTC(1904, 0, 1) + serial * DAY_MS;
  } else {
    if (serial === 60) return null;
    epochMs = (serial < 60 ? Date.UTC(1899, 11, 31) : Date.UTC(1899, 11, 30)) + serial * DAY_MS;
  }
  return new Date(epochMs).toISOString().slice(0, 10);
}

const BUILTIN_DATE_IDS = new Set<number>([
  14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58,
]);

/** True when a custom number-format code displays a date (d / m / y tokens outside quotes and brackets). */
export function formatCodeIsDate(code: string): boolean {
  let hasD = false;
  let hasY = false;
  let hasM = false;
  let hasTime = false;
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === '"') {
      const end = code.indexOf('"', i + 1);
      if (end < 0) break;
      i = end;
    } else if (c === '[') {
      const end = code.indexOf(']', i + 1);
      if (end < 0) break;
      i = end;
    } else if (c === '\\' || c === '_' || c === '*') {
      i++;
    } else {
      const l = c.toLowerCase();
      if (l === 'd') hasD = true;
      else if (l === 'y') hasY = true;
      else if (l === 'm') hasM = true;
      else if (l === 'h' || l === 's') hasTime = true;
    }
  }
  return hasD || hasY || (hasM && !hasTime);
}

function isDateFormat(numFmtId: number, customCodes: Map<number, string>): boolean {
  const custom = customCodes.get(numFmtId);
  if (custom !== undefined) return formatCodeIsDate(custom);
  return BUILTIN_DATE_IDS.has(numFmtId);
}

// ------------------------------------------------------------ cell refs ---

export function columnLetters(index0: number): string {
  let n = index0 + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function parseCellRef(ref: string): { col: number; row: number } | null {
  let i = 0;
  let col = 0;
  while (i < ref.length) {
    const c = ref.charCodeAt(i);
    const up = c >= 0x61 && c <= 0x7a ? c - 32 : c;
    if (up < 0x41 || up > 0x5a) break;
    col = col * 26 + (up - 64);
    i++;
    if (col > MAX_COLUMNS) return null;
  }
  if (i === 0 || i === ref.length) return null;
  let row = 0;
  for (; i < ref.length; i++) {
    const c = ref.charCodeAt(i);
    if (c < 0x30 || c > 0x39) return null;
    row = row * 10 + (c - 0x30);
    if (row > 1_048_576) return null;
  }
  return row >= 1 ? { col: col - 1, row } : null;
}

// ------------------------------------------------------------ zip parts ---

type TextPart = { ok: true; text: string } | { ok: false; problem: Problem };

function readTextPart(zip: OpenedZip, name: string, limits: UploadLimits): TextPart {
  const e = zip.entries.find((x) => x.name === name);
  if (!e) return { ok: false, problem: { code: 'XLSX_PART_MISSING', message: `The workbook has no ${name}.` } };
  if (e.uncompressedSize > limits.maxXmlBytes) {
    return { ok: false, problem: { code: 'XML_TOO_LARGE', message: `${name} is larger than the ${limits.maxXmlBytes}-byte XML limit.` } };
  }
  const r = zip.read(name);
  if (!r.ok) return { ok: false, problem: r.problem };
  try {
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true }).decode(r.bytes) };
  } catch {
    return { ok: false, problem: { code: 'XML_ENCODING_INVALID', message: `${name} is not valid UTF-8 XML.` } };
  }
}

function normalisePartPath(target: string): string {
  const t = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
  const out: string[] = [];
  for (const seg of t.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

interface WorkbookModel {
  date1904: boolean;
  sheets: Array<{ name: string; index: number; state: 'visible' | 'hidden' | 'veryHidden'; path: string | null }>;
}

function loadWorkbook(zip: OpenedZip, limits: UploadLimits, problems: Problem[]): WorkbookModel | null {
  const wb = readTextPart(zip, 'xl/workbook.xml', limits);
  if (!wb.ok) {
    problems.push(wb.problem);
    return null;
  }
  let date1904 = false;
  const raw: Array<{ name: string; state: string; rid: string }> = [];
  problems.push(
    ...scanXml(wb.text, {
      open(name, attrs) {
        if (name === 'workbookPr') date1904 = attrs.date1904 === '1' || attrs.date1904 === 'true';
        else if (name === 'sheet') raw.push({ name: attrs.name ?? '', state: attrs.state ?? 'visible', rid: attrs.id ?? '' });
      },
      close() {},
      text() {},
    }),
  );
  const rels = new Map<string, string>();
  if (zip.has('xl/_rels/workbook.xml.rels')) {
    const rp = readTextPart(zip, 'xl/_rels/workbook.xml.rels', limits);
    if (rp.ok) {
      problems.push(
        ...scanXml(rp.text, {
          open(name, attrs) {
            if (name === 'Relationship' && attrs.Id && attrs.Target) rels.set(attrs.Id, normalisePartPath(attrs.Target));
          },
          close() {},
          text() {},
        }),
      );
    } else problems.push(rp.problem);
  }
  const sheets = raw.map((s, index) => ({
    name: s.name,
    index,
    state: (s.state === 'hidden' ? 'hidden' : s.state === 'veryHidden' ? 'veryHidden' : 'visible') as
      | 'visible'
      | 'hidden'
      | 'veryHidden',
    path: rels.get(s.rid) ?? (rels.size === 0 ? `xl/worksheets/sheet${index + 1}.xml` : null),
  }));
  const seen = new Set<string>();
  for (const s of sheets) {
    const k = s.name.toLowerCase();
    if (seen.has(k)) problems.push({ code: 'SHEET_NAME_DUPLICATE', message: `The workbook has two sheets named "${s.name}".` });
    seen.add(k);
  }
  return { date1904, sheets };
}

function loadSharedStrings(zip: OpenedZip, limits: UploadLimits, problems: Problem[]): string[] {
  if (!zip.has('xl/sharedStrings.xml')) return [];
  const part = readTextPart(zip, 'xl/sharedStrings.xml', limits);
  if (!part.ok) {
    problems.push(part.problem);
    return [];
  }
  const strings: string[] = [];
  let cur = '';
  let inT = false;
  let rPh = 0;
  problems.push(
    ...scanXml(part.text, {
      open(name) {
        if (name === 'si') cur = '';
        else if (name === 't') inT = true;
        else if (name === 'rPh') rPh++;
      },
      close(name) {
        if (name === 'si') strings.push(cur);
        else if (name === 't') inT = false;
        else if (name === 'rPh') rPh--;
      },
      text(t) {
        if (inT && rPh === 0) cur += t;
      },
    }),
  );
  return strings;
}

function loadDateStyles(zip: OpenedZip, limits: UploadLimits, problems: Problem[]): boolean[] {
  if (!zip.has('xl/styles.xml')) return [];
  const part = readTextPart(zip, 'xl/styles.xml', limits);
  if (!part.ok) {
    problems.push(part.problem);
    return [];
  }
  const custom = new Map<number, string>();
  const xfIds: number[] = [];
  let inCellXfs = false;
  problems.push(
    ...scanXml(part.text, {
      open(name, attrs) {
        if (name === 'numFmt' && attrs.numFmtId !== undefined) custom.set(Number(attrs.numFmtId), attrs.formatCode ?? '');
        else if (name === 'cellXfs') inCellXfs = true;
        else if (name === 'xf' && inCellXfs) xfIds.push(Number(attrs.numFmtId ?? 0));
      },
      close(name) {
        if (name === 'cellXfs') inCellXfs = false;
      },
      text() {},
    }),
  );
  return xfIds.map((id) => isDateFormat(id, custom));
}

// ----------------------------------------------------------- public API ---

export function listWorkbookSheets(
  bytes: Uint8Array,
  limitsIn?: Partial<UploadLimits>,
): { sheets: SheetInfo[]; date1904: boolean; problems: Problem[] } {
  const limits = resolveLimits(limitsIn);
  const problems: Problem[] = [];
  try {
    const zip = openZip(bytes, limits);
    if (!zip.ok) return { sheets: [], date1904: false, problems: zip.problems };
    const wb = loadWorkbook(zip, limits, problems);
    if (!wb) return { sheets: [], date1904: false, problems };
    const sheets: SheetInfo[] = wb.sheets.map((s) => {
      let rowCount: number | null = null;
      if (s.path && zip.has(s.path)) {
        const part = readTextPart(zip, s.path, limits);
        if (part.ok) {
          const at = part.text.indexOf('<dimension');
          if (at >= 0) {
            const q = part.text.indexOf('ref="', at);
            const end = q >= 0 ? part.text.indexOf('"', q + 5) : -1;
            if (q >= 0 && end > q) {
              const [a, b] = part.text.slice(q + 5, end).split(':');
              const ra = parseCellRef(a ?? '');
              const rb = parseCellRef(b ?? a ?? '');
              if (ra && rb) rowCount = rb.row - ra.row + 1;
            }
          }
        }
      }
      return { name: s.name, index: s.index, state: s.state, rowCount };
    });
    return { sheets, date1904: wb.date1904, problems };
  } catch {
    return { sheets: [], date1904: false, problems: [{ code: 'XLSX_READ_FAILED', message: 'The workbook could not be read safely.' }] };
  }
}

function emptyResult(
  sheetName: string,
  headerRow: number,
  date1904: boolean,
  available: string[],
  problems: Problem[],
): WorksheetResult {
  return {
    sheetName,
    date1904,
    headerRow,
    header: [],
    rows: [],
    formulaCells: [],
    hiddenRowNumbers: [],
    disclosure: {
      sheetsAvailable: available,
      sheetProcessed: sheetName,
      rowsProcessed: 0,
      hiddenRowsSkipped: [],
      hiddenRowsIncluded: [],
      otherSheetsNotProcessed: available.filter((n) => n !== sheetName),
      hiddenSheetNames: [],
      processedSheetState: 'visible',
    },
    problems,
  };
}

export function readWorksheet(bytes: Uint8Array, sheetName: string, opts: ReadWorksheetOptions = {}): WorksheetResult {
  const limits = resolveLimits(opts.limits);
  const headerRow = opts.headerRow ?? 1;
  const includeHidden = opts.includeHiddenRows === true;
  const problems: Problem[] = [];
  try {
    if (!Number.isInteger(headerRow) || headerRow < 1) {
      return emptyResult(sheetName ?? '', 1, false, [], [{ code: 'HEADER_ROW_INVALID', message: 'The header row must be a whole number of 1 or more.' }]);
    }
    const zip = openZip(bytes, limits);
    if (!zip.ok) return emptyResult(sheetName ?? '', headerRow, false, [], zip.problems);
    const wb = loadWorkbook(zip, limits, problems);
    if (!wb) return emptyResult(sheetName ?? '', headerRow, false, [], problems);
    const available = wb.sheets.map((s) => s.name);
    if (!sheetName) {
      problems.push({
        code: 'SHEET_NAME_REQUIRED',
        message: `Choose the sheet to process explicitly. Available sheets: ${available.join(', ') || '(none)'}.`,
      });
      return emptyResult('', headerRow, wb.date1904, available, problems);
    }
    const sheet = wb.sheets.find((s) => s.name === sheetName);
    if (!sheet) {
      problems.push({
        code: 'SHEET_NOT_FOUND',
        message: `The workbook has no sheet named "${sheetName.slice(0, 60)}". Available sheets: ${available.join(', ') || '(none)'}.`,
      });
      return emptyResult(sheetName, headerRow, wb.date1904, available, problems);
    }
    const hiddenSheetNames = wb.sheets.filter((s) => s.state !== 'visible').map((s) => s.name);
    if (sheet.state === 'veryHidden') {
      problems.push({
        code: 'SHEET_VERY_HIDDEN',
        message: `The sheet "${sheetName}" is very-hidden (it cannot be seen in Excel) and cannot be processed.`,
      });
    }
    if (!sheet.path || !zip.has(sheet.path)) {
      problems.push({ code: 'SHEET_PART_MISSING', message: `The data for sheet "${sheetName}" is missing from the workbook.` });
    }
    if (problems.length > 0 && problems.some((p) => p.code === 'SHEET_VERY_HIDDEN' || p.code === 'SHEET_PART_MISSING')) {
      return emptyResult(sheetName, headerRow, wb.date1904, available, problems);
    }

    const strings = loadSharedStrings(zip, limits, problems);
    const dateStyles = loadDateStyles(zip, limits, problems);
    const part = readTextPart(zip, sheet.path as string, limits);
    if (!part.ok) {
      problems.push(part.problem);
      return emptyResult(sheetName, headerRow, wb.date1904, available, problems);
    }

    // ---- sheet XML ----
    interface RawRow {
      rowNumber: number;
      hidden: boolean;
      cells: Map<number, XlsxCell>;
    }
    const rawRows: RawRow[] = [];
    const formulaCells: WorksheetResult['formulaCells'] = [];
    const merges: Array<{ r1: number; r2: number; c1: number; c2: number }> = [];

    let lastRowNumber = 0;
    let curRow: RawRow | null = null;
    let keepRow = false;
    let lastCol = -1;
    let rowsSeen = 0;
    let tooMany = false;

    let inC = false;
    let cRef = '';
    let cType = 'n';
    let cStyle = -1;
    let cHasF = false;
    let vText = '';
    let inV = false;
    let isText = '';
    let inIs = false;
    let inIsT = false;
    let isRph = 0;
    let cCol = 0;
    let cRow = 0;
    let badShared = false;

    const finishCell = () => {
      if (!curRow) return;
      let cell: XlsxCell;
      const v = vText;
      switch (cType) {
        case 's': {
          const idx = Number(v);
          if (v.trim() === '' || !Number.isInteger(idx) || idx < 0 || idx >= strings.length) {
            badShared = true;
            cell = { raw: v, kind: 'error' };
          } else cell = { raw: strings[idx], kind: 'string' };
          break;
        }
        case 'inlineStr':
          cell = { raw: isText, kind: 'string' };
          break;
        case 'str':
          cell = { raw: v, kind: 'string' };
          break;
        case 'd':
          cell = { raw: v, kind: 'string' };
          break;
        case 'b':
          cell = { raw: v === '1' || v === 'true' ? 'TRUE' : 'FALSE', kind: 'boolean' };
          break;
        case 'e':
          cell = { raw: v, kind: 'error' };
          break;
        default: {
          if (v.trim() === '') cell = { raw: '', kind: 'empty' };
          else {
            const num = Number(v);
            if (!Number.isFinite(num)) cell = { raw: v, kind: 'error' };
            else {
              const isDate = cStyle >= 0 && dateStyles[cStyle] === true;
              cell = { raw: v.trim(), kind: isDate ? 'date' : 'number', numberValue: num };
            }
          }
        }
      }
      if (cHasF && cRow >= headerRow) formulaCells.push({ ref: cRef || `${columnLetters(cCol)}${cRow}`, column: columnLetters(cCol), rowNumber: cRow });
      if (keepRow) curRow.cells.set(cCol, cell);
    };

    const xmlProblems = scanXml(part.text, {
      open(name, attrs) {
        switch (name) {
          case 'row': {
            const r = attrs.r !== undefined ? Number(attrs.r) : lastRowNumber + 1;
            lastRowNumber = Number.isInteger(r) && r >= 1 ? r : lastRowNumber + 1;
            rowsSeen++;
            lastCol = -1;
            if (rowsSeen > limits.maxRows + headerRow) {
              if (!tooMany) {
                tooMany = true;
                problems.push({
                  code: 'TOO_MANY_ROWS',
                  message: `The sheet has more than ${limits.maxRows} data rows; reading stopped at the limit.`,
                });
              }
              keepRow = false;
              curRow = null;
              return;
            }
            // Only the header row and later rows are retained.
            keepRow = lastRowNumber >= headerRow;
            curRow = { rowNumber: lastRowNumber, hidden: attrs.hidden === '1' || attrs.hidden === 'true', cells: new Map() };
            if (keepRow) rawRows.push(curRow);
            break;
          }
          case 'c': {
            inC = true;
            cRef = attrs.r ?? '';
            const parsed = cRef ? parseCellRef(cRef) : null;
            cCol = parsed ? parsed.col : lastCol + 1;
            cRow = parsed ? parsed.row : lastRowNumber;
            if (cCol > MAX_COLUMNS - 1) cCol = MAX_COLUMNS - 1;
            lastCol = cCol;
            cType = attrs.t ?? 'n';
            cStyle = attrs.s !== undefined ? Number(attrs.s) : -1;
            cHasF = false;
            vText = '';
            isText = '';
            break;
          }
          case 'v':
            if (inC) inV = true;
            break;
          case 'f':
            if (inC) cHasF = true;
            break;
          case 'is':
            if (inC) inIs = true;
            break;
          case 't':
            if (inIs) inIsT = true;
            break;
          case 'rPh':
            if (inIs) isRph++;
            break;
          case 'mergeCell': {
            const [a, b] = (attrs.ref ?? '').split(':');
            const pa = parseCellRef(a ?? '');
            const pb = parseCellRef(b ?? a ?? '');
            if (pa && pb) merges.push({ r1: pa.row, r2: pb.row, c1: pa.col, c2: pb.col });
            break;
          }
          default:
            break;
        }
      },
      close(name) {
        switch (name) {
          case 'c':
            if (inC) finishCell();
            inC = false;
            inV = false;
            inIs = false;
            inIsT = false;
            break;
          case 'v':
            inV = false;
            break;
          case 'is':
            inIs = false;
            break;
          case 't':
            inIsT = false;
            break;
          case 'rPh':
            if (isRph > 0) isRph--;
            break;
          case 'row':
            curRow = null;
            keepRow = false;
            break;
          default:
            break;
        }
      },
      text(t) {
        if (inV) vText += t;
        else if (inIsT && isRph === 0) isText += t;
      },
    });
    problems.push(...xmlProblems);
    if (badShared) {
      problems.push({ code: 'SHARED_STRING_INDEX_INVALID', message: 'A cell refers to a shared string that does not exist.' });
    }

    // ---- merged cells ----
    for (const m of merges) {
      if (m.r1 === m.r2 && m.c1 === m.c2) continue;
      if (m.r2 > headerRow) {
        problems.push({
          code: 'MERGED_CELLS_IN_DATA',
          message: `Merged cells (${columnLetters(m.c1)}${m.r1}:${columnLetters(m.c2)}${m.r2}) overlap the data rows; unmerge them first.`,
        });
      } else if (m.r1 <= headerRow && headerRow <= m.r2 && m.c1 !== m.c2) {
        problems.push({
          code: 'MERGED_HEADER_CELLS',
          message: `The header row has merged cells (${columnLetters(m.c1)}${m.r1}:${columnLetters(m.c2)}${m.r2}); unmerge them first.`,
        });
      }
    }

    // ---- header and data rows ----
    const headerRaw = rawRows.find((r) => r.rowNumber === headerRow);
    let header: string[] = [];
    if (!headerRaw) {
      problems.push({ code: 'HEADER_ROW_MISSING', message: `Row ${headerRow} (the header row) is empty or missing.` });
    } else {
      let last = -1;
      for (const [c, cell] of headerRaw.cells) if (cell.kind !== 'empty' && cell.raw.trim() !== '' && c > last) last = c;
      header = Array.from({ length: last + 1 }, (_, c) => (headerRaw.cells.get(c)?.raw ?? '').trim());
    }

    const dataRaw = rawRows.filter((r) => r.rowNumber > headerRow).sort((a, b) => a.rowNumber - b.rowNumber);
    let width = header.length;
    for (const r of dataRaw) for (const c of r.cells.keys()) if (c + 1 > width) width = c + 1;
    const emptyCell = (): XlsxCell => ({ raw: '', kind: 'empty' });
    const hasContent = (r: RawRow) => [...r.cells.values()].some((c) => c.kind !== 'empty' && c.raw.trim() !== '');

    const hiddenRowNumbers: number[] = [];
    const hiddenSkipped: number[] = [];
    const hiddenIncluded: number[] = [];
    const rows: XlsxRow[] = [];
    for (const r of dataRaw) {
      if (r.hidden && hasContent(r)) {
        hiddenRowNumbers.push(r.rowNumber);
        (includeHidden ? hiddenIncluded : hiddenSkipped).push(r.rowNumber);
      }
      if (r.hidden && !includeHidden) continue;
      rows.push({
        rowNumber: r.rowNumber,
        hidden: r.hidden,
        cells: Array.from({ length: width }, (_, c) => r.cells.get(c) ?? emptyCell()),
      });
    }

    return {
      sheetName,
      date1904: wb.date1904,
      headerRow,
      header,
      rows,
      formulaCells,
      hiddenRowNumbers,
      disclosure: {
        sheetsAvailable: available,
        sheetProcessed: sheetName,
        rowsProcessed: rows.length,
        hiddenRowsSkipped: hiddenSkipped,
        hiddenRowsIncluded: hiddenIncluded,
        otherSheetsNotProcessed: available.filter((n) => n !== sheetName),
        hiddenSheetNames,
        processedSheetState: sheet.state,
      },
      problems,
    };
  } catch {
    return emptyResult(sheetName ?? '', headerRow, false, [], [
      { code: 'XLSX_READ_FAILED', message: 'The workbook could not be read safely.' },
    ]);
  }
}

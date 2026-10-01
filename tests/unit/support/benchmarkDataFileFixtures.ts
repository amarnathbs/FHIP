// TEST-ONLY helpers: a tiny ZIP writer and a minimal XLSX builder so the
// benchmark file-ingest tests can build every binary fixture (valid workbooks,
// zip bombs, lying headers, macro workbooks, ...) programmatically. Nothing
// here is used by production code.
import { deflateRawSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

export interface ZipEntrySpec {
  name: string;
  data: Uint8Array | string;
  method?: 0 | 8;
  /** Lie in the central directory / local header about the uncompressed size. */
  declaredUncompressedSize?: number;
  /** Use these bytes verbatim as the compressed stream (for crafted entries). */
  rawCompressed?: Uint8Array;
  /** General-purpose flag bits (e.g. 1 = encrypted). */
  flags?: number;
  /** Local header name that differs from the central directory name. */
  localName?: string;
  /** Force a method code in the headers (e.g. 12 = bzip2) without compressing differently. */
  methodCodeOverride?: number;
}

export interface ZipBuildOptions {
  /** Override the total-entries field of the end-of-central-directory record. */
  eocdTotalEntries?: number;
  /** Put the central-directory entries' local offsets to this value (overlap / bad pointer tests). */
  forceLocalOffset?: (index: number, real: number) => number;
  /** Insert a ZIP64 end-of-central-directory locator before the EOCD. */
  zip64Locator?: boolean;
}

function w16(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff];
}
function w32(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}

export function buildZip(entries: ZipEntrySpec[], opts: ZipBuildOptions = {}): Uint8Array {
  const chunks: number[][] = [];
  const central: number[][] = [];
  let offset = 0;
  const bytesOut: Uint8Array[] = [];
  const emit = (b: Uint8Array | number[]) => {
    const u = b instanceof Uint8Array ? b : Uint8Array.from(b);
    bytesOut.push(u);
    offset += u.length;
  };
  void chunks;
  entries.forEach((e, index) => {
    const nameBytes = utf8(e.name);
    const data = typeof e.data === 'string' ? utf8(e.data) : e.data;
    const method = e.method ?? 8;
    const comp = e.rawCompressed ?? (method === 8 ? new Uint8Array(deflateRawSync(data)) : data);
    const declared = e.declaredUncompressedSize ?? data.length;
    const flags = e.flags ?? 0;
    const methodCode = e.methodCodeOverride ?? method;
    const crc = crc32(data);
    const localOffset = offset;
    const lName = e.localName !== undefined ? utf8(e.localName) : nameBytes;
    emit([...w32(0x04034b50), ...w16(20), ...w16(flags), ...w16(methodCode), ...w16(0), ...w16(0x21), ...w32(crc), ...w32(comp.length), ...w32(declared), ...w16(lName.length), ...w16(0)]);
    emit(lName);
    emit(comp);
    const real = localOffset;
    central.push([
      ...w32(0x02014b50),
      ...w16(20),
      ...w16(20),
      ...w16(flags),
      ...w16(methodCode),
      ...w16(0),
      ...w16(0x21),
      ...w32(crc),
      ...w32(comp.length),
      ...w32(declared),
      ...w16(nameBytes.length),
      ...w16(0),
      ...w16(0),
      ...w16(0),
      ...w16(0),
      ...w32(0),
      ...w32(opts.forceLocalOffset ? opts.forceLocalOffset(index, real) : real),
      ...Array.from(nameBytes),
    ]);
  });
  const cdStart = offset;
  for (const c of central) emit(c);
  const cdSize = offset - cdStart;
  if (opts.zip64Locator) emit([...w32(0x07064b50), ...w32(0), ...w32(0), ...w32(0), ...w32(1)].slice(0, 20));
  emit([...w32(0x06054b50), ...w16(0), ...w16(0), ...w16(entries.length), ...w16(opts.eocdTotalEntries ?? entries.length), ...w32(cdSize), ...w32(cdStart), ...w16(0)]);
  const total = bytesOut.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const b of bytesOut) {
    out.set(b, p);
    p += b.length;
  }
  return out;
}

// ------------------------------------------------------------- XLSX ---

export type CellSpec =
  | string
  | number
  | null
  | { date: number; style?: 1 | 2 | 6 }
  | { formula: string; value?: number | string }
  | { bool: boolean }
  | { error: string }
  | { inline: string }
  | { rich: string[] }
  | { num: number; style?: number };

export interface SheetSpec {
  name: string;
  state?: 'hidden' | 'veryHidden';
  /** rows[0] is sheet row `firstRow` (default 1). A null row leaves a gap (sparse). */
  rows: Array<CellSpec[] | null>;
  firstRow?: number;
  hiddenRows?: number[];
  merges?: string[];
  dimension?: string;
}

export interface XlsxSpec {
  sheets: SheetSpec[];
  date1904?: boolean;
  vba?: boolean;
  macroContentType?: boolean;
  /** Entries added or REPLACED by name (use to craft hostile XML). */
  extraEntries?: ZipEntrySpec[];
  omitSharedStrings?: boolean;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function colLetters(i: number): string {
  let n = i + 1;
  let s = '';
  while (n > 0) {
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

const STYLES_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<numFmts count="4">' +
  '<numFmt numFmtId="164" formatCode="dd\\-mmm\\-yy"/>' +
  '<numFmt numFmtId="165" formatCode="&quot;day &quot;0.00"/>' +
  '<numFmt numFmtId="166" formatCode="[Red]0.0"/>' +
  '<numFmt numFmtId="167" formatCode="yyyy\\-mm\\-dd"/>' +
  '</numFmts>' +
  '<cellStyleXfs count="1"><xf numFmtId="14"/></cellStyleXfs>' +
  '<cellXfs count="8">' +
  '<xf numFmtId="0"/>' + // 0 General
  '<xf numFmtId="14"/>' + // 1 built-in date
  '<xf numFmtId="164"/>' + // 2 custom date dd-mmm-yy
  '<xf numFmtId="165"/>' + // 3 custom NOT a date ("day " in quotes)
  '<xf numFmtId="2"/>' + // 4 0.00
  '<xf numFmtId="166"/>' + // 5 [Red]0.0
  '<xf numFmtId="167"/>' + // 6 custom date yyyy-mm-dd
  '<xf numFmtId="0"/>' + // 7 General
  '</cellXfs></styleSheet>';

export function buildXlsx(spec: XlsxSpec): Uint8Array {
  const shared: string[] = [];
  const sharedXml: string[] = [];
  const sharedIndex = new Map<string, number>();
  const addShared = (xml: string, key: string): number => {
    const hit = sharedIndex.get(key);
    if (hit !== undefined) return hit;
    shared.push(key);
    sharedXml.push(xml);
    sharedIndex.set(key, shared.length - 1);
    return shared.length - 1;
  };

  const sheetXmls = spec.sheets.map((sheet) => {
    const first = sheet.firstRow ?? 1;
    const rowsXml: string[] = [];
    sheet.rows.forEach((cells, ri) => {
      if (cells === null) return;
      const rowNo = first + ri;
      const hidden = sheet.hiddenRows?.includes(rowNo) ? ' hidden="1"' : '';
      const cs: string[] = [];
      cells.forEach((c, ci) => {
        if (c === null) return;
        const ref = `${colLetters(ci)}${rowNo}`;
        if (typeof c === 'string') {
          const idx = addShared(`<si><t xml:space="preserve">${esc(c)}</t></si>`, `s:${c}`);
          cs.push(`<c r="${ref}" t="s"><v>${idx}</v></c>`);
        } else if (typeof c === 'number') cs.push(`<c r="${ref}"><v>${c}</v></c>`);
        else if ('date' in c) cs.push(`<c r="${ref}" s="${c.style ?? 1}"><v>${c.date}</v></c>`);
        else if ('formula' in c) {
          if (typeof c.value === 'string') cs.push(`<c r="${ref}" t="str"><f>${esc(c.formula)}</f><v>${esc(c.value)}</v></c>`);
          else cs.push(`<c r="${ref}"><f>${esc(c.formula)}</f>${c.value !== undefined ? `<v>${c.value}</v>` : ''}</c>`);
        } else if ('bool' in c) cs.push(`<c r="${ref}" t="b"><v>${c.bool ? 1 : 0}</v></c>`);
        else if ('error' in c) cs.push(`<c r="${ref}" t="e"><v>${esc(c.error)}</v></c>`);
        else if ('inline' in c) cs.push(`<c r="${ref}" t="inlineStr"><is><t>${esc(c.inline)}</t></is></c>`);
        else if ('rich' in c) {
          const xml = `<si>${c.rich.map((p) => `<r><t>${esc(p)}</t></r>`).join('')}<rPh sb="0" eb="1"><t>PHONETIC</t></rPh></si>`;
          const idx = addShared(xml, `r:${c.rich.join('|')}`);
          cs.push(`<c r="${ref}" t="s"><v>${idx}</v></c>`);
        } else cs.push(`<c r="${ref}" s="${c.style ?? 0}"><v>${c.num}</v></c>`);
      });
      rowsXml.push(`<row r="${rowNo}"${hidden}>${cs.join('')}</row>`);
    });
    // hidden rows that carry no cell data still need a <row> element
    const merges = sheet.merges?.length
      ? `<mergeCells count="${sheet.merges.length}">${sheet.merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>`
      : '';
    return (
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      (sheet.dimension ? `<dimension ref="${sheet.dimension}"/>` : '') +
      `<sheetData>${rowsXml.join('')}</sheetData>${merges}</worksheet>`
    );
  });

  const workbookXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<workbookPr${spec.date1904 ? ' date1904="1"' : ''}/>` +
    '<sheets>' +
    spec.sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}"${s.state ? ` state="${s.state}"` : ''} r:id="rId${i + 1}"/>`).join('') +
    '</sheets></workbook>';
  const relsXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    spec.sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
    '</Relationships>';
  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.${spec.macroContentType ? 'sheet.macroEnabled.main+xml' : 'sheet.main+xml'}"/>` +
    '</Types>';

  const entries = new Map<string, ZipEntrySpec>();
  const add = (name: string, data: string | Uint8Array) => entries.set(name, { name, data });
  add('[Content_Types].xml', contentTypes);
  add('xl/workbook.xml', workbookXml);
  add('xl/_rels/workbook.xml.rels', relsXml);
  add('xl/styles.xml', STYLES_XML);
  if (!spec.omitSharedStrings) {
    add('xl/sharedStrings.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">${sharedXml.join('')}</sst>`);
  }
  sheetXmls.forEach((x, i) => add(`xl/worksheets/sheet${i + 1}.xml`, x));
  if (spec.vba) add('xl/vbaProject.bin', new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3, 4]));
  for (const e of spec.extraEntries ?? []) entries.set(e.name, e);
  return buildZip([...entries.values()]);
}

/** A typical clean two-column sheet: header + `rows` of [date text, value]. */
export function simpleSheet(name: string, header: string[], rows: CellSpec[][], extra: Partial<SheetSpec> = {}): SheetSpec {
  return { name, rows: [header, ...rows], ...extra };
}

/** A stored (method 0) local file header + data, for crafting overlapping-entry archives. */
export function storedLocalRecord(name: string, data: string): Uint8Array {
  const n = utf8(name);
  const d = utf8(data);
  return Uint8Array.from([
    ...w32(0x04034b50), ...w16(20), ...w16(0), ...w16(0), ...w16(0), ...w16(0x21),
    ...w32(crc32(d)), ...w32(d.length), ...w32(d.length), ...w16(n.length), ...w16(0),
    ...Array.from(n), ...Array.from(d),
  ]);
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// Minimal ZIP writer for building HOSTILE test archives (zip bombs, lying headers, doctype sheets).
// Test support only. Stored (0) or deflate (8); optional lying declared sizes.

import { crc32, deflateRawSync } from 'node:zlib';

export interface ZipEntrySpec {
  name: string;
  data: Uint8Array | string;
  method?: 0 | 8;
  /** Override the declared uncompressed size (a lying header). */
  declaredSize?: number;
  /** Override the declared compressed size. */
  declaredCompressed?: number;
}

function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
}
function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
}

export function zipOf(entries: ZipEntrySpec[]): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const raw = Buffer.from(typeof e.data === 'string' ? Buffer.from(e.data, 'utf8') : e.data);
    const method = e.method ?? 8;
    const comp = method === 8 ? deflateRawSync(raw) : raw;
    const crc = crc32(raw);
    const name = Buffer.from(e.name, 'utf8');
    const declU = e.declaredSize ?? raw.length;
    const declC = e.declaredCompressed ?? comp.length;
    const local = Buffer.concat([u32(0x04034b50), u16(20), u16(0x0800), u16(method), u16(0), u16(0x21), u32(crc), u32(declC), u32(declU), u16(name.length), u16(0), name, comp]);
    const central = Buffer.concat([u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(method), u16(0), u16(0x21), u32(crc), u32(declC), u32(declU), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name]);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(cd.length), u32(offset), u16(0)]);
  return new Uint8Array(Buffer.concat([...locals, cd, eocd]));
}

/** A structurally plausible xlsx container (content types + workbook + one sheet) that the caller can poison. */
export function minimalXlsxZip(opts: { sheetXml?: string; workbookXml?: string; contentTypes?: string; extra?: ZipEntrySpec[] } = {}): Uint8Array {
  const contentTypes =
    opts.contentTypes ??
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>';
  const workbook =
    opts.workbookXml ??
    '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Article_Upload" sheetId="1" r:id="rId1"/></sheets></workbook>';
  const rels = '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="x" Target="worksheets/sheet1.xml"/></Relationships>';
  const sheet = opts.sheetXml ?? '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>';
  return zipOf([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: rels },
    { name: 'xl/worksheets/sheet1.xml', data: sheet },
    ...(opts.extra ?? []),
  ]);
}

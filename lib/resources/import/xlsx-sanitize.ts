// Resources Bulk Upload -- makes our GENERATED templates pass the shared ingest inspector unchanged.
//
// The shared inspector refuses a workbook whose [Content_Types].xml merely contains the text "macroEnabled". The
// library that WRITES our templates (SheetJS, write path only) always emits a Default mapping for the .bin extension
// whose content type contains that text, although the workbook has no .bin part at all and no macro. That mapping is
// unused (an Open Packaging Convention default for an extension nobody uses), so removing it changes nothing about the
// workbook's content or how Excel opens it, and the file then passes the shared inspector with NO local override.
//
// Only that one unused Default is removed, and only when the package contains no .bin part. Everything else is
// copied entry for entry.

import { crc32, deflateRawSync } from 'node:zlib';
import { readZipEntries } from '@/lib/services/investment-intelligence/benchmarkData/fileIngest';

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

function zipEntries(entries: { name: string; data: Uint8Array }[]): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const raw = Buffer.from(e.data);
    const comp = deflateRawSync(raw);
    const crc = crc32(raw);
    const name = Buffer.from(e.name, 'utf8');
    const local = Buffer.concat([u32(0x04034b50), u16(20), u16(0x0800), u16(8), u16(0), u16(0x21), u32(crc), u32(comp.length), u32(raw.length), u16(name.length), u16(0), name, comp]);
    const central = Buffer.concat([u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(8), u16(0), u16(0x21), u32(crc), u32(comp.length), u32(raw.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name]);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(cd.length), u32(offset), u16(0)]);
  return new Uint8Array(Buffer.concat([...locals, cd, eocd]));
}

/** Removes the unused .bin Default content type (see header). Returns the input unchanged if there is nothing to remove. */
export function stripUnusedBinContentType(bytes: Uint8Array): Uint8Array {
  const map = readZipEntries(bytes);
  const ct = map.get('[Content_Types].xml');
  if (!ct) return bytes;
  const hasBinPart = [...map.keys()].some((k) => k.toLowerCase().endsWith('.bin'));
  const text = new TextDecoder().decode(ct);
  const next = hasBinPart ? text : text.replace(/<Default\b[^>]*\bExtension="bin"[^>]*\/>/gi, '');
  if (next === text) return bytes;
  const ordered = [...map.entries()].map(([name, data]) => ({ name, data: name === '[Content_Types].xml' ? new TextEncoder().encode(next) : data }));
  ordered.sort((a, b) => (a.name === '[Content_Types].xml' ? -1 : b.name === '[Content_Types].xml' ? 1 : 0));
  return zipEntries(ordered);
}

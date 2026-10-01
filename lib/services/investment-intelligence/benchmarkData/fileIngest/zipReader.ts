// Minimal, strict ZIP reader used for XLSX containers. PURE and hostile-input
// safe: it parses the central directory itself, checks every limit BEFORE any
// inflation, and enforces the declared size again AT inflate time
// (`maxOutputLength`) so a lying header cannot expand past what it declared.
//
// Supported: stored (0) and deflate (8) only. Rejected: encrypted entries,
// zip64, multi-disk archives, path traversal names, duplicate names,
// overlapping or inconsistent local headers, and implausible compression.
import { inflateRawSync } from 'node:zlib';
import { resolveLimits, type Problem, type UploadLimits } from './types';

const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const EOCD_MIN = 22;
const MAX_COMMENT = 0xffff;
/** Ratio is only meaningful above this size; tiny entries can legitimately compress very well. */
const RATIO_MIN_BYTES = 4096;

export interface ZipEntryInfo {
  name: string;
  method: 0 | 8;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
  dataStart: number;
}

export interface OpenedZip {
  ok: boolean;
  problems: Problem[];
  entries: ZipEntryInfo[];
  has(name: string): boolean;
  /** Inflates one entry, enforcing its declared size at inflate time. */
  read(name: string): { ok: true; bytes: Uint8Array } | { ok: false; problem: Problem };
}

export class ZipReadError extends Error {
  readonly problems: Problem[];
  constructor(problems: Problem[]) {
    super(problems.map((p) => `${p.code}: ${p.message}`).join('; '));
    this.name = 'ZipReadError';
    this.problems = problems;
  }
}

function u16(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8);
}
function u32(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

function decodeName(raw: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    let s = '';
    for (const c of raw) s += String.fromCharCode(c);
    return s;
  }
}

function unsafeName(name: string): boolean {
  if (name.length === 0 || name.includes('\0') || name.includes('\\')) return true;
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) return true;
  for (const seg of name.split('/')) {
    if (seg === '..') return true;
  }
  return false;
}

function failed(problems: Problem[]): OpenedZip {
  return {
    ok: false,
    problems,
    entries: [],
    has: () => false,
    read: () => ({ ok: false, problem: problems[0] ?? { code: 'ZIP_INVALID', message: 'The archive is not valid.' } }),
  };
}

export function openZip(bytes: Uint8Array, limitsIn?: Partial<UploadLimits>): OpenedZip {
  const limits = resolveLimits(limitsIn);
  const bad = (code: string, message: string) => failed([{ code, message }]);

  if (bytes.length < EOCD_MIN) return bad('ZIP_INVALID', 'The file is too short to be a ZIP archive.');
  if (u32(bytes, 0) !== SIG_LOCAL) return bad('ZIP_INVALID', 'The file does not start with a ZIP header.');

  // End-of-central-directory record: scan backwards (bounded by the maximum comment length).
  let eocd = -1;
  const lowest = Math.max(0, bytes.length - EOCD_MIN - MAX_COMMENT);
  for (let i = bytes.length - EOCD_MIN; i >= lowest; i--) {
    if (u32(bytes, i) === SIG_EOCD && i + EOCD_MIN + u16(bytes, i + 20) === bytes.length) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return bad('ZIP_INVALID', 'The ZIP end-of-archive record was not found.');
  if (eocd >= 20 && u32(bytes, eocd - 20) === SIG_ZIP64_LOCATOR) {
    return bad('ZIP_BOMB_ZIP64_UNSUPPORTED', 'ZIP64 archives are not accepted.');
  }
  const diskNo = u16(bytes, eocd + 4);
  const cdDisk = u16(bytes, eocd + 6);
  const entriesOnDisk = u16(bytes, eocd + 8);
  const totalEntries = u16(bytes, eocd + 10);
  const cdSize = u32(bytes, eocd + 12);
  const cdOffset = u32(bytes, eocd + 16);
  if (totalEntries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    return bad('ZIP_BOMB_ZIP64_UNSUPPORTED', 'ZIP64 archives are not accepted.');
  }
  if (diskNo !== 0 || cdDisk !== 0 || entriesOnDisk !== totalEntries) {
    return bad('ZIP_INVALID', 'Multi-disk ZIP archives are not accepted.');
  }
  if (totalEntries > limits.maxZipEntries) {
    return bad(
      'ZIP_BOMB_TOO_MANY_ENTRIES',
      `The archive lists ${totalEntries} entries; the limit is ${limits.maxZipEntries}.`,
    );
  }
  if (cdOffset + cdSize > eocd || cdOffset > bytes.length) {
    return bad('ZIP_INVALID', 'The ZIP central directory lies outside the file.');
  }

  const entries: ZipEntryInfo[] = [];
  const names = new Set<string>();
  const problems: Problem[] = [];
  let pos = cdOffset;
  let totalUncompressed = 0;
  let totalCompressed = 0;
  for (let n = 0; n < totalEntries; n++) {
    if (pos + 46 > cdOffset + cdSize || u32(bytes, pos) !== SIG_CENTRAL) {
      return bad('ZIP_INVALID', 'The ZIP central directory is damaged.');
    }
    const flags = u16(bytes, pos + 8);
    const method = u16(bytes, pos + 10);
    const compressedSize = u32(bytes, pos + 20);
    const uncompressedSize = u32(bytes, pos + 24);
    const nameLen = u16(bytes, pos + 28);
    const extraLen = u16(bytes, pos + 30);
    const commentLen = u16(bytes, pos + 32);
    const localOffset = u32(bytes, pos + 42);
    const next = pos + 46 + nameLen + extraLen + commentLen;
    if (next > cdOffset + cdSize) return bad('ZIP_INVALID', 'The ZIP central directory is damaged.');
    const name = decodeName(bytes.subarray(pos + 46, pos + 46 + nameLen));
    pos = next;

    if (unsafeName(name)) {
      return bad('ZIP_PATH_TRAVERSAL', `The archive contains an unsafe entry name (${name.slice(0, 80)}).`);
    }
    if (names.has(name)) return bad('ZIP_DUPLICATE_ENTRY', `The archive lists "${name.slice(0, 80)}" more than once.`);
    names.add(name);
    if ((flags & 0x1) !== 0 || (flags & 0x40) !== 0) {
      return bad('ZIP_ENCRYPTED', 'The archive contains an encrypted entry.');
    }
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      return bad('ZIP_BOMB_ZIP64_UNSUPPORTED', 'ZIP64 entries are not accepted.');
    }
    if (method !== 0 && method !== 8) {
      return bad('ZIP_UNSUPPORTED_METHOD', `The archive uses an unsupported compression method (${method}).`);
    }
    if (name.endsWith('/')) {
      // Directory entry: must carry no data.
      if (uncompressedSize !== 0) return bad('ZIP_INVALID', 'A directory entry carries data.');
      continue;
    }
    if (uncompressedSize > limits.maxZipEntryBytes) {
      return bad(
        'ZIP_BOMB_ENTRY_TOO_LARGE',
        `The archive entry "${name.slice(0, 80)}" would expand to ${uncompressedSize} bytes; the limit is ${limits.maxZipEntryBytes}.`,
      );
    }
    totalUncompressed += uncompressedSize;
    totalCompressed += compressedSize;
    if (totalUncompressed > limits.maxZipUncompressedBytes) {
      return bad(
        'ZIP_BOMB_TOTAL_TOO_LARGE',
        `The archive would expand to more than ${limits.maxZipUncompressedBytes} bytes in total.`,
      );
    }
    if (uncompressedSize > RATIO_MIN_BYTES && uncompressedSize / Math.max(compressedSize, 1) > limits.maxZipRatio) {
      return bad(
        'ZIP_BOMB_RATIO',
        `The archive entry "${name.slice(0, 80)}" has a suspicious compression ratio (limit ${limits.maxZipRatio}:1).`,
      );
    }
    if (method === 0 && compressedSize !== uncompressedSize) {
      return bad('ZIP_BOMB_SIZE_MISMATCH', 'A stored entry declares inconsistent sizes.');
    }

    // Local header consistency.
    if (localOffset + 30 > cdOffset || u32(bytes, localOffset) !== SIG_LOCAL) {
      return bad('ZIP_INCONSISTENT_HEADER', 'An entry points at an invalid local header.');
    }
    const lNameLen = u16(bytes, localOffset + 26);
    const lExtraLen = u16(bytes, localOffset + 28);
    const lMethod = u16(bytes, localOffset + 8);
    const lFlags = u16(bytes, localOffset + 6);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const localName = decodeName(bytes.subarray(localOffset + 30, localOffset + 30 + lNameLen));
    if (localName !== name || lMethod !== method || (lFlags & 0x1) !== 0) {
      return bad('ZIP_INCONSISTENT_HEADER', 'An entry local header disagrees with the central directory.');
    }
    if (dataStart + compressedSize > cdOffset) {
      return bad('ZIP_INCONSISTENT_HEADER', 'An entry runs past the start of the central directory.');
    }
    entries.push({ name, method: method as 0 | 8, compressedSize, uncompressedSize, localOffset, dataStart });
  }

  // Aggregate ratio (many medium entries each under the per-entry ratio limit).
  if (totalUncompressed > 1024 * 1024 && totalUncompressed / Math.max(totalCompressed, 1) > limits.maxZipRatio) {
    return bad('ZIP_BOMB_RATIO', `The archive has a suspicious overall compression ratio (limit ${limits.maxZipRatio}:1).`);
  }

  // Overlap check on the raw byte ranges that each entry occupies.
  const ranges = entries
    .map((e) => ({ name: e.name, start: e.localOffset, end: e.dataStart + e.compressedSize }))
    .sort((a, b) => a.start - b.start);
  for (let i = 1; i < ranges.length; i++) {
    if (ranges[i].start < ranges[i - 1].end) {
      return bad('ZIP_OVERLAPPING_ENTRIES', 'Archive entries overlap each other.');
    }
  }

  const byName = new Map(entries.map((e) => [e.name, e] as const));
  return {
    ok: true,
    problems,
    entries,
    has: (name) => byName.has(name),
    read: (name) => {
      const e = byName.get(name);
      if (!e) return { ok: false, problem: { code: 'ZIP_ENTRY_MISSING', message: `The archive has no entry "${name}".` } };
      const raw = bytes.subarray(e.dataStart, e.dataStart + e.compressedSize);
      if (e.method === 0) return { ok: true, bytes: raw };
      try {
        // maxOutputLength = the DECLARED size: a lying header cannot expand further.
        const out = inflateRawSync(raw, { maxOutputLength: Math.max(e.uncompressedSize, 1) });
        if (out.length !== e.uncompressedSize) {
          return {
            ok: false,
            problem: {
              code: 'ZIP_BOMB_SIZE_MISMATCH',
              message: `The archive entry "${name.slice(0, 80)}" does not match its declared size.`,
            },
          };
        }
        return { ok: true, bytes: new Uint8Array(out.buffer, out.byteOffset, out.length) };
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        const tooBig = code === 'ERR_BUFFER_TOO_LARGE' || err instanceof RangeError;
        return {
          ok: false,
          problem: tooBig
            ? {
                code: 'ZIP_BOMB_SIZE_MISMATCH',
                message: `The archive entry "${name.slice(0, 80)}" expands beyond its declared size.`,
              }
            : { code: 'ZIP_CORRUPT', message: `The archive entry "${name.slice(0, 80)}" could not be decompressed.` },
        };
      }
    },
  };
}

/**
 * Eagerly reads and inflates every entry (same defences as {@link openZip}).
 * Throws {@link ZipReadError} (never raw errors) when the archive is unsafe or
 * damaged; use {@link tryReadZipEntries} for a non-throwing form.
 */
export function readZipEntries(bytes: Uint8Array, limits?: Partial<UploadLimits>): Map<string, Uint8Array> {
  const r = tryReadZipEntries(bytes, limits);
  if (!r.ok) throw new ZipReadError(r.problems);
  return r.entries;
}

export function tryReadZipEntries(
  bytes: Uint8Array,
  limits?: Partial<UploadLimits>,
): { ok: true; entries: Map<string, Uint8Array>; problems: Problem[] } | { ok: false; problems: Problem[] } {
  const zip = openZip(bytes, limits);
  if (!zip.ok) return { ok: false, problems: zip.problems };
  const out = new Map<string, Uint8Array>();
  for (const e of zip.entries) {
    const r = zip.read(e.name);
    if (!r.ok) return { ok: false, problems: [r.problem] };
    out.set(e.name, r.bytes);
  }
  return { ok: true, entries: out, problems: [] };
}

// Turn a fetched public fund document into text, entirely in-process. Server-side only.
//
// PDF: `pdf-parse` (already a dependency, already used by the AIE / FDH-5 / R2 extractors and therefore already
// proven in the Node / Amplify runtime). No new library, no native binary, no network call. Only the FIRST pages
// are read: a benchmark is stated on the cover / key-information pages. A password-protected or unreadable PDF is
// reported, never retried or guessed at.
// HTML: tags stripped with a small deterministic function (no DOM, no script execution).
//
// The checksum is the SHA-256 of the exact bytes fetched, recorded with every observation.

import { createHash } from 'node:crypto';
import { PDFParse, PasswordException } from 'pdf-parse';
import { DeadlineExceededError, deadlineBudget } from '@/lib/shared/withDeadline';
import { FACTSHEET_DEFAULTS } from './types';

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export type DocumentKind = 'pdf' | 'html' | 'text';

export type DocumentTextResult =
  | { ok: true; text: string; kind: DocumentKind; pagesRead: number; totalPages: number | null }
  | { ok: false; kind: 'password_protected' | 'corrupt' | 'timeout' | 'insufficient_text' | 'unsupported_type'; message: string };

export function looksLikePdf(bytes: Uint8Array): boolean {
  const head = Buffer.from(bytes.subarray(0, 1024)).toString('latin1');
  return head.includes('%PDF-');
}

export function looksLikeHtml(bytes: Uint8Array): boolean {
  const head = Buffer.from(bytes.subarray(0, 512)).toString('utf8').trimStart().toLowerCase();
  return /^<(?:!doctype html|html|head|body|title|meta|div|table)\b/.test(head);
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—' };

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\s*(?:br|\/p|\/div|\/tr|\/li|\/h[1-6]|\/table)\b[^>]*>/gi, '\n')
    .replace(/<\s*\/t[dh]\b[^>]*>/gi, '\t')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code < 0x10ffff ? String.fromCodePoint(code) : ' ';
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    // Keep a tab between table cells (a "Benchmark<TAB>value" row is a label the pattern pass reads); collapse other runs of spaces.
    .replace(/ +/g, ' ')
    .replace(/ ?\t ?/g, '\t')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

const MIN_TOTAL_CHARS = 80;

export async function extractPdfTextFirstPages(bytes: Uint8Array, opts: { maxPages?: number; timeoutMs?: number } = {}): Promise<DocumentTextResult> {
  let parser: PDFParse | null = null;
  let timedOut = false;
  const budget = deadlineBudget(opts.timeoutMs ?? FACTSHEET_DEFAULTS.pdfTimeoutMs);
  try {
    parser = new PDFParse({ data: bytes });
    const info = await budget.run(parser.getInfo(), 'PDF info');
    const totalPages = info.total ?? 0;
    const maxPages = opts.maxPages ?? FACTSHEET_DEFAULTS.maxPdfPages;
    const result = await budget.run(parser.getText({ first: Math.min(Math.max(totalPages, 1), maxPages) }), 'PDF text');
    const pages = (result.pages ?? []).map((p) =>
      p.text
        .split('\n')
        .filter((line) => !/^--\s*\d+\s+of\s+\d+\s*--$/.test(line.trim()))
        .join('\n')
    );
    const text = pages.join('\n');
    if (text.trim().length < MIN_TOTAL_CHARS) return { ok: false, kind: 'insufficient_text', message: 'Not enough extractable text (possibly a scanned or image-only PDF).' };
    return { ok: true, text, kind: 'pdf', pagesRead: pages.length, totalPages };
  } catch (err) {
    if (err instanceof DeadlineExceededError) {
      timedOut = true;
      return { ok: false, kind: 'timeout', message: 'Reading this PDF took too long, so it was stopped.' };
    }
    if (err instanceof PasswordException) return { ok: false, kind: 'password_protected', message: 'This document is password-protected.' };
    return { ok: false, kind: 'corrupt', message: 'Could not read this PDF.' };
  } finally {
    if (parser && timedOut) void parser.destroy().catch(() => undefined);
    else if (parser) await parser.destroy().catch(() => undefined);
  }
}

export async function documentTextFromBytes(bytes: Uint8Array, contentType: string | null, opts: { maxPages?: number; timeoutMs?: number } = {}): Promise<DocumentTextResult> {
  if (looksLikePdf(bytes)) return extractPdfTextFirstPages(bytes, opts);
  const ct = (contentType ?? '').toLowerCase();
  if (ct.includes('html') || looksLikeHtml(bytes)) {
    const text = htmlToText(Buffer.from(bytes).toString('utf8'));
    if (text.length < MIN_TOTAL_CHARS) return { ok: false, kind: 'insufficient_text', message: 'The page has too little text.' };
    return { ok: true, text, kind: 'html', pagesRead: 1, totalPages: 1 };
  }
  if (ct.startsWith('text/plain')) {
    const text = Buffer.from(bytes).toString('utf8');
    if (text.trim().length < MIN_TOTAL_CHARS) return { ok: false, kind: 'insufficient_text', message: 'The file has too little text.' };
    return { ok: true, text, kind: 'text', pagesRead: 1, totalPages: 1 };
  }
  return { ok: false, kind: 'unsupported_type', message: 'The document is neither a PDF nor a web page.' };
}

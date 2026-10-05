// Factsheet benchmark reader: reading a fetched document in the Node runtime with the repository's existing PDF library
// (pdf-parse; no native binary, no network). Built-in minimal PDFs are generated in-process; no real document is used.
import { describe, expect, it } from 'vitest';
import { buildMinimalTextPdf } from '../support/buildMinimalPdf';
import { documentTextFromBytes, extractPdfTextFirstPages, htmlToText, looksLikeHtml, looksLikePdf, sha256Hex } from '@/lib/services/investment-intelligence/factsheetReader/documentText';
import { extractWithPatterns } from '@/lib/services/investment-intelligence/factsheetReader/patternExtractor';
import { runFactsheetReader } from '@/lib/services/investment-intelligence/factsheetReader/runner';
import { FACTSHEET_SOURCE_SEED } from '@/lib/services/investment-intelligence/factsheetReader/sourceRegistry';
import { CONTROL_ON, FakeFetcher, FakeStore, HELD_CONTRA, okDoc, sourcesFor } from './support/factsheetFakes';

const PAGE_1 = ['SBI Contra Fund', 'Equity - Contra Fund', 'Report As On: 31/08/2025', 'Fund Details and a few more words so that the page has enough extractable text to count as readable text.', 'First Tier Benchmark: BSE 500 TRI'];

describe('PDF text in the Node runtime', () => {
  it('reads real PDF bytes, and the pattern pass finds the benchmark in the extracted text', async () => {
    const pdf = buildMinimalTextPdf([PAGE_1]);
    expect(looksLikePdf(pdf)).toBe(true);
    const r = await documentTextFromBytes(pdf, 'application/pdf');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.kind).toBe('pdf');
    expect(r.pagesRead).toBe(1);
    const ex = extractWithPatterns({ text: r.text, schemeName: 'SBI Contra Fund', scope: 'single_scheme' });
    expect(ex.status).toBe('found');
    if (ex.status === 'found') {
      expect(ex.extraction.tier1?.raw).toBe('BSE 500 TRI');
      expect(ex.extraction.documentDate?.iso).toBe('2025-08-31');
    }
  });
  it('only the FIRST pages are read: a benchmark stated after the page limit is not seen (a long SID is never read end to end)', async () => {
    const filler = Array.from({ length: 7 }, (_, i) => [`Page ${i + 2} filler text that is long enough to be treated as extractable content, line one.`, 'More filler words on the same page to keep the text well above the minimum.']);
    const pdf = buildMinimalTextPdf([PAGE_1.slice(0, 4), ...filler, ['SBI Contra Fund', 'First Tier Benchmark: BSE 500 TRI and some more words to pad this page out sufficiently.']]);
    const r = await extractPdfTextFirstPages(pdf, { maxPages: 3 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pagesRead).toBe(3);
    expect(r.totalPages).toBe(9);
    expect(r.text).not.toMatch(/First Tier Benchmark/);
  });
  it('a corrupt file, a scanned / empty PDF and an unsupported type are reported, never thrown', async () => {
    expect(await documentTextFromBytes(new TextEncoder().encode('%PDF-1.4 this is not really a pdf'), 'application/pdf')).toMatchObject({ ok: false, kind: 'corrupt' });
    const empty = buildMinimalTextPdf([['.']]);
    expect(await documentTextFromBytes(empty, 'application/pdf')).toMatchObject({ ok: false, kind: 'insufficient_text' });
    expect(await documentTextFromBytes(new Uint8Array([1, 2, 3, 4]), 'application/octet-stream')).toMatchObject({ ok: false, kind: 'unsupported_type' });
  });
  it('HTML is reduced to text deterministically (no script, no tags, entities decoded)', async () => {
    const html = '<html><head><style>.x{}</style><script>alert(1)</script></head><body><p>Nippon India Power &amp; Infra Fund</p><table><tr><td>Benchmark</td><td>Nifty Infrastructure TRI</td></tr></table><p>Padding text so that the page has enough characters to be read as a page.</p></body></html>';
    expect(looksLikeHtml(new TextEncoder().encode(html))).toBe(true);
    const text = htmlToText(html);
    expect(text).toContain('Nippon India Power & Infra Fund');
    expect(text).not.toMatch(/alert|<|\.x\{/);
    expect(text).toContain('Benchmark\tNifty Infrastructure TRI');
    const r = await documentTextFromBytes(new TextEncoder().encode(html), 'text/html');
    expect(r).toMatchObject({ ok: true, kind: 'html' });
  });
  it('the checksum is the SHA-256 of the exact bytes', () => {
    expect(sha256Hex(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('end to end through the REAL PDF reader (store and transport still fake)', () => {
  it('a fetched PDF is read, the benchmark recorded with the PDF bytes\' checksum', async () => {
    const key = 'sbi_contra_factsheet_2025_08';
    const url = (FACTSHEET_SOURCE_SEED.find((s) => s.sourceKey === key) as { url: string }).url;
    const pdf = buildMinimalTextPdf([PAGE_1]);
    const store = new FakeStore();
    store.control = CONTROL_ON;
    store.sources = sourcesFor([key]);
    store.held = [HELD_CONTRA];
    const fetcher = new FakeFetcher({ [url]: okDoc('') });
    fetcher.scripts[url] = { kind: 'ok', status: 200, bytes: new Uint8Array(pdf), contentType: 'application/pdf', etag: null, lastModified: null };
    await runFactsheetReader({ store, fetcher, nowIso: '2026-10-03T02:00:00.000Z', env: {}, runId: 'r' }); // no readDocument injected: the real reader is used
    expect(store.attempts.map((a) => a.outcome)).toEqual(['recorded_first_observation']);
    expect(store.versions[0]).toMatchObject({ tier1Name: 'BSE 500 TRI', documentDate: '2025-08-31', documentChecksum: sha256Hex(new Uint8Array(pdf)) });
  });
});

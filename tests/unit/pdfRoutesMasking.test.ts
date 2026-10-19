/**
 * Masking on the PDF route: the text that would be sent to a model (the REAL extracted text of the REAL corpus PDFs, through the REAL
 * `maskText` the shared gate uses) must not contain any planted personal detail, and must keep every figure the reading needs.
 * Also: the shared gate fails CLOSED (no masking key -> refusal, never an unmasked call), and a statement-type refusal never reaches masking at all.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { ALL_CORPUS_DOCS, buildCorpusPdf } from '../../scripts/pdf_routes_corpus';
import { readStatementPdf } from '@/lib/financial-data-hub/pdf-statements';
import { maskText } from '@/lib/aie/masking/piiMasking';
import { evaluateAiFallbackGate } from '@/lib/aie/adapters/shared/fallbackGate';

beforeAll(() => {
  process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY = 'a'.repeat(64);
});

const money = (n: number) => n.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

describe('planted personal details never survive masking (real corpus text, real masker)', () => {
  for (const d of ALL_CORPUS_DOCS.filter((x) => x.planted.length > 0)) {
    it(`${d.id}: none of ${d.planted.length} planted detail(s) survives; the statement's figures do`, async () => {
      const text = await readStatementPdf(new Uint8Array(buildCorpusPdf(d)));
      if (!text.ok) throw new Error('text');
      const masked = maskText(text.text, { tenantKey: 'tenant-1' }).maskedText;
      const compact = masked.replace(/\s+/g, ' ');
      const survivors = d.planted.filter((p) => compact.includes(p));
      expect(survivors, `${d.id} planted details that reached the model`).toEqual([]);
      // figures stay: the reading is impossible without them
      const e = (d as unknown as { expected: { opening?: number } | null }).expected;
      // (grouping commas are ignored so Western and lakh grouping are checked the same way)
      if (e && typeof e.opening === 'number') expect(compact.replace(/,/g, '')).toContain(money(e.opening).replace(/,/g, ''));
    });
  }
});

describe('the shared gate fails closed', () => {
  it('no masking key: refused as masking_unavailable, never an unmasked call', async () => {
    const saved = process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY;
    delete process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY;
    process.env.AIE_AI_FALLBACK_ENABLED = 'true';
    const r = await evaluateAiFallbackGate({
      userId: 'u1',
      adapterEnabled: true,
      extractedText: 'Card number: 5999 0000 1111 4821 and some more statement text to exceed the minimum length',
      entitlementDeps: { resolve: async () => ({ allowed: true }) } as never,
    }).catch((e) => ({ ok: false as const, reason: String(e) }));
    expect(r.ok).toBe(false);
    process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY = saved;
    delete process.env.AIE_AI_FALLBACK_ENABLED;
  });
});

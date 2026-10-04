// Factsheet benchmark reader: the OPTIONAL AI pass. AI output is never trusted unvalidated: it must be JSON, pass a
// STRICT schema, and be found in the document text. No real provider is called (a scripted provider stands in).
import { describe, expect, it } from 'vitest';
import {
  FACTSHEET_AI_OPENAI_JSON_SCHEMA,
  FACTSHEET_AI_SCHEMA_NAME,
  FACTSHEET_AI_SCHEMA_VERSION,
  buildAiExcerpt,
  buildAiUserPrompt,
  factsheetAiResponseSchema,
  runAiExtraction,
  validateAiResponse,
  type FactsheetAiExtractor,
} from '@/lib/services/investment-intelligence/factsheetReader/aiExtractor';
import { createAieFactsheetAiExtractor } from '@/lib/services/investment-intelligence/factsheetReader/aieAdapter';
import { getKnownOpenAiJsonSchema } from '@/lib/aie/provider/openaiJsonSchema';
import type { AieAiGenerateRequest, AieAiGenerateResult, AieAiProvider } from '@/lib/aie/provider/types';

const DOC = [
  'SYNTHETIC TEST FIXTURE',
  'SBI Contra Fund',
  'Report As On: 31/08/2025',
  'First Tier Benchmark: BSE 500 TRI',
  'Benchmark effective from 1 April 2021',
  'Additional Benchmark: Nifty 100 TRI',
].join('\n');

const good = {
  schemeNameInDocument: 'SBI Contra Fund',
  tier1BenchmarkName: 'BSE 500 TRI',
  tier1VariantStated: 'total_return',
  additionalBenchmarkNames: ['Nifty 100 TRI'],
  effectiveFromIso: '2021-04-01',
  documentDateIso: '2025-08-31',
  verbatimQuote: 'First Tier Benchmark: BSE 500 TRI',
  notFoundReason: null,
};
const validate = (o: unknown, doc = DOC) => validateAiResponse({ rawText: typeof o === 'string' ? o : JSON.stringify(o), model: 'gpt-4o-mini', documentText: doc, schemeName: 'SBI Contra Fund', scope: 'single_scheme' });

describe('NEGATIVE CONTROL: AI output failing the schema is rejected', () => {
  it('accepts a well-formed answer that is found in the document', () => {
    const r = validate(good);
    expect(r.status).toBe('found');
    if (r.status !== 'found') return;
    expect(r.extraction.tier1?.raw).toBe('BSE 500 TRI');
    expect(r.extraction.tier1?.variantHint).toBe('total_return');
    expect(r.extraction.additional.map((a) => a.raw)).toEqual(['Nifty 100 TRI']);
    expect(r.extraction.effectiveFromStated?.iso).toBe('2021-04-01');
    expect(r.extraction.documentDate?.iso).toBe('2025-08-31');
    expect(r.extraction.excerpt).toBe('First Tier Benchmark: BSE 500 TRI');
  });
  it('rejects invalid JSON, an unknown key (strict), a wrong enum value, a missing field and a bad date shape', () => {
    expect(validate('not json').status).toBe('rejected');
    expect(validate({ ...good, rogue: 'x' }).status).toBe('rejected');
    expect(validate({ ...good, tier1VariantStated: 'maybe' }).status).toBe('rejected');
    const { verbatimQuote: _q, ...missing } = good;
    expect(validate(missing).status).toBe('rejected');
    expect(validate({ ...good, effectiveFromIso: '01/04/2021' }).status).toBe('rejected');
    expect(validate({ ...good, additionalBenchmarkNames: ['a', 'b', 'c', 'd'].map((x) => `${x}-index`) }).status).toBe('rejected');
    expect(validate('{"fields": []}').status).toBe('rejected');
  });
  it('the Zod schema and the strict OpenAI JSON schema list exactly the same keys, all required, no extras', () => {
    const props = Object.keys((FACTSHEET_AI_OPENAI_JSON_SCHEMA.properties as Record<string, unknown>));
    expect(props.sort()).toEqual(Object.keys(factsheetAiResponseSchema.shape).sort());
    expect([...(FACTSHEET_AI_OPENAI_JSON_SCHEMA.required as string[])].sort()).toEqual(props.sort());
    expect(FACTSHEET_AI_OPENAI_JSON_SCHEMA.additionalProperties).toBe(false);
  });
  it('the schema is REGISTERED with the AIE provider layer (an unregistered schema would fail every real call)', () => {
    expect(getKnownOpenAiJsonSchema(FACTSHEET_AI_SCHEMA_NAME, FACTSHEET_AI_SCHEMA_VERSION)).toBe(FACTSHEET_AI_OPENAI_JSON_SCHEMA);
  });
});

describe('deterministic checks against the document text (the answer is evidence-checked, not trusted)', () => {
  it('a benchmark name that is not in the document is rejected', () => {
    expect(validate({ ...good, tier1BenchmarkName: 'Nifty 500 TRI', verbatimQuote: 'First Tier Benchmark: Nifty 500 TRI' }).status).toBe('rejected');
  });
  it('a quote that is not in the document is rejected, and so is a quote that lacks the benchmark name', () => {
    expect(validate({ ...good, verbatimQuote: 'The fund will always beat BSE 500 TRI' }).status).toBe('rejected');
    expect(validate({ ...good, verbatimQuote: 'Report As On: 31/08/2025' }).status).toBe('rejected');
  });
  it('an additional benchmark that is not in the document is rejected', () => {
    expect(validate({ ...good, additionalBenchmarkNames: ['Invented Index TRI'] }).status).toBe('rejected');
  });
  it('a date the document does not contain is DROPPED, never invented (the document date then comes from the text, not the model)', () => {
    const r = validate({ ...good, effectiveFromIso: '2019-02-03', documentDateIso: '2024-01-01' });
    expect(r.status).toBe('found');
    if (r.status !== 'found') return;
    expect(r.extraction.effectiveFromStated).toBeNull();
    expect(r.extraction.documentDate?.iso).toBe('2025-08-31');
  });
  it('a null Tier-1 is "not found" (with the model\'s reason), not a rejection and not a record', () => {
    expect(validate({ ...good, tier1BenchmarkName: null, verbatimQuote: null, notFoundReason: 'not_present_on_document' })).toMatchObject({ status: 'not_found' });
  });
  it('a document that does not name the scheme is rejected even for a perfect-looking answer', () => {
    expect(validate(good, 'Some Other Fund\nFirst Tier Benchmark: BSE 500 TRI').status).toBe('rejected');
  });
});

describe('the request carries the scheme name and a bounded excerpt of the public document, nothing else', () => {
  it('the excerpt keeps benchmark-bearing lines only, is capped, and is empty when there are none', () => {
    const long = ['SBI Contra Fund', ...Array(500).fill('First Tier Benchmark: BSE 500 TRI blah blah blah blah blah blah')].join('\n');
    expect(buildAiExcerpt(long, 'SBI Contra Fund', 'single_scheme').length).toBeLessThanOrEqual(6000);
    const ex = buildAiExcerpt(DOC, 'SBI Contra Fund', 'single_scheme');
    expect(ex).toContain('First Tier Benchmark: BSE 500 TRI');
    expect(buildAiExcerpt('SBI Contra Fund\njust prose with nothing relevant at all here', 'SBI Contra Fund', 'single_scheme')).toBe('');
  });
  it('the user prompt is exactly "Scheme: <name>" plus the excerpt (no other input exists to leak)', () => {
    expect(buildAiUserPrompt({ schemeName: 'SBI Contra Fund', excerpt: 'First Tier Benchmark: BSE 500 TRI' })).toBe('Scheme: SBI Contra Fund\n\nExcerpt:\n<<<\nFirst Tier Benchmark: BSE 500 TRI\n>>>');
  });
  it('a failing or throwing adapter is a rejection, never a throw; no excerpt means the adapter is not even called', async () => {
    const throwing: FactsheetAiExtractor = { id: 't', extract: async () => { throw new Error('boom'); } };
    expect((await runAiExtraction(throwing, { documentText: DOC, schemeName: 'SBI Contra Fund', scope: 'single_scheme' })).status).toBe('rejected');
    let called = 0;
    const counting: FactsheetAiExtractor = { id: 'c', extract: async () => { called++; return { ok: false, reason: 'x' }; } };
    expect((await runAiExtraction(counting, { documentText: 'SBI Contra Fund\nnothing relevant', schemeName: 'SBI Contra Fund', scope: 'single_scheme' })).status).toBe('not_found');
    expect(called).toBe(0);
  });
});

function scripted(raw: Partial<AieAiGenerateResult> | Error, seen: AieAiGenerateRequest[] = []): AieAiProvider {
  return {
    providerName: 'scripted',
    async generateStructured(req) {
      seen.push(req);
      if (raw instanceof Error) throw raw;
      return { rawText: '{}', inputTokens: 1, outputTokens: 1, latencyMs: 1, modelVersion: 'gpt-4o-mini', finishReason: 'stop', ...raw };
    },
    async validateProviderHealth() {
      return { healthy: true, checkedAt: '2026-10-03T00:00:00Z', detail: 'scripted' };
    },
    estimateCost: (i, o) => ({ inputTokens: i, outputTokens: o, estimatedCostUsd: 0 }),
  };
}

describe('the AIE-backed adapter', () => {
  it('sends the registered schema, the permitted model, temperature 0 and ONLY the scheme name + excerpt', async () => {
    const seen: AieAiGenerateRequest[] = [];
    const ex = createAieFactsheetAiExtractor(scripted({ rawText: JSON.stringify(good) }, seen));
    const r = await ex.extract({ schemeName: 'SBI Contra Fund', excerpt: 'First Tier Benchmark: BSE 500 TRI' });
    expect(r).toMatchObject({ ok: true, model: 'gpt-4o-mini' });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ schemaName: FACTSHEET_AI_SCHEMA_NAME, schemaVersion: FACTSHEET_AI_SCHEMA_VERSION, model: 'gpt-4o-mini', temperature: 0 });
    expect(seen[0].userPrompt).toBe('Scheme: SBI Contra Fund\n\nExcerpt:\n<<<\nFirst Tier Benchmark: BSE 500 TRI\n>>>');
    expect(seen[0].systemPrompt).toMatch(/untrusted/);
  });
  it('a model outside the permitted list is refused BEFORE any provider call', async () => {
    const prev = process.env.AIE_AI_MODEL;
    process.env.AIE_AI_MODEL = 'gpt-4o';
    try {
      const seen: AieAiGenerateRequest[] = [];
      const r = await createAieFactsheetAiExtractor(scripted({}, seen)).extract({ schemeName: 'X Fund', excerpt: 'Benchmark: Nifty 500 TRI' });
      expect(r.ok).toBe(false);
      expect(seen).toHaveLength(0);
    } finally {
      if (prev === undefined) delete process.env.AIE_AI_MODEL;
      else process.env.AIE_AI_MODEL = prev;
    }
  });
  it('a truncated answer (finish_reason length) and a provider error are failures that expose a category only', async () => {
    expect((await createAieFactsheetAiExtractor(scripted({ finishReason: 'length' })).extract({ schemeName: 'X Fund', excerpt: 'e' })).ok).toBe(false);
    const err = Object.assign(new Error('secret prompt text must not leak'), { code: 'RATE_LIMIT' });
    const r = await createAieFactsheetAiExtractor(scripted(err)).extract({ schemeName: 'X Fund', excerpt: 'e' });
    expect(r).toEqual({ ok: false, reason: 'provider error (RATE_LIMIT)' });
  });
});

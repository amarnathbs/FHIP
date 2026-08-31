import { describe, it, expect } from 'vitest';
import { validateProviderResponse, findUnknownSourceRefs, aiResponseEnvelopeSchema } from '@/lib/ai/structuredOutput';

const VALID_ENVELOPE = {
  answer_type: 'score_explanation',
  headline: 'Your score improved this month',
  summary: 'Your Financial Health Score rose from 62 to 68, mainly driven by an improved savings rate.',
  key_points: ['Savings rate improved', 'Debt-to-income unchanged'],
  actions: [],
  source_refs: [{ source_type: 'health_score', source_id: 'abc-123', model_version: 'fhs-2.0.0', data_as_of: '2026-08-01' }],
  confidence: 'high',
  data_as_of: '2026-08-01',
  limitations: [],
  safety_classification: 'FHIP_EXPLANATION',
  prompt_version: 'PR-AI-001-v1',
  model_version: 'mock-1.0.0',
};

describe('Module 11.0 structured output envelope (spec section 45)', () => {
  it('accepts a well-formed response', () => {
    const result = validateProviderResponse(JSON.stringify(VALID_ENVELOPE));
    expect(result.ok).toBe(true);
  });

  it('rejects non-JSON text', () => {
    const result = validateProviderResponse('this is not json at all {{{');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/JSON/);
  });

  it('rejects a response missing required fields', () => {
    const result = validateProviderResponse(JSON.stringify({ headline: 'only a headline' }));
    expect(result.ok).toBe(false);
  });

  it('rejects an out-of-vocabulary safety_classification (does not trust arbitrary provider JSON)', () => {
    const bad = { ...VALID_ENVELOPE, safety_classification: 'TOTALLY_MADE_UP' };
    const result = validateProviderResponse(JSON.stringify(bad));
    expect(result.ok).toBe(false);
  });

  it('rejects an out-of-vocabulary confidence value', () => {
    const bad = { ...VALID_ENVELOPE, confidence: 'extremely-sure' };
    const result = validateProviderResponse(JSON.stringify(bad));
    expect(result.ok).toBe(false);
  });

  it('rejects unknown extra fields (schema is strict)', () => {
    const bad = { ...VALID_ENVELOPE, extra_field_the_provider_invented: 'sneaky' };
    const result = validateProviderResponse(JSON.stringify(bad));
    expect(result.ok).toBe(false);
  });

  it('rejects a source_ref missing required sub-fields', () => {
    const bad = { ...VALID_ENVELOPE, source_refs: [{ source_type: 'health_score' }] };
    const result = validateProviderResponse(JSON.stringify(bad));
    expect(result.ok).toBe(false);
  });

  it('findUnknownSourceRefs flags a citation FHIP never offered (spec 51-E)', () => {
    const parsed = aiResponseEnvelopeSchema.parse(VALID_ENVELOPE);
    const known = new Set(['some-other-id']);
    const unknown = findUnknownSourceRefs(parsed, known);
    expect(unknown).toEqual(['abc-123']);
  });

  it('findUnknownSourceRefs returns empty when every citation is known', () => {
    const parsed = aiResponseEnvelopeSchema.parse(VALID_ENVELOPE);
    const known = new Set(['abc-123']);
    expect(findUnknownSourceRefs(parsed, known)).toEqual([]);
  });
});

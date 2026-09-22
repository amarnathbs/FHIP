// Module 11 remediation R3 — OpenAIBatchProvider against a fetch double
// (brief sections 28-29). No network, no spend; the credential value is a
// made-up string that never leaves the process.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { OpenAIBatchProvider, OPENAI_FILES_URL, OPENAI_BATCHES_URL } from '@/lib/ai/providers/openaiBatchProvider';
import type { FetchLike } from '@/lib/ai/providers/openaiProvider';
import type { BatchPackItemRequest } from '@/lib/ai/insightPack/batchTypes';
import { ProviderError } from '@/lib/ai/providers/types';

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ['OPENAI_API_KEY', 'MODULE11_AI_MODEL', 'MODULE11_AI_PROVIDER']) saved[k] = process.env[k];
  process.env.OPENAI_API_KEY = 'sk-unit-test-only';
  process.env.MODULE11_AI_MODEL = 'gpt-4o-mini';
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

const items: BatchPackItemRequest[] = [
  { requestId: 'req-A', systemPrompt: 'sys', userPrompt: 'user A', model: 'gpt-4o-mini', maxOutputTokens: 3000 },
  { requestId: 'req-B', systemPrompt: 'sys', userPrompt: 'user B', model: 'gpt-4o-mini', maxOutputTokens: 3000 },
  { requestId: 'req-C', systemPrompt: 'sys', userPrompt: 'user C', model: 'gpt-4o-mini', maxOutputTokens: 3000 },
];

function jsonRes(body: unknown, status = 200): Response { return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }); }

describe('R3 — JSONL rendering', () => {
  it('one line per item: custom_id = requestId, chat completions body with strict json_schema, store:false, temperature 0, max_tokens', () => {
    const jsonl = new OpenAIBatchProvider(vi.fn()).buildJsonl(items);
    const lines = jsonl.split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => l.custom_id)).toEqual(['req-A', 'req-B', 'req-C']);
    for (const l of lines) {
      expect(l.method).toBe('POST');
      expect(l.url).toBe('/v1/chat/completions');
      expect(l.body.model).toBe('gpt-4o-mini');
      expect(l.body.store).toBe(false);
      expect(l.body.temperature).toBe(0);
      expect(l.body.max_tokens).toBe(3000);
      expect(l.body.response_format.type).toBe('json_schema');
      expect(l.body.response_format.json_schema.strict).toBe(true);
    }
  });

  it('refuses a model other than the configured one, and a duplicate requestId', () => {
    const p = new OpenAIBatchProvider(vi.fn());
    expect(() => p.buildJsonl([{ ...items[0], model: 'gpt-4.1' }])).toThrow(/not the configured Module 11 model/);
    expect(() => p.buildJsonl([items[0], { ...items[1], requestId: 'req-A' }])).toThrow(/Duplicate requestId/);
  });
});

describe('R3 — submit / poll / cancel through the Files + Batches API shape', () => {
  it('submitBatch uploads a purpose=batch file then creates a 24h batch; returns the provider batch id; never called without a key', async () => {
    const calls: { url: string; method: string; body: unknown }[] = [];
    const fetchDouble: FetchLike = async (url, init) => {
      calls.push({ url, method: init.method ?? 'GET', body: init.body });
      if (url === OPENAI_FILES_URL) {
        const form = init.body as FormData;
        expect(form.get('purpose')).toBe('batch');
        expect((form.get('file') as File).size).toBeGreaterThan(0);
        return jsonRes({ id: 'file-123', purpose: 'batch' });
      }
      if (url === OPENAI_BATCHES_URL) {
        const body = JSON.parse(String(init.body));
        expect(body).toMatchObject({ input_file_id: 'file-123', endpoint: '/v1/chat/completions', completion_window: '24h' });
        return jsonRes({ id: 'batch_abc', status: 'validating' });
      }
      throw new Error(`unexpected ${url}`);
    };
    const p = new OpenAIBatchProvider(fetchDouble);
    const r = await p.submitBatch(items);
    expect(r).toEqual({ providerBatchId: 'batch_abc', itemCount: 3 });
    expect(p.lastInputFileId).toBe('file-123');
    expect(calls.map((c) => c.url)).toEqual([OPENAI_FILES_URL, OPENAI_BATCHES_URL]);

    delete process.env.OPENAI_API_KEY;
    const spy = vi.fn();
    await expect(new OpenAIBatchProvider(spy).submitBatch(items)).rejects.toThrow(ProviderError);
    expect(spy).not.toHaveBeenCalled();
  });

  it('pollBatch: PENDING while in_progress; on completed downloads output+error files and maps by custom_id — out of order, per-item failures, refusal, unparseable line dropped', async () => {
    let status = 'in_progress';
    const outputJsonl = [
      JSON.stringify({ id: 'r3', custom_id: 'req-C', response: { status_code: 200, body: { choices: [{ message: { content: '{"c":1}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 30, completion_tokens: 3 } } } }),
      'this line is not json',
      JSON.stringify({ id: 'r1', custom_id: 'req-A', response: { status_code: 200, body: { choices: [{ message: { content: '{"a":1}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 1 } } } }),
      JSON.stringify({ id: 'r9', response: { status_code: 200, body: {} } }), // no custom_id -> attributable to nobody -> dropped
    ].join('\n');
    const errorJsonl = JSON.stringify({ id: 'r2', custom_id: 'req-B', response: { status_code: 429, body: { error: { message: 'rate limited' } } }, error: { code: 'rate_limit_exceeded', message: 'rate limited' } });
    const fetchDouble: FetchLike = async (url) => {
      if (url === `${OPENAI_BATCHES_URL}/batch_abc`) return jsonRes({ id: 'batch_abc', status, output_file_id: status === 'completed' ? 'file-out' : null, error_file_id: status === 'completed' ? 'file-err' : null });
      if (url === `${OPENAI_FILES_URL}/file-out/content`) return new Response(outputJsonl, { status: 200 });
      if (url === `${OPENAI_FILES_URL}/file-err/content`) return new Response(errorJsonl, { status: 200 });
      throw new Error(`unexpected ${url}`);
    };
    const p = new OpenAIBatchProvider(fetchDouble);
    const pending = await p.pollBatch('batch_abc');
    expect(pending).toEqual({ status: 'PENDING', results: [] });
    expect(p.lastProviderStatus).toBe('in_progress');

    status = 'completed';
    const done = await p.pollBatch('batch_abc');
    expect(done.status).toBe('COMPLETED');
    expect(done.batchFailure).toBeUndefined();
    const byId = new Map(done.results.map((r) => [r.requestId, r]));
    expect([...byId.keys()].sort()).toEqual(['req-A', 'req-B', 'req-C']);
    expect(byId.get('req-A')).toMatchObject({ ok: true, rawText: '{"a":1}', inputTokens: 10, outputTokens: 1 });
    expect(byId.get('req-C')).toMatchObject({ ok: true, rawText: '{"c":1}', inputTokens: 30, outputTokens: 3 });
    expect(byId.get('req-B')).toMatchObject({ ok: false, errorCode: 'rate_limit_exceeded' });
    expect(done.results.length).toBe(3); // the unparseable and the id-less lines were dropped, never attributed
  });

  it('a batch that ends expired/failed reports batchFailure and any partial results it did produce', async () => {
    const fetchDouble: FetchLike = async (url) => {
      if (url === `${OPENAI_BATCHES_URL}/batch_x`) return jsonRes({ id: 'batch_x', status: 'expired', output_file_id: 'file-part', error_file_id: null, errors: null });
      if (url === `${OPENAI_FILES_URL}/file-part/content`) return new Response(JSON.stringify({ custom_id: 'req-A', response: { status_code: 200, body: { choices: [{ message: { content: '{}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } } } }), { status: 200 });
      throw new Error(`unexpected ${url}`);
    };
    const done = await new OpenAIBatchProvider(fetchDouble).pollBatch('batch_x');
    expect(done.status).toBe('COMPLETED');
    expect(done.batchFailure?.status).toBe('expired');
    expect(done.results).toHaveLength(1);
  });

  it('HTTP errors map to ProviderError codes (401 AUTH, 429 RATE_LIMIT, 503 PROVIDER_UNAVAILABLE); cancel posts to /cancel', async () => {
    for (const [status, code] of [[401, 'AUTH'], [429, 'RATE_LIMIT'], [503, 'PROVIDER_UNAVAILABLE']] as const) {
      const p = new OpenAIBatchProvider(async () => new Response('{}', { status }));
      await expect(p.pollBatch('b')).rejects.toMatchObject({ code });
    }
    const calls: string[] = [];
    const p = new OpenAIBatchProvider(async (url, init) => { calls.push(`${init.method} ${url}`); return jsonRes({ id: 'b', status: 'cancelling' }); });
    await p.cancelBatch('b');
    expect(calls).toEqual([`POST ${OPENAI_BATCHES_URL}/b/cancel`]);
  });
});

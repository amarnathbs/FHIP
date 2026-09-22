// Module 11 remediation R3 — OpenAIBatchProvider: the REAL async batch
// adapter behind the provider-neutral BatchCapableProvider contract
// (lib/ai/insightPack/batchTypes.ts), brief section 28.
//
// PROVIDER-NATIVE BATCH. OpenAI's Batch API (verified against the official
// guide on 2026-09-22) accepts a JSONL file of chat-completion requests,
// each with a caller-chosen `custom_id`, runs them within a 24h completion
// window at 50% of standard token pricing, and returns an output JSONL whose
// line order "may not match the input line order" — results are matched by
// `custom_id` only. /v1/chat/completions bodies are accepted verbatim, so
// the SAME strict `response_format: json_schema` the synchronous adapter
// sends is used per line. gpt-4o-mini is listed in the Batch pricing table.
//
// CONTRACT MAPPING
//   submitBatch(items)  -> POST /v1/files (purpose=batch, JSONL) then
//                          POST /v1/batches {input_file_id, endpoint, completion_window:'24h'}
//                          returns providerBatchId = batch.id; custom_id = item.requestId
//   pollBatch(id)       -> GET /v1/batches/{id}; PENDING until status is one of
//                          completed/failed/expired/cancelled; on completed
//                          downloads output_file_id (+ error_file_id) and maps
//                          each line by custom_id -> BatchPackItemResult
//   cancelBatch(id)     -> POST /v1/batches/{id}/cancel
//
// EVERY rule the synchronous adapter enforces applies here too: credential
// from process.env only (server-only), approved-model guard per item,
// `store:false`, strict schema, fail-closed ProviderError mapping, no
// fabricated results. Cost attribution is per item from each output line's
// own `usage`, priced at the BATCH rate (50% of the registry's standard
// rate) — reported alongside the standard-rate figure so the batch row can
// record both the conservative estimate and the actual pricing basis.
//
// This class performs NO admission, grounding or persistence; the
// orchestrator does all of that per household exactly as for the mock.

import '@/lib/serverOnly';
import { ProviderError } from '@/lib/ai/providers/types';
import type { BatchCapableProvider, BatchPackItemRequest, BatchPackItemResult, BatchPollResult } from '@/lib/ai/insightPack/batchTypes';
import { getOpenAiJsonSchema } from '@/lib/ai/providers/openaiJsonSchemas';
import { getModule11AiModel, getModule11AiTimeoutMs } from '@/lib/ai/config';
import type { FetchLike } from '@/lib/ai/providers/openaiProvider';

export const OPENAI_FILES_URL = 'https://api.openai.com/v1/files';
export const OPENAI_BATCHES_URL = 'https://api.openai.com/v1/batches';

/** Batch API = 50% of the standard rate (OpenAI pricing page, 2026-09-22). */
export const OPENAI_BATCH_PRICE_MULTIPLIER = 0.5;

export type OpenAiBatchStatus = 'validating' | 'failed' | 'in_progress' | 'finalizing' | 'completed' | 'expired' | 'cancelling' | 'cancelled';

interface OpenAiBatchObject {
  id?: string;
  status?: OpenAiBatchStatus;
  output_file_id?: string | null;
  error_file_id?: string | null;
  errors?: { data?: { message?: string; code?: string }[] } | null;
  request_counts?: { total?: number; completed?: number; failed?: number };
}

interface OpenAiBatchOutputLine {
  id?: string;
  custom_id?: string;
  response?: { status_code?: number; body?: { choices?: { message?: { content?: string | null; refusal?: string | null }; finish_reason?: string }[]; usage?: { prompt_tokens?: number; completion_tokens?: number }; error?: { message?: string } } } | null;
  error?: { code?: string; message?: string } | null;
}

/** Extends the neutral contract with the two things a REAL async provider adds: a cancel and a provider-status readout. */
export interface AsyncBatchCapableProvider extends BatchCapableProvider {
  cancelBatch(providerBatchId: string): Promise<void>;
  /** The provider's own last-known status string, set by the most recent pollBatch(). */
  readonly lastProviderStatus: string | null;
  readonly lastOutputFileId: string | null;
  readonly lastInputFileId: string | null;
}

export class OpenAIBatchProvider implements AsyncBatchCapableProvider {
  readonly providerName = 'openai';
  lastProviderStatus: string | null = null;
  lastOutputFileId: string | null = null;
  lastInputFileId: string | null = null;
  private readonly fetchImpl: FetchLike;

  constructor(fetchImpl?: FetchLike) {
    this.fetchImpl = fetchImpl ?? ((input, init) => fetch(input, init));
  }

  private apiKey(): string {
    const key = process.env.OPENAI_API_KEY;
    if (!key || key.trim().length === 0) throw new ProviderError('AUTH', 'OPENAI_API_KEY is not configured in this environment.');
    return key.trim();
  }

  private async call(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), getModule11AiTimeoutMs());
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal, headers: { Authorization: `Bearer ${this.apiKey()}`, ...(init.headers as Record<string, string> | undefined) } });
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') throw new ProviderError('TIMEOUT', `OpenAI batch call exceeded ${getModule11AiTimeoutMs()}ms.`);
      throw new ProviderError('UNKNOWN', e instanceof Error ? e.message : 'Network error calling OpenAI batch API.');
    } finally {
      clearTimeout(timer);
    }
  }

  private static mapHttpError(res: Response, what: string): ProviderError {
    if (res.status === 401 || res.status === 403) return new ProviderError('AUTH', `OpenAI rejected the Module 11 credential during ${what} (${res.status}).`);
    if (res.status === 429) return new ProviderError('RATE_LIMIT', `OpenAI rate-limited ${what} (429).`);
    if (res.status >= 500) return new ProviderError('PROVIDER_UNAVAILABLE', `OpenAI returned ${res.status} during ${what}.`);
    return new ProviderError('INVALID_REQUEST', `OpenAI returned ${res.status} during ${what}.`);
  }

  /** Renders one JSONL line per item — the same request body the synchronous adapter sends. */
  buildJsonl(items: BatchPackItemRequest[]): string {
    const configured = getModule11AiModel();
    const { name: schemaName, schema } = getOpenAiJsonSchema('insight_pack_envelope');
    const seen = new Set<string>();
    return items
      .map((item) => {
        if (item.model !== configured) throw new ProviderError('INVALID_REQUEST', `Model "${item.model}" is not the configured Module 11 model ("${configured}"); refusing to submit.`);
        if (seen.has(item.requestId)) throw new ProviderError('INVALID_REQUEST', `Duplicate requestId "${item.requestId}" in one batch submission.`);
        seen.add(item.requestId);
        return JSON.stringify({
          custom_id: item.requestId,
          method: 'POST',
          url: '/v1/chat/completions',
          body: {
            model: item.model,
            messages: [
              { role: 'system', content: item.systemPrompt },
              { role: 'user', content: item.userPrompt },
            ],
            max_tokens: Math.floor(item.maxOutputTokens),
            temperature: 0,
            store: false,
            response_format: { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema } },
          },
        });
      })
      .join('\n');
  }

  async submitBatch(items: BatchPackItemRequest[]): Promise<{ providerBatchId: string; itemCount: number }> {
    if (items.length === 0) throw new ProviderError('INVALID_REQUEST', 'Refusing to submit an empty batch.');
    const jsonl = this.buildJsonl(items);

    const form = new FormData();
    form.append('purpose', 'batch');
    form.append('file', new Blob([jsonl], { type: 'application/jsonl' }), `fhip-insight-pack-${Date.now()}.jsonl`);
    const fileRes = await this.call(OPENAI_FILES_URL, { method: 'POST', body: form });
    if (!fileRes.ok) throw OpenAIBatchProvider.mapHttpError(fileRes, 'batch file upload');
    const file = (await fileRes.json().catch(() => ({}))) as { id?: string };
    if (!file.id) throw new ProviderError('UNKNOWN', 'OpenAI file upload returned no file id.');
    this.lastInputFileId = file.id;

    const batchRes = await this.call(OPENAI_BATCHES_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input_file_id: file.id, endpoint: '/v1/chat/completions', completion_window: '24h', metadata: { source: 'fhip-module11-insight-pack' } }),
    });
    if (!batchRes.ok) throw OpenAIBatchProvider.mapHttpError(batchRes, 'batch create');
    const batch = (await batchRes.json().catch(() => ({}))) as OpenAiBatchObject;
    if (!batch.id) throw new ProviderError('UNKNOWN', 'OpenAI batch create returned no batch id.');
    this.lastProviderStatus = batch.status ?? 'validating';
    return { providerBatchId: batch.id, itemCount: items.length };
  }

  async pollBatch(providerBatchId: string): Promise<BatchPollResult> {
    const res = await this.call(`${OPENAI_BATCHES_URL}/${encodeURIComponent(providerBatchId)}`, { method: 'GET' });
    if (!res.ok) throw OpenAIBatchProvider.mapHttpError(res, 'batch poll');
    const batch = (await res.json().catch(() => ({}))) as OpenAiBatchObject;
    this.lastProviderStatus = batch.status ?? null;
    this.lastOutputFileId = batch.output_file_id ?? null;

    if (batch.status === 'validating' || batch.status === 'in_progress' || batch.status === 'finalizing' || batch.status === 'cancelling' || !batch.status) {
      return { status: 'PENDING', results: [] };
    }

    // Terminal. completed -> read output (+ error) files; failed/expired/
    // cancelled -> every item is a failure UNLESS a partial output file exists
    // (expired batches can carry partial results, which are still valid
    // per-item successes — attributed by custom_id like any other).
    const results: BatchPackItemResult[] = [];
    if (batch.output_file_id) results.push(...(await this.readResultFile(batch.output_file_id)));
    if (batch.error_file_id) results.push(...(await this.readResultFile(batch.error_file_id)));
    if (batch.status !== 'completed') {
      const providerMsg = batch.errors?.data?.map((e) => e.message).filter(Boolean).join('; ') || `provider batch ended ${batch.status}`;
      return { status: 'COMPLETED', results, batchFailure: { status: batch.status, message: providerMsg } };
    }
    return { status: 'COMPLETED', results };
  }

  private async readResultFile(fileId: string): Promise<BatchPackItemResult[]> {
    const res = await this.call(`${OPENAI_FILES_URL}/${encodeURIComponent(fileId)}/content`, { method: 'GET' });
    if (!res.ok) throw OpenAIBatchProvider.mapHttpError(res, 'batch output download');
    const text = await res.text();
    const out: BatchPackItemResult[] = [];
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      let parsed: OpenAiBatchOutputLine;
      try {
        parsed = JSON.parse(line) as OpenAiBatchOutputLine;
      } catch {
        continue; // an unparseable line has no custom_id and can be attributed to nobody — dropped, never guessed
      }
      const requestId = parsed.custom_id;
      if (!requestId) continue;
      if (parsed.error || !parsed.response || (parsed.response.status_code ?? 500) >= 400) {
        out.push({ requestId, ok: false, errorCode: parsed.error?.code ?? `http_${parsed.response?.status_code ?? 'unknown'}`, errorMessage: parsed.error?.message ?? parsed.response?.body?.error?.message ?? 'Batch item failed.' });
        continue;
      }
      const choice = parsed.response.body?.choices?.[0];
      const content = choice?.message?.refusal ? '' : (choice?.message?.content ?? '');
      out.push({
        requestId,
        ok: true,
        rawText: content, // an empty/refused body fails schema validation downstream — never fabricated
        inputTokens: parsed.response.body?.usage?.prompt_tokens ?? 0,
        outputTokens: parsed.response.body?.usage?.completion_tokens ?? 0,
      });
    }
    return out;
  }

  async cancelBatch(providerBatchId: string): Promise<void> {
    const res = await this.call(`${OPENAI_BATCHES_URL}/${encodeURIComponent(providerBatchId)}/cancel`, { method: 'POST' });
    if (!res.ok && res.status !== 409) throw OpenAIBatchProvider.mapHttpError(res, 'batch cancel');
    this.lastProviderStatus = 'cancelling';
  }
}

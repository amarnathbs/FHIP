// Module 11 remediation R2 — OpenAIProviderAdapter, the REAL Module 11
// provider (brief section 12). Replaces the Module 11.0 architecture-proof
// stub whose generateStructured() threw PROVIDER_UNAVAILABLE unconditionally
// (source audit PH-01).
//
// POSITION IN THE ARCHITECTURE. This class is reached ONLY through
// AIModelGateway (brief section 13). It performs no admission, no quota, no
// cost-ceiling and no kill-switch evaluation of its own — those are the
// gateway's and ai_admit_request()'s job and run BEFORE this class is
// called. What this class DOES enforce, because only it can:
//   * timeout (AbortController, MODULE11_AI_TIMEOUT_MS);
//   * approved-model guard: it refuses to send any model identifier other
//     than the one configured for Module 11 (MODULE11_AI_MODEL), so a
//     registry row for a different model can never be executed through
//     this adapter by mistake;
//   * output-token cap forwarded as `max_tokens`;
//   * strict structured output (`response_format: json_schema`, strict);
//   * `store: false` (explicit opt-out; NOT a Zero Data Retention claim);
//   * bounded transient retries (timeout/429/5xx only), cumulative usage
//     accounting across attempts so a retried request's spend is not lost;
//   * fail-closed error mapping to ProviderError codes the gateway already
//     understands. No fabricated fallback answer, ever.
//
// CREDENTIAL. `OPENAI_API_KEY`, read from process.env inside this server-only
// module only (serverOnly marker). Never accepted as a constructor argument,
// never logged, never returned by validateProviderHealth().
//
// PRICING FALLBACK. estimateCost() is only consulted when the model registry
// row has no price (lib/ai/cost/registryCost.ts prefers the registry). The
// table below is per-1K tokens, verified against OpenAI's official pricing
// page on 2026-09-22 (gpt-4o-mini: $0.15 / 1M input, $0.60 / 1M output). The
// Module 11.0 stub's table was labelled "per 1K" but carried the per-1M
// figures (0.15 / 0.6), i.e. a 1000x over-estimate — corrected here and
// covered by tests/unit/aiOpenAiProviderR2.test.ts.
//
// HTTP client: platform `fetch` (Next.js server runtime). No `openai` SDK is
// added — this repo has none, and the sibling AIE adapter established the
// same fetch-based convention.

import '@/lib/serverOnly';
import type { AIGenerateRequest, AIGenerateResult, AIProvider, CostEstimate, ProviderHealth } from '@/lib/ai/providers/types';
import { ProviderError } from '@/lib/ai/providers/types';
import { estimateTokens } from '@/lib/ai/providers/mockProvider';
import { getOpenAiJsonSchema } from '@/lib/ai/providers/openaiJsonSchemas';
import { getModule11AiMaxTransientRetries, getModule11AiModel, getModule11AiTimeoutMs } from '@/lib/ai/config';

export const OPENAI_CHAT_COMPLETIONS_URL = 'https://api.openai.com/v1/chat/completions';
export const OPENAI_MODELS_URL = 'https://api.openai.com/v1/models';

/**
 * Per-1K-token USD, standard (synchronous) tier. Source: OpenAI official
 * pricing page, read 2026-09-22. Versioned by `verified_on`; a registry row
 * price always wins over this table.
 */
export const OPENAI_FALLBACK_PRICING_PER_1K: Readonly<Record<string, { input: number; output: number; verified_on: string }>> = {
  'gpt-4o-mini': { input: 0.00015, output: 0.0006, verified_on: '2026-09-22' },
};

interface OpenAiChatCompletionResponse {
  id?: string;
  model?: string;
  choices?: Array<{ message?: { content?: string | null; refusal?: string | null }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
  error?: { message?: string; type?: string; code?: string };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
function backoffMs(attempt: number): number {
  return Math.floor(Math.random() * 250 * 2 ** attempt);
}

/** Injectable for tests so no test ever reaches the network. Defaults to the platform fetch. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export class OpenAIProviderAdapter implements AIProvider {
  readonly providerName = 'openai';
  private readonly fetchImpl: FetchLike;

  constructor(fetchImpl?: FetchLike) {
    this.fetchImpl = fetchImpl ?? ((input, init) => fetch(input, init));
  }

  private apiKey(): string {
    const key = process.env.OPENAI_API_KEY;
    if (!key || key.trim().length === 0) throw new ProviderError('AUTH', 'OPENAI_API_KEY is not configured in this environment.');
    return key.trim();
  }

  /** Brief section 12 "approved model": this adapter only ever sends the one configured Module 11 model. */
  private assertApprovedModel(model: string): void {
    const configured = getModule11AiModel();
    if (model !== configured) {
      throw new ProviderError('INVALID_REQUEST', `Model "${model}" is not the configured Module 11 model ("${configured}"); refusing to call the provider.`);
    }
  }

  async generateStructured(req: AIGenerateRequest): Promise<AIGenerateResult> {
    const apiKey = this.apiKey();
    this.assertApprovedModel(req.model);
    if (!Number.isFinite(req.maxOutputTokens) || req.maxOutputTokens <= 0) {
      throw new ProviderError('INVALID_REQUEST', 'maxOutputTokens must be a positive integer.');
    }
    const { name: schemaName, schema } = getOpenAiJsonSchema(req.responseSchema);
    const timeoutMs = req.timeoutMs ?? getModule11AiTimeoutMs();
    const maxRetries = getModule11AiMaxTransientRetries();

    let cumulativeInput = 0;
    let cumulativeOutput = 0;
    let cumulativeCached = 0;
    const addUsage = (body: OpenAiChatCompletionResponse | null): void => {
      cumulativeInput += body?.usage?.prompt_tokens ?? 0;
      cumulativeOutput += body?.usage?.completion_tokens ?? 0;
      cumulativeCached += body?.usage?.prompt_tokens_details?.cached_tokens ?? 0;
    };
    const absorbDiscarded = async (res: Response): Promise<void> => {
      try { addUsage((await res.json()) as OpenAiChatCompletionResponse); } catch { /* no usage reported */ }
    };

    let lastError: ProviderError | null = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) await sleep(backoffMs(attempt));
      const start = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await this.fetchImpl(OPENAI_CHAT_COMPLETIONS_URL, {
          method: 'POST',
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model: req.model,
            messages: [
              { role: 'system', content: req.systemPrompt },
              { role: 'user', content: req.userPrompt },
            ],
            max_tokens: Math.floor(req.maxOutputTokens),
            temperature: req.temperature ?? 0,
            store: false,
            response_format: { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema } },
          }),
        });
      } catch (e) {
        clearTimeout(timer);
        const aborted = e instanceof Error && e.name === 'AbortError';
        lastError = aborted
          ? new ProviderError('TIMEOUT', `OpenAI request exceeded ${timeoutMs}ms.`)
          : new ProviderError('UNKNOWN', e instanceof Error ? e.message : 'Network error calling OpenAI.');
        if (aborted && attempt < maxRetries) continue;
        throw lastError;
      }
      clearTimeout(timer);
      const latencyMs = Date.now() - start;

      if (response.status === 401 || response.status === 403) {
        throw new ProviderError('AUTH', 'OpenAI rejected the Module 11 API credential (401/403).');
      }
      if (response.status === 429) {
        await absorbDiscarded(response);
        lastError = new ProviderError('RATE_LIMIT', 'OpenAI rate-limited this request (429).');
        if (attempt < maxRetries) continue;
        throw lastError;
      }
      if (response.status >= 500) {
        await absorbDiscarded(response);
        lastError = new ProviderError('PROVIDER_UNAVAILABLE', `OpenAI returned ${response.status}.`);
        if (attempt < maxRetries) continue;
        throw lastError;
      }
      if (response.status >= 400) {
        let detail = `OpenAI returned ${response.status}.`;
        try {
          const body = (await response.json()) as OpenAiChatCompletionResponse;
          addUsage(body);
          if (body.error?.message) detail = body.error.message;
        } catch { /* keep generic detail */ }
        throw new ProviderError('INVALID_REQUEST', detail);
      }

      let body: OpenAiChatCompletionResponse;
      try {
        body = (await response.json()) as OpenAiChatCompletionResponse;
      } catch {
        throw new ProviderError('UNKNOWN', 'OpenAI returned a non-JSON response body.');
      }
      addUsage(body);
      const choice = body.choices?.[0];
      const modelVersion = body.model ?? req.model;
      const base = { inputTokens: cumulativeInput, outputTokens: cumulativeOutput, cachedInputTokens: cumulativeCached, latencyMs, modelVersion };

      if (choice?.message?.refusal) {
        // A model refusal is returned as an empty, content_filter result —
        // the gateway's schema validation then rejects it (no fabricated
        // fallback), and the refusal never reaches a user.
        return { rawText: '', finishReason: 'content_filter', ...base };
      }
      const fr = choice?.finish_reason;
      const finishReason: AIGenerateResult['finishReason'] = fr === 'length' ? 'length' : fr === 'content_filter' ? 'content_filter' : fr === 'stop' ? 'stop' : 'error';
      const rawText = choice?.message?.content ?? '';
      if (!rawText) return { rawText: '', finishReason: finishReason === 'stop' ? 'error' : finishReason, ...base };
      return { rawText, finishReason, ...base };
    }
    throw lastError ?? new ProviderError('UNKNOWN', 'OpenAI request failed with no captured error.');
  }

  /**
   * Brief section 14. A ZERO-TOKEN probe: GET /v1/models/{configured model}
   * proves credential validity, network reachability AND that the
   * configured model exists on this account, without spending a token.
   * Never returns any part of the key.
   */
  async validateProviderHealth(): Promise<ProviderHealth> {
    const checkedAt = new Date().toISOString();
    let apiKey: string;
    try {
      apiKey = this.apiKey();
    } catch (e) {
      return { healthy: false, checkedAt, detail: e instanceof Error ? e.message : 'OPENAI_API_KEY is not configured.' };
    }
    const model = getModule11AiModel();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(getModule11AiTimeoutMs(), 10_000));
    try {
      const res = await this.fetchImpl(`${OPENAI_MODELS_URL}/${encodeURIComponent(model)}`, {
        method: 'GET',
        signal: controller.signal,
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      clearTimeout(timer);
      if (res.status === 200) return { healthy: true, checkedAt, detail: `OpenAI reachable; model "${model}" available to this credential (zero-token probe).` };
      if (res.status === 401 || res.status === 403) return { healthy: false, checkedAt, detail: 'OpenAI rejected the Module 11 credential (401/403).' };
      if (res.status === 404) return { healthy: false, checkedAt, detail: `Model "${model}" is not available to this credential (404).` };
      return { healthy: false, checkedAt, detail: `OpenAI models endpoint returned ${res.status}.` };
    } catch (e) {
      clearTimeout(timer);
      const aborted = e instanceof Error && e.name === 'AbortError';
      return { healthy: false, checkedAt, detail: aborted ? 'OpenAI health probe timed out.' : 'OpenAI health probe failed (network).' };
    }
  }

  estimateCost(inputTokens: number, outputTokens: number, model: string): CostEstimate {
    const pricing = OPENAI_FALLBACK_PRICING_PER_1K[model];
    if (!pricing) {
      // No silent default for an unknown model: an unpriced model is
      // reported as costing NaN-free ZERO only if the registry also has no
      // price, which ai_admit_request() treats as unpriced (fails closed on
      // ceilings). Returning a fabricated positive number for an unknown
      // model would be worse than admitting we do not know.
      return { inputTokens, outputTokens, estimatedCostUsd: Number.NaN };
    }
    return { inputTokens, outputTokens, estimatedCostUsd: (inputTokens / 1000) * pricing.input + (outputTokens / 1000) * pricing.output };
  }
}

// Exported for cost-preparation tests / documentation only.
export { estimateTokens };

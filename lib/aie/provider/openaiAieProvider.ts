/**
 * AIE-1 closure mission (section 7) — the real OpenAI GPT-4o mini provider
 * adapter, implementing the SAME `AieAiProvider` interface
 * `lib/aie/provider/mockAieProvider.ts` implements. This is the adapter
 * `mockAieProvider.ts`'s own header named as future work: "wrapping
 * `lib/ai/providers/openaiProvider.ts`'s HTTP-call technique." No new
 * dependency is added — this repo has no `openai` SDK dependency
 * (confirmed: absent from package.json) and Module 11's own
 * `openaiProvider.ts` stub is itself un-wired to any HTTP call, so there is
 * no existing fetch-based technique to literally reuse; this file uses the
 * platform `fetch` already available in the Next.js server runtime,
 * matching the "no unreviewed new dependency" convention documented
 * throughout `lib/aie/**`.
 *
 * PRIVACY (mission section 7.2/7.4). This class NEVER receives raw document
 * bytes, a signed URL, a password, or the identity/mask token map — its
 * only inputs are `AieAiGenerateRequest.systemPrompt`/`userPrompt`, which
 * `lib/aie/provider/gateway.ts` builds exclusively from already-masked text
 * and independently re-verifies contains no residual PII match immediately
 * before this class is ever called (PAY-04). `systemPrompt` explicitly
 * frames the document text as untrusted DATA, not an instruction (PRM-01),
 * so this adapter does not need its own prompt-injection filtering layer —
 * it trusts the gateway's contract and does not weaken it (e.g. never
 * appends anything to `systemPrompt` that could be construed as new
 * instructions from the caller). `store: false` is sent explicitly on every
 * request (section 7.2) — this is NOT described as, and must never be
 * confused with, OpenAI's separately-provisioned Zero Data Retention
 * program; the mission is explicit that the two are different things, and
 * this repo has no evidence either way about the configured project's
 * actual retention settings, which remain a manual account-console check.
 * No browsing/hosted tools/functions are ever included in the request
 * (section 7.4).
 *
 * FAILURE HANDLING (section 7.6). HTTP/network errors and non-2xx
 * responses are mapped to the existing generic `ProviderError` codes so
 * `gateway.ts`'s `mapProviderErrorToOutcome` — already written against that
 * enum — needs no change. Bounded retries (`getAieAiMaxTransientRetries()`,
 * default 2, mission section 8) apply ONLY to transient causes (timeout,
 * 429, 5xx) with jittered backoff; a 4xx (other than 429) or a schema-shape
 * failure is never retried here — a schema-invalid response is instead
 * surfaced to the gateway's own `validateAiOutput` gate as a normal
 * `success` result with bad JSON, which correctly produces `schema_rejected`
 * without this adapter needing to know anything about JSON Schema
 * semantics itself.
 */

import type { AieAiGenerateRequest, AieAiGenerateResult, AieAiProvider } from './types';
import { ProviderError, type ProviderHealth, type CostEstimate } from '@/lib/ai/providers/types';
import { getAieAiMaxTransientRetries, getAieAiTimeoutMs, estimateOpenAiCostUsd } from '../config';
import { getKnownOpenAiJsonSchema } from './openaiJsonSchema';

const OPENAI_CHAT_COMPLETIONS_URL = 'https://api.openai.com/v1/chat/completions';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Deterministic-enough jitter without pulling in a dependency — full-jitter
 * exponential backoff, bounded to a few hundred ms so a bounded retry
 * budget (max 2) cannot itself blow the gateway's own request timeout. */
function backoffMs(attempt: number): number {
  const base = 250 * 2 ** attempt;
  return Math.floor(Math.random() * base);
}

interface OpenAiChatCompletionResponse {
  id?: string;
  model?: string;
  choices?: Array<{
    message?: { content?: string | null; refusal?: string | null };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string; type?: string; code?: string };
}

export class OpenAiAieProvider implements AieAiProvider {
  readonly providerName = 'openai';

  private apiKey(): string {
    // Deliberately a DIFFERENT env var from Module 11's `OPENAI_API_KEY`
    // (mission section 7.1: "use separate DEV credentials/project
    // configuration" — a single shared key would let one feature's outage/
    // quota/kill-switch decision silently affect an unrelated feature).
    const key = process.env.AIE_OPENAI_API_KEY;
    if (!key) {
      throw new ProviderError('AUTH', 'AIE_OPENAI_API_KEY is not configured in this environment — real AIE OpenAI provider cannot be used.');
    }
    return key;
  }

  async generateStructured(req: AieAiGenerateRequest): Promise<AieAiGenerateResult> {
    const apiKey = this.apiKey();
    const jsonSchema = getKnownOpenAiJsonSchema(req.schemaName, req.schemaVersion);
    const maxRetries = getAieAiMaxTransientRetries();
    const timeoutMs = req.timeoutMs ?? getAieAiTimeoutMs();

    let lastError: ProviderError | null = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) await sleep(backoffMs(attempt));

      const start = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await fetch(OPENAI_CHAT_COMPLETIONS_URL, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: req.model,
            messages: [
              { role: 'system', content: req.systemPrompt },
              { role: 'user', content: req.userPrompt },
            ],
            max_tokens: req.maxOutputTokens,
            temperature: req.temperature ?? 0,
            // Explicit, non-default opt-out (mission section 7.2). Not a
            // claim of Zero Data Retention — see module header.
            store: false,
            response_format: {
              type: 'json_schema',
              json_schema: {
                name: `${req.schemaName}_v${req.schemaVersion}`,
                strict: true,
                schema: jsonSchema,
              },
            },
          }),
        });
      } catch (e) {
        clearTimeout(timer);
        const aborted = e instanceof Error && e.name === 'AbortError';
        lastError = aborted
          ? new ProviderError('TIMEOUT', `OpenAI request exceeded ${timeoutMs}ms`)
          : new ProviderError('UNKNOWN', e instanceof Error ? e.message : 'network error calling OpenAI');
        if (aborted && attempt < maxRetries) continue; // transient — retry
        throw lastError;
      }
      clearTimeout(timer);
      const latencyMs = Date.now() - start;

      if (response.status === 401 || response.status === 403) {
        throw new ProviderError('AUTH', 'OpenAI rejected the AIE API credential (401/403).');
      }
      if (response.status === 429) {
        lastError = new ProviderError('RATE_LIMIT', 'OpenAI rate-limited this request (429).');
        if (attempt < maxRetries) continue;
        throw lastError;
      }
      if (response.status >= 500) {
        lastError = new ProviderError('PROVIDER_UNAVAILABLE', `OpenAI returned ${response.status}.`);
        if (attempt < maxRetries) continue;
        throw lastError;
      }
      if (response.status >= 400) {
        // 4xx other than 401/403/429 is a request-shape problem, not
        // transient — never retried (section 7.6: "do not repeatedly retry
        // a semantically invalid result").
        let detail = `OpenAI returned ${response.status}.`;
        try {
          const body = (await response.json()) as OpenAiChatCompletionResponse;
          if (body.error?.message) detail = body.error.message;
        } catch {
          /* body not JSON — keep the generic detail */
        }
        throw new ProviderError('INVALID_REQUEST', detail);
      }

      let body: OpenAiChatCompletionResponse;
      try {
        body = (await response.json()) as OpenAiChatCompletionResponse;
      } catch {
        throw new ProviderError('UNKNOWN', 'OpenAI returned a non-JSON response body.');
      }

      const choice = body.choices?.[0];
      const inputTokens = body.usage?.prompt_tokens ?? 0;
      const outputTokens = body.usage?.completion_tokens ?? 0;
      const modelVersion = body.model ?? req.model;

      if (choice?.message?.refusal) {
        // GW-10 / section 7.6: a model refusal is a distinct, non-schema
        // outcome — never forced through JSON parsing.
        return {
          rawText: '',
          inputTokens,
          outputTokens,
          latencyMs,
          modelVersion,
          finishReason: 'content_filter',
        };
      }

      const finishReasonRaw = choice?.finish_reason;
      const finishReason: AieAiGenerateResult['finishReason'] =
        finishReasonRaw === 'length'
          ? 'length'
          : finishReasonRaw === 'content_filter'
            ? 'content_filter'
            : finishReasonRaw === 'stop'
              ? 'stop'
              : 'error';

      const rawText = choice?.message?.content ?? '';
      if (!rawText && finishReason === 'stop') {
        // Empty content with a normal stop reason is still an anomaly —
        // treat as an error outcome rather than handing the gateway an
        // empty string it would otherwise fail JSON.parse on with a less
        // specific diagnosis.
        return { rawText: '', inputTokens, outputTokens, latencyMs, modelVersion, finishReason: 'error' };
      }

      return { rawText, inputTokens, outputTokens, latencyMs, modelVersion, finishReason };
    }

    // Unreachable in practice (every loop branch above either returns or
    // throws), but keeps the function's control flow provably total.
    throw lastError ?? new ProviderError('UNKNOWN', 'OpenAI request failed with no captured error.');
  }

  async validateProviderHealth(): Promise<ProviderHealth> {
    try {
      this.apiKey();
    } catch (e) {
      return { healthy: false, checkedAt: new Date().toISOString(), detail: e instanceof Error ? e.message : 'no API key configured' };
    }
    // A real health probe would spend a token calling the API — deliberately
    // NOT done automatically (mission: never spend without an explicit,
    // authorised call). Presence of a configured credential is reported as
    // "configured", not "verified live" — the distinction this mission
    // insists on throughout (section 15: "distinguish implementation
    // complete... from production-ready").
    return { healthy: true, checkedAt: new Date().toISOString(), detail: 'AIE_OPENAI_API_KEY configured; live reachability not probed automatically.' };
  }

  estimateCost(inputTokens: number, outputTokens: number, model: string): CostEstimate {
    return { inputTokens, outputTokens, estimatedCostUsd: estimateOpenAiCostUsd(inputTokens, outputTokens, model) };
  }
}

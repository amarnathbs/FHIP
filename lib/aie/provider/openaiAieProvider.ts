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
 *
 * COST ACCOUNTING ACROSS RETRIES (M12C `M2-OPEN-5`). Because those bounded
 * retries mean ONE logical `generateStructured` call can send up to
 * `getAieAiMaxTransientRetries() + 1` real HTTP requests, and OpenAI bills
 * per request, this adapter accumulates `usage` across EVERY attempt and
 * reports the CUMULATIVE totals as `inputTokens`/`outputTokens` — the figures
 * `gateway.ts` settles against. Before this change only the final,
 * successfully-returning attempt's usage was ever read, and on a fully
 * exhausted retry budget (which throws) the accumulated usage was lost
 * entirely and settled as zero.
 *
 * EXACTLY WHICH ATTEMPTS CAN CONTRIBUTE — stated explicitly so the accounting
 * claim is honest rather than implied:
 *   CAN contribute (a body exists and is read):
 *     - the final 2xx attempt (success, refusal, or empty-content);
 *     - a RETRIED 429 or 5xx attempt, IF that response carries a JSON body
 *       with a `usage` object. OpenAI does not guarantee one on an error
 *       response, so this is opportunistic: when present it is counted, when
 *       absent it contributes zero.
 *     - a terminal non-429 4xx attempt, whose body is read anyway for the
 *       error message.
 *   CANNOT contribute (no body exists at all, so any number would be
 *   INVENTED — and inventing one is specifically not done here):
 *     - an attempt that aborted on the client-side timeout;
 *     - an attempt that failed with a network/transport error;
 *     - a 401/403, which is rejected before any body is read.
 * The uncertainty of the timeout case is handled ONE layer up, by
 * `gateway.ts` settling a `timeout` outcome at the full conservative
 * RESERVED amount (`treatAsFullReservedCost`) rather than at an assumed
 * zero — that pre-existing behaviour is deliberately left untouched here.
 */

// M12C §13 (`M2-OPEN-4`): this module reads the AIE provider credential from
// `process.env`. The marker makes that explicit and enforceable — see
// `lib/serverOnly.ts` for what it does, what it deliberately does not do, and
// why the canonical `server-only` package is a named follow-up rather than a
// silent omission.
import '@/lib/serverOnly';
import type { AieAiGenerateRequest, AieAiGenerateResult, AieAiProvider } from './types';
import { attachAieCumulativeUsage } from './types';
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
    // M12C M2-OPEN-5: hoisted OUTSIDE the retry loop exactly as `lastError`
    // already is, so usage survives a `continue` into the next attempt and a
    // `throw` out of the loop entirely. Previously `inputTokens`/
    // `outputTokens` were per-iteration `const`s, so only the one iteration
    // that returned could ever contribute anything.
    let cumulativeInputTokens = 0;
    let cumulativeOutputTokens = 0;
    let attemptCount = 0;
    // AIE-1 final completion (2026-09-25): the OpenAI `x-request-id` of EVERY
    // HTTP attempt, so each billed request is traceable in the OpenAI
    // dashboard and recorded per call (migration 0195). Identifiers only.
    const providerRequestIds: string[] = [];
    // True once at least one request has been handed to the network. A
    // failure after that point may have been billed without usage reported.
    let requestSent = false;
    const addUsage = (body: OpenAiChatCompletionResponse | null): void => {
      cumulativeInputTokens += body?.usage?.prompt_tokens ?? 0;
      cumulativeOutputTokens += body?.usage?.completion_tokens ?? 0;
    };
    /** Read a body we are about to DISCARD (a retried 429/5xx) purely for its
     * `usage`. Deliberately total: a non-JSON or missing body is simply "no
     * usage reported", and can never turn a retryable status into a hard
     * failure — the retry path must not become more fragile than it was
     * before cost accounting was added. */
    const absorbUsageFromDiscardedBody = async (res: Response): Promise<void> => {
      try {
        addUsage((await res.json()) as OpenAiChatCompletionResponse);
      } catch {
        /* no body, non-JSON body, or already-consumed body -> contributes 0 */
      }
    };
    /** Stamp the usage incurred SO FAR onto an error on its way out, so the
     * gateway can settle it instead of assuming zero. */
    const withUsage = <E>(err: E): E =>
      attachAieCumulativeUsage(err, { cumulativeInputTokens, cumulativeOutputTokens, attemptCount, providerRequestIds: [...providerRequestIds], requestSent });

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) await sleep(backoffMs(attempt));

      attemptCount += 1;
      const start = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      requestSent = true;
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
        // No response object at all -> no `usage` exists to read. Contributes
        // nothing rather than a guess (see module header).
        if (aborted && attempt < maxRetries) continue; // transient — retry
        throw withUsage(lastError);
      }
      clearTimeout(timer);
      const latencyMs = Date.now() - start;
      const requestId = response.headers?.get?.('x-request-id');
      if (requestId) providerRequestIds.push(requestId.slice(0, 200));

      if (response.status === 401 || response.status === 403) {
        // Terminal, never retried, and the body is not read — an auth
        // rejection is not a billable completion.
        throw withUsage(new ProviderError('AUTH', 'OpenAI rejected the AIE API credential (401/403).'));
      }
      if (response.status === 429) {
        // M12C M2-OPEN-5: a 429 can still carry a JSON body reporting the
        // tokens the provider already processed for this request. Read it
        // (defensively) BEFORE discarding the response, whether we are about
        // to retry or about to give up.
        await absorbUsageFromDiscardedBody(response);
        lastError = new ProviderError('RATE_LIMIT', 'OpenAI rate-limited this request (429).');
        if (attempt < maxRetries) continue;
        throw withUsage(lastError);
      }
      if (response.status >= 500) {
        await absorbUsageFromDiscardedBody(response);
        lastError = new ProviderError('PROVIDER_UNAVAILABLE', `OpenAI returned ${response.status}.`);
        if (attempt < maxRetries) continue;
        throw withUsage(lastError);
      }
      if (response.status >= 400) {
        // 4xx other than 401/403/429 is a request-shape problem, not
        // transient — never retried (section 7.6: "do not repeatedly retry
        // a semantically invalid result").
        let detail = `OpenAI returned ${response.status}.`;
        try {
          const body = (await response.json()) as OpenAiChatCompletionResponse;
          // This body IS read, so if it reports usage it is counted.
          addUsage(body);
          if (body.error?.message) detail = body.error.message;
        } catch {
          /* body not JSON — keep the generic detail, contribute no usage */
        }
        throw withUsage(new ProviderError('INVALID_REQUEST', detail));
      }

      let body: OpenAiChatCompletionResponse;
      try {
        body = (await response.json()) as OpenAiChatCompletionResponse;
      } catch {
        throw withUsage(new ProviderError('UNKNOWN', 'OpenAI returned a non-JSON response body.'));
      }

      const choice = body.choices?.[0];
      // M12C M2-OPEN-5: this attempt's OWN usage, kept separately and also
      // folded into the cumulative running totals. Everything returned below
      // reports the CUMULATIVE figures as `inputTokens`/`outputTokens` (what
      // settlement must use) and this attempt's own as the explicit
      // `finalAttempt*` fields.
      const finalAttemptInputTokens = body.usage?.prompt_tokens ?? 0;
      const finalAttemptOutputTokens = body.usage?.completion_tokens ?? 0;
      addUsage(body);
      const modelVersion = body.model ?? req.model;

      if (choice?.message?.refusal) {
        // GW-10 / section 7.6: a model refusal is a distinct, non-schema
        // outcome — never forced through JSON parsing.
        return {
          rawText: '',
          inputTokens: cumulativeInputTokens,
          outputTokens: cumulativeOutputTokens,
          finalAttemptInputTokens,
          finalAttemptOutputTokens,
          attemptCount,
          providerRequestIds: [...providerRequestIds],
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
        return {
          rawText: '',
          inputTokens: cumulativeInputTokens,
          outputTokens: cumulativeOutputTokens,
          finalAttemptInputTokens,
          finalAttemptOutputTokens,
          attemptCount,
          providerRequestIds: [...providerRequestIds],
          latencyMs,
          modelVersion,
          finishReason: 'error',
        };
      }

      return {
        rawText,
        inputTokens: cumulativeInputTokens,
        outputTokens: cumulativeOutputTokens,
        finalAttemptInputTokens,
        finalAttemptOutputTokens,
        attemptCount,
        providerRequestIds: [...providerRequestIds],
        // `latencyMs` stays deliberately PER-ATTEMPT (this attempt's own
        // wall-clock), NOT a sum across retries: it is used as a provider
        // responsiveness signal, and summing in backoff sleeps would make it
        // dishonest. Only the token counts are cumulative.
        latencyMs,
        modelVersion,
        finishReason,
      };
    }

    // Unreachable in practice (every loop branch above either returns or
    // throws), but keeps the function's control flow provably total.
    throw withUsage(lastError ?? new ProviderError('UNKNOWN', 'OpenAI request failed with no captured error.'));
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

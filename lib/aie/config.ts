/**
 * AIE-1 closure mission — central, auditable configuration for the real
 * OpenAI GPT-4o mini integration and its cost/quota controls (mission
 * sections 2.3, 7, 8).
 *
 * Every value here is read from an environment variable with an explicit,
 * documented, production-safe default — never a bare magic number scattered
 * across call sites (`lib/aie/orchestrator.ts` previously hardcoded the
 * placeholder model id `'aie-fallback-default'` directly; that is now
 * sourced from here, see `getAieAiModel()`).
 *
 * PRICING DISCLOSURE (mission section 8: "verify current official prices
 * rather than hard-coding historical estimates"). The figures below were
 * confirmed against OpenAI's public pricing page as of 2026-09-13 (the date
 * this closure mission ran): gpt-4o-mini = $0.15 / 1M input tokens, $0.60 /
 * 1M output tokens. `AIE_PRICING_CONFIRMED_DATE` records exactly when this
 * was last checked so a future reader can tell a stale estimate from a
 * freshly-confirmed one — re-verify against
 * https://platform.openai.com/docs/pricing before relying on this for a
 * real production cost decision.
 */

/** The exact model SNAPSHOT id, not a floating alias (mission section 2.3:
 * "pin a supported snapshot after evaluation where practical"). Confirmed
 * via OpenAI's own documentation (2026-09-13) that Structured Outputs with
 * strict json_schema is supported on this snapshot and later. Overridable
 * for a future re-pin, but the override is deliberately a distinct env var
 * from `AIE_AI_PROVIDER`/`AIE_OPENAI_API_KEY` so a pin change is a reviewed,
 * one-line diff, not an accidental drift. */
export function getAieAiModel(): string {
  return process.env.AIE_AI_MODEL?.trim() || 'gpt-4o-mini-2024-07-18';
}

/** Request timeout for one provider call (mission section 6.4/7.6: "define
 * a scan-wait deadline" style bounded wait — this is the AI-call analogue).
 * Default 20s: generous for a small masked-text completion, bounded so a
 * stuck request cannot hold the in-process idempotency lock indefinitely. */
export function getAieAiTimeoutMs(): number {
  const raw = Number(process.env.AIE_AI_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 20_000;
}

/** Mission section 8: "at most two transient retries within the same
 * allowance." Applies only to TIMEOUT/RATE_LIMIT/PROVIDER_UNAVAILABLE —
 * never to a schema-invalid or refused response (section 7.6: "do not
 * repeatedly retry a semantically invalid result"). */
export function getAieAiMaxTransientRetries(): number {
  const raw = Number(process.env.AIE_AI_MAX_TRANSIENT_RETRIES);
  return Number.isFinite(raw) && raw >= 0 ? Math.min(raw, 2) : 2;
}

/** AIE-scoped OpenAI pilot allowance in USD (mission section 8: "US$10
 * application-enforced pilot allowance"). Deliberately a SEPARATE env var
 * from any Module 11 budget — AIE's pilot spend must never silently share
 * or exhaust a different feature's allowance, and vice versa. */
export function getAieCostAllowanceUsd(): number {
  const raw = Number(process.env.AIE_AI_COST_ALLOWANCE_USD);
  return Number.isFinite(raw) && raw > 0 ? raw : 10;
}

/** Per-document output budget the gateway/orchestrator already sends today
 * (`maxOutputTokens: 512` at the one call site) — surfaced here so limits
 * are visible/auditable in one place rather than only inline at the call
 * site, and so this closure mission's cost-admission math and the actual
 * request agree by construction. */
export function getAieAiMaxOutputTokensPerDocument(): number {
  const raw = Number(process.env.AIE_AI_MAX_OUTPUT_TOKENS);
  return Number.isFinite(raw) && raw > 0 ? raw : 512;
}

/** Conservative worst-case input-token estimate used for the PRE-call cost
 * RESERVATION (mission section 8: "reserve a conservative maximum before
 * the provider call"). Actual masked-text length varies per document; this
 * is a ceiling on what one call is allowed to admit against, not a measured
 * value — `costAdmission.ts` settles against the real `usage.*_tokens`
 * the provider returns once the call completes. */
export function getAieAiMaxInputTokensPerDocument(): number {
  const raw = Number(process.env.AIE_AI_MAX_INPUT_TOKENS);
  return Number.isFinite(raw) && raw > 0 ? raw : 4000;
}

/** Dated, auditable indicative pricing (mission section 8: "keep price
 * configuration dated and auditable"). USD per single token (not per 1K/1M)
 * so `estimateCost()` call sites do simple multiplication. */
export const AIE_OPENAI_PRICING = Object.freeze({
  'gpt-4o-mini-2024-07-18': { inputUsdPerToken: 0.15 / 1_000_000, outputUsdPerToken: 0.6 / 1_000_000 },
  // Alias so a caller using the floating name (never sent to the API
  // directly — see `openaiAieProvider.ts` — but useful for cost-estimation
  // call sites that only know the family name) still resolves to the same
  // confirmed figures rather than an unpriced lookup miss.
  'gpt-4o-mini': { inputUsdPerToken: 0.15 / 1_000_000, outputUsdPerToken: 0.6 / 1_000_000 },
});

export const AIE_PRICING_CONFIRMED_DATE = '2026-09-13';

export function estimateOpenAiCostUsd(inputTokens: number, outputTokens: number, model: string): number {
  const pricing = AIE_OPENAI_PRICING[model as keyof typeof AIE_OPENAI_PRICING] ?? AIE_OPENAI_PRICING['gpt-4o-mini'];
  return inputTokens * pricing.inputUsdPerToken + outputTokens * pricing.outputUsdPerToken;
}

/** Which AI provider backs `lib/aie/provider/providerFactory.ts`. Defaults
 * to `'mock'` — the production-safe default (mission: "no silent
 * substitution", and separately, no real provider traffic without an
 * explicit, reviewed opt-in). Set to `'openai'` only once
 * `AIE_OPENAI_API_KEY` is genuinely configured for this environment. */
export function getAieAiProviderKind(): 'mock' | 'openai' {
  return process.env.AIE_AI_PROVIDER === 'openai' ? 'openai' : 'mock';
}

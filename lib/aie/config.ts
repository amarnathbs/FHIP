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

/** The configured default model.
 *
 * M2 (H.5) RE-PIN, 2026-09-15 — was `'gpt-4o-mini-2024-07-18'`.
 *
 * The previous value was a pinned SNAPSHOT id, chosen on the reasoning that
 * a snapshot is more reproducible than a floating alias. That reasoning was
 * sound in the abstract but wrong for this deployment, and it was proven
 * wrong against the real provider rather than argued: M2 issued two real
 * calls to `POST https://api.openai.com/v1/chat/completions` with the
 * configured project key and an identical masked synthetic payload —
 *
 *   `gpt-4o-mini-2024-07-18` -> HTTP 403, error.code=`model_not_found`,
 *       "Project `proj_***` does not have access to model
 *        `gpt-4o-mini-2024-07-18`"
 *   `gpt-4o-mini`            -> HTTP 200, strict json_schema honoured,
 *       usage 261 in / 37 out
 *
 * So the snapshot id was not merely suboptimal, it was UNCALLABLE by the
 * only OpenAI project this application is configured to use: every real AI
 * fallback would have failed 403 the moment `AIE_AI_PROVIDER=openai` was
 * set. This is the Product Owner's decided default (mission Part H.5:
 * "Default configured low-cost model: `gpt-4o-mini`").
 *
 * Reproducibility is NOT lost by using the alias here. The 200 response's
 * own `model` field echoed back `gpt-4o-mini-2024-07-18` — the alias
 * resolves server-side to exactly the snapshot that was pinned before, so
 * this change alters which NAME is sent, not which weights answer. The
 * project allowlist admits the alias and refuses the snapshot id.
 *
 * Still overridable via `AIE_AI_MODEL`, deliberately a distinct env var from
 * `AIE_AI_PROVIDER`/`AIE_OPENAI_API_KEY` so a re-pin is a reviewed one-line
 * diff, not accidental drift. Anything set here must be confirmed callable
 * by the target project's allowlist first — a model name that typechecks is
 * not evidence that the project may call it. */
export function getAieAiModel(): string {
  return process.env.AIE_AI_MODEL?.trim() || 'gpt-4o-mini';
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

/**
 * The SEPARATE output budget for LINE-ITEM documents (2026-09-23, AIE unified
 * document fallback).
 *
 * WHY A SECOND BUDGET RATHER THAN RAISING THE FIRST. Every AI-fallback
 * adapter before this one extracted a fixed, small set of SCALAR facts — a
 * payslip's ~22 header totals, an insurance schedule's 5 fields — for which
 * 512 output tokens is ample. The four document types added by this dispatch
 * are different in kind: a bank statement, a retirement statement and a
 * broker statement are LINE-ITEM documents whose useful content is an array
 * of transactions or holdings. At 512 output tokens a model cannot emit even
 * twenty transaction rows, so the call does not fail loudly — it returns a
 * TRUNCATED array, which is far worse than an error because a truncated
 * statement still looks plausible.
 *
 * Raising `AIE_AI_MAX_OUTPUT_TOKENS` itself would have silently widened the
 * per-call cost ceiling for payslip, insurance and Investment Intelligence
 * too — three mechanisms this dispatch has no authority over and did not
 * test. A separate, separately-overridable value keeps the blast radius to
 * the adapters that actually need it.
 *
 * 4096 is chosen against this codebase's own numbers rather than picked: at
 * gpt-4o-mini's $0.60 / 1M output tokens (see this file's pricing disclosure)
 * a fully-used 4096-token response costs about a quarter of a cent, and it
 * admits roughly 80 transaction rows in this schema's shape — which is the
 * `maxItems` the bank-statement schema sets.
 *
 * TRUNCATION IS STILL POSSIBLE AND IS NOT LEFT TO TRUST. A statement with
 * more rows than the cap is caught deterministically downstream: the AI's
 * rows are re-run through the SAME `reconcileBalances` rollforward the native
 * parser uses, and a missing row makes the closing balance disagree, which
 * marks the import `review_required` rather than certified. The schema also
 * asks the model to state explicitly whether it listed every row.
 */
export function getAieAiMaxOutputTokensPerLineItemDocument(): number {
  const raw = Number(process.env.AIE_AI_MAX_OUTPUT_TOKENS_LINE_ITEMS);
  return Number.isFinite(raw) && raw > 0 ? raw : 4096;
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

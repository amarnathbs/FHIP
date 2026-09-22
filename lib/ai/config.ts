// Module 11 remediation R2 — Module 11's OWN server-side provider
// configuration (brief sections 10-11).
//
// Deliberately separate from lib/aie/config.ts: the AIE document-extraction
// subsystem and Module 11 (personalised insights) are different features
// with different kill switches, different quotas and different credentials.
// Sharing one env var would let one feature's outage/rotation/kill decision
// silently affect the other. The credential NAME here (`OPENAI_API_KEY`) is
// the one Module 11.0's adapter has read since ADR-M11-001 and the one the
// AIE adapter explicitly describes itself as being different from.
//
// EVERYTHING here fails toward "mock"/"off":
//   * MODULE11_AI_PROVIDER unset or anything other than 'openai' -> 'mock'.
//   * MODULE11_AI_MODEL unset -> the Product Owner's approved low-cost tier
//     for the sibling AIE subsystem (gpt-4o-mini) is adopted as the
//     CONFIGURABLE default, per brief section 10. It is a default, not a
//     hard-code: no service anywhere names a model literal.
//   * The model must ALSO exist in ai_model_registry as active+approved for
//     the task, or resolveConfiguredModelForTask() returns null and the
//     generation fails closed with no_approved_model. Configuration alone
//     never authorises a model; the registry does (ADR-M11-001 #14).
//
// NEVER `NEXT_PUBLIC_`. This module is imported only by server code; the
// serverOnly marker throws if it is ever evaluated in a browser.

import '@/lib/serverOnly';

export type Module11Provider = 'mock' | 'openai';

export const MODULE11_DEFAULT_MODEL = 'gpt-4o-mini';
export const MODULE11_DEFAULT_TIMEOUT_MS = 30_000;
export const MODULE11_DEFAULT_MAX_TRANSIENT_RETRIES = 1;

/** Which provider Module 11's governed generations use. Only 'openai' is a real provider; every other value is the zero-cost mock. */
export function getModule11AiProvider(): Module11Provider {
  return process.env.MODULE11_AI_PROVIDER?.trim() === 'openai' ? 'openai' : 'mock';
}

/** The configured model identifier for the real provider. Must still be approved in ai_model_registry to be used. */
export function getModule11AiModel(): string {
  return process.env.MODULE11_AI_MODEL?.trim() || MODULE11_DEFAULT_MODEL;
}

function positiveIntEnv(name: string, fallback: number, max: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.min(Math.floor(raw), max);
}

/** Per-request wall-clock timeout for the real provider. Bounded to 120s so a misconfiguration cannot hold a concurrency lease indefinitely. */
export function getModule11AiTimeoutMs(): number {
  return positiveIntEnv('MODULE11_AI_TIMEOUT_MS', MODULE11_DEFAULT_TIMEOUT_MS, 120_000);
}

/** Transient-failure retry budget (timeout / 429 / 5xx only). Bounded to 3. A value of 0 means "no retries". */
export function getModule11AiMaxTransientRetries(): number {
  const raw = Number(process.env.MODULE11_AI_MAX_TRANSIENT_RETRIES);
  if (!Number.isFinite(raw) || raw < 0) return MODULE11_DEFAULT_MAX_TRANSIENT_RETRIES;
  return Math.min(Math.floor(raw), 3);
}

export type Module11BatchMode = 'provider_batch' | 'sync_fanout';

/**
 * R3 — how the monthly scheduler reaches the real provider.
 *   'provider_batch' -> OpenAI Batch API (50% pricing, 24h window, resumed reconcile).
 *   'sync_fanout'    -> one synchronous call per household inside the submit
 *                       invocation (standard pricing). DEFAULT, because the
 *                       first live probe (2026-09-22) showed this credential's
 *                       OpenAI project is not entitled to the batch model
 *                       variant (403 per item). Switch once the project is.
 * Irrelevant for the mock provider.
 */
export function getModule11BatchMode(): Module11BatchMode {
  return process.env.MODULE11_AI_BATCH_MODE?.trim() === 'provider_batch' ? 'provider_batch' : 'sync_fanout';
}

/** R3 — households per scheduler submit tick. Defaults: 5 in sync_fanout (one HTTP invocation budget), 50 in provider_batch. Bounded 1..500. */
export function getModule11SchedulerMaxHouseholdsPerRun(): number {
  const fallback = getModule11BatchMode() === 'provider_batch' ? 50 : 5;
  return positiveIntEnv('MODULE11_SCHEDULER_MAX_HOUSEHOLDS_PER_RUN', fallback, 500);
}

/** Presence check only — the value is never returned, logged or compared here. */
export function isModule11OpenAiKeyConfigured(): boolean {
  return Boolean(process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim().length > 0);
}

/**
 * A secret-free description of the configuration for health/admin surfaces
 * (brief section 14: "Health response must not expose secrets").
 */
export function describeModule11AiConfig(): {
  provider: Module11Provider;
  model: string;
  timeout_ms: number;
  max_transient_retries: number;
  credential_configured: boolean;
  batch_mode: Module11BatchMode;
  scheduler_max_households_per_run: number;
} {
  const provider = getModule11AiProvider();
  return {
    provider,
    model: provider === 'openai' ? getModule11AiModel() : 'mock-standard-1',
    timeout_ms: getModule11AiTimeoutMs(),
    max_transient_retries: getModule11AiMaxTransientRetries(),
    credential_configured: provider === 'openai' ? isModule11OpenAiKeyConfigured() : true,
    batch_mode: getModule11BatchMode(),
    scheduler_max_households_per_run: getModule11SchedulerMaxHouseholdsPerRun(),
  };
}

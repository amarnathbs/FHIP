/**
 * AIE-1.1 — the AI gateway: the ONE typed internal extraction operation
 * (GW-01..12, PAY-01..12). No adapter, route, or browser call may reach an
 * AI provider except through this class (P2 in AIE_1_MASTER_PLAN.md /
 * AIE-1.1 section 4: "No adapter or browser route may call/select an AI
 * provider directly").
 *
 * Enforces, in order:
 *   1. Global kill switch (CST-08/GW-03).
 *   2. Defensive re-scan for residual unmasked PII (PAY-04) — refuses to
 *      build a payload from text that still matches a known PII pattern,
 *      independent of whether the caller claims it already masked it.
 *   3. In-process idempotency collapse (CST-05/GW-06): concurrent calls
 *      sharing an idempotency key collapse to exactly one provider call.
 *      (Cross-process/duplicate-attempt collapse is additionally enforced
 *      by `aie_ai_completion_attempt.idempotency_key`'s UNIQUE constraint —
 *      this in-memory map only prevents redundant provider calls WITHIN one
 *      process; the DB is the real source of truth once persisted.)
 *   4. Provider call, mapped to typed, privacy-safe outcomes (GW-10: "never
 *      return raw provider response to users").
 *   5. Strict schema validation of the raw response (JSC gate) — this
 *      gateway does not trust its own provider's output any more than any
 *      other provider's.
 */

import type { AieAiProvider } from './types';
import { readAieCumulativeUsage } from './types';
import { ProviderError } from '@/lib/ai/providers/types';
import { containsUnmaskedPii } from '../masking/piiMasking';
import { isPermittedAieModel } from '../config';
import { validateAiOutput } from '../schema/schemaRegistry';
import type { AieAiOutcome } from '../types';

export interface AieFieldCompletionRequest {
  systemPrompt: string;
  /** Must already be the output of `maskText()` — this gateway re-checks
   * but does not itself mask. */
  maskedUserPrompt: string;
  schemaName: string;
  schemaVersion: string;
  model: string;
  maxOutputTokens: number;
  requestedFields: string[];
  idempotencyKey: string;
}

export interface AieFieldCompletionResult {
  // 'budget_exhausted' (AIE-1 closure mission, section 8): the atomic cost
  // admission reservation was refused -- the provider was never called.
  outcome: AieAiOutcome | 'kill_switch_blocked' | 'unmasked_pii_detected' | 'budget_exhausted';
  data?: unknown;
  errorCodes?: string[];
  inputTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
  /** AIE-1 final completion: provider request ids of every HTTP attempt made
   * for this call (OpenAI `x-request-id`). Empty when nothing was sent. */
  providerRequestIds?: string[];
  /** Set only when the provider call threw: a CATEGORY code, never a message
   * (GW-10) -- the ProviderError code (AUTH, TIMEOUT, INVALID_REQUEST, ...),
   * or NON_PROVIDER_ERROR:<error class>[:<network cause code>]. The full
   * sanitised message goes to the server log only. */
  failureCode?: string;
}

const FAILURE_DETAIL_MAX = 240;
const CODE_TOKEN = /^[A-Za-z0-9_]{1,40}$/;

/** `code`: a category safe to hand to callers and persist (identifier
 * tokens only, no free text). `detail`: a bounded, secret-redacted one-line
 * summary for the SERVER LOG ONLY -- it may carry runtime text such as host
 * names, which GW-10 keeps away from callers. Neither ever contains the
 * masked prompt or the document. */
export function describeProviderFailure(e: unknown): { code: string; detail: string } {
  let code: string = e instanceof ProviderError ? e.code : 'NON_PROVIDER_ERROR';
  let detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  const cause = e instanceof Error ? (e as Error & { cause?: unknown }).cause : undefined;
  if (!(e instanceof ProviderError) && e instanceof Error && CODE_TOKEN.test(e.name)) code += `:${e.name}`;
  if (cause instanceof Error) {
    const causeCode = (cause as Error & { code?: unknown }).code;
    if (!(e instanceof ProviderError) && typeof causeCode === 'string' && CODE_TOKEN.test(causeCode)) code += `:${causeCode}`;
    detail += ` (cause ${cause.name}${typeof causeCode === 'string' ? ` ${causeCode}` : ''}: ${cause.message})`;
  }
  detail = detail.replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-[redacted]').replace(/\s+/g, ' ').trim();
  if (detail.length > FAILURE_DETAIL_MAX) detail = `${detail.slice(0, FAILURE_DETAIL_MAX - 3)}...`;
  return { code, detail };
}

export interface AieGatewayOptions {
  /** GW-03: "enforce user/tenant/adapter/global feature-kill switches."
   * Defaults to reading `AIE_AI_FALLBACK_ENABLED` — production-safe default
   * is DISABLED (undefined/anything other than 'true' blocks AI fallback,
   * deterministic processing still proceeds — architecture prohibition:
   * "no production... provider traffic... without separate authority"). */
  isKillSwitchEnabled?: () => boolean;
  /** Optional persistence hook — called once per genuinely-attempted
   * provider call (never for calls collapsed by in-flight dedup) so the
   * caller can write `aie_ai_completion_attempt` /
   * `aie_schema_validation_result` rows. Kept as an injected callback so
   * this class stays unit-testable without a database. */
  recordAttempt?: (record: {
    idempotencyKey: string;
    outcome: AieAiOutcome;
    inputTokens?: number;
    outputTokens?: number;
    latencyMs?: number;
    schemaValid?: boolean;
    errorCodes?: string[];
  }) => Promise<void>;
  /**
   * AIE-1 closure mission (section 8) — atomic cost admission, injected the
   * same way `recordAttempt` is so this class stays unit-testable without a
   * database/RPC. When supplied, a conservative reservation is made BEFORE
   * every genuinely-attempted provider call (never for kill_switch_blocked/
   * unmasked_pii_detected, which never reach the provider at all) and
   * settled against the actual observed usage afterward, regardless of
   * outcome. If the reservation is refused (budget exhausted), the provider
   * is never called at all — a new `budget_exhausted` outcome, distinct
   * from every existing provider-side outcome, so callers/tests can tell
   * "the provider said no" apart from "we never asked."
   */
  costAdmission?: {
    reserve: (
      model: string,
      idempotencyKey: string,
      sizing?: { promptChars?: number; maxOutputTokens?: number },
    ) => Promise<{ admitted: boolean; reservedUsd: number }>;
    settle: (params: {
      reservedUsd: number;
      actualInputTokens: number;
      actualOutputTokens: number;
      model: string;
      idempotencyKey: string;
      treatAsFullReservedCost?: boolean;
      providerRequestIds?: string[];
      callOutcome?: string;
    }) => Promise<unknown>;
  };
}

function defaultKillSwitch(): boolean {
  return process.env.AIE_AI_FALLBACK_ENABLED === 'true';
}

export class AieDocumentAiGateway {
  private readonly inFlight = new Map<string, Promise<AieFieldCompletionResult>>();

  constructor(
    private readonly provider: AieAiProvider,
    private readonly options: AieGatewayOptions = {},
  ) {}

  async requestFieldCompletion(req: AieFieldCompletionRequest): Promise<AieFieldCompletionResult> {
    const killSwitchEnabled = this.options.isKillSwitchEnabled ?? defaultKillSwitch;
    if (!killSwitchEnabled()) {
      return { outcome: 'kill_switch_blocked' };
    }

    // AIE-1 final completion (2026-09-25): the contract is GPT-4o mini ONLY,
    // with no substitution or escalation. A model outside the permitted set
    // (e.g. a mistyped or widened AIE_AI_MODEL) is blocked before any
    // reservation or provider call, exactly like the kill switch.
    if (!isPermittedAieModel(req.model)) {
      console.error(`aie gateway refused a non-permitted model for key ${req.idempotencyKey}`);
      return { outcome: 'kill_switch_blocked' };
    }

    if (containsUnmaskedPii(req.maskedUserPrompt) || containsUnmaskedPii(req.systemPrompt)) {
      // P1 / PAY-04: never build or send a payload carrying a residual PII
      // pattern match, regardless of what the caller claims.
      return { outcome: 'unmasked_pii_detected' };
    }

    const existing = this.inFlight.get(req.idempotencyKey);
    if (existing) return existing;

    const promise = this.executeOnce(req).finally(() => {
      this.inFlight.delete(req.idempotencyKey);
    });
    this.inFlight.set(req.idempotencyKey, promise);
    return promise;
  }

  private async executeOnce(req: AieFieldCompletionRequest): Promise<AieFieldCompletionResult> {
    // AIE-1 closure mission (section 8): reserve a conservative maximum
    // BEFORE the provider call. Never for a call that was never going to
    // reach the provider (kill switch / PII guard already returned earlier
    // in requestFieldCompletion, before this method is ever entered) -- so
    // every reservation made here corresponds to a genuine attempt, and
    // every genuine attempt is settled below regardless of how it ends.
    let reservedUsd = 0;
    if (this.options.costAdmission) {
      // req.idempotencyKey identifies this ONE logical attempt at both the
      // gateway's own in-memory in-flight layer AND (migration 0152) the
      // DB-level reserve/settle idempotency layer -- one key, one identity,
      // across both defenses, rather than a second key concept.
      const reservation = await this.options.costAdmission.reserve(req.model, req.idempotencyKey, {
        promptChars: req.systemPrompt.length + req.maskedUserPrompt.length,
        maxOutputTokens: req.maxOutputTokens,
      });
      if (!reservation.admitted) {
        // No provider call, no recordAttempt (nothing was attempted) --
        // matches kill_switch_blocked/unmasked_pii_detected precedent.
        return { outcome: 'budget_exhausted' };
      }
      reservedUsd = reservation.reservedUsd;
    }
    // M12C M2-OPEN-5: `settle` is called on EXACTLY ONE code path per
    // `executeOnce` (throw / refused / schema_rejected / success are mutually
    // exclusive and each returns immediately), and `executeOnce` itself runs
    // once per idempotency key thanks to the in-flight collapse above --
    // so "never double-settle" needs no new TypeScript mechanism here. The
    // cross-process guarantee is separately enforced in SQL by
    // `aie_ai_cost_attempt.idempotency_key` + the `v_already_settled` guard
    // (migration 0152), and `req.idempotencyKey` is threaded through
    // unchanged so a replay collapses there.
    const settle = (
      actualInputTokens: number,
      actualOutputTokens: number,
      treatAsFullReservedCost: boolean,
      providerRequestIds: string[] | undefined,
      callOutcome: string,
    ) =>
      this.options.costAdmission?.settle({
        reservedUsd,
        actualInputTokens,
        actualOutputTokens,
        model: req.model,
        idempotencyKey: req.idempotencyKey,
        treatAsFullReservedCost,
        providerRequestIds: providerRequestIds ?? [],
        callOutcome,
      }) ?? Promise.resolve();

    let raw;
    try {
      raw = await this.provider.generateStructured({
        systemPrompt: req.systemPrompt,
        userPrompt: req.maskedUserPrompt,
        schemaName: req.schemaName,
        schemaVersion: req.schemaVersion,
        model: req.model,
        maxOutputTokens: req.maxOutputTokens,
      });
    } catch (e) {
      const outcome = mapProviderErrorToOutcome(e);
      // Section 8: "handle uncertain charges after timeouts conservatively"
      // -- a TIMEOUT specifically means the provider may or may not have
      // actually processed (and been billed for) the request, so it settles
      // at the full conservative reserved amount rather than assumed zero.
      // Every other pre-response failure (auth/rate-limit/network) genuinely
      // never produced billable tokens.
      // M12C M2-OPEN-5: the provider may have sent SEVERAL real HTTP requests
      // (bounded transient retries) before giving up, and the provider bills
      // per request. Any usage those attempts actually reported rides on the
      // thrown error (see `attachAieCumulativeUsage` in ./types) and is
      // settled here instead of the previous hard-coded `0, 0`, which
      // under-billed the ledger on every exhausted-retry failure. An error
      // carrying nothing (any non-AIE provider, or a failure before the first
      // attempt) reads back as null and still settles zero -- never a guess.
      const incurred = readAieCumulativeUsage(e);
      // AIE-1 final completion: a network failure AFTER the request left this
      // process (ProviderError UNKNOWN with requestSent) is as uncertain as a
      // timeout -- the provider may have processed and billed it -- so it is
      // settled at the full reservation too, never assumed free.
      const billingUncertain =
        outcome === 'timeout' || (incurred?.requestSent === true && e instanceof ProviderError && e.code === 'UNKNOWN');
      await settle(incurred?.cumulativeInputTokens ?? 0, incurred?.cumulativeOutputTokens ?? 0, billingUncertain, incurred?.providerRequestIds, outcome);
      await this.options.recordAttempt?.({
        idempotencyKey: req.idempotencyKey,
        outcome,
        // Recorded only when genuinely observed, so the evidence row keeps
        // saying "unknown" (null) rather than a fabricated 0 when the
        // provider reported nothing at all.
        ...(incurred ? { inputTokens: incurred.cumulativeInputTokens, outputTokens: incurred.cumulativeOutputTokens } : {}),
      });
      // GW-10: never return the raw provider error to the caller -- only its
      // category code; the sanitised message goes to the server log. Without
      // these the first production payslip attempts (2026-09-25) recorded a
      // bare 'provider_error' with no request id and no way to tell a missing
      // key from a network failure from a local exception.
      const failure = describeProviderFailure(e);
      console.error(`aie gateway provider failure for key ${req.idempotencyKey}: ${failure.code} -- ${failure.detail}`);
      return {
        outcome,
        providerRequestIds: incurred?.providerRequestIds ?? [],
        ...(incurred ? { inputTokens: incurred.cumulativeInputTokens, outputTokens: incurred.cumulativeOutputTokens } : {}),
        failureCode: failure.code,
      };
    }

    // M12C M2-OPEN-5: `raw.inputTokens`/`raw.outputTokens` are CUMULATIVE
    // across every provider attempt inside this one call (contract documented
    // on `AieAiGenerateResult`), so all three settle sites below are already
    // summing retries -- no call-site arithmetic here, which is what keeps
    // "sum across attempts" and "settle exactly once" from fighting.
    if (raw.finishReason === 'content_filter' || raw.finishReason === 'error') {
      await settle(raw.inputTokens, raw.outputTokens, false, raw.providerRequestIds, 'refused');
      await this.options.recordAttempt?.({
        idempotencyKey: req.idempotencyKey,
        outcome: 'refused',
        inputTokens: raw.inputTokens,
        outputTokens: raw.outputTokens,
        latencyMs: raw.latencyMs,
      });
      return { outcome: 'refused', providerRequestIds: raw.providerRequestIds ?? [], inputTokens: raw.inputTokens, outputTokens: raw.outputTokens };
    }

    const validation = validateAiOutput({ schemaName: req.schemaName, schemaVersion: req.schemaVersion, rawText: raw.rawText });
    if (!validation.valid) {
      await settle(raw.inputTokens, raw.outputTokens, false, raw.providerRequestIds, 'schema_rejected');
      await this.options.recordAttempt?.({
        idempotencyKey: req.idempotencyKey,
        outcome: 'schema_rejected',
        inputTokens: raw.inputTokens,
        outputTokens: raw.outputTokens,
        latencyMs: raw.latencyMs,
        schemaValid: false,
        errorCodes: validation.errorCodes,
      });
      return { outcome: 'schema_rejected', errorCodes: validation.errorCodes, providerRequestIds: raw.providerRequestIds ?? [], inputTokens: raw.inputTokens, outputTokens: raw.outputTokens };
    }

    await settle(raw.inputTokens, raw.outputTokens, false, raw.providerRequestIds, 'success');
    await this.options.recordAttempt?.({
      idempotencyKey: req.idempotencyKey,
      outcome: 'success',
      inputTokens: raw.inputTokens,
      outputTokens: raw.outputTokens,
      latencyMs: raw.latencyMs,
      schemaValid: true,
    });

    return {
      outcome: 'success',
      data: validation.data,
      inputTokens: raw.inputTokens,
      outputTokens: raw.outputTokens,
      latencyMs: raw.latencyMs,
      providerRequestIds: raw.providerRequestIds ?? [],
    };
  }
}

function mapProviderErrorToOutcome(e: unknown): AieAiOutcome {
  if (e instanceof ProviderError) {
    switch (e.code) {
      case 'TIMEOUT':
        return 'timeout';
      case 'RATE_LIMIT':
        return 'rate_limited';
      default:
        return 'provider_error';
    }
  }
  return 'provider_error';
}

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
import { ProviderError } from '@/lib/ai/providers/types';
import { containsUnmaskedPii } from '../masking/piiMasking';
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
    reserve: (model: string) => Promise<{ admitted: boolean; reservedUsd: number }>;
    settle: (params: { reservedUsd: number; actualInputTokens: number; actualOutputTokens: number; model: string; treatAsFullReservedCost?: boolean }) => Promise<void>;
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
      const reservation = await this.options.costAdmission.reserve(req.model);
      if (!reservation.admitted) {
        // No provider call, no recordAttempt (nothing was attempted) --
        // matches kill_switch_blocked/unmasked_pii_detected precedent.
        return { outcome: 'budget_exhausted' };
      }
      reservedUsd = reservation.reservedUsd;
    }
    const settle = (actualInputTokens: number, actualOutputTokens: number, treatAsFullReservedCost = false) =>
      this.options.costAdmission?.settle({ reservedUsd, actualInputTokens, actualOutputTokens, model: req.model, treatAsFullReservedCost }) ?? Promise.resolve();

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
      await settle(0, 0, outcome === 'timeout');
      await this.options.recordAttempt?.({ idempotencyKey: req.idempotencyKey, outcome });
      // GW-10: never return the raw provider error to the caller.
      return { outcome };
    }

    if (raw.finishReason === 'content_filter' || raw.finishReason === 'error') {
      await settle(raw.inputTokens, raw.outputTokens);
      await this.options.recordAttempt?.({
        idempotencyKey: req.idempotencyKey,
        outcome: 'refused',
        inputTokens: raw.inputTokens,
        outputTokens: raw.outputTokens,
        latencyMs: raw.latencyMs,
      });
      return { outcome: 'refused' };
    }

    const validation = validateAiOutput({ schemaName: req.schemaName, schemaVersion: req.schemaVersion, rawText: raw.rawText });
    if (!validation.valid) {
      await settle(raw.inputTokens, raw.outputTokens);
      await this.options.recordAttempt?.({
        idempotencyKey: req.idempotencyKey,
        outcome: 'schema_rejected',
        inputTokens: raw.inputTokens,
        outputTokens: raw.outputTokens,
        latencyMs: raw.latencyMs,
        schemaValid: false,
        errorCodes: validation.errorCodes,
      });
      return { outcome: 'schema_rejected', errorCodes: validation.errorCodes };
    }

    await settle(raw.inputTokens, raw.outputTokens);
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

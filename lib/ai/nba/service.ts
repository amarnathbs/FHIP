// Module 11.6 — AINextBestActionService: the ONE entry point consumer
// surfaces (the NBA API, SQ-AI-003/025, the Insight Pack ranking source)
// use to obtain the deterministic Next Best Actions.
//
// STRUCTURAL ISOLATION FROM LIVE AI (brief sections 47-48) — the same
// discipline as Module 11.4/11.5, enforced by an import-boundary test:
//   - lib/ai/gateway/aiModelGateway ......... NOT imported, never may be
//   - lib/ai/providers/* .................... NOT imported, never may be
//   - the admission RPC / quota reservation .. NOT imported/called
// The engine (lib/ai/nba/engine.ts) is a pure function; this service adds
// only entitlement, the kill switches, the certified-context build, the
// audit row and the tenant boundary.
//
// KILL-SWITCH SEMANTICS (0178): ai_globally_enabled=false -> unavailable;
// next_best_action_enabled=false -> unavailable; live_provider_enabled has
// NO effect (asserted by test). Premium required, same as SQ-AI-003/025.

import { createAdminClient } from '@/lib/supabase/admin';
import { AIEntitlementService } from '@/lib/ai/entitlement/aiEntitlementService';
import { AI_CAPABILITY_IMPLEMENTED } from '@/lib/ai/entitlement/capabilities';
import { getPlatformControls } from '@/lib/ai/entitlement/platformControls';
import { createRouterDependencies } from '@/lib/ai/resolution/routerDependencies';
import type { FinancialContextObject } from '@/lib/ai/context/types';
import { evaluateNextBestActions } from '@/lib/ai/nba/engine';
import type { NbaEvaluation } from '@/lib/ai/nba/types';

export type NbaStatus = 'AVAILABLE' | 'NO_ACTIONS' | 'PREMIUM_REQUIRED' | 'FEATURE_DISABLED' | 'INSUFFICIENT_DATA';
export type NbaTrigger = 'api' | 'standard_question' | 'insight_pack' | 'admin';

export interface NbaResponse {
  status: NbaStatus;
  evaluation: NbaEvaluation | null;
  /** Structural invariants echoed for the client and for tests. */
  provider_called: false;
  custom_quota_consumed: false;
  note: string;
}

export interface NbaServiceDeps {
  isPersonalisedAiEligible: (userId: string, householdId: string | null) => Promise<boolean>;
  getControls: () => Promise<{ ai_globally_enabled: boolean; next_best_action_enabled?: boolean } | null>;
  buildContext: (userId: string, householdId: string | null) => Promise<FinancialContextObject>;
  recordEvaluation: (userId: string, householdId: string | null, evaluation: NbaEvaluation, trigger: NbaTrigger) => Promise<void>;
}

export const NBA_NOTE = 'Next Best Action is computed by FHIP\'s deterministic rules from your certified data. No AI model selects or orders these actions, and they never use your custom AI question allowance.';

/**
 * Audit write, never fatal: an audit failure (e.g. migration 0178 not yet
 * applied) must not turn a correct deterministic answer into an error for
 * the user; it is logged and surfaced by the admin screen's unavailable
 * state. Exported so SQ-AI-003/025 record their evaluations the same way.
 */
export async function recordNbaEvaluationSafely(userId: string, householdId: string | null, evaluation: NbaEvaluation, trigger: NbaTrigger): Promise<void> {
  try {
    const admin = createAdminClient();
    const { error } = await admin.from('ai_next_best_action_evaluations').insert({
      user_id: userId, household_id: householdId, snapshot_id: evaluation.snapshot_id, context_hash: evaluation.context_hash,
      rules_version: evaluation.rules_version, ranking_policy_version: evaluation.ranking_policy_version,
      country: evaluation.country, reporting_currency: evaluation.reporting_currency,
      candidate_count: evaluation.candidates.length, suppressed_count: evaluation.suppressed.length, action_count: evaluation.actions.length,
      action_codes: evaluation.actions.map((a) => a.action_code),
      actions_json: evaluation.actions, suppressed_json: evaluation.suppressed, trigger,
    });
    if (error) console.error('[AINextBestActionService] audit insert failed:', error.message);
  } catch (e) {
    console.error('[AINextBestActionService] audit insert failed:', e instanceof Error ? e.message : e);
  }
}

export function createRealNbaDeps(): NbaServiceDeps {
  return {
    isPersonalisedAiEligible: (userId, householdId) => AIEntitlementService.isPersonalisedAIEligible(userId, householdId ?? undefined),
    getControls: () => getPlatformControls(),
    buildContext: (userId, householdId) => createRouterDependencies(userId, householdId).buildContext('FULL'),
    recordEvaluation: recordNbaEvaluationSafely,
  };
}

export class AINextBestActionService {
  constructor(private readonly deps: NbaServiceDeps = createRealNbaDeps()) {}

  /**
   * Evaluate for the AUTHENTICATED subject only. `userId`/`householdId`
   * come from resolveHouseholdContext() (server-side), never from a request
   * body — a client cannot evaluate another household (tested).
   */
  async evaluate(userId: string, householdId: string | null, trigger: NbaTrigger = 'api', prebuilt?: FinancialContextObject): Promise<NbaResponse> {
    const base = { provider_called: false as const, custom_quota_consumed: false as const, note: NBA_NOTE };
    if (!AI_CAPABILITY_IMPLEMENTED.AI_NEXT_BEST_ACTION) return { ...base, status: 'FEATURE_DISABLED', evaluation: null };
    const controls = await this.deps.getControls().catch(() => null);
    if (!controls || !controls.ai_globally_enabled || controls.next_best_action_enabled === false) return { ...base, status: 'FEATURE_DISABLED', evaluation: null };
    if (!(await this.deps.isPersonalisedAiEligible(userId, householdId))) return { ...base, status: 'PREMIUM_REQUIRED', evaluation: null };

    let ctx: FinancialContextObject;
    try {
      ctx = prebuilt ?? (await this.deps.buildContext(userId, householdId));
    } catch {
      return { ...base, status: 'INSUFFICIENT_DATA', evaluation: null };
    }
    if (ctx.meta.certification_status === 'INVALID' || ctx.meta.certification_status === 'UNAVAILABLE') {
      return { ...base, status: 'INSUFFICIENT_DATA', evaluation: null };
    }
    const evaluation = evaluateNextBestActions(ctx);
    await this.deps.recordEvaluation(userId, householdId, evaluation, trigger);
    return { ...base, status: evaluation.actions.length === 0 ? 'NO_ACTIONS' : 'AVAILABLE', evaluation };
  }
}

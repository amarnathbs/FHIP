'use client';

// Module 11.5 — the shared client-side registry fetch (spec sections 58, 72).
//
// A page can host a dozen Explain controls. Each one needs the same two
// answers ("is the feature on?" and "is this household entitled?"), so this
// module holds ONE in-flight promise for the whole page rather than letting
// every button issue its own request. That keeps the added network cost of
// Module 11.5 at exactly one cheap, financial-data-free GET per page load,
// however many controls are rendered.
//
// Nothing here caches an ANSWER. Only the target registry and the two
// booleans are shared; every explanation is resolved fresh on click, so a
// stale answer can never be shown (and there is no semantic/embedding cache
// anywhere — spec section 95).

export interface ContextualTargetSummary {
  target_code: string;
  module: string;
  display_label: string;
  display_question: string;
  target_entity_type: 'goal' | 'report' | null;
  premium_required: boolean;
}

export interface ContextualRegistry {
  feature_enabled: boolean;
  entitled: boolean;
  targets: ContextualTargetSummary[];
}

const FAIL_CLOSED: ContextualRegistry = { feature_enabled: false, entitled: false, targets: [] };

let inFlight: Promise<ContextualRegistry> | null = null;

export function loadContextualRegistry(): Promise<ContextualRegistry> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const res = await fetch('/api/ai/contextual-explanations');
      if (!res.ok) return FAIL_CLOSED;
      const body = await res.json();
      const data = body?.data;
      if (!data || typeof data !== 'object') return FAIL_CLOSED;
      return {
        feature_enabled: Boolean(data.feature_enabled),
        entitled: Boolean(data.entitled),
        targets: Array.isArray(data.targets) ? (data.targets as ContextualTargetSummary[]) : [],
      };
    } catch {
      // Fail closed: a registry we could not read must not render controls.
      return FAIL_CLOSED;
    }
  })();
  return inFlight;
}

/** Test-only reset so one spec's fetch stub cannot leak into the next. */
export function __resetContextualRegistryCache(): void {
  inFlight = null;
}

export interface ContextualAnswerPayload {
  module: string;
  target_code: string;
  target_id: string | null;
  status: string;
  status_label: string;
  question: string;
  answer: { headline: string; summary: string; key_points: string[]; limitations: string[] } | null;
  answer_origin_labels: string[];
  data_as_of: string | null;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | null;
  source_context_label: string | null;
  historical_context: boolean;
  related_module: string;
  action_route: string;
  insights_route: string;
  provider_called: false;
  custom_quota_consumed: false;
  eligible_targets?: { id: string; label: string }[];
}

/**
 * Resolves ONE contextual explanation.
 *
 * The body carries only a target code and (where the registry says the target
 * needs one) an owned entity id. There is no field here through which a user
 * could send text — the UI has no text input at all (spec section 96).
 */
export async function resolveContextualExplanation(input: {
  targetCode: string;
  targetId?: string | null;
  contextId?: string | null;
}): Promise<ContextualAnswerPayload | null> {
  const res = await fetch('/api/ai/contextual-explanations/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      target_code: input.targetCode,
      ...(input.targetId ? { target_id: input.targetId } : {}),
      ...(input.contextId ? { context_id: input.contextId } : {}),
    }),
  });
  if (!res.ok) return null;
  const body = await res.json();
  return (body?.data as ContextualAnswerPayload) ?? null;
}

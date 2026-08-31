// Module 11.1 — AI enforcement observability counters (spec section 60).
//
// Section 60 names the counters that must exist and adds one hard constraint:
// "No raw personal financial data in telemetry."
//
// DESIGN. Counters are held in-process and are also derivable from the
// database, which is the important half: ai_admission_events and
// ai_operational_events already record every one of these facts durably, with
// a user id, a reason and a timestamp, and the admin usage endpoint aggregates
// them. This module exists so that a metric is emitted at the moment the
// decision is made — including for the decisions that never reach the database
// at all, such as an entitlement denial raised before any RPC call, or an
// enforcement outage where the database is exactly what is unavailable.
//
// PRIVACY (spec sections 60, 61). The label allowlist below is an ALLOWLIST,
// not a denylist: any label key not on it is dropped, and every value is
// coerced to a short string. A user id is deliberately NOT an accepted label —
// per-subject attribution belongs in the audit tables, which are RLS-protected
// and admin-gated, not in a metrics stream. Nothing financial can reach here
// because no financial field name is accepted.

export type AIMetricName =
  | 'ai_entitlement_allowed'
  | 'ai_entitlement_denied'
  | 'ai_quota_reserved'
  | 'ai_quota_consumed'
  | 'ai_quota_released'
  | 'ai_quota_exhausted'
  | 'ai_rate_limited'
  | 'ai_concurrency_denied'
  | 'ai_user_cost_blocked'
  | 'ai_global_cost_blocked'
  | 'ai_provider_disabled'
  | 'ai_model_disabled'
  | 'ai_kill_switch_blocked'
  | 'ai_idempotency_reuse'
  // Module 11.2 — resolution router (spec sections 58-59).
  | 'resolver_requests_total'
  | 'resolver_deterministic'
  | 'resolver_knowledge_base'
  | 'resolver_stored_personalised'
  | 'resolver_exact_cache'
  | 'resolver_live_ai_required'
  | 'resolver_blocked'
  | 'resolver_unsupported'
  | 'resolver_unavailable'
  | 'resolver_partial'
  | 'ai_avoided_calls';

/**
 * The ONLY label keys that may accompany a metric. Everything else is dropped
 * silently rather than sanitised, because a value we did not anticipate is a
 * value we cannot vouch for.
 */
const ALLOWED_LABELS = new Set(['reason', 'capability', 'request_class', 'usage_outcome', 'task_type', 'provider', 'model', 'outcome', 'intent_family', 'resolution_type']);

export type AIMetricLabels = Record<string, string | number | boolean | null | undefined>;

interface Counter { name: AIMetricName; labels: Record<string, string>; count: number }

const counters = new Map<string, Counter>();

function sanitise(labels: AIMetricLabels | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!labels) return out;
  for (const [k, v] of Object.entries(labels)) {
    if (!ALLOWED_LABELS.has(k)) continue;
    if (v === null || v === undefined) continue;
    // Bounded length: a label is a dimension, not a payload.
    out[k] = String(v).slice(0, 64);
  }
  return out;
}

function keyOf(name: AIMetricName, labels: Record<string, string>): string {
  return name + '|' + Object.keys(labels).sort().map((k) => `${k}=${labels[k]}`).join(',');
}

export function recordAiMetric(name: AIMetricName, labels?: AIMetricLabels, by = 1): void {
  const safe = sanitise(labels);
  const key = keyOf(name, safe);
  const existing = counters.get(key);
  if (existing) existing.count += by;
  else counters.set(key, { name, labels: safe, count: by });
}

/** Snapshot for tests and for an admin diagnostics surface. */
export function snapshotAiMetrics(): Counter[] {
  return [...counters.values()].map((c) => ({ ...c, labels: { ...c.labels } }));
}

export function getAiMetric(name: AIMetricName, labels?: AIMetricLabels): number {
  return counters.get(keyOf(name, sanitise(labels)))?.count ?? 0;
}

/** Total across every label combination for one counter name. */
export function getAiMetricTotal(name: AIMetricName): number {
  let total = 0;
  for (const c of counters.values()) if (c.name === name) total += c.count;
  return total;
}

export function resetAiMetrics(): void {
  counters.clear();
}

/**
 * Maps one admission verdict onto the section 60 counter set. Kept in this
 * module (rather than scattered at each denial site) so that adding a deny
 * reason without a corresponding metric is a single-file omission that shows
 * up here, and so the mapping can be asserted directly by a test.
 */
export function recordAdmissionMetrics(input: {
  allowed: boolean;
  denyReason: string | null;
  quotaConsumed: boolean;
  idempotencyReuse: boolean;
  executionState: string | null;
  labels?: AIMetricLabels;
}): void {
  const l = input.labels;
  if (input.idempotencyReuse) recordAiMetric('ai_idempotency_reuse', l);

  if (input.allowed) {
    recordAiMetric('ai_entitlement_allowed', l);
    if (input.executionState === 'reserved') recordAiMetric('ai_quota_reserved', l);
    if (input.quotaConsumed) recordAiMetric('ai_quota_consumed', l);
    return;
  }

  recordAiMetric('ai_entitlement_denied', { ...l, reason: input.denyReason });
  switch (input.denyReason) {
    case 'quota_exhausted': recordAiMetric('ai_quota_exhausted', l); break;
    case 'rate_limited': recordAiMetric('ai_rate_limited', l); break;
    case 'request_in_progress': recordAiMetric('ai_concurrency_denied', l); break;
    case 'user_cost_ceiling': recordAiMetric('ai_user_cost_blocked', l); break;
    case 'platform_cost_ceiling':
    case 'daily_cost_limit':
    case 'provider_cost_limit':
    case 'task_monthly_cost_limit': recordAiMetric('ai_global_cost_blocked', { ...l, reason: input.denyReason }); break;
    case 'provider_disabled': recordAiMetric('ai_provider_disabled', l); break;
    case 'model_disabled':
    case 'model_unknown': recordAiMetric('ai_model_disabled', { ...l, reason: input.denyReason }); break;
    case 'ai_disabled':
    case 'kill_switch_active':
    case 'live_provider_disabled':
    case 'batch_disabled':
    case 'scenario_disabled': recordAiMetric('ai_kill_switch_blocked', { ...l, reason: input.denyReason }); break;
    default: break;
  }
}

// ---------------------------------------------------------------------------
// Module 11.2 — resolution router metrics (spec sections 58-59, 94-95).
//
// `ai_avoided_calls` is the section-58 KPI: incremented for every request a
// PERSONALISED intent resolved without reaching a provider (DETERMINISTIC,
// KNOWLEDGE_BASE, STORED_PERSONALISED, EXACT_CACHE). A non-personalised
// educational/glossary hit still counts toward `resolver_knowledge_base` but
// NOT toward `ai_avoided_calls` — it was never a request that would
// plausibly have needed AI in the first place (spec section 58: "a request
// that could otherwise PLAUSIBLY require AI").
// ---------------------------------------------------------------------------
const ZERO_COST_COUNTER: Record<string, AIMetricName> = {
  DETERMINISTIC: 'resolver_deterministic',
  KNOWLEDGE_BASE: 'resolver_knowledge_base',
  STORED_PERSONALISED: 'resolver_stored_personalised',
  EXACT_CACHE: 'resolver_exact_cache',
};

export function recordResolutionMetric(input: {
  resolution: 'DETERMINISTIC' | 'KNOWLEDGE_BASE' | 'STORED_PERSONALISED' | 'EXACT_CACHE' | 'LIVE_AI_REQUIRED' | 'UNSUPPORTED' | 'BLOCKED' | 'UNAVAILABLE';
  personalised: boolean;
  intentFamily?: string;
}): void {
  const labels = input.intentFamily ? { intent_family: input.intentFamily } : undefined;
  recordAiMetric('resolver_requests_total', labels);

  const counter = ZERO_COST_COUNTER[input.resolution];
  if (counter) {
    recordAiMetric(counter, labels);
    if (input.personalised) recordAiMetric('ai_avoided_calls', labels);
    return;
  }
  switch (input.resolution) {
    case 'LIVE_AI_REQUIRED': recordAiMetric('resolver_live_ai_required', labels); break;
    case 'BLOCKED': recordAiMetric('resolver_blocked', labels); break;
    case 'UNSUPPORTED': recordAiMetric('resolver_unsupported', labels); break;
    case 'UNAVAILABLE': recordAiMetric('resolver_unavailable', labels); break;
    default: break;
  }
}

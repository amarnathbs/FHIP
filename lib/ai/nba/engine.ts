// Module 11.6 — the deterministic engine: rules -> suppression -> ranking ->
// max 3 -> zero-cost explanation (brief sections 40, 43-45, 47-48).
//
// PURE. No I/O, no provider, no clock, no randomness. Same input -> same
// output, byte for byte (tested). The hash of the certified context is
// carried on the evaluation so an audit row can prove which state it was
// computed from.

import { createHash } from 'node:crypto';
import type { FinancialContextObject } from '@/lib/ai/context/types';
import { evaluateRules } from '@/lib/ai/nba/rules';
import {
  NBA_MAX_ACTIONS, NBA_RANKING_POLICY_VERSION, NBA_RULES_VERSION, NBA_TIER_ORDER,
  type NbaAction, type NbaCandidate, type NbaEvaluation, type NbaSeverity, type NbaSuppression,
} from '@/lib/ai/nba/types';

const SEVERITY_WEIGHT: Record<NbaSeverity, number> = { critical: 4, high: 3, medium: 2, low: 1 };

/**
 * Brief section 45 — specific suppresses generic; data-quality blockers
 * suppress unsupported conclusions. A candidate is suppressed when ANY other
 * surviving candidate names it in `suppresses`. Suppression is evaluated
 * against the full candidate set (not iteratively), so the outcome does not
 * depend on evaluation order.
 */
export function applySuppression(candidates: NbaCandidate[]): { eligible: NbaCandidate[]; suppressed: NbaSuppression[] } {
  const suppressed: NbaSuppression[] = [];
  const eligible: NbaCandidate[] = [];
  for (const c of candidates) {
    const by = candidates.find((other) => other.action_code !== c.action_code && other.suppresses.includes(c.action_code));
    if (by) suppressed.push({ action_code: c.action_code, suppressed_by: by.action_code, reason: `${by.action_code} is the more specific action` });
    else eligible.push(c);
  }
  return { eligible, suppressed };
}

/**
 * Brief section 43 — transparent, versioned policy: severity weight
 * (desc) -> tier order -> action_code (alphabetical, the stable tie-break).
 */
export function rankCandidates(candidates: NbaCandidate[]): NbaCandidate[] {
  return [...candidates].sort((a, b) => {
    const s = SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity];
    if (s !== 0) return s;
    const t = NBA_TIER_ORDER.indexOf(a.tier) - NBA_TIER_ORDER.indexOf(b.tier);
    if (t !== 0) return t;
    return a.action_code < b.action_code ? -1 : a.action_code > b.action_code ? 1 : 0;
  });
}

/** Brief section 48 — zero-cost, template-composed "Why this?" from certified evidence only. */
export function explain(c: NbaCandidate, rank: number): string {
  const evidence = c.evidence.map((e) => `${e.label}: ${e.value}`).join('; ');
  const lead = rank === 1 ? 'FHIP ranks this first' : `FHIP ranks this #${rank}`;
  return `${lead} because a certified FHIP status triggered it (${c.source_ref}). Evidence — ${evidence}. This is a deterministic rule (${NBA_RULES_VERSION}, ${NBA_RANKING_POLICY_VERSION}); no AI model selected or ordered it.`;
}

export function hashContextForNba(ctx: FinancialContextObject): string {
  return createHash('sha256').update(JSON.stringify(ctx)).digest('hex');
}

export function evaluateNextBestActions(ctx: FinancialContextObject): NbaEvaluation {
  const candidates = evaluateRules(ctx);
  const { eligible, suppressed } = applySuppression(candidates);
  const ranked = rankCandidates(eligible).slice(0, NBA_MAX_ACTIONS); // never padded
  const actions: NbaAction[] = ranked.map((c, i) => ({ ...c, rank: i + 1, explanation: explain(c, i + 1) }));
  return {
    rules_version: NBA_RULES_VERSION,
    ranking_policy_version: NBA_RANKING_POLICY_VERSION,
    snapshot_id: ctx.meta.snapshot_id,
    context_hash: hashContextForNba(ctx),
    country: ctx.meta.country_of_residence,
    reporting_currency: ctx.meta.reporting_currency,
    candidates,
    suppressed,
    actions,
    provider_calls: 0,
    custom_quota_consumed: 0,
  };
}

// Module 11.6 — GET /api/ai/next-best-actions (brief sections 40-48).
//
// Returns the authenticated household's deterministic Next Best Actions
// (0..3). Accepts NO input: no body, no query parameter is read, so a client
// cannot request another household's actions, cannot inject a threshold,
// cannot pad the list and cannot request a provider call (client-tampering
// test in tests/unit/aiNbaEngine.test.ts). Scope comes entirely from
// resolveHouseholdContext() — the same rule as every Module 11 endpoint.
//
// provider_called and custom_quota_consumed are structural constants
// (false) on every response; the service cannot import a provider.

import { ok, bad } from '@/lib/api';
import { resolveHouseholdContext } from '@/lib/ai/household/resolveHouseholdContext';
import { AINextBestActionService } from '@/lib/ai/nba/service';

export async function GET() {
  const { scope, forbidden } = await resolveHouseholdContext();
  if (!scope) return forbidden;
  try {
    const result = await new AINextBestActionService().evaluate(scope.userId, scope.householdId, 'api');
    return ok({
      status: result.status,
      note: result.note,
      provider_called: result.provider_called,
      custom_quota_consumed: result.custom_quota_consumed,
      rules_version: result.evaluation?.rules_version ?? null,
      ranking_policy_version: result.evaluation?.ranking_policy_version ?? null,
      snapshot_id: result.evaluation?.snapshot_id ?? null,
      actions: (result.evaluation?.actions ?? []).map((a) => ({
        rank: a.rank, action_code: a.action_code, title: a.title, tier: a.tier, severity: a.severity,
        explanation: a.explanation, evidence: a.evidence, source_ref: a.source_ref, related_module: a.related_module, action_route: a.action_route,
      })),
      suppressed: result.evaluation?.suppressed ?? [],
    });
  } catch (err) {
    return bad(err instanceof Error ? err.message : 'Failed to evaluate next best actions.', 500);
  }
}

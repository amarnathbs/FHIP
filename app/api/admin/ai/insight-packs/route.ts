// Module 11.3 — Admin -> AI Operations -> Insight Packs (spec sections
// 73-74, 117-119). Read-only aggregate + list, admin-gated identically to
// every other /api/admin/ai/* route. Never returns a household's raw
// financial context — only pack/block metadata, status, cost and
// grounding-outcome fields (spec section 74: "Do not expose unnecessary raw
// financial context").

import { requireAdmin, adminClient, adminRoute } from '@/lib/services/adminAuth';
import { ok, bad } from '@/lib/api';

export const GET = adminRoute(async () => {
  const { forbidden } = await requireAdmin();
  if (forbidden) return forbidden;
  const client = adminClient();

  const { data: packs, error } = await client
    .from('ai_insight_packs')
    .select('id, user_id, status, overall_confidence, grounding_status, critical_safety_failure, provider, model, input_tokens, output_tokens, estimated_cost_usd, generated_at, validated_at, ready_at, failure_code, created_at')
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) return bad(error.message);

  const rows = packs ?? [];
  const counts: Record<string, number> = {};
  let totalCost = 0;
  let readyCount = 0;
  let groundingFailures = 0;
  let safetyFailures = 0;
  for (const p of rows) {
    counts[p.status] = (counts[p.status] ?? 0) + 1;
    totalCost += Number(p.estimated_cost_usd ?? 0);
    if (p.status === 'READY') readyCount += 1;
    if (p.grounding_status === 'FAIL') groundingFailures += 1;
    if (p.critical_safety_failure) safetyFailures += 1;
  }

  const { count: blockCount } = await client.from('ai_insight_pack_blocks').select('id', { count: 'exact', head: true });
  const { count: storedReuseCount } = await client.from('ai_insights').select('id', { count: 'exact', head: true }).eq('source_engine', 'ai_insight_pack_service');

  return ok({
    packs_by_status: counts,
    packs_generated: rows.length,
    packs_ready: readyCount,
    grounding_failures: groundingFailures,
    safety_failures: safetyFailures,
    average_pack_cost_usd: rows.length > 0 ? totalCost / rows.length : 0,
    average_blocks_per_pack: rows.length > 0 ? (blockCount ?? 0) / rows.length : 0,
    stored_answer_blocks_created: storedReuseCount ?? 0,
    cost_per_reusable_answer_usd: (blockCount ?? 0) > 0 ? totalCost / (blockCount ?? 1) : 0,
    recent_packs: rows,
  });
});

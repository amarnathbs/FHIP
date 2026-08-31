// Module 11.1 — admin edit of one per-task/per-model cost ceiling.
//
// Raising a task's cap is exactly the "explicit, bounded reason" the brief
// requires before a cheap task may run on a more expensive model: it is an
// admin action against a specific row, recorded with who did it and when,
// rather than something a code path can decide for itself.

import { requireAdmin, adminRoute } from '@/lib/services/adminAuth';
import { ok, bad } from '@/lib/api';
import { updateTaskCostLimit, type TaskCostLimitPatch } from '@/lib/ai/entitlement/platformControls';
import type { ModelTier } from '@/lib/ai/modelRegistry';

const TIERS: ModelTier[] = ['LOW_COST', 'STANDARD', 'ADVANCED'];

export const PUT = adminRoute(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { user, forbidden } = await requireAdmin();
  if (forbidden) return forbidden;

  const { id } = await params;
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') return bad('A JSON body is required', 422);
  const raw = body as Record<string, unknown>;

  const patch: TaskCostLimitPatch = {};

  if (raw.max_cost_per_request_usd !== undefined) {
    const v = raw.max_cost_per_request_usd;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return bad('max_cost_per_request_usd must be a number >= 0', 422);
    patch.max_cost_per_request_usd = v;
  }
  if (raw.max_internal_tier !== undefined) {
    if (typeof raw.max_internal_tier !== 'string' || !TIERS.includes(raw.max_internal_tier as ModelTier)) {
      return bad('max_internal_tier must be one of LOW_COST, STANDARD, ADVANCED', 422);
    }
    patch.max_internal_tier = raw.max_internal_tier as ModelTier;
  }
  if (raw.max_monthly_cost_usd !== undefined) {
    const v = raw.max_monthly_cost_usd;
    if (v !== null && (typeof v !== 'number' || !Number.isFinite(v) || v < 0)) {
      return bad('max_monthly_cost_usd must be a number >= 0 or null', 422);
    }
    patch.max_monthly_cost_usd = v as number | null;
  }
  if (raw.active !== undefined) {
    if (typeof raw.active !== 'boolean') return bad('active must be a boolean', 422);
    patch.active = raw.active;
  }
  if (raw.notes !== undefined) {
    if (raw.notes !== null && typeof raw.notes !== 'string') return bad('notes must be a string or null', 422);
    patch.notes = raw.notes as string | null;
  }

  if (Object.keys(patch).length === 0) return bad('No recognised cost-limit fields were supplied', 422);

  const updated = await updateTaskCostLimit(id, patch, user!.id);
  return ok(updated);
});

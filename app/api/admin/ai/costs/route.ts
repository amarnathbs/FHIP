// Module 11.1 — GET /api/admin/ai/costs  (spec sections 36, 40).
//
// The cost-configuration view: model price metadata, per-task ceilings,
// per-provider limits, the platform soft/hard thresholds, and the request and
// output token caps.
//
// SECTION 36: "Never expose provider API keys through these screens." That is
// structural here, not a filter that could be forgotten: no provider API key
// is stored in the database at all. Keys live only in server environment
// variables (lib/ai/providers/openaiProvider.ts reads process.env), so there
// is nothing for this endpoint to read even if it tried. The explicit column
// list below is nonetheless written as an allowlist rather than `select('*')`,
// so a future secret-bearing column could not begin leaking here by default.

import { requireAdmin, adminRoute } from '@/lib/services/adminAuth';
import { ok } from '@/lib/api';
import { createAdminClient } from '@/lib/supabase/admin';
import {
  getPlatformControls,
  listTaskCostLimits,
  listProviderControls,
} from '@/lib/ai/entitlement/platformControls';

const MODEL_PRICE_COLUMNS = [
  'id', 'provider', 'model_identifier', 'internal_tier', 'active', 'approved',
  'max_input_tokens', 'max_output_tokens', 'supports_batch',
  'cost_input_per_1k_usd', 'cost_output_per_1k_usd', 'cost_cached_input_per_1k_usd',
  'batch_cost_multiplier', 'price_currency', 'price_source_note', 'price_last_verified_at',
  'effective_from', 'effective_to',
].join(', ');

export const GET = adminRoute(async () => {
  const { forbidden } = await requireAdmin();
  if (forbidden) return forbidden;

  const admin = createAdminClient();
  const [controls, taskLimits, providers, models] = await Promise.all([
    getPlatformControls(),
    listTaskCostLimits(),
    listProviderControls(),
    admin.from('ai_model_registry').select(MODEL_PRICE_COLUMNS).order('provider', { ascending: true }),
  ]);

  return ok({
    // Section 36 names these four groups explicitly.
    subject_cost_ceilings: controls
      ? {
          per_user_monthly_cost_ceiling_usd: controls.per_user_monthly_cost_ceiling_usd,
          per_user_soft_cost_threshold_usd: controls.per_user_soft_cost_threshold_usd,
        }
      : null,
    platform_cost_thresholds: controls
      ? {
          platform_monthly_cost_ceiling_usd: controls.platform_monthly_cost_ceiling_usd,
          platform_soft_cost_threshold_usd: controls.platform_soft_cost_threshold_usd,
          daily_live_ai_cost_limit_usd: controls.daily_live_ai_cost_limit_usd,
          max_cost_per_request_usd: controls.max_cost_per_request_usd,
        }
      : null,
    token_caps: controls
      ? {
          max_context_tokens: controls.max_context_tokens,
          max_user_input_tokens: controls.max_user_input_tokens,
          max_output_tokens: controls.max_output_tokens,
        }
      : null,
    model_price_metadata: models.data ?? [],
    task_cost_limits: taskLimits,
    provider_controls: providers,
  });
});

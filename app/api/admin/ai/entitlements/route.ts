// Module 11.1 — GET /api/admin/ai/entitlements  (spec sections 35, 37, 40).
//
// The admin view of entitlement configuration and of who is consuming what.
//
// SECTION 35 asks that an admin can VIEW (and where governance permits,
// modify) the custom-question limit, the rollover policy, the feature
// entitlement mapping, the enabled AI capabilities, and the rate-limit and
// concurrency configuration. Viewing is here; MODIFYING all of these already
// goes through PUT /api/admin/ai/controls, which is the single write path and
// the one the ai_config_audit trigger watches. Two write paths for the same
// settings would mean two places to get validation right.
//
// ROLLOVER POLICY is reported as a fixed, non-configurable `false`. That is
// honest rather than lazy: no-rollover is STRUCTURAL in this design — usage is
// counted per billing_period, so an unused allowance in period N is simply
// never visible when counting period N+1. There is no switch to expose because
// there is no code path that could roll anything over, and presenting a
// toggle that does nothing would be worse than presenting a fact.

import { requireAdmin, adminRoute } from '@/lib/services/adminAuth';
import { ok } from '@/lib/api';
import { createAdminClient } from '@/lib/supabase/admin';
import { getPlatformControls, summariseUsageForPeriod } from '@/lib/ai/entitlement/platformControls';
import { AI_COACH_PREMIUM, AI_SUB_CAPABILITIES, AI_CAPABILITY_IMPLEMENTED } from '@/lib/ai/entitlement/capabilities';
import { currentBillingPeriod } from '@/lib/ai/billingPeriod';

export const GET = adminRoute(async () => {
  const { forbidden } = await requireAdmin();
  if (forbidden) return forbidden;

  const admin = createAdminClient();
  const period = currentBillingPeriod();

  const [controls, usage, premiumCount, freeCount] = await Promise.all([
    getPlatformControls(),
    summariseUsageForPeriod(period),
    admin.from('user_entitlements').select('user_id', { count: 'exact', head: true }).eq('plan_tier', 'premium'),
    admin.from('user_entitlements').select('user_id', { count: 'exact', head: true }).eq('plan_tier', 'free'),
  ]);

  const allowance = controls?.monthly_custom_question_allowance ?? 0;

  return ok({
    billing_period: period,
    entitlement_configuration: {
      plan_feature: AI_COACH_PREMIUM,
      // The single source of Premium truth, named explicitly so nobody has to
      // go looking for a second one.
      subscription_truth_source: 'user_entitlements.plan_tier',
      subject_ownership: 'user',
      custom_question_limit: allowance,
      rollover_policy: 'none',
      rollover_configurable: false,
      standard_requires_premium: controls?.standard_requires_premium ?? null,
      rate_limit: controls
        ? { max_requests: controls.rate_limit_max_requests, window_seconds: controls.rate_limit_window_seconds }
        : null,
      concurrency: controls
        ? { max_per_subject: controls.max_concurrent_requests_per_subject, lease_seconds: controls.concurrency_lease_seconds }
        : null,
    },
    // Section 6's capability map, with an honest built/not-built flag beside
    // each entry rather than a list that implies all seven work.
    capabilities: AI_SUB_CAPABILITIES.map((c) => ({ capability: c, implemented: AI_CAPABILITY_IMPLEMENTED[c] })),
    subjects: {
      premium: premiumCount.count ?? 0,
      free: freeCount.count ?? 0,
      with_usage_this_period: usage.perUser.length,
      at_quota_this_period: allowance > 0 ? usage.perUser.filter((u) => u.custom_question_count >= allowance).length : 0,
    },
    usage_this_period: usage,
  });
});

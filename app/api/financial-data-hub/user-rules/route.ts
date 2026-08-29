import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import { createPersonalClassificationRule, ClassificationReviewError } from '@/lib/financial-data-hub/services/classificationReviewService';
import { fdhUserClassificationRuleSchema } from '@/lib/financial-data-hub/validation/classification';

// POST /api/financial-data-hub/user-classification-rules — R8 spec section
// 40/47: a household's own rule, created ONLY through this explicit,
// deliberate action — never inferred automatically from a single
// correction. Writes exclusively to fdh_user_classification_rules; the
// database has no INSERT/UPDATE policy at all for the authenticated role on
// fdh_merchants/fdh_classification_rules, so a personal rule can never
// become a global one through this path even in principle.
export async function POST(req: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const body = await req.json().catch(() => null);
  const parsed = fdhUserClassificationRuleSchema.safeParse(body);
  if (!parsed.success) return bad(parsed.error.issues[0]?.message ?? 'Invalid request', 422);

  try {
    const rule = await createPersonalClassificationRule(user.id, {
      rule_type: parsed.data.rule_type,
      match_definition: parsed.data.match_definition,
      action_definition: parsed.data.action_definition,
      priority: parsed.data.priority,
    });
    return ok({ rule_id: rule.id, rule_type: rule.rule_type, active: rule.active });
  } catch (e) {
    if (e instanceof ClassificationReviewError) return bad(e.message, 409);
    return bad('We could not save this rule.', 500);
  }
}

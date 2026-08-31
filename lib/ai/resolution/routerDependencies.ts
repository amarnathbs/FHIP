// Module 11.2 — real (non-test) RouterDependencies wiring for the resolution
// router. Kept separate from router.ts so the router itself stays unit-
// testable with plain fakes (no Next.js cookies()/session dependency).

import { createClient } from '@/lib/supabase/server';
import { buildFinancialContextObject } from '@/lib/ai/context/financialContextObject';
import { getUserHomeCountry } from '@/lib/services/jurisdiction';
import { AIEntitlementService } from '@/lib/ai/entitlement/aiEntitlementService';
import { recordResolutionAudit, hashNormalisedQuestion } from '@/lib/ai/resolution/audit';
import type { RouterDependencies } from '@/lib/ai/resolution/router';

export function createRouterDependencies(userId: string, householdId: string | null): RouterDependencies {
  return {
    async buildContext(mode, intentCode) {
      return buildFinancialContextObject(userId, { mode, intentCode });
    },
    async getUserCountry() {
      const supabase = await createClient();
      return getUserHomeCountry(userId, supabase);
    },
    async isPersonalisedAiEligible() {
      return AIEntitlementService.isPersonalisedAIEligible(userId, householdId ?? undefined);
    },
    async writeAudit(result, normalisedQuestionHash) {
      await recordResolutionAudit({ userId, householdId, normalisedQuestionHash, result });
    },
  };
}

export { hashNormalisedQuestion };

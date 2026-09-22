// Module 11 remediation R3 — the production composition of the scheduler:
// real DB clients, real provider factory, real orchestrator, service-role
// context builder. The ONLY place these are assembled; both the CRON_SECRET
// route and the admin manual-trigger route call createSchedulerService().

import '@/lib/serverOnly';
import { createAdminClient } from '@/lib/supabase/admin';
import { buildFinancialContextObject } from '@/lib/ai/context/financialContextObject';
import { AIInsightPackBatchOrchestrator } from '@/lib/ai/insightPack/batchOrchestrator';
import { realInsightPackDbClient } from '@/lib/ai/insightPack/insightPackDbClient';
import { realInsightPackBatchDbClient } from '@/lib/ai/insightPack/insightPackBatchDbClient';
import { resolvePackProvider, resolveBatchProvider } from '@/lib/ai/providers/providerFactory';
import { AIEntitlementService } from '@/lib/ai/entitlement/aiEntitlementService';
import { getActivePrompt } from '@/lib/ai/promptRegistry';
import { PROMPT_CODE } from '@/lib/ai/insightPack/insightPackService';
import { OPENAI_BATCH_PRICE_MULTIPLIER } from '@/lib/ai/providers/openaiBatchProvider';
import { AIInsightPackSchedulerService } from '@/lib/ai/insightPack/scheduler/schedulerService';
import { realSchedulerDbClient } from '@/lib/ai/insightPack/scheduler/schedulerDbClient';
import type { SchedulerContextBuilder } from '@/lib/ai/insightPack/scheduler/types';
export { getModule11SchedulerMaxHouseholdsPerRun } from '@/lib/ai/config';

/** Session-less certified context: the service-role base client, still write-blocked and user-id-scoped inside the builder. */
export const serviceRoleContextBuilder: SchedulerContextBuilder = (userId) =>
  buildFinancialContextObject(userId, { mode: 'FULL', client: createAdminClient() });

export function createSchedulerService(): AIInsightPackSchedulerService {
  const orchestrator = new AIInsightPackBatchOrchestrator(
    realInsightPackDbClient,
    realInsightPackBatchDbClient,
    resolvePackProvider,
    resolveBatchProvider(),
    undefined,
    3,
    undefined,
    120,
    15 * 60_000,
    OPENAI_BATCH_PRICE_MULTIPLIER
  );
  return new AIInsightPackSchedulerService(
    realSchedulerDbClient,
    realInsightPackBatchDbClient,
    orchestrator,
    serviceRoleContextBuilder,
    (userId, householdId) => AIEntitlementService.isPersonalisedAIEligible(userId, householdId ?? undefined),
    async () => (await getActivePrompt(PROMPT_CODE, null, createAdminClient()))?.version ?? null
  );
}

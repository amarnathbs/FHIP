// Module 11.3 — the real (non-test) InsightPackDbClient, wiring
// AIPersonalisedInsightPackService to actual Supabase tables. Kept separate
// from insightPackService.ts so the service itself stays unit-testable with
// a plain in-memory double (mirrors lib/ai/resolution/routerDependencies.ts's
// split from router.ts).

import { createAdminClient } from '@/lib/supabase/admin';
import { getActivePrompt as registryGetActivePrompt } from '@/lib/ai/promptRegistry';
import { resolveModelForTask as registryResolveModel, type ModelRegistryRow } from '@/lib/ai/modelRegistry';
import { AIEntitlementService } from '@/lib/ai/entitlement/aiEntitlementService';
import { getPlatformControls } from '@/lib/ai/entitlement/platformControls';
import type { PromptTemplateRow } from '@/lib/ai/promptRegistry';
import type {
  InsightPackDbClient, PackRow, InsertPendingPackInput, PersistedBlockInput, StoredAnswerUpsertInput,
} from '@/lib/ai/insightPack/insightPackService';
import type { PackIdentity } from '@/lib/ai/insightPack/types';

function packRowFromDb(row: Record<string, unknown>): PackRow {
  return row as unknown as PackRow;
}

export const realInsightPackDbClient: InsightPackDbClient = {
  async getActivePrompt(promptCode: string, countryScope: string | null): Promise<PromptTemplateRow | null> {
    const admin = createAdminClient();
    return registryGetActivePrompt(promptCode, countryScope, admin);
  },

  async resolveModelForTask(taskType, tier = 'STANDARD'): Promise<ModelRegistryRow | null> {
    const admin = createAdminClient();
    return registryResolveModel(taskType, tier, admin);
  },

  async isPersonalisedAiEligible(userId, householdId): Promise<boolean> {
    return AIEntitlementService.isPersonalisedAIEligible(userId, householdId ?? undefined);
  },

  async isBatchGenerationEnabled(): Promise<{ globallyEnabled: boolean; batchEnabled: boolean }> {
    const controls = await getPlatformControls();
    if (!controls) return { globallyEnabled: false, batchEnabled: false };
    return { globallyEnabled: controls.ai_globally_enabled, batchEnabled: controls.batch_generation_enabled };
  },

  async findPackByIdentity(identity: PackIdentity): Promise<PackRow | null> {
    const admin = createAdminClient();
    let q = admin
      .from('ai_insight_packs')
      .select('*')
      .eq('user_id', identity.userId)
      .eq('snapshot_id', identity.snapshotId)
      .eq('financial_context_hash', identity.financialContextHash)
      .eq('context_schema_version', identity.contextSchemaVersion)
      .eq('pack_schema_version', identity.packSchemaVersion)
      .eq('prompt_code', identity.promptCode)
      .eq('prompt_version', identity.promptVersion)
      .eq('language', identity.language);
    q = identity.countryContext ? q.eq('country_context', identity.countryContext) : q.is('country_context', null);
    const { data, error } = await q.maybeSingle();
    if (error) throw new Error(`findPackByIdentity failed: ${error.message}`);
    return data ? packRowFromDb(data) : null;
  },

  async findCurrentPackForUser(userId: string): Promise<PackRow | null> {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from('ai_insight_packs')
      .select('*')
      .eq('user_id', userId)
      .in('status', ['READY', 'PARTIAL'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`findCurrentPackForUser failed: ${error.message}`);
    return data ? packRowFromDb(data) : null;
  },

  async insertPendingPack(input: InsertPendingPackInput): Promise<PackRow> {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from('ai_insight_packs')
      .insert({
        user_id: input.userId,
        household_id: input.householdId,
        snapshot_id: input.identity.snapshotId,
        financial_context_hash: input.identity.financialContextHash,
        context_schema_version: input.identity.contextSchemaVersion,
        pack_schema_version: input.identity.packSchemaVersion,
        prompt_code: input.identity.promptCode,
        prompt_version: input.identity.promptVersion,
        country_context: input.identity.countryContext,
        language: input.identity.language,
        provider: input.provider,
        model: input.model,
        status: 'GENERATING',
        idempotency_key: input.idempotencyKey,
      })
      .select('*')
      .single();
    if (error) throw new Error(`insertPendingPack failed: ${error.message}`);
    return packRowFromDb(data);
  },

  async updatePack(id: string, patch: Partial<PackRow>): Promise<PackRow> {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from('ai_insight_packs')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select('*')
      .single();
    if (error) throw new Error(`updatePack failed: ${error.message}`);
    return packRowFromDb(data);
  },

  async insertBlocks(packId: string, userId: string, householdId: string | null, blocks: PersistedBlockInput[]): Promise<void> {
    if (blocks.length === 0) return;
    const admin = createAdminClient();
    const { error } = await admin.from('ai_insight_pack_blocks').insert(
      blocks.map((b) => ({
        pack_id: packId,
        user_id: userId,
        household_id: householdId,
        block_code: b.block_code,
        status: b.status,
        headline: b.headline,
        short_answer: b.short_answer,
        explanation: b.explanation,
        why_it_matters: b.why_it_matters,
        source_refs_json: b.source_refs_json,
        source_metric_codes: b.source_metric_codes,
        confidence: b.confidence,
        data_as_of: b.data_as_of,
        limitations_json: b.limitations_json,
        related_module: b.related_module,
        action_route: b.action_route,
        safety_classification: b.safety_classification,
        block_order: b.block_order,
        violations_json: b.violations_json,
      }))
    );
    if (error) throw new Error(`insertBlocks failed: ${error.message}`);
  },

  async supersedeOlderPacks(userId: string, keepPackId: string): Promise<number> {
    const admin = createAdminClient();
    const nowIso = new Date().toISOString();
    const { data, error } = await admin
      .from('ai_insight_packs')
      .update({ status: 'SUPERSEDED', superseded_at: nowIso, updated_at: nowIso })
      .eq('user_id', userId)
      .neq('id', keepPackId)
      .in('status', ['READY', 'PARTIAL', 'STALE'])
      .select('id');
    if (error) throw new Error(`supersedeOlderPacks failed: ${error.message}`);
    return (data ?? []).length;
  },

  async upsertStoredAnswer(input: StoredAnswerUpsertInput): Promise<void> {
    const admin = createAdminClient();
    // ai_insights (Module 11.0) has no unique constraint on (user_id,
    // metric_code) — see storedPersonalisedResolver.ts's own comment that it
    // orders by created_at desc and takes the newest valid row. This inserts
    // a fresh row (the newest one) rather than updating in place; the
    // resolver's own staleness check (current_value vs the LIVE metric)
    // means an old row simply stops matching once data moves, so it is
    // naturally superseded without needing to be deleted here.
    const { error } = await admin.from('ai_insights').insert({
      user_id: input.userId,
      household_id: input.householdId,
      insight_code: `insight_pack:${input.metricCode}`,
      category: 'ai_insight_pack',
      severity: 'info',
      metric_code: input.metricCode,
      current_value: input.currentValue,
      structured_fact_json: {},
      source_engine: 'ai_insight_pack_service',
      deterministic_status: 'ai_validated',
      future_ai_explanation: input.explanation,
      confidence: input.confidence,
      valid_from: new Date().toISOString(),
    });
    if (error) throw new Error(`upsertStoredAnswer failed: ${error.message}`);
  },
};

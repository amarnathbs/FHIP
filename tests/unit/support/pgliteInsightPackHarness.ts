// Module 11.3 continuation — shared PGlite-backed harness for tests that
// need to run the REAL AIPersonalisedInsightPackService against a REAL,
// ISOLATED, ephemeral Postgres instance (not a JS in-memory FakeDb, and not
// the shared hosted DEV project). Used by:
//   - tests/unit/aiInsightPackIsolatedKillSwitchLiveProof.test.ts (item 2)
//   - tests/unit/aiInsightPack20HouseholdE2E.test.ts (item 3)
//
// Every method below runs the SAME table/column/query shape the real
// lib/ai/insightPack/insightPackDbClient.ts runs — only the transport is
// PGlite's direct SQL interface rather than supabase-js over HTTP, because
// supabase-js requires a live hosted endpoint. The entitlement gate calls
// the REAL ai_admit_request()/ai_refund_admission()/ai_finalise_admission()
// SQL functions and the REAL interpretAdmissionPayload() interpreter — none
// of the enforcement logic is reimplemented.

import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { interpretAdmissionPayload } from '@/lib/ai/entitlement/entitlementService';
import type { EntitlementGate, AdmissionRequest, AdmissionResult } from '@/lib/ai/entitlement/types';
import type { InsightPackDbClient, PackRow, InsertPendingPackInput, PersistedBlockInput, StoredAnswerUpsertInput } from '@/lib/ai/insightPack/insightPackService';
import type { PackIdentity } from '@/lib/ai/insightPack/types';
import type { InsightPackBatchDbClient, BatchRow, InsertBatchInput } from '@/lib/ai/insightPack/batchTypes';
import type { PromptTemplateRow } from '@/lib/ai/promptRegistry';
import type { ModelRegistryRow } from '@/lib/ai/modelRegistry';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUPABASE_ROOT = path.resolve(HERE, '..', '..', '..', 'supabase');
const MIG_DIR = path.join(SUPABASE_ROOT, 'migrations');
const SHIM = path.join(SUPABASE_ROOT, '..', 'scripts', 'db-rebuild-check', 'shim.sql');

export interface PgliteInsightPackHarness {
  db: PGlite;
  gate: EntitlementGate;
  dbClient: InsightPackDbClient;
  batchDbClient: InsightPackBatchDbClient;
}

export async function buildPgliteInsightPackHarness(): Promise<PgliteInsightPackHarness> {
  const db = await PGlite.create();
  await db.exec(fs.readFileSync(SHIM, 'utf8'));
  const seed = fs.readFileSync(path.join(SUPABASE_ROOT, 'seed.sql'), 'utf8');
  const files = fs.readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    await db.exec(fs.readFileSync(path.join(MIG_DIR, f), 'utf8').replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, ''));
    if (f.startsWith('0001')) await db.exec(seed);
  }
  // PR-AI-013 is seeded DRAFT (migration 0121) — activate it in THIS
  // isolated instance only, so the real getActivePrompt() query can find it.
  await db.exec(`update ai_prompt_templates set status='ACTIVE' where prompt_code='PR-AI-013' and version=1;`);
  // Give the mock model a non-zero per-token price in THIS isolated
  // instance only, so cost-ceiling-driven tests have a genuine non-zero
  // projected cost to compare against a ceiling (the real seeded mock row
  // is priced at exactly $0).
  await db.exec(`update ai_model_registry set cost_input_per_1k_usd = 0.01, cost_output_per_1k_usd = 0.02 where provider='mock' and model_identifier='mock-standard-1';`);
  // DISCLOSED FINDING (same one item 1's live-DEV script found): the real
  // AIPersonalisedInsightPackService requests a fixed 3000-token output
  // budget per generation, but the seeded `ai_platform_controls.
  // max_output_tokens` default (800, a Module 11.1 value sized for a single
  // explanation) is smaller than that, which would make every admission
  // fail token_budget_exceeded before the provider is ever reached. In THIS
  // fully isolated, ephemeral instance (unlike shared DEV) it is safe to
  // raise the ceiling so this harness's tests exercise the kill-switch/
  // cost-ceiling behaviour under test, not this unrelated token-budget gap.
  await db.exec(`update ai_platform_controls set max_output_tokens = 3200 where id='global';`);
  // The model registry row ALSO carries its own max_output_tokens ceiling
  // (checked independently by ai_admit_request()), seeded at 800 — the same
  // undersized default. Raise it in this isolated instance for the same
  // reason as above.
  await db.exec(`update ai_model_registry set max_output_tokens = 3200 where provider='mock' and model_identifier='mock-standard-1';`);

  const gate: EntitlementGate = {
    async admit(request: AdmissionRequest): Promise<AdmissionResult> {
      const { rows } = await db.query(
        `select ai_admit_request($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) v`,
        [
          request.userId, request.householdId, request.requestClass, request.taskType,
          request.provider, request.model, request.internalTier, request.estimatedCostUsd,
          request.cacheHit, request.usageOutcome ?? null, request.idempotencyKey ?? null,
          request.requestHash ?? null, request.contextTokens ?? null, request.userInputTokens ?? null,
          request.outputTokens ?? null,
        ]
      );
      return interpretAdmissionPayload((rows[0] as Record<string, unknown>).v);
    },
    async refund(admissionId: string): Promise<boolean> {
      const { rows } = await db.query(`select ai_refund_admission($1) v`, [admissionId]);
      return Boolean(((rows[0] as Record<string, unknown>).v as { refunded?: boolean } | null)?.refunded);
    },
    async finalise(admissionId: string): Promise<boolean> {
      const { rows } = await db.query(`select ai_finalise_admission($1) v`, [admissionId]);
      return Boolean(((rows[0] as Record<string, unknown>).v as { finalised?: boolean } | null)?.finalised);
    },
  };

  const dbClient: InsightPackDbClient = {
    async getActivePrompt(promptCode: string): Promise<PromptTemplateRow | null> {
      const { rows } = await db.query(`select * from ai_prompt_templates where prompt_code=$1 and status='ACTIVE' and country_scope is null limit 1`, [promptCode]);
      return (rows[0] as PromptTemplateRow) ?? null;
    },
    async resolveModelForTask(taskType: string, tier = 'STANDARD'): Promise<ModelRegistryRow | null> {
      const { rows } = await db.query(
        `select * from ai_model_registry where active=true and approved=true and internal_tier=$1 and task_types @> array[$2] limit 1`,
        [tier, taskType]
      );
      return (rows[0] as ModelRegistryRow) ?? null;
    },
    async isPersonalisedAiEligible(userId: string): Promise<boolean> {
      const { rows } = await db.query(`select ai_entitlement_state($1) v`, [userId]);
      return Boolean(((rows[0] as Record<string, unknown> | undefined)?.v as { eligible?: boolean } | null)?.eligible);
    },
    async isBatchGenerationEnabled(): Promise<{ globallyEnabled: boolean; batchEnabled: boolean }> {
      const { rows } = await db.query(`select ai_globally_enabled, batch_generation_enabled from ai_platform_controls where id='global'`);
      const controlsRow = rows[0] as Record<string, unknown> | undefined;
      return { globallyEnabled: Boolean(controlsRow?.ai_globally_enabled), batchEnabled: Boolean(controlsRow?.batch_generation_enabled) };
    },
    async findPackByIdentity(identity: PackIdentity): Promise<PackRow | null> {
      const { rows } = await db.query(
        `select * from ai_insight_packs where user_id=$1 and snapshot_id=$2 and financial_context_hash=$3 and context_schema_version=$4 and pack_schema_version=$5 and prompt_code=$6 and prompt_version=$7 and language=$8 and (country_context = $9 or (country_context is null and $9 is null)) limit 1`,
        [identity.userId, identity.snapshotId, identity.financialContextHash, identity.contextSchemaVersion, identity.packSchemaVersion, identity.promptCode, identity.promptVersion, identity.language, identity.countryContext]
      );
      return (rows[0] as PackRow) ?? null;
    },
    async findCurrentPackForUser(userId: string): Promise<PackRow | null> {
      const { rows } = await db.query(`select * from ai_insight_packs where user_id=$1 and status in ('READY','PARTIAL') order by created_at desc limit 1`, [userId]);
      return (rows[0] as PackRow) ?? null;
    },
    async findMostRecentGenerationTime(userId: string): Promise<string | null> {
      const { rows } = await db.query(`select generated_at from ai_insight_packs where user_id=$1 and generated_at is not null order by generated_at desc limit 1`, [userId]);
      return ((rows[0] as Record<string, unknown> | undefined)?.generated_at as string | undefined) ?? null;
    },
    async insertPendingPack(input: InsertPendingPackInput): Promise<PackRow> {
      const { rows } = await db.query(
        `insert into ai_insight_packs (user_id, household_id, snapshot_id, financial_context_hash, context_schema_version, pack_schema_version, prompt_code, prompt_version, country_context, language, provider, model, status, idempotency_key, batch_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'GENERATING',$13,$14) returning *`,
        [input.userId, input.householdId, input.identity.snapshotId, input.identity.financialContextHash, input.identity.contextSchemaVersion, input.identity.packSchemaVersion, input.identity.promptCode, input.identity.promptVersion, input.identity.countryContext, input.identity.language, input.provider, input.model, input.idempotencyKey, input.batchId ?? null]
      );
      return rows[0] as PackRow;
    },
    async updatePack(id: string, patch: Partial<PackRow>): Promise<PackRow> {
      const entries = Object.entries(patch).filter(([k]) => k !== 'id' && k !== 'updated_at');
      const sets = entries.map(([k], i) => `${k} = $${i + 2}`).join(', ');
      const values = entries.map(([, v]) => v);
      const setClause = sets.length > 0 ? `${sets}, updated_at = now()` : `updated_at = now()`;
      const { rows } = await db.query(`update ai_insight_packs set ${setClause} where id = $1 returning *`, [id, ...values]);
      return rows[0] as PackRow;
    },
    async insertBlocks(packId: string, userId: string, householdId: string | null, blocks: PersistedBlockInput[]): Promise<void> {
      for (const b of blocks) {
        await db.query(
          `insert into ai_insight_pack_blocks (pack_id, user_id, household_id, block_code, status, headline, short_answer, explanation, why_it_matters, source_refs_json, source_metric_codes, confidence, data_as_of, limitations_json, related_module, action_route, safety_classification, block_order, violations_json)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
          [packId, userId, householdId, b.block_code, b.status, b.headline, b.short_answer, b.explanation, b.why_it_matters, JSON.stringify(b.source_refs_json), b.source_metric_codes, b.confidence, b.data_as_of, JSON.stringify(b.limitations_json), b.related_module, b.action_route, b.safety_classification, b.block_order, JSON.stringify(b.violations_json)]
        );
      }
    },
    async supersedeOlderPacks(userId: string, keepPackId: string): Promise<number> {
      const { rows } = await db.query(`update ai_insight_packs set status='SUPERSEDED', superseded_at=now() where user_id=$1 and id<>$2 and status in ('READY','PARTIAL','STALE') returning id`, [userId, keepPackId]);
      return rows.length;
    },
    async upsertStoredAnswer(input: StoredAnswerUpsertInput): Promise<void> {
      await db.query(
        `insert into ai_insights (user_id, household_id, insight_code, category, severity, metric_code, current_value, structured_fact_json, source_engine, deterministic_status, future_ai_explanation, confidence, valid_from)
         values ($1,$2,$3,'ai_insight_pack','info',$4,$5,'{}','ai_insight_pack_service','ai_validated',$6,$7, now())`,
        [input.userId, input.householdId, `insight_pack:${input.metricCode}`, input.metricCode, input.currentValue, input.explanation, input.confidence]
      );
    },
  };

  const batchDbClient: InsightPackBatchDbClient = {
    async insertBatch(input: InsertBatchInput): Promise<BatchRow> {
      const { rows } = await db.query(
        `insert into ai_insight_pack_batches (provider, task_type, status, request_count, success_count, failure_count, estimated_cost_usd)
         values ($1,$2,'PENDING',$3,0,0,0) returning *`,
        [input.provider, input.taskType, input.requestCount]
      );
      return rows[0] as BatchRow;
    },
    async updateBatch(id: string, patch: Partial<BatchRow>): Promise<BatchRow> {
      const entries = Object.entries(patch).filter(([k]) => k !== 'id' && k !== 'updated_at');
      const sets = entries.map(([k], i) => `${k} = $${i + 2}`).join(', ');
      const values = entries.map(([, v]) => v);
      const setClause = sets.length > 0 ? `${sets}, updated_at = now()` : `updated_at = now()`;
      const { rows } = await db.query(`update ai_insight_pack_batches set ${setClause} where id = $1 returning *`, [id, ...values]);
      return rows[0] as BatchRow;
    },
  };

  return { db, gate, dbClient, batchDbClient };
}

export async function insertPremiumUser(db: PGlite, userId: string, email: string): Promise<void> {
  await db.exec(`insert into auth.users(id,email) values ('${userId}','${email}');`);
  await db.exec(`update user_entitlements set plan_tier='premium' where user_id='${userId}';`);
}

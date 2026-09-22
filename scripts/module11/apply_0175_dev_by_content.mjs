// Module 11 remediation R2 — apply migration 0175's CONTENT to the DEV
// project via the service-role PostgREST path.
//
// WHY THIS EXISTS. scripts/pc5_ddl_capability_probe.mjs re-confirmed on
// 2026-09-22 that this environment has NO DDL path to DEV (no exec_sql-style
// RPC, no Management API token, no direct Postgres connection string).
// Migration 0175 is DML-ONLY (two inserts into tables that already exist on
// DEV since 0110/0121), so its exact effect can be reproduced through the
// ordinary supabase-js client. This script inserts the SAME two rows the
// migration inserts, with the SAME idempotency (skip if present). It does
// NOT record the migration in Supabase's migration-history table (no path
// to it) — an operator applying the chain later will find `on conflict do
// nothing` makes 0175 a no-op on DEV.
//
// Refuses to run against anything but the DEV project host.
import fs from 'fs';
import { createClient } from '@supabase/supabase-js';

const raw = fs.readFileSync('.env.local', 'utf8').replace(/^﻿/, '');
const pick = (n) => raw.match(new RegExp(`^${n}=(.*)$`, 'm'))?.[1]?.trim();
const url = pick('NEXT_PUBLIC_SUPABASE_URL');
const key = pick('SUPABASE_SERVICE_ROLE_KEY');
if (!url || !key) { console.error('DEV credentials absent'); process.exit(2); }
if (new URL(url).host !== 'vqycarelcoijzwlpkpcz.supabase.co') { console.error(`Refusing: ${new URL(url).host} is not the DEV project`); process.exit(2); }
const c = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

// The migration file is the single source of truth for the prompt text —
// parse it out of the SQL rather than duplicating it here.
const sql = fs.readFileSync('supabase/migrations/0175_module11_r1_r2_prompt_v2_and_openai_model_row.sql', 'utf8');
function sqlString(block) {
  // Join 'a' || 'b' || 'c' concatenations into one JS string, unescaping ''.
  return block.split('||').map((p) => p.trim()).map((p) => p.replace(/^'/, '').replace(/'$/, '').replace(/''/g, "'")).join('');
}
const promptSection = sql.slice(sql.indexOf("'PR-AI-013',"), sql.indexOf("'ai-context-1.0.0',\n  'insight-pack-1.1.0'"));
const [, systemBlock, developerBlock] = promptSection.match(/'monthly_insight_pack',\n([\s\S]*?),\n\s*('Populate[\s\S]*?),\n\s*$/) ?? [];
if (!systemBlock || !developerBlock) { console.error('Could not parse PR-AI-013 v2 text from migration 0175'); process.exit(3); }
const systemPrompt = sqlString(systemBlock);
const developerPrompt = sqlString(developerBlock);

const { data: v1 } = await c.from('ai_prompt_templates').select('id').eq('prompt_code', 'PR-AI-013').eq('version', 1).maybeSingle();
if (!v1) { console.error('PR-AI-013 v1 not present on DEV (0121 not applied?) — refusing, exactly as the migration\'s WHERE EXISTS guard would'); process.exit(3); }
const { data: v2 } = await c.from('ai_prompt_templates').select('id, status').eq('prompt_code', 'PR-AI-013').eq('version', 2).maybeSingle();
if (v2) console.log(`PR-AI-013 v2 already present (status ${v2.status}) — skipped (on conflict do nothing)`);
else {
  const { error } = await c.from('ai_prompt_templates').insert({
    prompt_code: 'PR-AI-013', prompt_name: 'Monthly Personalised Insight Pack', version: 2, task_type: 'monthly_insight_pack',
    system_prompt: systemPrompt, developer_prompt: developerPrompt,
    context_schema_version: 'ai-context-1.0.0', output_schema_version: 'insight-pack-1.1.0', country_scope: null,
    safety_policy_version: 'safety-policy-1.0.0', status: 'DRAFT',
  });
  if (error) { console.error('prompt insert failed:', error.message); process.exit(4); }
  console.log('PR-AI-013 v2 inserted as DRAFT');
}

const { data: model } = await c.from('ai_model_registry').select('id, active, approved').eq('provider', 'openai').eq('model_identifier', 'gpt-4o-mini').maybeSingle();
if (model) console.log(`openai/gpt-4o-mini already present (active=${model.active}, approved=${model.approved}) — skipped`);
else {
  const { error } = await c.from('ai_model_registry').insert({
    provider: 'openai', model_identifier: 'gpt-4o-mini', internal_tier: 'LOW_COST', active: false, approved: false,
    task_types: ['monthly_insight_pack'], max_input_tokens: 32000, max_output_tokens: 3200,
    supports_structured_output: true, supports_streaming: false, supports_batch: true,
    cost_input_per_1k_usd: 0.00015, cost_output_per_1k_usd: 0.0006, effective_from: '2026-09-22T00:00:00Z', rollout_percentage: 100, fallback_model_id: null,
  });
  if (error) { console.error('model insert failed:', error.message); process.exit(4); }
  console.log('openai/gpt-4o-mini inserted (active=false, approved=false)');
}
console.log('0175 content applied to DEV.');

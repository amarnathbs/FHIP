// Module 11 remediation — READ-ONLY probe of the DEV project's Module 11
// registry/control state. Prints no secrets, writes nothing.
import fs from 'fs';
import { createClient } from '@supabase/supabase-js';
const raw = fs.readFileSync('.env.local', 'utf8').replace(/^\uFEFF/, '');
const pick = (n) => raw.match(new RegExp(`^${n}=(.*)$`, 'm'))?.[1]?.trim();
const url = pick('NEXT_PUBLIC_SUPABASE_URL'); const key = pick('SUPABASE_SERVICE_ROLE_KEY');
if (!url || !key) { console.log('DEV credentials absent'); process.exit(0); }
const c = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
console.log(`DEV host: ${new URL(url).host}`);
const show = async (label, q) => { const { data, error } = await q; console.log(`\n== ${label}`); if (error) console.log('  ERROR', error.code, error.message); else console.log(JSON.stringify(data, null, 1)); };
await show('ai_prompt_templates (code, version, status, output_schema_version)', c.from('ai_prompt_templates').select('prompt_code, version, status, output_schema_version, task_type').order('prompt_code').order('version'));
await show('ai_model_registry', c.from('ai_model_registry').select('provider, model_identifier, internal_tier, active, approved, task_types, max_input_tokens, max_output_tokens, cost_input_per_1k_usd, cost_output_per_1k_usd, supports_batch'));
await show('ai_platform_controls', c.from('ai_platform_controls').select('*').eq('id', 'global'));
await show('ai_provider_controls', c.from('ai_provider_controls').select('*'));
await show('ai_task_cost_limits', c.from('ai_task_cost_limits').select('task_type, model_identifier, max_cost_per_request_usd, max_internal_tier, max_monthly_cost_usd, active'));
await show('ai_insight_packs count', c.from('ai_insight_packs').select('id', { count: 'exact', head: true }));
await show('ai_runs count', c.from('ai_runs').select('id', { count: 'exact', head: true }));
await show('admin_users columns sample', c.from('admin_users').select('*').limit(1));

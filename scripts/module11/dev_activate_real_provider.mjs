// Module 11 remediation R2 — DEV-ONLY activation / deactivation of the real
// provider path (brief sections 15, 17). Reversible. Refuses to run against
// any project other than DEV.
//
//   node scripts/module11/dev_activate_real_provider.mjs --activate
//   node scripts/module11/dev_activate_real_provider.mjs --deactivate
//
// --activate (exactly the R7 production activation plan's steps 4-5, in DEV):
//   1. ai_model_registry openai/gpt-4o-mini -> active=true, approved=true
//      (approved_at stamped; approved_by left null because this is a
//      service-role script, not an admin session — recorded in the R2 report).
//   2. ai_prompt_templates PR-AI-013 v2 -> ACTIVE. v1 stays DRAFT (it was
//      never ACTIVE on any environment) so exactly ONE compatible active
//      prompt resolves for monthly_insight_pack (section 17). The partial
//      unique index idx_ai_prompt_templates_one_active is the DB backstop.
//   3. ai_platform_controls.max_output_tokens 800 -> 3200. The pack service
//      requests a fixed 3000-token output budget; the seeded 800 (a Module
//      11.1 default sized for a single explanation) makes ai_admit_request()
//      refuse every real pack with token_budget_exceeded before the provider
//      is reached. This is the disclosed finding of the 11.3 live-DEV script,
//      now corrected for real. The change is written through the same table
//      the admin controls route writes, so migration 0115's audit trigger
//      records it in ai_config_audit.
//   Every other switch (live_provider_enabled, batch_generation_enabled,
//   provider control) is READ and reported, never changed here.
//
// --deactivate reverses 1 and 2 (3 is left at 3200: it is a corrected
// default, not a test fixture — see the R2 report).
import fs from 'fs';
import { createClient } from '@supabase/supabase-js';

const mode = process.argv.includes('--deactivate') ? 'deactivate' : process.argv.includes('--activate') ? 'activate' : null;
if (!mode) { console.error('usage: --activate | --deactivate'); process.exit(2); }
const raw = fs.readFileSync('.env.local', 'utf8').replace(/^﻿/, '');
const pick = (n) => raw.match(new RegExp(`^${n}=(.*)$`, 'm'))?.[1]?.trim();
const url = pick('NEXT_PUBLIC_SUPABASE_URL'); const key = pick('SUPABASE_SERVICE_ROLE_KEY');
if (!url || !key) { console.error('DEV credentials absent'); process.exit(2); }
if (new URL(url).host !== 'vqycarelcoijzwlpkpcz.supabase.co') { console.error(`Refusing: ${new URL(url).host} is not the DEV project`); process.exit(2); }
const c = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
const fail = (m, e) => { console.error(m, e?.message ?? e); process.exit(4); };

if (mode === 'activate') {
  const { error: e1 } = await c.from('ai_model_registry').update({ active: true, approved: true, approved_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('provider', 'openai').eq('model_identifier', 'gpt-4o-mini');
  if (e1) fail('model activate failed', e1);
  console.log('1. openai/gpt-4o-mini -> active=true, approved=true');

  const { data: others } = await c.from('ai_prompt_templates').select('version, status').eq('prompt_code', 'PR-AI-013').eq('status', 'ACTIVE');
  for (const o of others ?? []) if (o.version !== 2) console.log(`   note: PR-AI-013 v${o.version} was ACTIVE — retiring it first`);
  const { error: eR } = await c.from('ai_prompt_templates').update({ status: 'RETIRED', effective_to: new Date().toISOString() }).eq('prompt_code', 'PR-AI-013').eq('status', 'ACTIVE').neq('version', 2);
  if (eR) fail('retire failed', eR);
  const { error: e2 } = await c.from('ai_prompt_templates').update({ status: 'ACTIVE', effective_from: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('prompt_code', 'PR-AI-013').eq('version', 2);
  if (e2) fail('prompt activate failed', e2);
  console.log('2. PR-AI-013 v2 -> ACTIVE (v1 remains DRAFT)');

  const { data: ctl } = await c.from('ai_platform_controls').select('max_output_tokens').eq('id', 'global').single();
  if ((ctl?.max_output_tokens ?? 0) < 3200) {
    const { error: e3 } = await c.from('ai_platform_controls').update({ max_output_tokens: 3200, updated_at: new Date().toISOString() }).eq('id', 'global');
    if (e3) fail('controls update failed', e3);
    console.log(`3. ai_platform_controls.max_output_tokens ${ctl?.max_output_tokens} -> 3200 (audited by 0115 trigger)`);
  } else console.log(`3. ai_platform_controls.max_output_tokens already ${ctl?.max_output_tokens}`);
} else {
  const { error: e1 } = await c.from('ai_model_registry').update({ active: false, approved: false, updated_at: new Date().toISOString() }).eq('provider', 'openai').eq('model_identifier', 'gpt-4o-mini');
  if (e1) fail('model deactivate failed', e1);
  console.log('1. openai/gpt-4o-mini -> active=false, approved=false');
  const { error: e2 } = await c.from('ai_prompt_templates').update({ status: 'DRAFT', updated_at: new Date().toISOString() }).eq('prompt_code', 'PR-AI-013').eq('version', 2);
  if (e2) fail('prompt deactivate failed', e2);
  console.log('2. PR-AI-013 v2 -> DRAFT');
}

const { data: state } = await c.from('ai_platform_controls').select('ai_globally_enabled, live_provider_enabled, batch_generation_enabled, max_output_tokens').eq('id', 'global').single();
const { data: prov } = await c.from('ai_provider_controls').select('provider, enabled').eq('provider', 'openai').maybeSingle();
const { data: prompts } = await c.from('ai_prompt_templates').select('version, status').eq('prompt_code', 'PR-AI-013').order('version');
const { data: audit } = await c.from('ai_config_audit').select('config_table, field, previous_value, new_value, changed_at').order('changed_at', { ascending: false }).limit(3);
console.log('\nDEV state now:', JSON.stringify({ controls: state, openai_provider_control: prov, prompts }, null, 1));
console.log('latest ai_config_audit rows:', JSON.stringify(audit, null, 1));

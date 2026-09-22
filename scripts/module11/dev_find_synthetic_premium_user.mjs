// READ-ONLY: list premium-entitled DEV users whose emails look synthetic (test/example domains), for the R2 smoke test.
import fs from 'fs';
import { createClient } from '@supabase/supabase-js';
const raw = fs.readFileSync('.env.local', 'utf8').replace(/^\uFEFF/, '');
const pick = (n) => raw.match(new RegExp(`^${n}=(.*)$`, 'm'))?.[1]?.trim();
const c = createClient(pick('NEXT_PUBLIC_SUPABASE_URL'), pick('SUPABASE_SERVICE_ROLE_KEY'), { auth: { autoRefreshToken: false, persistSession: false } });
const { data: ents } = await c.from('user_entitlements').select('user_id, plan_tier').eq('plan_tier', 'premium');
console.log(`premium entitlements: ${ents?.length ?? 0}`);
const { data: users } = await c.auth.admin.listUsers({ perPage: 1000 });
const premiumIds = new Set((ents ?? []).map((e) => e.user_id));
const synthetic = (users?.users ?? []).filter((u) => premiumIds.has(u.id) && /(test|synthetic|example|fhip-?e2e|cert|smoke|dev)/i.test(u.email ?? ''));
for (const u of synthetic.slice(0, 15)) console.log(`${u.id}  ${u.email}  created=${u.created_at?.slice(0,10)}`);
console.log(`total premium synthetic-looking: ${synthetic.length}`);

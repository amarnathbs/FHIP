// NAV2 release candidate, B2 on DEV: the REAL price-history gate, against the REAL DEV tables, for a fixture user, unscoped and scoped to chosen funds.
// READ ONLY (no anchor event, no kick). Prints a JSON verdict and exits non-zero if the scoping does not behave.
//   npx tsx scripts/nav2_rc/dev_gate_scope.ts <fixture-email> <selected-instrument-id>[,<id>...] <expectUnscopedHold:true|false>
import { createClient } from '@supabase/supabase-js';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { checkReportNavHistoryGate } from '../../lib/services/investment-intelligence/pc6/reportNavHistoryGate';

const DEV_REF = 'vqycarelcoijzwlpkpcz';
const file = path.resolve(__dirname, '..', '..', '.env.local');
if (!existsSync(file)) throw new Error('no .env.local');
const env: Record<string, string> = {};
for (const l of readFileSync(file, 'utf8').split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, ''); }
if (!env.NEXT_PUBLIC_SUPABASE_URL?.includes(DEV_REF)) throw new Error('not DEV: refusing');
if (Object.keys(env).some((k) => k.startsWith('PRODUCTION_'))) throw new Error('a PRODUCTION_ variable is present: refusing');

async function main() {
  const [email, selected, expectHold] = process.argv.slice(2);
  if (!email || !selected) throw new Error('usage: <email> <ids> <expectUnscopedHold>');
  const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  let userId = '';
  for (let page = 1; page < 20 && !userId; page++) {
    const { data } = await db.auth.admin.listUsers({ page, perPage: 1000 });
    userId = data.users.find((u) => u.email === email)?.id ?? '';
    if (data.users.length < 1000) break;
  }
  if (!userId) throw new Error('no such fixture user');
  const today = new Date().toISOString().slice(0, 10);
  const ids = selected.split(',');
  const unscoped = await checkReportNavHistoryGate({ db: db as never, userId, today });
  const scoped = await checkReportNavHistoryGate({ db: db as never, userId, today, onlyInstrumentIds: ids });
  const slim = (g: typeof unscoped) => ({ hold: g.hold, total: g.total, loaded: g.loaded, waiting: g.waiting.map((f) => f.schemeName), unavailable: g.unavailable.map((f) => `${f.schemeName}:${f.reason}`) });
  const verdict = { unscoped: slim(unscoped), scoped: slim(scoped), selected: ids.length };
  console.log(JSON.stringify(verdict, null, 1));
  const ok = unscoped.hold === (expectHold === 'true') && scoped.total === ids.length && (expectHold === 'true' ? scoped.hold === false : true);
  console.log(ok ? 'GATE SCOPE: as expected' : 'GATE SCOPE: NOT as expected');
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(2); });

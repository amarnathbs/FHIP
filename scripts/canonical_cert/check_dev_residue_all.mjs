/**
 * READ-ONLY DEV check for scripts/canonical_cert/dev_residue_ALL_for_PO.sql: does DEV still hold exactly the
 * rows the file expects, owned by synthetic users, and does the environment guard pass on DEV?
 * Service-role GETs only (no write of any kind). Refuses unless the target is DEV (lib/env.mjs).
 *
 *   node scripts/canonical_cert/check_dev_residue_all.mjs          (exit 0 = every count matches)
 */
import { loadDevEnv } from './lib/env.mjs';
import { buildSpec, DELETE_ORDER } from './build_dev_residue_all_sql.mjs';

const { url, serviceKey } = loadDevEnv();
const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
const get = async (p) => {
  const r = await fetch(`${url}${p}`, { headers });
  if (!r.ok) throw new Error(`GET ${p.split('?')[0]} -> ${r.status} ${await r.text()}`);
  return r.json();
};

const policy = await get('/rest/v1/ii_nav_retention_policy?select=environment');
const envs = policy.map((p) => p.environment);
const guardOk = envs.includes('dev') && !envs.includes('production');
console.log(`guard: ii_nav_retention_policy environments = [${envs.join(', ')}] -> ${guardOk ? 'PASS (the file would proceed)' : 'REFUSE'}`);

const emailOf = new Map();
async function email(uid) {
  if (!emailOf.has(uid)) emailOf.set(uid, (await get(`/auth/v1/admin/users/${uid}`)).email ?? '');
  return emailOf.get(uid);
}
const synthetic = (e) => /@example\.test$/.test(e) || /@test\.fhip\.invalid$/.test(e);

let bad = 0;
let rows = 0;
const spec = buildSpec();
for (const s of spec.sections) {
  const checks = [...(s.preUpdates ?? []).map((u) => ({ table: u.table, ids: [u.id], userId: u.userId, what: 'restore' })), ...s.deletes.map((d) => ({ ...d, what: 'delete' }))];
  for (const c of checks) {
    const found = await get(`/rest/v1/${c.table}?select=id,user_id&id=in.(${c.ids.join(',')})`);
    const owners = await Promise.all(found.map((f) => email(f.user_id)));
    const okOwner = owners.every(synthetic) && (!c.userId || found.every((f) => f.user_id === c.userId));
    const ok = found.length === c.ids.length && okOwner;
    if (!ok) bad += 1;
    if (c.what === 'delete') rows += found.length;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${s.label} ${c.what} ${c.table}: ${found.length}/${c.ids.length} present, owners ${[...new Set(owners)].join(' ') || '-'}`);
  }
}
console.log(`tables in delete order: ${DELETE_ORDER.join(' -> ')}`);

// Dependents the deletes would cascade to / be blocked by (informational; a RESTRICT dependent is a failure).
const idsOf = (table) => spec.sections.flatMap((s) => s.deletes.filter((d) => d.table === table).flatMap((d) => d.ids));
const count = async (table, col, ids) => (ids.length ? (await get(`/rest/v1/${table}?select=id&${col}=in.(${ids.join(',')})`)).length : 0);
const restrictGoals = await count('user_goals', 'linked_liability_id', idsOf('liabilities'));
if (restrictGoals) bad += 1;
console.log(`dependents: user_goals.linked_liability_id (ON DELETE RESTRICT) -> ${restrictGoals}${restrictGoals ? '  FAIL: would block the liabilities delete' : ''}`);
console.log(`dependents (cascade): fdh_transactions on the facility accounts -> ${await count('fdh_transactions', 'financial_account_id', idsOf('fdh_financial_accounts'))}`);
console.log(`dependents (cascade): fdh_transactions on the uploads -> ${await count('fdh_transactions', 'statement_upload_id', idsOf('fdh_statement_uploads'))}`);
console.log(`dependents (cascade): fdh_liability_statement_activities -> ${await count('fdh_liability_statement_activities', 'statement_id', idsOf('fdh_liability_statements'))}`);
console.log(`dependents (cascade): fhip_import_proposal_fields -> ${await count('fhip_import_proposal_fields', 'proposal_id', idsOf('fhip_import_proposals'))}`);
console.log(`${rows} rows to delete present on DEV; ${bad} mismatching check(s)`);
process.exit(bad === 0 && guardOk ? 0 : 1);

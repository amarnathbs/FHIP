/* eslint-disable @typescript-eslint/no-explicit-any -- certification script */
/**
 * Owner-before-upload DEV certification, step 33: the raw-file purge keeps owner provenance.
 *   npx tsx scripts/canonical_cert/final/obu_purge.ts
 * Runs the REAL purge service (runPurgeAttempt: storage delete + verified absent + purge patch) for the synthetic documents AU3 created
 * (bank Self / Spouse / Joint / SMSF, AU investment Joint 50/50) and proves: raw object deleted, owner columns and allocation retained, the raw
 * filename handled per policy (nulled), and no full account number retained anywhere on the row. Synthetic fixture user only; DEV only.
 */
import fs from 'node:fs';
import { loadDevEnv } from '../lib/env.mjs';
import { db, hostGuard, record, results } from './obu_lib.mjs';

const { env } = loadDevEnv();
process.env.NEXT_PUBLIC_SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
process.env.SUPABASE_SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
console.log('DEV host verified:', hostGuard());

async function main() {
  const { runPurgeAttempt } = await import('@/lib/financial-data-hub/services/purge');
  const sb = await db();
  const U3 = (await sb.auth.admin.listUsers({ perPage: 1000 })).data.users.find((u: any) => u.email === 'forecast.tc015@example.test').id;
  const OWNER_COLS = ['owner_member_id', 'owner_business_entity_id', 'owner_role', 'owner_selection_source', 'owner_allocation'];
  const docs = ((await sb.from('fdh_statement_uploads').select('*').eq('user_id', U3).not('raw_document_storage_reference', 'is', null).in('raw_document_purge_status', ['not_required', 'pending', 'failed'])).data ?? []) as any[];
  const picks: any[] = [];
  for (const role of ['self', 'spouse', 'joint', 'smsf']) {
    const d = docs.find((x) => x.owner_role === role && x.document_type === 'bank_statement');
    if (d) picks.push(d);
  }
  const au = docs.find((x) => x.document_type === 'investment_statement' && x.owner_role === 'joint');
  if (au) picks.push(au);
  record(33, 'fixture: synthetic documents with raw files exist for Self, Spouse, Joint, SMSF bank and a Joint AU investment statement', picks.length >= 4, picks.map((p) => `${p.document_type}/${p.owner_role}`).join(', '));
  for (const d of picks) {
    const before = { owner: Object.fromEntries(OWNER_COLS.map((c) => [c, d[c]])), file: d.original_filename_sanitised, ref: d.raw_document_storage_reference };
    const bucket = 'fdh-source-documents';
    const present = await sb.storage.from(bucket).download(d.raw_document_storage_reference);
    const objectThereBefore = !present.error;
    await sb.from('fdh_statement_uploads').update({ raw_document_purge_status: 'pending', raw_document_purge_due_at: new Date().toISOString(), purge_reason: 'obu_cert_manual' }).eq('id', d.id);
    const fresh = (await sb.from('fdh_statement_uploads').select('*').eq('id', d.id).single()).data;
    const r = await runPurgeAttempt(fresh);
    const after = (await sb.from('fdh_statement_uploads').select('*').eq('id', d.id).single()).data;
    const gone = await sb.storage.from(bucket).download(before.ref);
    const label = `${d.document_type}/${d.owner_role}`;
    record(33, `${label}: raw object existed, purge reports purged, and the object is verified ABSENT`, objectThereBefore && r.status === 'purged' && !!gone.error && after.raw_document_purge_status === 'purged' && after.raw_document_storage_reference === null, `before=${objectThereBefore} result=${r.status} after.status=${after.raw_document_purge_status} ref=${after.raw_document_storage_reference} downloadAfterErr=${gone.error?.message ?? 'NONE(object still downloadable)'}`);
    record(33, `${label}: owner provenance RETAINED (role, member, entity, source, allocation unchanged)`, JSON.stringify(OWNER_COLS.map((c) => after[c])) === JSON.stringify(OWNER_COLS.map((c) => before.owner[c])), JSON.stringify({ role: after.owner_role, src: after.owner_selection_source, alloc: after.owner_allocation }));
    record(33, `${label}: raw filename handled per policy (nulled on purge; owner metadata is not a filename)`, before.file !== null && after.original_filename_sanitised === null, `before=${before.file ? 'set' : 'null'} after=${after.original_filename_sanitised === null ? 'null' : 'set'}`);
    const dump = JSON.stringify(after);
    record(33, `${label}: no full account number (7+ digit run) remains anywhere on the row`, !/\d{7,}/.test(dump.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '').replace(/20\d\d-\d\d-\d\dT[\d:.+]+/g, '').replace(/[0-9a-f]{64}/g, '')), '');
  }
  // CAS side (already purged at processing time): owner provenance of the documents is intact on DEV
  const U1 = (await sb.auth.admin.listUsers({ perPage: 1000 })).data.users.find((u: any) => u.email === 'forecast.tc083@example.test').id;
  const cas = ((await sb.from('ii_source_documents').select('owner_role,owner_selection_source,owner_member_id,owner_business_entity_id,owner_allocation,storage_purged_at').eq('user_id', U1).eq('owner_selection_source', 'user_selected')).data ?? []) as any[];
  record(33, 'India CAS documents: raw files already purged and owner provenance (role, member / entity, joint allocation) retained on every one', cas.length >= 6 && cas.every((c) => c.storage_purged_at && c.owner_role) && cas.some((c) => c.owner_role === 'joint' && Array.isArray(c.owner_allocation)) && cas.some((c) => c.owner_business_entity_id), `${cas.length} documents; roles=${[...new Set(cas.map((c) => c.owner_role))].join(',')}`);
  const allocs = (await sb.from('ii_ownership_allocation').select('status,allocation_basis_points').eq('user_id', U1).eq('status', 'active')).data ?? [];
  record(33, 'the active ownership allocations of those documents are retained (the purge never touches them)', allocs.length >= 5, `${allocs.length} active allocation rows`);
}

main().then(() => {
  fs.writeFileSync('.canonical-cert/obu-purge-results.json', JSON.stringify(results, null, 2));
  const bad = results.filter((r: any) => r.ok === false);
  console.log(`\n${results.length} recorded, ${bad.length} FAIL`);
  process.exit(bad.length ? 1 : 0);
}).catch((e) => { console.error(e); process.exit(1); });

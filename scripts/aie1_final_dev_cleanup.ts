/**
 * AIE-1 final production completion (2026-09-25) -- DEV cleanup of every
 * synthetic artefact recorded in the manifest, with independent verification.
 *
 * Deletes each synthetic auth user (email must match the synthetic pattern --
 * a real-looking email is REFUSED), which cascades their owned rows; removes
 * any Supabase Storage object still referenced by their FDH/II rows first;
 * then verifies zero rows remain for those user ids in the tables the journeys
 * wrote. S3 malware-bucket copies are listed, not deleted: the DEV identity has
 * s3:DeleteObject but not s3:DeleteObjectVersion on a VERSIONED bucket, so a
 * plain delete only adds a delete marker (proven live) -- reported for the PO.
 *
 * Run: npx tsx scripts/aie1_final_dev_cleanup.ts
 */
import fs from 'node:fs';
import { devFetch, MANIFEST, makeChecker } from './aie1_final_dev_harness.mjs';

const { check, summary } = makeChecker('AIE1-CLEANUP');
const SYNTHETIC = /^aie1-final-[a-z0-9_-]+@fhip-test\.invalid$/;

async function main() {
  const lines = fs.existsSync(MANIFEST) ? fs.readFileSync(MANIFEST, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : [];
  const users = new Map<string, string>();
  for (const e of lines) if (e.kind === 'auth_user' && e.id && e.email) users.set(e.id, e.email);
  console.log(`manifest entries: ${lines.length}, synthetic users: ${users.size}`);

  const tables = ['fdh_statement_uploads', 'fdh_payroll_events', 'income_sources', 'fhip_import_proposals', 'fdh_transactions', 'ii_source_documents', 'ii_accounts', 'ii_transactions', 'fdh_liability_statements', 'fdh_retirement_statements', 'fdh_investment_statements'];
  let deleted = 0;
  const s3Keys: string[] = [];
  for (const [id, email] of users) {
    if (!SYNTHETIC.test(email)) { console.log(`  REFUSE non-synthetic email for ${id}`); continue; }
    const exists = await devFetch(`/auth/v1/admin/users/${id}`);
    if (exists.status === 404) continue;
    // Storage objects still referenced (FDH + II) are removed before the rows go.
    const fdh = await devFetch(`/rest/v1/fdh_statement_uploads?user_id=eq.${id}&select=raw_document_storage_reference,malware_scan_object_ref`);
    for (const r of (fdh.json ?? []) as any[]) {
      if (r.raw_document_storage_reference) await devFetch(`/storage/v1/object/fdh-source-documents`, { method: 'DELETE', body: { prefixes: [r.raw_document_storage_reference] } });
      const key = r.malware_scan_object_ref?.ref?.objectKey;
      if (key) s3Keys.push(key);
    }
    const ii = await devFetch(`/rest/v1/ii_source_documents?user_id=eq.${id}&select=storage_path,storage_purged_at`);
    for (const r of (ii.json ?? []) as any[]) {
      if (r.storage_path && !r.storage_purged_at) await devFetch(`/storage/v1/object/investment-source-documents`, { method: 'DELETE', body: { prefixes: [r.storage_path] } });
    }
    const del = await devFetch(`/auth/v1/admin/users/${id}`, { method: 'DELETE' });
    if (del.ok) deleted++;
    else console.log(`  could not delete ${id}: ${del.status} ${del.text.slice(0, 200)}`);
  }
  console.log(`deleted users: ${deleted}`);
  let leftovers = 0;
  const ids = [...users.keys()];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50).join(',');
    for (const t of tables) {
      const r = await devFetch(`/rest/v1/${t}?user_id=in.(${chunk})&select=id`);
      const n = Array.isArray(r.json) ? r.json.length : 0;
      if (n > 0) { leftovers += n; console.log(`  leftover ${t}: ${n}`); }
    }
  }
  let authLeft = 0;
  for (const id of ids) if ((await devFetch(`/auth/v1/admin/users/${id}`)).status !== 404) authLeft++;
  check('every synthetic auth user is gone', authLeft === 0, `remaining=${authLeft}`);
  check('no synthetic rows remain in the journey tables (cascade verified independently)', leftovers === 0, `leftover rows=${leftovers}`);
  console.log(`S3 malware-bucket copies needing a version-aware delete (PO/IAM): ${s3Keys.length}`);
  fs.writeFileSync(MANIFEST.replace(/\.jsonl$/, '.s3-keys.txt'), s3Keys.join('\n'));
  process.exit(summary() === 0 ? 0 : 1);
}
main().catch((e) => { console.error('FATAL', e instanceof Error ? e.message : e); process.exit(2); });

/**
 * Zero-residue proof for the Resources Bulk Upload DEV certification: counts every synthetic artefact the harnesses can
 * create (all run tags) across posts, sources, categories, tags, authors, CTAs, import runs, audit rows and auth users.
 *   npx tsx scripts/resources_bulk_upload_residue_check_dev.ts      (DEV only; read-only)
 */
import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const raw = fs.readFileSync('.env.local', 'utf8').replace(/^﻿/, '');
const get = (k: string) => raw.split(/\r?\n/).find((l) => l.startsWith(k + '='))!.slice(k.length + 1).trim();
const url = get('NEXT_PUBLIC_SUPABASE_URL');
if (!url.includes('vqycarelcoijzwlpkpcz')) throw new Error('REFUSING: not DEV');
const admin = createClient(url, get('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
const TAGS = ['bulkcert', 'bulkrecert', 'bulkbrw', 'verify0272', 'verify0273', 'probe', 'timing'];
async function count(table: string, col: string, tag: string) {
  const r = await admin.from(table).select('*', { count: 'exact', head: true }).like(col, `${tag}%`);
  return r.error ? -1 : (r.count ?? 0);
}
async function main() {
  const out: Record<string, number> = {};
  for (const t of TAGS) {
    out[`posts:${t}`] = await count('resource_posts', 'slug', t);
    out[`posts_content_id:${t}`] = await count('resource_posts', 'content_id', t);
    out[`sources:${t}`] = await count('resource_sources', 'source_name', t);
    out[`categories:${t}`] = await count('resource_categories', 'slug', t);
    out[`tags:${t}`] = await count('resource_tags', 'slug', t);
    out[`authors:${t}`] = await count('resource_authors', 'slug', t);
    out[`ctas:${t}`] = await count('resource_ctas', 'name', t);
    out[`import_runs:${t}`] = await count('resource_content_import_runs', 'file_name', '');
  }
  const runs = await admin.from('resource_content_import_runs').select('*', { count: 'exact', head: true });
  const rows = await admin.from('resource_content_import_rows').select('*', { count: 'exact', head: true });
  const users = (await admin.auth.admin.listUsers({ page: 1, perPage: 1000 })).data?.users ?? [];
  const synthetic = users.filter((u) => /@fhip-test\.invalid$/.test(u.email ?? '') && /^(bulkcert|bulkbrw|verify0272|verify0273|probe|timing)/.test(u.email ?? ''));
  const nonzero = Object.entries(out).filter(([k, v]) => v !== 0 && !k.startsWith('import_runs'));
  console.log(JSON.stringify({ importRunsTotal: runs.count, importRowsTotal: rows.count, syntheticAuthUsers: synthetic.length, nonZero: nonzero }, null, 1));
  process.exit(nonzero.length === 0 && synthetic.length === 0 && (runs.count ?? 0) === 0 && (rows.count ?? 0) === 0 ? 0 : 1);
}
void main();

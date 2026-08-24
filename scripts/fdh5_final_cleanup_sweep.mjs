// Final independent cleanup-verification sweep for FDH-5 (orchestration
// note 4/spec 108: never claim cleanup without independently verifying it).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function loadEnv() {
  const p = path.join(repoRoot, '.env.local');
  const env = {};
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}
const env = loadEnv();
const BASE = env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;

async function sb(p) {
  const res = await fetch(`${BASE}${p}`, { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } });
  return res.json();
}

async function main() {
  let page = 1;
  const leftover = [];
  for (;;) {
    const r = await sb(`/auth/v1/admin/users?page=${page}&per_page=200`);
    const users = r.users ?? [];
    if (users.length === 0) break;
    for (const u of users) if (typeof u.email === 'string' && (u.email.startsWith('fdh5-live-cert-') || u.email.startsWith('fdh5-probe-'))) leftover.push(u.email);
    page += 1;
    if (page > 20) break;
  }
  console.log(`Leftover FDH-5 test users: ${leftover.length}`);
  for (const e of leftover) console.log('  -', e);

  const docs = await sb(`/rest/v1/fdh_statement_uploads?original_filename_sanitised=in.(cba-fdh5-e2e.pdf,sbi-fdh5-e2e.pdf,cba-fdh5-password.pdf,probe.pdf)&select=id`);
  console.log(`Leftover FDH-5 test documents: ${Array.isArray(docs) ? docs.length : 'ERROR:' + JSON.stringify(docs)}`);

  if (leftover.length === 0 && Array.isArray(docs) && docs.length === 0) {
    console.log('CLEANUP VERIFIED CLEAN.');
  } else {
    console.log('CLEANUP INCOMPLETE.');
    process.exitCode = 1;
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });

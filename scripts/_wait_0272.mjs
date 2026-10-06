// Polls DEV (read-only, service role, metadata probe) until migration 0272 tables exist. Exits 0 when they do.
import fs from 'node:fs';
const raw = fs.readFileSync('.env.local', 'utf8').replace(/^﻿/, '');
const get = (k) => raw.split(/\r?\n/).find((l) => l.startsWith(k + '='))?.slice(k.length + 1).trim();
const url = get('NEXT_PUBLIC_SUPABASE_URL');
if (!url.includes('vqycarelcoijzwlpkpcz')) throw new Error('not dev');
const key = get('SUPABASE_SERVICE_ROLE_KEY');
const deadline = Date.now() + 5 * 60 * 60 * 1000;
while (Date.now() < deadline) {
  const r = await fetch(url + '/rest/v1/resource_content_import_runs?select=id&limit=1', { headers: { apikey: key, Authorization: 'Bearer ' + key } });
  if (r.status === 200) {
    console.log('0272 TABLES PRESENT');
    process.exit(0);
  }
  await new Promise((res) => setTimeout(res, 30000));
}
console.log('timed out waiting');
process.exit(2);

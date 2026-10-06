// Scans the built CLIENT bundle (.next/static) for secrets, local paths, private fixtures and server-only libraries.
import fs from 'node:fs';
import path from 'node:path';
const raw = fs.readFileSync('.env.local', 'utf8').replace(/^\uFEFF/, '');
const secrets = [];
for (const l of raw.split(/\r?\n/)) {
  const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && /KEY|SECRET|TOKEN|PASSWORD/.test(m[1]) && !m[1].startsWith('NEXT_PUBLIC') && m[2].trim().length > 12) secrets.push([m[1], m[2].trim()]);
}
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(js|css|map|html|json)$/.test(e.name)) files.push(p);
  }
})('.next/static');
const needles = ['D:\\\\FHIP', 'D:/FHIP', 'C:\\\\Users', 'bulkcert', 'bulkbrw', 'fhip-test.invalid', 'SheetJS', 'XLSX.utils', 'SUPABASE_SERVICE_ROLE_KEY', 'resourcesImportFixtures', 'RESOURCE_BULK_UPLOAD_DEV_EVIDENCE', 'node:zlib', 'inflateRawSync', 'twwpnltizhtjxhamyoxt'];
const hits = {};
let bytes = 0;
for (const f of files) {
  const t = fs.readFileSync(f, 'utf8');
  bytes += t.length;
  for (const [k, v] of secrets) if (t.includes(v)) (hits[`SECRET ${k}`] ??= []).push(f);
  for (const n of needles) if (t.includes(n)) (hits[n] ??= []).push(path.basename(f));
}
console.log(JSON.stringify({ filesScanned: files.length, bytes, secretValuesChecked: secrets.length, hits }, null, 1));

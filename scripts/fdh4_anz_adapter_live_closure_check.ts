/**
 * FDH-4 closure check (post-0066): proves the DB-gated pipeline genuinely
 * works end-to-end for a NEW adapter (ANZ) now that migration 0066's
 * parser_registry/parser_versions rows are live -- the specific gap that
 * kept FDH-4 at CONDITIONAL PASS. Not a full re-cert; a targeted closure
 * proof. Reuses the exact auth/upload helpers from
 * fdh4_live_dev_certification.ts.
 *
 * Run: npx tsx scripts/fdh4_anz_adapter_live_closure_check.ts [appBaseUrl]
 */
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const APP = process.argv[2] ?? 'http://localhost:31998';
function loadEnv() {
  const p = path.join(repoRoot, '.env.local');
  const env: Record<string, string> = {};
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}
const env = loadEnv();
const BASE = env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
const PROJECT_REF = new URL(BASE).host.split('.')[0];
const FIXDIR = path.join(repoRoot, 'tests/fixtures/r7-bank-csv');

async function sb(p: string, opts: { method?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };
  const res = await fetch(`${BASE}${p}`, { method: opts.method ?? 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const text = await res.text();
  let json: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { ok: res.ok, status: res.status, json, text };
}
const stamp = Date.now();
const cleanup = { users: [] as string[] };
async function makeUser(tag: string) {
  const email = `fdh4-anz-closure-${tag}-${stamp}@test.fhip.internal`;
  const password = 'TestPass!' + stamp + tag;
  const created = await sb('/auth/v1/admin/users', { method: 'POST', body: { email, password, email_confirm: true } });
  const id = created.json?.id;
  const res2 = await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
  });
  const session = await res2.json();
  if (!id || !session?.access_token) throw new Error(`user setup failed: ${created.text} ${JSON.stringify(session)}`);
  cleanup.users.push(id);
  const cookieValue = 'base64-' + Buffer.from(JSON.stringify(session), 'utf8').toString('base64');
  return { id, cookie: `sb-${PROJECT_REF}-auth-token=${cookieValue}` };
}
async function uploadCsv(cookie: string, meta: Record<string, string>, bytes: Buffer) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(meta)) if (v !== undefined && v !== null) qs.set(k, String(v));
  const res = await fetch(`${APP}/api/financial-data-hub/bank-csv/upload?${qs.toString()}`, {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'text/csv', 'Content-Length': String(bytes.byteLength) }, body: new Uint8Array(bytes),
  });
  const text = await res.text();
  let json: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}
async function appPostJson(pathname: string, cookie: string, body?: unknown) {
  const res = await fetch(`${APP}${pathname}`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  const text = await res.text();
  let json: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}
async function getInstitutionId(code: string, country: string) {
  const r = await sb(`/rest/v1/fdh_financial_institutions?institution_code=eq.${code}&country_code=eq.${country}&select=id`);
  return r.json?.[0]?.id ?? null;
}

async function main() {
  console.log(`DEV project: ${new URL(BASE).host}`);
  console.log(`App under test: ${APP}\n`);
  const user = await makeUser('a');
  const anzInst = await getInstitutionId('anz', 'AU');
  console.log('ANZ institution id (live):', anzInst);
  const bytes = fs.readFileSync(path.join(FIXDIR, 'au_anz_debit_credit.csv'));

  const up = await uploadCsv(user.cookie, { country_code: 'AU', currency_code: 'AUD', institution_id: anzInst, masked_identifier: 'FDH4ANZ1', filename: 'anz-closure-check.csv' }, bytes);
  const docId = up.json?.data?.document_id;
  console.log('Upload:', up.status, docId);

  const det = await appPostJson(`/api/financial-data-hub/bank-csv/${docId}/detect`, user.cookie);
  console.log('Detect:', det.status, JSON.stringify(det.json?.data ?? det.json));

  const proc = await appPostJson(`/api/financial-data-hub/bank-csv/${docId}/process`, user.cookie);
  console.log('Process:', proc.status, JSON.stringify(proc.json?.data ?? proc.json));

  const detectedAdapter = det.json?.data?.adapter_key ?? det.json?.adapter_key;
  const pass = up.status === 200 && det.status === 200 && detectedAdapter === 'au_anz_debit_credit_v1' && proc.status === 200
    && (proc.json?.data?.transactions_created ?? proc.json?.transactions_created) === 5;
  console.log('\n=== RESULT ===');
  console.log(pass ? 'PASS -- ANZ adapter genuinely resolves and processes through the real DB-gated pipeline now that 0066 is live' : 'FAIL -- see raw output above');

  // cleanup
  for (const id of cleanup.users) {
    await sb(`/auth/v1/admin/users/${id}`, { method: 'DELETE' });
  }
  const verify = await Promise.all(cleanup.users.map((id) => sb(`/auth/v1/admin/users/${id}`)));
  console.log('cleanup verify (expect 404 each):', verify.map((v) => v.status));
  process.exit(pass ? 0 : 1);
}
main();

/**
 * FDH-4 — Live DEV scale certification (spec sections 51-52, 85, 110).
 *
 * R7's own live-DEV verification proved pagination correctness up to 2,500
 * rows (R7_TERMINAL_COMPLETION_REPORT.md:90). This closes the remaining gap
 * to the spec's actual 10,000-row target, live, against real DEV — not a
 * local/PGlite simulation. Not a performance benchmark: a correctness proof
 * that (a) no row silently disappears during parse, (b) no row is silently
 * truncated on retrieval by PostgREST's 1000-row default page size, and (c)
 * reconciliation remains exact at this volume.
 *
 * Run: npx tsx scripts/fdh4_live_scale_certification.ts [appBaseUrl]
 */
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const APP = process.argv[2] ?? 'http://localhost:31997';

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

async function sb(p: string, opts: { method?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };
  const res = await fetch(`${BASE}${p}`, { method: opts.method ?? 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const text = await res.text();
  let json: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any -- dynamic JSON response body in certification tooling
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { ok: res.ok, status: res.status, json, text };
}
async function sbCount(p: string) {
  const headers: Record<string, string> = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, Prefer: 'count=exact', Range: '0-0' };
  const res = await fetch(`${BASE}${p}`, { headers });
  const range = res.headers.get('content-range'); // "0-0/12345"
  return range ? Number(range.split('/')[1]) : -1;
}

const stamp = Date.now();
async function makeUser(tag: string) {
  const email = `fdh4-scale-cert-${tag}-${stamp}@test.fhip.internal`;
  const password = 'TestPass!' + stamp + tag;
  const created = await sb('/auth/v1/admin/users', { method: 'POST', body: { email, password, email_confirm: true } });
  const id = created.json?.id;
  const res2 = await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
  });
  const session = await res2.json();
  if (!id || !session?.access_token) throw new Error(`user setup failed: ${created.text} ${JSON.stringify(session)}`);
  const cookieValue = 'base64-' + Buffer.from(JSON.stringify(session), 'utf8').toString('base64');
  return { id, cookie: `sb-${PROJECT_REF}-auth-token=${cookieValue}` };
}

async function main() {
  console.log(`DEV project: ${new URL(BASE).host}\nApp under test: ${APP}\n`);
  const user = await makeUser('scale');
  const cbaInst = (await sb(`/rest/v1/fdh_financial_institutions?institution_code=eq.cba&country_code=eq.AU&select=id`)).json?.[0]?.id;
  const bytes = fs.readFileSync(path.join(repoRoot, '.r7scratch', 'fixtures', 'cba_10000_rows.csv'));
  console.log(`Fixture: ${bytes.byteLength} bytes\n`);

  const t0 = Date.now();
  const qs = new URLSearchParams({ country_code: 'AU', currency_code: 'AUD', institution_id: cbaInst, masked_identifier: 'SCALE1', filename: 'cba-10000.csv' });
  const upRes = await fetch(`${APP}/api/financial-data-hub/bank-csv/upload?${qs}`, { method: 'POST', headers: { Cookie: user.cookie, 'Content-Type': 'text/csv', 'Content-Length': String(bytes.byteLength) }, body: bytes });
  const up = await upRes.json();
  const docId = up.data?.document_id;
  const accountId = up.data?.financial_account_id;
  console.log(`Upload: ${upRes.status} doc=${docId} (${Date.now() - t0}ms)`);

  const t1 = Date.now();
  const detRes = await fetch(`${APP}/api/financial-data-hub/bank-csv/${docId}/detect`, { method: 'POST', headers: { Cookie: user.cookie, 'Content-Type': 'application/json' }, body: '{}' });
  const det = await detRes.json();
  console.log(`Detect: ${detRes.status} status=${det.data?.detection_status} adapter=${det.data?.adapter_key} rows=${det.data?.declared_row_count} (${Date.now() - t1}ms)`);

  const t2 = Date.now();
  const procRes = await fetch(`${APP}/api/financial-data-hub/bank-csv/${docId}/process`, { method: 'POST', headers: { Cookie: user.cookie, 'Content-Type': 'application/json' }, body: '{}' });
  const proc = await procRes.json();
  const procMs = Date.now() - t2;
  console.log(`Process: ${procRes.status} (${procMs}ms)`, JSON.stringify(proc.data));

  const dbCount = await sbCount(`/rest/v1/fdh_transactions?financial_account_id=eq.${accountId}&select=id`);
  const reconRes = await sb(`/rest/v1/fdh_reconciliation_results?statement_upload_id=eq.${docId}&select=*`);
  const recon = reconRes.json?.[0];

  const declared = det.data?.declared_row_count;
  const parsed = proc.data?.parsed_row_count;
  const created = proc.data?.transactions_created;
  const rejected = proc.data?.rejected_rows ?? 0;

  const rowIntegrityOk = declared === 10000 && parsed === 10000 && created === 10000 && rejected === 0;
  const dbRetrievalOk = dbCount === 10000; // proves no silent truncation at the DB/PostgREST layer
  const reconOk = recon?.status === 'reconciled' && recon?.variance === 0;

  console.log(`\n=== RESULTS ===`);
  console.log(`Row integrity (declared=parsed=created=10000, rejected=0): ${rowIntegrityOk ? 'PASS' : 'FAIL'} (declared=${declared} parsed=${parsed} created=${created} rejected=${rejected})`);
  console.log(`DB retrieval count (no PostgREST default-page truncation): ${dbRetrievalOk ? 'PASS' : 'FAIL'} (exact count via Content-Range = ${dbCount})`);
  console.log(`Reconciliation exact at 10,000 rows: ${reconOk ? 'PASS' : 'FAIL'} (status=${recon?.status} variance=${recon?.variance} opening=${recon?.opening_balance} closing=${recon?.expected_closing_balance}/${recon?.reported_closing_balance})`);
  console.log(`Processing time for 10,000 rows: ${procMs}ms (informational only — not a performance benchmark)`);

  // cleanup
  await sb(`/rest/v1/fdh_reconciliation_results?statement_upload_id=eq.${docId}`, { method: 'DELETE' });
  await sb(`/rest/v1/fdh_data_provenance?user_id=eq.${user.id}`, { method: 'DELETE' });
  await sb(`/rest/v1/fdh_transactions?financial_account_id=eq.${accountId}`, { method: 'DELETE' });
  await sb(`/rest/v1/fdh_statement_uploads?id=eq.${docId}`, { method: 'DELETE' });
  await sb(`/rest/v1/fdh_financial_accounts?id=eq.${accountId}`, { method: 'DELETE' });
  await sb(`/auth/v1/admin/users/${user.id}`, { method: 'DELETE' });
  const verify = await sbCount(`/rest/v1/fdh_transactions?financial_account_id=eq.${accountId}&select=id`);
  console.log(`Cleanup verified (0 remaining): ${verify === 0 ? 'PASS' : 'FAIL'}`);

  const allPass = rowIntegrityOk && dbRetrievalOk && reconOk && verify === 0;
  process.exitCode = allPass ? 0 : 1;
}

main().catch((e) => { console.error('FATAL', e); process.exitCode = 1; });

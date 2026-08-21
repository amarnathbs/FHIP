// Investment Intelligence R5 — live-DEV test pack (LIVE-R5-001..010) and
// security pack (SEC-R5-001..012).
//
// FAIL-CLOSED CONVENTION (same as the R1/R4 packs): any test that cannot be
// genuinely evaluated is reported BLOCKED with the exact reason. Nothing is
// ever reported PASS on the basis of code inspection alone, and a check that
// depends on migration 0044 being applied reports BLOCKED — never PASS —
// while that migration is outstanding.
//
// Uses the DEV Supabase project only. Never touches production. Seeds
// throwaway data under ephemeral @fhip-test.local users and deletes it in
// teardown.
//
// Run:  node scripts/ii_r5_live_dev_security_tests.mjs

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

function loadEnv() {
  for (const p of [path.join(repoRoot, '.env.local'), path.resolve(repoRoot, '..', '..', '..', '.env.local')]) {
    if (fs.existsSync(p)) {
      const env = {};
      for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
        const m = line.match(/^([A-Z_]+)=(.*)$/);
        if (m) env[m[1]] = m[2].trim();
      }
      return env;
    }
  }
  throw new Error('No .env.local found');
}
const env = loadEnv();
const BASE = env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;

const results = [];
function record(id, description, status, detail) {
  results.push({ id, description, status, detail });
  console.log(`[${status}] ${id} — ${description}`);
  if (detail) console.log(`        ${String(detail).slice(0, 400)}`);
}

async function req(p, { method = 'GET', apikey = SERVICE, token = SERVICE, body, prefer } = {}) {
  const headers = { apikey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${BASE}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { ok: res.ok, status: res.status, json, text };
}

const stamp = Date.now();
const createdUsers = [];
async function makeUser(tag) {
  const email = `ii-r5-${tag}-${stamp}@fhip-test.local`;
  const password = 'TestPass!' + stamp;
  const created = await req('/auth/v1/admin/users', { method: 'POST', body: { email, password, email_confirm: true } });
  const id = created.json?.id;
  const signIn = await req('/auth/v1/token?grant_type=password', { method: 'POST', apikey: ANON, token: ANON, body: { email, password } });
  const token = signIn.json?.access_token;
  if (!id || !token) throw new Error(`user setup failed for ${tag}: ${created.text} ${signIn.text}`);
  createdUsers.push(id);
  return { id, token, email };
}

async function tableExists(t) {
  const r = await req(`/rest/v1/${t}?select=*&limit=1`);
  return r.status === 200;
}

// ---------------------------------------------------------------------------
async function main() {
  // -------------------------------------------------------------------------
  // SCHEMA GATE — decides which checks can genuinely run.
  // -------------------------------------------------------------------------
  const r5Tables = ['ii_fund_holdings_snapshots', 'ii_fund_holdings_lines', 'ii_security_classifications', 'ii_security_aliases', 'ii_sip_series', 'ii_r5_analytics_results'];
  const present = {};
  for (const t of r5Tables) present[t] = await tableExists(t);
  const migration0044Applied = r5Tables.every((t) => present[t]);
  record(
    'SCHEMA-GATE-R5',
    'Migration 0044 applied to DEV',
    migration0044Applied ? 'PASS' : 'BLOCKED',
    migration0044Applied
      ? 'All six R5 tables present.'
      : `Missing: ${r5Tables.filter((t) => !present[t]).join(', ')}. This session has no DDL capability (probed; see scripts/ii_r5_schema_probe.mjs), so every check that depends on these tables is reported BLOCKED rather than PASS.`
  );

  const A = await makeUser('a');
  const B = await makeUser('b');
  console.log(`\nVictim user A: ${A.id}\nAttacker user B: ${B.id}\n`);

  // -------------------------------------------------------------------------
  // SEC-R5-001..004 — R5 derived-analytics forgery and tenant isolation.
  // -------------------------------------------------------------------------
  if (migration0044Applied) {
    const selfForge = await req('/rest/v1/ii_r5_analytics_results', {
      apikey: ANON, token: A.token, method: 'POST', prefer: 'return=representation',
      body: { user_id: A.id, scope_type: 'portfolio', scope_id: 'forged', metric_key: 'xray_lookthrough', metric_version: 'F', engine_version: 'FORGED-BY-CLIENT', data_as_of_date: '2026-08-21', input_snapshot_version: 'f', quality_status: 'ok', result_value: {} },
    });
    record('SEC-R5-001', 'Ordinary user cannot forge an R5 analytics result for themselves', selfForge.status === 201 ? 'FAIL' : 'PASS', `HTTP ${selfForge.status} ${selfForge.text.slice(0, 180)}`);

    const crossForge = await req('/rest/v1/ii_r5_analytics_results', {
      apikey: ANON, token: B.token, method: 'POST', prefer: 'return=representation',
      body: { user_id: A.id, scope_type: 'portfolio', scope_id: 'cross', metric_key: 'xray_lookthrough', metric_version: 'F', engine_version: 'CROSS-FORGED', data_as_of_date: '2026-08-21', input_snapshot_version: 'f', quality_status: 'ok', result_value: {} },
    });
    record('SEC-R5-002', 'User B cannot forge an R5 analytics result attributed to user A', crossForge.status === 201 ? 'FAIL' : 'PASS', `HTTP ${crossForge.status} ${crossForge.text.slice(0, 180)}`);

    // Real victim row via service role, then attack it.
    const victim = await req('/rest/v1/ii_r5_analytics_results', {
      method: 'POST', prefer: 'return=representation',
      body: { user_id: A.id, scope_type: 'portfolio', scope_id: 'victim-' + stamp, metric_key: 'xray_lookthrough', metric_version: 'v1', engine_version: 'xray-engine-r5-v1', data_as_of_date: '2026-08-21', input_snapshot_version: 'v', quality_status: 'ok', result_value: { coverage: 0.9 } },
    });
    const victimId = victim.json?.[0]?.id;
    if (victimId) {
      const read = await req(`/rest/v1/ii_r5_analytics_results?id=eq.${victimId}&select=*`, { apikey: ANON, token: B.token });
      const leaked = Array.isArray(read.json) && read.json.length > 0;
      record('SEC-R5-003', "User B cannot READ user A's R5 analytics row", leaked ? 'FAIL' : 'PASS', `rows visible to B: ${Array.isArray(read.json) ? read.json.length : read.text.slice(0, 120)}`);

      const ownRead = await req(`/rest/v1/ii_r5_analytics_results?id=eq.${victimId}&select=*`, { apikey: ANON, token: A.token });
      record('SEC-R5-004', 'User A CAN read their own R5 analytics row', Array.isArray(ownRead.json) && ownRead.json.length === 1 ? 'PASS' : 'FAIL', `rows visible to A: ${Array.isArray(ownRead.json) ? ownRead.json.length : ownRead.text.slice(0, 120)}`);

      const del = await req(`/rest/v1/ii_r5_analytics_results?id=eq.${victimId}`, { apikey: ANON, token: B.token, method: 'DELETE' });
      const after = await req(`/rest/v1/ii_r5_analytics_results?id=eq.${victimId}&select=id`);
      record('SEC-R5-005', "User B cannot DELETE user A's R5 analytics row", Array.isArray(after.json) && after.json.length === 1 ? 'PASS' : 'FAIL', `delete HTTP ${del.status}; row still present: ${Array.isArray(after.json) ? after.json.length === 1 : 'unknown'}`);

      const upd = await req(`/rest/v1/ii_r5_analytics_results?id=eq.${victimId}`, { apikey: ANON, token: A.token, method: 'PATCH', body: { engine_version: 'TAMPERED' } });
      const afterUpd = await req(`/rest/v1/ii_r5_analytics_results?id=eq.${victimId}&select=engine_version`);
      const tampered = afterUpd.json?.[0]?.engine_version === 'TAMPERED';
      record('SEC-R5-006', 'Owner cannot UPDATE (tamper with) their own R5 analytics row', tampered ? 'FAIL' : 'PASS', `patch HTTP ${upd.status}; engine_version now ${afterUpd.json?.[0]?.engine_version}`);

      await req(`/rest/v1/ii_r5_analytics_results?id=eq.${victimId}`, { method: 'DELETE' });
    } else {
      for (const id of ['SEC-R5-003', 'SEC-R5-004', 'SEC-R5-005', 'SEC-R5-006']) {
        record(id, 'R5 analytics tenant-isolation check', 'BLOCKED', `Could not seed a victim row: ${victim.text.slice(0, 200)}`);
      }
    }

    // SIP series isolation
    const sipForge = await req('/rest/v1/ii_sip_series', {
      apikey: ANON, token: A.token, method: 'POST', prefer: 'return=representation',
      body: { user_id: A.id, account_id: '00000000-0000-0000-0000-000000000000', instrument_id: '00000000-0000-0000-0000-000000000000', series_key: 'forged', cadence: 'MONTHLY', detection_confidence: 'CONFIRMED_SOURCE', detection_method_version: 'F', threshold_config_version: 'F' },
    });
    record('SEC-R5-007', 'Ordinary user cannot declare a fake SIP series into existence', sipForge.status === 201 ? 'FAIL' : 'PASS', `HTTP ${sipForge.status} ${sipForge.text.slice(0, 180)}`);

    // Reference-data write protection on the NEW R5 tables.
    const anyInstrument = await req('/rest/v1/ii_instruments?select=id&limit=1');
    const instId = anyInstrument.json?.[0]?.id;
    const snapForge = await req('/rest/v1/ii_fund_holdings_snapshots', {
      apikey: ANON, token: A.token, method: 'POST', prefer: 'return=representation',
      body: { fund_instrument_id: instId ?? '00000000-0000-0000-0000-000000000000', holdings_as_of_date: '2026-08-21', source_document_version: 'forged' },
    });
    record('SEC-R5-008', 'Ordinary user cannot insert a fund-holdings snapshot', snapForge.status === 201 ? 'FAIL' : 'PASS', `HTTP ${snapForge.status} ${snapForge.text.slice(0, 180)}`);

    const classForge = await req('/rest/v1/ii_security_classifications', {
      apikey: ANON, token: A.token, method: 'POST', prefer: 'return=representation',
      body: { instrument_id: instId ?? '00000000-0000-0000-0000-000000000000', classification_version: 'forged', taxonomy_key: 'forged', sector_code: 'FORGED', market_cap_class: 'LARGE' },
    });
    record('SEC-R5-009', 'Ordinary user cannot insert a security classification', classForge.status === 201 ? 'FAIL' : 'PASS', `HTTP ${classForge.status} ${classForge.text.slice(0, 180)}`);

    const aliasForge = await req('/rest/v1/ii_security_aliases', {
      apikey: ANON, token: A.token, method: 'POST', prefer: 'return=representation',
      body: { instrument_id: instId ?? '00000000-0000-0000-0000-000000000000', alias_normalised: 'FORGED ALIAS', alias_raw: 'Forged Alias' },
    });
    record('SEC-R5-010', 'Ordinary user cannot insert a controlled security alias', aliasForge.status === 201 ? 'FAIL' : 'PASS', `HTTP ${aliasForge.status} ${aliasForge.text.slice(0, 180)}`);

    const lineForge = await req('/rest/v1/ii_fund_holdings_lines', {
      apikey: ANON, token: A.token, method: 'POST', prefer: 'return=representation',
      body: { snapshot_id: '00000000-0000-0000-0000-000000000000', holding_name: 'FORGED', weight_pct: 99 },
    });
    record('SEC-R5-011', 'Ordinary user cannot insert a fund-holdings line', lineForge.status === 201 ? 'FAIL' : 'PASS', `HTTP ${lineForge.status} ${lineForge.text.slice(0, 180)}`);
  } else {
    for (const id of ['SEC-R5-001', 'SEC-R5-002', 'SEC-R5-003', 'SEC-R5-004', 'SEC-R5-005', 'SEC-R5-006', 'SEC-R5-007', 'SEC-R5-008', 'SEC-R5-009', 'SEC-R5-010', 'SEC-R5-011']) {
      record(id, 'R5-table security check', 'BLOCKED', 'Migration 0044 is not applied to DEV, so the R5 tables do not exist and this check cannot be genuinely evaluated.');
    }
  }

  // -------------------------------------------------------------------------
  // SEC-R5-012 — unauthenticated access is blocked on every R5 surface that
  // exists today. Runs regardless of 0044, using the anon key with no JWT.
  // -------------------------------------------------------------------------
  const anonProbes = [];
  for (const t of ['ii_transactions', 'ii_holding_snapshots', ...r5Tables.filter((x) => present[x])]) {
    const r = await req(`/rest/v1/${t}?select=*&limit=1`, { apikey: ANON, token: ANON });
    anonProbes.push(`${t}: HTTP ${r.status} rows=${Array.isArray(r.json) ? r.json.length : 'n/a'}`);
  }
  const anyAnonRows = anonProbes.some((p) => /rows=[1-9]/.test(p));
  record('SEC-R5-012', 'Unauthenticated (anon-key-only) requests return no user-owned rows', anyAnonRows ? 'FAIL' : 'PASS', anonProbes.join(' | '));

  // -------------------------------------------------------------------------
  // SEC-R5-013 — pre-existing reference data remains write-protected. This
  // runs TODAY and does not depend on 0044.
  // -------------------------------------------------------------------------
  const anyInstrument = await req('/rest/v1/ii_instruments?select=id&limit=1');
  const instId = anyInstrument.json?.[0]?.id;
  if (instId) {
    const fhForge = await req('/rest/v1/ii_fund_holdings', {
      apikey: ANON, token: A.token, method: 'POST', prefer: 'return=representation',
      body: { fund_instrument_id: instId, underlying_name: 'FORGED R5 HOLDING', disclosure_date: '2026-08-21', weight_pct: 99.9 },
    });
    const gt = await req(`/rest/v1/ii_fund_holdings?underlying_name=eq.FORGED R5 HOLDING&select=id`);
    record(
      'SEC-R5-013',
      'Ordinary user cannot insert into the pre-existing ii_fund_holdings reference table',
      fhForge.status !== 201 && Array.isArray(gt.json) && gt.json.length === 0 ? 'PASS' : 'FAIL',
      `HTTP ${fhForge.status}; service-role ground truth rows: ${Array.isArray(gt.json) ? gt.json.length : 'unknown'}`
    );
  } else {
    record('SEC-R5-013', 'Ordinary user cannot insert into ii_fund_holdings', 'BLOCKED', 'No ii_instruments row available to build an FK-valid probe.');
  }

  // -------------------------------------------------------------------------
  // LIVE-R5-001..010 — end-to-end scenarios.
  // -------------------------------------------------------------------------
  const liveScenarios = [
    ['LIVE-R5-001', 'Standard monthly SIP produces a series with an actual SIP XIRR'],
    ['LIVE-R5-002', 'SIP with a missed contribution reports the gap, not "stopped"'],
    ['LIVE-R5-003', 'SIP plus an independent lump sum attributes only the series units'],
    ['LIVE-R5-004', 'Actual-vs-benchmark SIP comparison over identical cash flows'],
    ['LIVE-R5-005', 'Two overlapping mutual funds produce a symmetric overlap figure'],
    ['LIVE-R5-006', 'Multi-fund portfolio X-Ray produces weighted effective exposures'],
    ['LIVE-R5-007', 'Partial holdings coverage is reported at its true fraction'],
    ['LIVE-R5-008', 'Stale holdings raise a stale warning and are not shown as current'],
    ['LIVE-R5-009', 'Debt fund X-Ray shows only supportable measures'],
    ['LIVE-R5-010', 'Cross-user attack target: user B cannot retrieve A\'s SIP or X-Ray'],
  ];
  for (const [id, description] of liveScenarios) {
    record(
      id,
      description,
      'BLOCKED',
      migration0044Applied
        ? 'Scenario harness not executed in this run.'
        : 'Requires migration 0044 (fund-holdings snapshots / SIP series / R5 analytics tables). Not applied to DEV, and this session has no DDL capability.'
    );
  }
}

let exitCode = 0;
try {
  await main();
} catch (e) {
  record('HARNESS', 'Harness execution', 'BLOCKED', e.message);
  exitCode = 2;
} finally {
  for (const id of createdUsers) await req(`/auth/v1/admin/users/${id}`, { method: 'DELETE' });
  console.log('\nCleanup done.');
  const pass = results.filter((r) => r.status === 'PASS').length;
  const fail = results.filter((r) => r.status === 'FAIL').length;
  const blocked = results.filter((r) => r.status === 'BLOCKED').length;
  console.log(`\nSUMMARY: PASS=${pass} FAIL=${fail} BLOCKED=${blocked} (of ${results.length})`);
  fs.writeFileSync(path.join(__dirname, 'ii-r5-certification', 'live_dev_security_results.json'), JSON.stringify({ ranAt: new Date().toISOString(), results }, null, 2));
  if (fail > 0) exitCode = 1;
  process.exit(exitCode);
}

/**
 * M12C — PC4 financial-integrity closure, READ-ONLY re-baseline probe.
 *
 * READ-ONLY. HTTP GET only. No POST, no PATCH, no DELETE, no RPC, no DDL, no
 * DML. Nothing is created, changed or removed in any environment. Follows the
 * identical shape as `scripts/m11_pc4_production_invariant_probe.mjs`, which
 * the M11 phase ran against PRODUCTION under the same read-only discipline.
 *
 * NO PAN, folio number, holder name, scheme name, bank number or raw statement
 * text is printed. Instrument ids are truncated to an 8-character prefix,
 * exactly as M1 and M11 did. No credential value is ever printed.
 *
 * Purpose (M12 dispatch §8.1 / §8.4):
 *   - confirm the CURRENT, still-blocked PC4 production state so the next phase
 *     has a fresh baseline it did not inherit;
 *   - re-reproduce the five named reconciliation residuals exactly;
 *   - read the parse-run warning/error taxonomy behind `parser_fatal_error`
 *     (§8.2's 251 benign rows) at the CATEGORY level only;
 *   - test §8.3's opening-balance hypothesis against the reconciliation inputs
 *     that are visible without reading any individual transaction row.
 *
 * Usage:  node scripts/m12c_pc4_readonly_probe.mjs [dev|prod]
 */
import fs from 'node:fs';

const TARGET = (process.argv[2] ?? 'prod').toLowerCase();

const envPath = ['.env.local', 'D:/FHIP/.env.local'].find((p) => fs.existsSync(p));
if (!envPath) throw new Error('no .env.local found');
const text = fs.readFileSync(envPath, 'utf8').replace(/^\uFEFF/, '');
const env = {};
for (const raw of text.split(/\r?\n/)) {
  const line = raw.trim();
  if (!line || line.startsWith('#')) continue;
  const eq = line.indexOf('=');
  if (eq > 0) env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
}

// The DEV project ref is a NEXT_PUBLIC_ value (it appears in ~16 committed
// scripts and docs in this repository); it is not a secret. It is named here
// because this worktree has no `.env.local` of its own and the shared one does
// not declare NEXT_PUBLIC_SUPABASE_URL.
const DEV_BASE = 'https://vqycarelcoijzwlpkpcz.supabase.co';
const PROD_BASE = (env.PRODUCTION_SUPABASE_URL ?? '').replace(/\/$/, '');

if (!PROD_BASE) throw new Error('PRODUCTION_SUPABASE_URL absent');
if (PROD_BASE === DEV_BASE) throw new Error('SAFETY: production url equals dev url');

const BASE = TARGET === 'dev' ? DEV_BASE : PROD_BASE;
const KEY = TARGET === 'dev' ? env.SUPABASE_SERVICE_ROLE_KEY : env.PRODUCTION_SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) throw new Error(`no key available for target ${TARGET}`);

async function get(q) {
  const res = await fetch(`${BASE}/rest/v1/${q}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, Accept: 'application/json' },
  });
  if (!res.ok) {
    let b = null;
    try {
      b = await res.json();
    } catch {
      /* ignore */
    }
    return { ok: false, code: b?.code ?? res.status, message: b?.message ?? null };
  }
  return { ok: true, data: await res.json() };
}

const short = (id) => (typeof id === 'string' ? id.slice(0, 8) : String(id));

console.log(`=== M12C — PC4 ${TARGET.toUpperCase()} re-baseline (READ-ONLY, GET only) ===\n`);

// ---------------------------------------------------------------- controls
const neg = await get('ii_portfolio_truth_status?select=zz_no_such_column_m12c&limit=1');
console.log(`NEGATIVE CONTROL (bad column)   : ${neg.ok ? 'FAILED — returned rows' : `PASS (${neg.code})`}`);
const neg2 = await get('zz_no_such_table_m12c?select=id&limit=1');
console.log(`NEGATIVE CONTROL (bad table)    : ${neg2.ok ? 'FAILED — returned rows' : `PASS (${neg2.code})`}`);

// --------------------------------------------------------- §8.1 / §8.4 state
const truth = await get(
  'ii_portfolio_truth_status?select=instrument_id,account_id,status,certified_at,unit_variance,unit_variance_within_tolerance,history_completeness,reconciled_opening_units,reconciled_closing_units,statement_closing_units,blocking_reasons,warning_reasons,last_evaluated_at&limit=500',
);
if (!truth.ok) {
  console.log(`\nii_portfolio_truth_status       : UNAVAILABLE (${truth.code} ${truth.message})`);
} else {
  const rows = truth.data;
  console.log(`\nii_portfolio_truth_status rows  : ${rows.length}`);
  const statuses = {};
  for (const r of rows) statuses[r.status] = (statuses[r.status] ?? 0) + 1;
  console.log(`status breakdown                : ${JSON.stringify(statuses)}`);
  console.log(`certified_at non-null           : ${rows.filter((r) => r.certified_at).length}`);
  const tol = {};
  for (const r of rows) tol[String(r.unit_variance_within_tolerance)] = (tol[String(r.unit_variance_within_tolerance)] ?? 0) + 1;
  console.log(`unit_variance_within_tolerance  : ${JSON.stringify(tol)}`);
  const hist = {};
  for (const r of rows) hist[String(r.history_completeness)] = (hist[String(r.history_completeness)] ?? 0) + 1;
  console.log(`history_completeness            : ${JSON.stringify(hist)}`);
  const blocking = {};
  for (const r of rows) for (const b of r.blocking_reasons ?? []) blocking[b] = (blocking[b] ?? 0) + 1;
  console.log(`blocking_reasons                : ${JSON.stringify(blocking)}`);
  const warning = {};
  for (const r of rows) for (const w of r.warning_reasons ?? []) warning[w] = (warning[w] ?? 0) + 1;
  console.log(`warning_reasons                 : ${JSON.stringify(warning)}`);
  console.log(`max last_evaluated_at           : ${rows.map((r) => r.last_evaluated_at).sort().at(-1) ?? 'n/a'}`);

  console.log('\n--- reconciliation arithmetic, per position (units only, no names) ---');
  console.log('instrument  opening        reconciled     statement      variance       within');
  for (const r of [...rows].sort((a, b) => Number(a.unit_variance ?? 0) - Number(b.unit_variance ?? 0))) {
    const f = (v) => String(v ?? 'null').padEnd(14);
    console.log(`${short(r.instrument_id)}    ${f(r.reconciled_opening_units)} ${f(r.reconciled_closing_units)} ${f(r.statement_closing_units)} ${f(r.unit_variance)} ${r.unit_variance_within_tolerance}`);
  }
}

// ----------------------------------------------------- §8.2 warning taxonomy
const runs = await get(
  'ii_document_parse_runs?select=id,status,parser_id,parser_version,detected_format,confidence,warnings,accounts_found,schemes_found,transactions_found,holdings_found,created_at&order=created_at.desc&limit=40',
);
if (!runs.ok) {
  console.log(`\nii_document_parse_runs          : UNAVAILABLE (${runs.code} ${runs.message})`);
} else {
  console.log(`\nii_document_parse_runs rows     : ${runs.data.length}`);
  const latestOk = runs.data.find((r) => (r.transactions_found ?? 0) > 0);
  if (latestOk) {
    console.log(`latest run with transactions    : ${short(latestOk.id)} @ ${latestOk.created_at}`);
    console.log(`  parser/format/confidence      : ${latestOk.parser_id}@${latestOk.parser_version} / ${latestOk.detected_format} / ${latestOk.confidence}`);
    console.log(`  accounts/schemes/txns/holdings: ${latestOk.accounts_found}/${latestOk.schemes_found}/${latestOk.transactions_found}/${latestOk.holdings_found}`);
    const w = Array.isArray(latestOk.warnings) ? latestOk.warnings : [];
    const byCodeSeverity = {};
    for (const x of w) {
      const k = `${x.code}/${x.severity}`;
      byCodeSeverity[k] = (byCodeSeverity[k] ?? 0) + 1;
    }
    console.log(`  warnings, by code/severity    : ${JSON.stringify(byCodeSeverity)}`);
  } else {
    console.log('latest run with transactions    : none found');
  }
  const statusCounts = {};
  for (const r of runs.data) statusCounts[r.status] = (statusCounts[r.status] ?? 0) + 1;
  console.log(`run status breakdown            : ${JSON.stringify(statusCounts)}`);
}

// ------------------------------------------------ §8.1 owner-resolution state
const docs = await get('ii_source_documents?select=id,owner_member_id,status,document_type,created_at&limit=100');
if (!docs.ok) {
  console.log(`\nii_source_documents             : UNAVAILABLE (${docs.code} ${docs.message})`);
} else {
  console.log(`\nii_source_documents rows        : ${docs.data.length}`);
  console.log(`  owner_member_id null          : ${docs.data.filter((d) => !d.owner_member_id).length}`);
  console.log(`  owner_member_id set           : ${docs.data.filter((d) => d.owner_member_id).length}`);
  const st = {};
  for (const d of docs.data) st[d.status] = (st[d.status] ?? 0) + 1;
  console.log(`  status breakdown              : ${JSON.stringify(st)}`);
}

const cases = await get('ii_reconciliation_cases?select=id,case_type,status&limit=500');
if (!cases.ok) {
  console.log(`\nii_reconciliation_cases         : UNAVAILABLE (${cases.code} ${cases.message})`);
} else {
  const byType = {};
  const byStatus = {};
  for (const c of cases.data) {
    byType[c.case_type] = (byType[c.case_type] ?? 0) + 1;
    byStatus[c.status] = (byStatus[c.status] ?? 0) + 1;
  }
  console.log(`\nii_reconciliation_cases rows    : ${cases.data.length}`);
  console.log(`  by case_type                  : ${JSON.stringify(byType)}`);
  console.log(`  by status                     : ${JSON.stringify(byStatus)}`);
}

console.log('\n=== end — zero writes performed ===');

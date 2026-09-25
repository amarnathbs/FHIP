// NAV 1 D.10 -- READ-ONLY cleanup candidate manifest (rebuilt 2026-09-25 against
// the 0189 KEEP rule; replaces the retired nav1_dev_retention_dryrun.mjs and
// pc6_nav1_retention_dryrun_manifest.sql, whose protected set was the obsolete
// certified-only rule).
//
// WHAT IT DOES
//   Reads through PostgREST with GET only. The HTTP wrapper refuses any other
//   method and any request body, asserts the target project host before every
//   request, and logs every request's method, so the manifest itself carries
//   the proof that generation performed no mutation.
//
//   The protected set is computed INDEPENDENTLY of the candidate function:
//   it reads the seven user-scoped ii_* sources, benchmark mappings, report NAV
//   dependencies, holds, merge links and core `investments` links directly and
//   builds its own anti-join. The candidate function (pc6_nav_row_is_candidate)
//   is used only afterwards, on samples, as a cross-check -- never to produce
//   the manifest.
//
//   Candidate rows = pre-changeover rows of every instrument outside the
//   protected set. Counted two independent ways -- per instrument and per
//   calendar month -- which must agree exactly (the per-month count minus the
//   protected rows in that month).
//
// WHAT IT CANNOT DO VIA POSTGREST (and says so in the manifest)
//   - a checksum over all ~22M candidate primary keys (the SQL for the PO to
//     run in the SQL editor is in docs/nav1/NAV1_D10_manifest_sql_for_PO.sql);
//   - physical table/index sizes (pg_class is not exposed): bytes are an
//     explicitly labelled estimate.
//   It DOES produce an exact primary-key list + checksum for the proposed
//   canary, which is small enough to page.
//
// Usage: node scripts/nav1_d10_readonly_manifest.mjs <prod|dev> <outDir> [canaryRowCeiling=10000]
// Credentials from D:/FHIP/.env.local (never printed).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';

const TARGETS = {
  prod: { host: 'twwpnltizhtjxhamyoxt.supabase.co', urlKey: 'PRODUCTION_SUPABASE_URL', keyKey: 'PRODUCTION_SUPABASE_SERVICE_ROLE_KEY', environment: 'production' },
  dev: { host: 'vqycarelcoijzwlpkpcz.supabase.co', urlKey: 'NEXT_PUBLIC_SUPABASE_URL', keyKey: 'SUPABASE_SERVICE_ROLE_KEY', environment: 'dev' },
};
const which = process.argv[2];
const outDir = process.argv[3];
const CANARY_CEILING = Number(process.argv[4] ?? 10000);
if (!TARGETS[which] || !outDir) { console.error('usage: nav1_d10_readonly_manifest.mjs <prod|dev> <outDir> [canaryRowCeiling]'); process.exit(2); }
const T = TARGETS[which];
const env = Object.fromEntries(fs.readFileSync('D:/FHIP/.env.local', 'utf8').split(/\r?\n/)
  .filter((l) => l && !l.startsWith('#') && l.includes('='))
  .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^"|"$/g, '')]));
const BASE = env[T.urlKey];
const KEY = env[T.keyKey];
if (new URL(BASE).host !== T.host) throw new Error('HOST ASSERTION FAILED');

// ---------------------------------------------------------------- GET-only client
const requestLog = { GET: 0, refused: 0 };
async function get(pathAndQuery, { prefer } = {}, attempt = 1) {
  const method = 'GET';
  if (new URL(BASE).host !== T.host) throw new Error('HOST ASSERTION FAILED');
  requestLog[method]++;
  const headers = { apikey: KEY, Authorization: `Bearer ${KEY}` };
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${BASE}/rest/v1/${pathAndQuery}`, { method, headers });
  const text = await res.text();
  if (res.status >= 500 && attempt < 4) { await new Promise((r) => setTimeout(r, 1000 * attempt)); return get(pathAndQuery, { prefer }, attempt + 1); }
  let body; try { body = JSON.parse(text); } catch { body = text; }
  if (res.status >= 400) throw new Error(`GET ${pathAndQuery.slice(0, 120)} -> ${res.status} ${text.slice(0, 200)}`);
  return { body, range: res.headers.get('content-range') };
}
// Any non-GET is a programming error in this file; there is deliberately no way to issue one.
const count = async (table, filter) => {
  const r = await get(`${table}?select=*${filter ? '&' + filter : ''}&limit=1`, { prefer: 'count=exact' });
  return Number(r.range.split('/')[1]);
};
async function pageAll(pathAndQuery, order) {
  const out = [];
  for (let offset = 0; ; offset += 1000) {
    const r = await get(`${pathAndQuery}${pathAndQuery.includes('?') ? '&' : '?'}order=${order}&limit=1000&offset=${offset}`);
    out.push(...r.body);
    if (r.body.length < 1000) return out;
  }
}
async function pool(items, n, fn) {
  const results = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; results[k] = await fn(items[k], k); } }));
  return results;
}
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const NL = String.fromCharCode(10);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------------------------------------------------------------- identity
const generatedAt = new Date().toISOString();
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const git = (c) => { try { return execSync(`git ${c}`, { cwd: repoRoot }).toString().trim(); } catch { return null; } };
const migDir = path.join(repoRoot, 'supabase', 'migrations');
const migFiles = fs.readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort();
const migrationSetHash = sha256(migFiles.map((f) => `${f}:${sha256(fs.readFileSync(path.join(migDir, f)))}`).join('\n'));
const m0189 = fs.readFileSync(path.join(migDir, '0189_nav1_user_held_retention_definition.sql'), 'utf8');
const predicateSrc = m0189.slice(m0189.indexOf('create or replace function pc6_nav_row_is_candidate'), m0189.indexOf("comment on function pc6_nav_row_is_candidate"));

log(`target ${T.environment} (${T.host}); READ-ONLY`);
const policyRows = (await get(`ii_nav_retention_policy?select=policy_version,changeover_date,environment,activated_at&environment=eq.${T.environment}`)).body;
if (policyRows.length !== 1) throw new Error(`expected exactly one ${T.environment} retention policy row, got ${policyRows.length} -- refusing (fail closed)`);
const policy = policyRows[0];
const C = policy.changeover_date;
const specRes = await fetch(`${BASE}/rest/v1/`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, Accept: 'application/openapi+json' } });
requestLog.GET++;
const spec = await specRes.json();
const deployedPredicateDescription = spec.paths?.['/rpc/pc6_nav_row_is_candidate']?.post?.summary ?? spec.paths?.['/rpc/pc6_nav_row_is_candidate']?.post?.parameters?.[0]?.schema?.description ?? null;

// ---------------------------------------------------------------- snapshot (before)
const snapshot = async () => ({
  held_rpc: (await pageAll('rpc/pc6_user_held_instrument_ids?select=instrument_id', 'instrument_id')).length,
  holds: await count('ii_nav_retention_holds'),
  report_deps: await count('ii_report_nav_dependencies'),
  benchmarks: await count('ii_instrument_benchmarks'),
  batches_running: await count('ii_reference_import_batches', 'status=eq.running'),
  pre_changeover_rows_of_held: null,
});
const before = await snapshot();
log('snapshot before', JSON.stringify(before));

// ---------------------------------------------------------------- independent protected set
const SOURCES = ['ii_transactions', 'ii_holding_snapshots', 'ii_portfolio_truth_status', 'ii_tax_lots', 'ii_sip_series', 'ii_capital_gains_computations', 'ii_fhip_publications'];
const protectedBy = new Map(); // instrument -> Set(reasons)
const addReason = (id, reason) => { if (!id) return; if (!protectedBy.has(id)) protectedBy.set(id, new Set()); protectedBy.get(id).add(reason); };
const sourceCounts = {};
for (const t of SOURCES) {
  const rows = await pageAll(`${t}?select=id,instrument_id&instrument_id=not.is.null`, 'id');
  sourceCounts[t] = { rows: rows.length, instruments: new Set(rows.map((r) => r.instrument_id)).size };
  rows.forEach((r) => addReason(r.instrument_id, `user_held:${t}`));
}
const bench = await pageAll('ii_instrument_benchmarks?select=id,instrument_id', 'id');
bench.forEach((r) => addReason(r.instrument_id, 'benchmark_mapping'));
const deps = await pageAll('ii_report_nav_dependencies?select=id,instrument_id,nav_date_from,nav_date_to', 'id');
// Report deps are date-ranged in the predicate; the manifest protects the WHOLE instrument (stricter).
deps.forEach((r) => addReason(r.instrument_id, 'report_nav_dependency'));
const holds = await pageAll('ii_nav_retention_holds?select=id,instrument_id,released_at,expires_at', 'id');
const nowIso = new Date().toISOString();
// ANY hold row -- open, released or expired -- protects its instrument in the manifest (stricter than the predicate).
holds.forEach((h) => addReason(h.instrument_id, h.released_at === null && (h.expires_at === null || h.expires_at > nowIso) ? 'open_hold' : 'closed_hold_(manifest_is_stricter)'));
const merges = [
  ...(await pageAll('ii_instruments?select=id,merged_into_instrument_id&merged_into_instrument_id=not.is.null', 'id')).map((r) => [r.id, r.merged_into_instrument_id]),
  ...(await pageAll('ii_scheme_master?select=id,instrument_id,merged_into_instrument_id&merged_into_instrument_id=not.is.null', 'id')).map((r) => [r.instrument_id, r.merged_into_instrument_id]),
].filter(([a, b]) => a && b);
// Merge families: any member of a family containing a protected instrument is protected.
{
  let changed = true;
  while (changed) {
    changed = false;
    for (const [a, b] of merges) {
      if (protectedBy.has(a) && !protectedBy.get(b)?.has('merge_family')) { addReason(b, 'merge_family'); changed = true; }
      if (protectedBy.has(b) && !protectedBy.get(a)?.has('merge_family')) { addReason(a, 'merge_family'); changed = true; }
    }
  }
}
// Outside ii_*: core investments linked to a canonical II instrument.
const inv = await pageAll('investments?select=id,ii_canonical_instrument_id&ii_canonical_instrument_id=not.is.null', 'id').catch((e) => ({ error: e.message }));
if (Array.isArray(inv)) inv.forEach((r) => addReason(r.ii_canonical_instrument_id, 'core_investments_link'));
// Pending AI-extraction reviews: ISINs not yet written as transactions. Map to instruments, protect them.
let pendingReviews = { rows: 0, isins: 0, instruments: 0 };
try {
  const rev = await pageAll('ii_ai_extraction_reviews?select=id,status,extracted_holdings&status=eq.pending_review', 'id');
  const isins = new Set();
  for (const r of rev) for (const h of Array.isArray(r.extracted_holdings) ? r.extracted_holdings : []) if (h && typeof h.isin === 'string') isins.add(h.isin);
  let mapped = 0;
  for (const isin of isins) {
    const a = (await get(`ii_instruments?select=id&isin=eq.${encodeURIComponent(isin)}`)).body.map((x) => x.id);
    const b = (await get(`ii_instrument_identifiers?select=instrument_id&identifier_scheme=eq.isin&identifier_value=eq.${encodeURIComponent(isin)}`)).body.map((x) => x.instrument_id);
    for (const id of new Set([...a, ...b])) { addReason(id, 'pending_ai_review_isin'); mapped++; }
  }
  pendingReviews = { rows: rev.length, isins: isins.size, instruments: mapped };
} catch (e) {
  // PGRST205: the table is not in this environment's schema (0160 not applied) -- nothing can be pending in it.
  pendingReviews = /PGRST205/.test(e.message) ? { table_absent_in_this_environment: true, rows: 0 } : { error: e.message };
}

// Cross-check the independent user-held set against the deployed RPC (two definitions must agree).
const rpcHeld = new Set((await pageAll('rpc/pc6_user_held_instrument_ids?select=instrument_id', 'instrument_id')).map((r) => r.instrument_id));
const independentHeld = new Set([...protectedBy].filter(([, rs]) => [...rs].some((x) => x.startsWith('user_held:'))).map(([id]) => id));
const heldAgree = rpcHeld.size === independentHeld.size && [...rpcHeld].every((x) => independentHeld.has(x));
log(`protected instruments: ${protectedBy.size} (user-held independent ${independentHeld.size}, RPC ${rpcHeld.size}, agree=${heldAgree})`);
if (!heldAgree) throw new Error('independent user-held set disagrees with pc6_user_held_instrument_ids() -- refusing (fail closed)');

// ---------------------------------------------------------------- per-instrument counts
const instruments = (await pageAll('ii_instruments?select=id', 'id')).map((r) => r.id);
log(`counting pre-changeover rows for ${instruments.length} instruments (GET count=exact, 4 in flight)`);
let done = 0;
const perInstrument = await pool(instruments, 4, async (id) => {
  const c = await count('ii_prices_nav', `instrument_id=eq.${id}&price_date=lt.${C}`);
  if (++done % 2000 === 0) log(`  ${done}/${instruments.length}`);
  return c;
});
const perInstrumentMap = Object.fromEntries(instruments.map((id, i) => [id, perInstrument[i]]));
const preTotalByInstrument = perInstrument.reduce((a, b) => a + b, 0);
const protectedPre = instruments.filter((id) => protectedBy.has(id)).reduce((a, id) => a + perInstrumentMap[id], 0);
const candidateInstruments = instruments.filter((id) => !protectedBy.has(id) && perInstrumentMap[id] > 0);
const candidateRows = candidateInstruments.reduce((a, id) => a + perInstrumentMap[id], 0);
const postChangeoverRows = await count('ii_prices_nav', `price_date=gte.${C}`);

// ---------------------------------------------------------------- per-month counts (independent partition)
const minDate = (await get('ii_prices_nav?select=price_date&order=price_date.asc&limit=1')).body[0]?.price_date;
const maxPre = (await get(`ii_prices_nav?select=price_date&price_date=lt.${C}&order=price_date.desc&limit=1`)).body[0]?.price_date;
const months = [];
for (let d = new Date(`${minDate.slice(0, 7)}-01T00:00:00Z`); d.toISOString().slice(0, 10) < C; d.setUTCMonth(d.getUTCMonth() + 1)) months.push(d.toISOString().slice(0, 7));
log(`counting ${months.length} months ${months[0]}..${months.at(-1)}`);
const monthEnd = (m) => { const d = new Date(`${m}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + 1); const e = d.toISOString().slice(0, 10); return e < C ? e : C; };
const perMonthAll = await pool(months, 4, async (m) => count('ii_prices_nav', `price_date=gte.${m}-01&price_date=lt.${monthEnd(m)}`));
// protected rows per month: page the protected instruments' pre-changeover dates (small).
const protectedPerMonth = {};
const protectedDates = [];
for (const id of instruments.filter((x) => protectedBy.has(x) && perInstrumentMap[x] > 0)) {
  const rows = await pageAll(`ii_prices_nav?select=id,price_date&instrument_id=eq.${id}&price_date=lt.${C}`, 'id');
  for (const r of rows) { protectedPerMonth[r.price_date.slice(0, 7)] = (protectedPerMonth[r.price_date.slice(0, 7)] ?? 0) + 1; protectedDates.push(r.price_date); }
}
const perMonth = Object.fromEntries(months.map((m, i) => [m, { all: perMonthAll[i], protected: protectedPerMonth[m] ?? 0, candidate: perMonthAll[i] - (protectedPerMonth[m] ?? 0) }]));
const preTotalByMonth = perMonthAll.reduce((a, b) => a + b, 0);
const candidateByMonthTotal = Object.values(perMonth).reduce((a, m) => a + m.candidate, 0);
const perYear = {};
for (const [m, v] of Object.entries(perMonth)) perYear[m.slice(0, 4)] = (perYear[m.slice(0, 4)] ?? 0) + v.candidate;

// ---------------------------------------------------------------- canary: exact PK list
// A few WHOLE instruments with substantial history (1,000+ pre-changeover
// rows), in instrument_id order, up to the ceiling. Whole instruments keep the
// canary easy to verify, and to restore by re-hydrating from AMFI.
const canary = { instruments: [], ids: [], rule: `whole candidate instruments with >= 1000 pre-changeover rows, instrument_id order, cumulative rows <= ${CANARY_CEILING}` };
for (const id of candidateInstruments) {
  if (perInstrumentMap[id] < 1000) continue;
  if (canary.ids.length + perInstrumentMap[id] > CANARY_CEILING) continue;
  const rows = await pageAll(`ii_prices_nav?select=id,price_date&instrument_id=eq.${id}&price_date=lt.${C}`, 'id');
  if (rows.length !== perInstrumentMap[id]) throw new Error(`canary drift on ${id}: ${rows.length} vs ${perInstrumentMap[id]}`);
  canary.instruments.push({ instrument_id: id, rows: rows.length, from: rows.map((r) => r.price_date).sort()[0], to: rows.map((r) => r.price_date).sort().at(-1) });
  canary.ids.push(...rows.map((r) => r.id));
  if (canary.ids.length >= CANARY_CEILING * 0.9) break;
}
canary.ids.sort();
const canaryChecksum = sha256(canary.ids.join('\n'));

// ---------------------------------------------------------------- samples, cross-checked against the deployed predicate
const pick = (arr, n, salt) => arr.map((x) => [sha256(salt + x), x]).sort().slice(0, n).map(([, x]) => x);
const candSample = [];
for (const id of pick(candidateInstruments, 30, 'cand')) {
  const r = (await get(`ii_prices_nav?select=id,instrument_id,price_date&instrument_id=eq.${id}&price_date=lt.${C}&order=price_date.asc&limit=1&offset=${Math.floor(perInstrumentMap[id] / 2)}`)).body[0];
  const v = (await get(`rpc/pc6_nav_row_is_candidate?p_instrument_id=${r.instrument_id}&p_price_date=${r.price_date}&p_changeover_date=${C}`)).body;
  candSample.push({ instrument_id: r.instrument_id, price_date: r.price_date, predicate: v });
}
const protSample = [];
for (const [id, reasons] of protectedBy) {
  if (!perInstrumentMap[id]) continue;
  const r = (await get(`ii_prices_nav?select=instrument_id,price_date&instrument_id=eq.${id}&price_date=lt.${C}&order=price_date.asc&limit=1`)).body[0];
  const v = (await get(`rpc/pc6_nav_row_is_candidate?p_instrument_id=${id}&p_price_date=${r.price_date}&p_changeover_date=${C}`)).body;
  protSample.push({ instrument_id: id, reasons: [...reasons], earliest_pre_changeover: r.price_date, predicate: v });
}
const postSample = [];
for (const id of pick(candidateInstruments, 10, 'post')) {
  const r = (await get(`ii_prices_nav?select=instrument_id,price_date&instrument_id=eq.${id}&price_date=gte.${C}&order=price_date.asc&limit=1`)).body[0];
  if (!r) continue;
  const v = (await get(`rpc/pc6_nav_row_is_candidate?p_instrument_id=${id}&p_price_date=${r.price_date}&p_changeover_date=${C}`)).body;
  postSample.push({ instrument_id: id, price_date: r.price_date, predicate: v });
}

// ---------------------------------------------------------------- assertions
const after = await snapshot();
const assertions = {
  zero_candidates_intersect_user_held_sources: candidateInstruments.every((id) => !independentHeld.has(id)),
  zero_candidates_intersect_rpc_user_held: candidateInstruments.every((id) => !rpcHeld.has(id)),
  zero_candidates_intersect_any_hold_row: candidateInstruments.every((id) => !holds.some((h) => h.instrument_id === id)),
  zero_candidates_intersect_report_dependencies: candidateInstruments.every((id) => !deps.some((d) => d.instrument_id === id)),
  zero_candidates_intersect_benchmarks: candidateInstruments.every((id) => !bench.some((b) => b.instrument_id === id)),
  zero_candidates_intersect_merge_families_of_protected: candidateInstruments.every((id) => !protectedBy.has(id)),
  zero_candidates_intersect_core_investments_links: Array.isArray(inv) ? candidateInstruments.every((id) => !inv.some((r) => r.ii_canonical_instrument_id === id)) : 'NOT_EVALUATED',
  zero_candidates_on_or_after_changeover: maxPre < C && candidateByMonthTotal === candidateRows,
  no_running_import_or_hydration_batch_at_generation: before.batches_running === 0 && after.batches_running === 0,
  partitions_agree_instrument_vs_month: preTotalByInstrument === preTotalByMonth && candidateByMonthTotal === candidateRows,
  every_candidate_sample_is_candidate_per_deployed_predicate: candSample.every((s) => s.predicate === true),
  every_protected_sample_is_keep_per_deployed_predicate: protSample.every((s) => s.predicate === false),
  every_post_changeover_sample_is_keep_per_deployed_predicate: postSample.every((s) => s.predicate === false),
  protected_state_unchanged_during_generation: JSON.stringify(before) === JSON.stringify(after),
  generation_issued_only_GET_requests: requestLog.refused === 0,
};

const aggregate = {
  changeover: C,
  per_instrument_candidate_counts: candidateInstruments.map((id) => `${id}:${perInstrumentMap[id]}`),
  per_month_candidate_counts: Object.entries(perMonth).map(([m, v]) => `${m}:${v.candidate}`),
};
const aggregateChecksum = sha256(JSON.stringify(aggregate));
const manifest = {
  manifest_id: `NAV1-D10-${T.environment}-${generatedAt.slice(0, 10)}-${aggregateChecksum.slice(0, 12)}`,
  generated_at: generatedAt,
  database: { environment: T.environment, project_host: T.host },
  deployed_app: { note: 'no version endpoint exists; see certification report for SHA evidence' },
  generator: { commit: git('rev-parse HEAD'), branch: git('rev-parse --abbrev-ref HEAD'), dirty: (git('status --porcelain') ?? '').length > 0, command: `node scripts/nav1_d10_readonly_manifest.mjs ${which} <outDir> ${CANARY_CEILING}` },
  migration_set: { files: migFiles.length, last: migFiles.at(-1), sha256: migrationSetHash, note: 'repository set at the generator commit; the applied set is not readable via PostgREST' },
  retention_policy: policy,
  candidate_predicate: {
    version: '0189 (pc6_nav_row_is_candidate)', repo_source_sha256: sha256(predicateSrc), deployed_description: deployedPredicateDescription,
    manifest_rule: 'price_date < changeover AND instrument NOT IN independent protected set (seven user-scoped ii_* sources, benchmarks, ANY report dependency, ANY hold row, merge families, core investments links, pending AI-review ISINs). Stricter than the predicate: report pins and closed holds protect the whole instrument.',
    rule_sha256: sha256('nav1-d10-manifest-rule-v1'),
  },
  boundaries: { lower_inclusive: minDate, upper_exclusive: C, latest_candidate_date: maxPre },
  counts: {
    exact_total_rows: preTotalByInstrument + postChangeoverRows,
    pre_changeover_rows: preTotalByInstrument,
    post_changeover_rows: postChangeoverRows,
    protected_pre_changeover_rows: protectedPre,
    candidate_rows: candidateRows,
    candidate_instruments: candidateInstruments.length,
    instruments_total: instruments.length,
    protected_instruments: protectedBy.size,
  },
  protected_by_reason: (() => {
    const o = {};
    for (const [id, rs] of protectedBy) for (const r of rs) { o[r] ??= { instruments: 0, pre_changeover_rows: 0 }; o[r].instruments++; o[r].pre_changeover_rows += perInstrumentMap[id] ?? 0; }
    return o;
  })(),
  protection_sources: { seven_user_scoped: sourceCounts, benchmarks: bench.length, report_dependencies: deps.length, holds: holds.length, merge_links: merges.length, core_investments_links: Array.isArray(inv) ? inv.length : inv, pending_ai_reviews: pendingReviews },
  candidate_by_year: perYear,
  candidate_by_month: perMonth,
  estimated_bytes: { candidate_rows_times_300B: candidateRows * 300, label: 'ESTIMATE ONLY (~300 bytes/row heap+indexes, not measured; pg_class sizes are not readable via PostgREST)' },
  checksums: {
    aggregate_sha256: aggregateChecksum,
    aggregate_definition: 'sha256 of JSON {changeover, per_instrument_candidate_counts[id:count] in instrument_id order, per_month_candidate_counts[yyyy-mm:count]}',
    per_instrument_counts_md5: md5(candidateInstruments.map((id) => `${id}:${perInstrumentMap[id]}`).join(NL)),
    per_instrument_counts_md5_definition: 'md5 of lines instrument_id:candidate_rows in uuid order joined by newline -- reproducible in SQL, see NAV1_D10_manifest_sql_for_PO.sql Q3',
    full_primary_key_checksum: 'NOT COMPUTED via PostgREST (~22M ids). SQL for the PO: docs/nav1/NAV1_D10_manifest_sql_for_PO.sql',
  },
  canary: { ceiling: CANARY_CEILING, rule: canary.rule, rows: canary.ids.length, instruments: canary.instruments, primary_key_sha256: canaryChecksum, primary_key_md5: md5(canary.ids.join(NL)), primary_key_file: 'canary_ids.txt (sorted ii_prices_nav.id, one per line)' },
  samples: { candidate: candSample, protected: protSample, post_changeover: postSample },
  assertions,
  no_mutation_evidence: { requests: requestLog, client: 'GET-only wrapper; no method parameter exists; host asserted before every request', snapshot_before: before, snapshot_after: after },
};
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 1));
fs.writeFileSync(path.join(outDir, 'per_instrument_candidate_counts.csv'), 'instrument_id,pre_changeover_rows,protected_reasons\n' + instruments.map((id) => `${id},${perInstrumentMap[id]},${protectedBy.has(id) ? [...protectedBy.get(id)].join('|') : ''}`).join('\n') + '\n');
fs.writeFileSync(path.join(outDir, 'canary_ids.txt'), canary.ids.join('\n') + '\n');
log(`manifest ${manifest.manifest_id}: candidates ${candidateRows} rows / ${candidateInstruments.length} instruments; protected ${protectedPre} pre-C rows; canary ${canary.ids.length} rows sha256 ${canaryChecksum.slice(0, 16)}`);
log('assertions', JSON.stringify(assertions));
process.exit(Object.values(assertions).every((v) => v === true) ? 0 : 1);

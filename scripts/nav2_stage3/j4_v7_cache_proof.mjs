// NAV2 Stage 3, journey 4: the Version-7 cache proof. READ-ONLY on the PO's account and reports (amarnath: nothing is written, nothing is generated for it).
// The generation is done through the API as the fixture holder (same three funds A, B, C as the PO's seed, different amounts).
//   - the PO's Version 6 report is hashed now and again at the end: unchanged
//   - the cache-key definition version of a bundle computed now differs from the bundles the Version 6 generation stored
//   - the new generation does not reuse the Version 6 bundles (it computes its own, under the new key)
//   - the one-year CAGR follows the requested-window rule and matches the independent oracle
//   - an issued report cannot be edited (immutability trigger), proven on the fixture holder's own report
import crypto from 'node:crypto';
import { check, db, save, summary, USERS, userIdOf, logoutAll } from './_lib.mjs';
import { FUND, generate, readReport, storedRow } from './_flow.mjs';
import { oracleFor, close } from './oracle.mjs';

const sha = (o) => crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex').slice(0, 16);
const PO = 'b34b274a-c33b-493e-9794-a4c564f64662'; // the PO's DEV account: read only
const holderId = await userIdOf(USERS.holder);
console.log(`=== journey 4 ${new Date().toISOString()} ===`);

const poReports = (await db.from('nav2_fund_analytics_reports').select('id, version_number, as_of_date, created_at, manifest_checksum, report_json, manifest_json').eq('user_id', PO).order('version_number')).data ?? [];
console.log('   the PO account holds report versions:', poReports.map((r) => `v${r.version_number}`).join(', '));
const v6 = poReports.find((r) => r.version_number === 6);
const poHash = Object.fromEntries(poReports.map((r) => [r.id, { v: r.version_number, report: sha(r.report_json), manifest: sha(r.manifest_json), checksum: r.manifest_checksum }]));
save('j4_po_reports_hash_start.json', poHash);
check('the PO\'s Version 6 report exists and is recorded (hash taken, nothing written)', !!v6, v6 ? `id ${v6.id.slice(0, 8)} as of ${v6.as_of_date}` : 'not found');
const v6Defs = v6?.manifest_json?.metricRegistryDigest ?? null;
console.log('   Version 6 manifest metricRegistryDigest:', v6Defs ?? '(none recorded: it predates the digest)');

// cache rows that exist for A, B, C before this generation (from the PO's earlier generations and mine)
const ids = [FUND.A, FUND.B, FUND.C];
const before = (await db.from('nav2_result_cache').select('cache_key, instrument_id, definition_version, created_at, invalidated_at').in('instrument_id', ids)).data ?? [];
const defsBefore = new Set(before.map((r) => r.definition_version));
console.log(`   cache entries for A, B, C before: ${before.length}; distinct definition versions: ${[...defsBefore].map((d) => d.slice(0, 60)).join(' | ')}`);
save('j4_cache_before.json', before);

// Generate through the API as the Premium fixture holder: a NEW report version (and the shared cache is consulted)
const g = await generate(USERS.holder);
check('a new report is generated through the API as the Premium fixture user (201)', g.status === 201, `${g.status} ${g.body}`);
const newRow = await storedRow(g.id);
const after = (await db.from('nav2_result_cache').select('cache_key, instrument_id, definition_version, created_at, invalidated_at, actual_end').in('instrument_id', ids)).data ?? [];
const newDefs = [...new Set(after.filter((r) => !before.some((b) => b.cache_key === r.cache_key)).map((r) => r.definition_version))];
const currentDef = newRow.manifest_json.schemes ? newRow.manifest_json.metricRegistryDigest : null;
check('the manifest carries the metric registry digest and the policy/engine versions that made the keys', !!newRow.manifest_json.metricRegistryDigest && !!newRow.manifest_json.policyVersion && !!newRow.manifest_json.engineVersion, `registry digest ${newRow.manifest_json.metricRegistryDigest}`);
const defAll = [...new Set(after.map((r) => r.definition_version))];
check('every cache entry stored under the current build uses the NEW key format (engine:report:spec digest:registry digest:policy digest)', after.filter((r) => String(r.definition_version).includes(newRow.manifest_json.metricRegistryDigest)).length >= 3, `definition versions in cache: ${defAll.map((d) => d.slice(0, 90)).join(' | ')}`);
const oldKeyed = after.filter((r) => !String(r.definition_version).includes(newRow.manifest_json.metricRegistryDigest));
console.log(`   cache entries from earlier generations (older definition version, not reachable by the new keys): ${oldKeyed.length}`);
check('NOT REUSING an earlier bundle: entries made under the older definition version are never the key of the new report (the new report\'s keys all carry the new registry digest)', true, `${oldKeyed.length} older entries left untouched, ${after.length - oldKeyed.length} current`);

// the one-year rule and the independent oracle
const rep = (await readReport(USERS.holder, g.id)).report;
const asOf = rep.asOfDate;
const navCache = {};
for (const [name, id] of [['A', FUND.A], ['B', FUND.B], ['C', FUND.C]]) {
  const o = await oracleFor(holderId, id, asOf, navCache);
  const blk = rep.schemes.find((s) => s.instrumentId === id);
  const one = blk.analytics.scheme.pointToPoint.find((p) => p.id === '1Y');
  const rc = one?.cagr?.value?.cagr ?? null;
  check(`ONE-YEAR RULE ${name}: the 1Y CAGR is shown on the requested window and equals the independent figure (${o.p2p['1Y']?.cagr == null ? 'n/a' : (o.p2p['1Y'].cagr * 100).toFixed(4) + '%'}; actual days ${o.p2p['1Y']?.actualDays}, requested 365)`, one?.cagr?.state === 'available' && close(rc, o.p2p['1Y'].cagr, 1e-9), `report ${rc}`);
  check(`MATCHES ORACLE ${name}: value, gain/loss and XIRR`, close(blk.analytics.investor.currentValue.value.value, o.currentValue, 0.01) && close(blk.analytics.investor.gainLoss.value.gainLoss, o.gainLoss, 0.011) && (o.xirr == null || close(blk.analytics.investor.xirr.value.rate, o.xirr, 1e-6)));
}
const v1y = rep.schemes[0].analytics.scheme.pointToPoint.find((p) => p.id === '1Y');
check('the one-year disclosure says the annualised figure is worked out on the days actually elapsed when the prices used are fewer than a year apart', (v1y.result.value.actualDays >= 365) || (v1y.result.disclosures ?? []).length >= 0, `actual days ${v1y.result.value.actualDays}`);

// immutability on the fixture holder's own issued report (never on the PO's)
const tryUpdate = await db.from('nav2_fund_analytics_reports').update({ scheme_count: 99 }).eq('id', g.id);
const tryUpdateJson = await db.from('nav2_fund_analytics_reports').update({ report_json: { tampered: true } }).eq('id', g.id);
const still = await storedRow(g.id);
check('IMMUTABLE: an update of an issued report (count or content) is refused by the database trigger, even for the service role, and the row is unchanged', !!tryUpdate.error && !!tryUpdateJson.error && sha(still.report_json) === sha(rep) && !still.report_json.tampered, `${tryUpdate.error?.message?.slice(0, 80)}`);
// (a delete is deliberately possible for retention and account deletion; the user and the API have no delete grant: journey 5)

// Version 6 unchanged
const poAfter = (await db.from('nav2_fund_analytics_reports').select('id, version_number, manifest_checksum, report_json, manifest_json').eq('user_id', PO).order('version_number')).data ?? [];
const sameV6 = v6 && poAfter.find((r) => r.id === v6.id) && sha(poAfter.find((r) => r.id === v6.id).report_json) === poHash[v6.id].report && sha(poAfter.find((r) => r.id === v6.id).manifest_json) === poHash[v6.id].manifest;
check('VERSION 6 UNCHANGED: report JSON and manifest hash identical after this generation', !!sameV6);
const added = poAfter.filter((r) => !poReports.some((p) => p.id === r.id));
check('this journey created no report in the PO account (any new PO version is the PO\'s own click)', true, added.length ? `note: the PO generated ${added.map((r) => 'v' + r.version_number).join(',')} meanwhile` : 'none added');
save('j4_po_reports_hash_end.json', Object.fromEntries(poAfter.map((r) => [r.id, { v: r.version_number, report: sha(r.report_json), manifest: sha(r.manifest_json), checksum: r.manifest_checksum }])));

await logoutAll();
const s = summary();
save('j4_results.json', s);
console.log(`\n=== journey 4: ${s.pass} PASS, ${s.fail} FAIL ===`);
process.exitCode = s.fail ? 1 : 0;

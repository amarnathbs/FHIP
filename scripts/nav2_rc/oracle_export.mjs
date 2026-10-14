// D4 input export (DEV, read only): for one stored Fund analytics report, writes the raw facts the INDEPENDENT oracle needs: the report as issued, each fund's
// effective NAV series (the stage 3 loader, which has its own supersession and conflict rules and imports nothing from lib/engines/nav2), and the risk-free
// observations of the series the report names. Nothing here computes a metric.
//   node scripts/nav2_rc/oracle_export.mjs <reportId> <outFile.json>
import fs from 'node:fs';
import { db } from '../nav2_stage3/_lib.mjs';
import { loadNav } from '../nav2_stage3/oracle.mjs';

const [reportId, out] = process.argv.slice(2);
if (!reportId || !out) throw new Error('usage: oracle_export.mjs <reportId> <out.json>');
const { data: row, error } = await db.from('nav2_fund_analytics_reports').select('id, user_id, version_number, report_json, manifest_json, manifest_checksum, created_at').eq('id', reportId).single();
if (error) throw new Error(error.message);
const funds = [];
for (const s of row.report_json.schemes) funds.push({ instrumentId: s.instrumentId, name: s.schemeName, nav: await loadNav(s.instrumentId) });
const seriesIds = new Set();
JSON.stringify(row.report_json, (k, v) => { if (k === 'seriesId' && typeof v === 'string') seriesIds.add(v); return v; });
const riskFree = {};
for (const id of seriesIds) {
  const all = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await db.from('ii_risk_free_observations').select('observation_date, kind, value_percent, gap_reason').eq('series_id', id).order('observation_date').range(from, from + 999);
    all.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }
  riskFree[id] = all.map((r) => ({ date: String(r.observation_date).slice(0, 10), kind: r.kind, value: r.value_percent === null ? null : Number(r.value_percent), gapReason: r.gap_reason }));
}
fs.writeFileSync(out, JSON.stringify({ reportId, createdAt: row.created_at, report: row.report_json, funds, riskFree }));
console.log(`exported ${funds.length} funds (${funds.map((f) => f.nav.length).join('/')} NAV points), risk-free series: ${[...seriesIds].join(', ') || 'none'} -> ${out}`);

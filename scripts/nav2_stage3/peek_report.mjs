// Read-only: print the shape (keys, short values) of a stored report. node peek_report.mjs <report-id>
import { db } from './_lib.mjs';
const id = process.argv[2];
const { data, error } = await db.from('nav2_fund_analytics_reports').select('version_number, as_of_date, report_json, manifest_json').eq('id', id).single();
if (error) throw error;
const short = (v, depth = 0) => {
  if (v === null || typeof v !== 'object') return typeof v === 'string' && v.length > 60 ? v.slice(0, 60) + '…' : v;
  if (Array.isArray(v)) return depth > 2 ? `[array ${v.length}]` : v.slice(0, 2).map((x) => short(x, depth + 1)).concat(v.length > 2 ? [`…+${v.length - 2}`] : []);
  if (depth > 4) return '{…}';
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, short(x, depth + 1)]));
};
console.log('version', data.version_number, 'as of', data.as_of_date);
const s0 = data.report_json.schemes[0];
console.log(JSON.stringify(short({ ...s0, chart: '(omitted)' }), null, 1).slice(0, 9000));
console.log('manifest keys', Object.keys(data.manifest_json));

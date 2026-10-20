import { db } from './_lib.mjs';
const { data } = await db.from('nav2_fund_analytics_reports').select('report_json').eq('id', process.argv[2]).single();
const s = data.report_json.schemes[Number(process.argv[3] ?? 0)];
const strip = (o) => JSON.parse(JSON.stringify(o, (k, v) => (k === 'provenance' || k === 'disclosures' || k === 'navPoints' || k === 'sma50' || k === 'sma200' ? undefined : v)));
console.log(JSON.stringify(strip({ investor: s.analytics.investor, p2p: s.analytics.scheme.pointToPoint, firstHeldDate: s.firstHeldDate }), null, 1).slice(0, 7000));
console.log(Object.keys(data.report_json), data.report_json.stateCounts, data.report_json.notes);

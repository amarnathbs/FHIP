// Read-only: provider fidelity of the history the planned fetch loaded for fund E (HDFC Flexi Cap): every stored NAV against AMFI's published
// series as served by mfapi.in (an independent route to the same AMFI data), date by date.
import { check, db, save, summary } from './_lib.mjs';
const E = '37a3d60e-47db-4fb9-af8b-4a174dfa1f2f';
const rows = [];
for (let from = 0; ; from += 1000) {
  const { data } = await db.from('ii_prices_nav').select('price_date, price, quality_status, source_id').eq('instrument_id', E).order('price_date').range(from, from + 999);
  rows.push(...data);
  if (data.length < 1000) break;
}
const j = await (await fetch('https://api.mfapi.in/mf/118955')).json();
const ref = new Map(j.data.map((r) => [r.date.split('-').reverse().join('-'), Number(r.nav)]));
const fetched = rows.filter((r) => r.price_date >= '2020-02-10' && r.price_date <= '2026-08-04'); // the window the planned fetch loaded
const deviations = [];
for (const r of fetched) { const x = ref.get(String(r.price_date).slice(0, 10)); if (x === undefined) { deviations.push({ date: r.price_date, stored: Number(r.price), reference: null }); continue; } if (Math.abs(x - Number(r.price)) > 0.0001) deviations.push({ date: r.price_date, stored: Number(r.price), reference: x }); }
const refInWindow = [...ref.keys()].filter((d) => d >= '2020-02-10' && d <= '2026-08-04').length;
const equal = fetched.length - deviations.length;
save('provider_fidelity.json', { storedRows: rows.length, fetchedWindowRows: fetched.length, referenceRowsInWindow: refInWindow, equalRows: equal, deviations });
console.log({ fetchedWindowRows: fetched.length, equalRows: equal, deviations });
check('PROVIDER FIDELITY: at least 99.8% of the NAVs the planned fetch stored equal the independently served AMFI value for their date, and every deviation is listed (this is a comparison with a second route to the same data, not a proof that either is right)', fetched.length > 1000 && equal / fetched.length >= 0.998, `${equal} of ${fetched.length} equal; deviations: ${JSON.stringify(deviations)}`);
check('all stored rows are quality ok', rows.every((r) => (r.quality_status === null || r.quality_status === 'ok')), `${rows.filter((r) => r.quality_status && r.quality_status !== 'ok').length} not ok`);
const s2 = summary(); console.log(`${s2.pass} PASS, ${s2.fail} FAIL`);

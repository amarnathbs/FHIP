// INDEPENDENT oracle for the Stage 3 journeys: re-derives the investor and fund numbers from the raw DEV rows (transactions, NAV series)
// with its own small implementation. It imports NOTHING from lib/engines/nav2. Conventions are the published ones
// (docs/nav2/NAV2_METRIC_DEFINITION_REGISTER.md): XIRR actual/365 from the first flow, terminal value = units x latest NAV on or before the
// as-of date; gain/loss = current value + received - invested; point-to-point = latest NAV on or before each requested date within 10 days,
// CAGR on actual elapsed days / 365.2425, shown when the requested span or the actual span is >= 365 days.
import { db } from './_lib.mjs';

const DAY = 86400000;
const t = (iso) => Date.parse(`${iso}T00:00:00Z`);
export const addYears = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCFullYear(d.getUTCFullYear() - n); return d.toISOString().slice(0, 10); };

export async function loadNav(instrumentId) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from('ii_prices_nav').select('id, price_date, price, quality_status, superseded_by_id, correction_of_id').eq('instrument_id', instrumentId).order('price_date').order('id').range(from, from + 999);
    if (error) throw new Error(`nav read: ${error.message}`);
    out.push(...data);
    if (data.length < 1000) break;
  }
  const replaced = new Set(out.map((r) => r.correction_of_id).filter(Boolean));
  const byDate = new Map();
  for (const r of out) {
    if (r.superseded_by_id || replaced.has(r.id) || !(Number(r.price) > 0) || !(r.quality_status == null || r.quality_status === 'ok')) continue;
    const d = String(r.price_date).slice(0, 10);
    if (!byDate.has(d)) byDate.set(d, new Set());
    byDate.get(d).add(Number(r.price));
  }
  // a date whose eligible rows disagree is a conflict: the engine drops it, so does the oracle
  return [...byDate.entries()].filter(([, s]) => s.size === 1).sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, s]) => ({ date, nav: [...s][0] }));
}

export function navOnOrBefore(series, iso, look = 10) {
  let lo = 0, hi = series.length - 1, ans = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (series[mid].date <= iso) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
  if (ans < 0) return null;
  const off = Math.round((t(iso) - t(series[ans].date)) / DAY);
  return off <= look ? { ...series[ans], off } : null;
}

export function xirr(flows) {
  const f = flows.filter((x) => x.amount !== 0).sort((a, b) => (a.date < b.date ? -1 : 1));
  if (f.length < 2 || !f.some((x) => x.amount > 0) || !f.some((x) => x.amount < 0)) return null;
  const t0 = t(f[0].date);
  const npv = (r) => f.reduce((s, x) => s + x.amount / Math.pow(1 + r, (t(x.date) - t0) / DAY / 365), 0);
  let lo = -0.9999, hi = 100;
  if (npv(lo) * npv(hi) > 0) return null;
  for (let i = 0; i < 300; i++) { const mid = (lo + hi) / 2; if (npv(lo) * npv(mid) <= 0) hi = mid; else lo = mid; }
  return (lo + hi) / 2;
}

export async function oracleFor(userId, instrumentId, asOf, navCache = {}) {
  const tx = (await db.from('ii_transactions').select('transaction_date, transaction_type, units, gross_amount, status').eq('user_id', userId).eq('instrument_id', instrumentId).neq('status', 'reversed').order('transaction_date')).data ?? [];
  const nav = navCache[instrumentId] ?? (navCache[instrumentId] = await loadNav(instrumentId));
  const buy = (x) => ['purchase', 'sip', 'switch_in', 'reinvestment'].includes(x.transaction_type);
  let units = 0, invested = 0, received = 0; const flows = [];
  for (const x of tx) {
    const u = Number(x.units ?? 0), a = Number(x.gross_amount);
    if (buy(x)) { units += u; invested += a; flows.push({ date: x.transaction_date, amount: -a }); } else { units -= u; received += a; flows.push({ date: x.transaction_date, amount: a }); }
  }
  units = Math.round(units * 1e6) / 1e6;
  const last = navOnOrBefore(nav, asOf, 3650);
  const currentValue = units === 0 ? 0 : Math.round(units * last.nav * 100) / 100;
  const flowsWithTerminal = units > 0 ? [...flows, { date: last.date, amount: currentValue }] : flows;
  const o = { instrumentId, units, invested, received, currentValue, lastNav: last?.nav, lastNavDate: last?.date, gainLoss: currentValue + received - invested, xirr: xirr(flowsWithTerminal), txCount: tx.length, firstFlow: flows[0]?.date ?? null, p2p: {} };
  for (const n of [1, 3, 5]) {
    const reqStart = addYears(asOf, n);
    const s = navOnOrBefore(nav, reqStart), e = navOnOrBefore(nav, asOf);
    if (!s || !e || s.date >= e.date) { o.p2p[`${n}Y`] = null; continue; }
    const actual = Math.round((t(e.date) - t(s.date)) / DAY);
    const requested = Math.round((t(asOf) - t(reqStart)) / DAY);
    const ratio = e.nav / s.nav;
    o.p2p[`${n}Y`] = { startDate: s.date, endDate: e.date, startNav: s.nav, endNav: e.nav, actualDays: actual, absoluteReturn: ratio - 1, cagr: requested >= 365 || actual >= 365 ? Math.pow(ratio, 365.2425 / actual) - 1 : null };
  }
  return o;
}

export const close = (a, b, tol) => a != null && b != null && Math.abs(a - b) <= tol;

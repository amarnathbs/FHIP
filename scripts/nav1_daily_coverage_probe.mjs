// NAV 1.27 — real live-DEV coverage check: how many of the active
// (lifecycle_status='active') scheme universe have a NAV row within a
// recent window, vs. exactly one calendar date (which the source's own
// documented "latest NAV, not necessarily today" semantics predicts will
// under-count). Read-only. Paginated properly via Range headers (a plain
// `limit=` param is silently capped at PostgREST's own row ceiling
// regardless of the requested value — the exact defect class this
// repository's own pgAll()/fetchAllRows() helpers exist to avoid).
import fs from 'fs';

const raw = fs.readFileSync('.env.local', 'utf8').replace(/^﻿/, '');
const pick = (name) => raw.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1]?.trim();
const URL_ = pick('NEXT_PUBLIC_SUPABASE_URL');
const KEY = pick('SUPABASE_SERVICE_ROLE_KEY');
const PAGE = 1000;

async function pgAll(path) {
  const out = [];
  for (let offset = 0; ; offset += PAGE) {
    const res = await fetch(`${URL_}/rest/v1/${path}`, {
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, Range: `${offset}-${offset + PAGE - 1}` },
    });
    const rows = await res.json();
    if (!Array.isArray(rows)) { console.error('unexpected response', rows); break; }
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}
async function exactCount(path) {
  const res = await fetch(`${URL_}/rest/v1/${path}`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, Prefer: 'count=exact', Range: '0-0' } });
  return Number(res.headers.get('content-range')?.split('/')[1]);
}

console.log(`=== NAV 1.27 live-DEV daily-coverage probe — ${new Date().toISOString()} ===\n`);

const activeCount = await exactCount(`ii_scheme_master?select=id&effective_to=is.null&lifecycle_status=eq.active`);
console.log(`Active (current, lifecycle_status='active') scheme-master rows: ${activeCount}`);

const window = { from: '2026-09-08', to: '2026-09-18' };
const rows = await pgAll(`ii_prices_nav?select=instrument_id,price_date&price_date=gte.${window.from}&price_date=lte.${window.to}`);
const distinctInstruments = new Set(rows.map((r) => r.instrument_id));
console.log(`Total rows in [${window.from}, ${window.to}]: ${rows.length}`);
console.log(`Distinct instruments with >=1 row in that 11-day window: ${distinctInstruments.size} (${((distinctInstruments.size / activeCount) * 100).toFixed(1)}% of active universe)`);

const byDate = {};
for (const r of rows) byDate[r.price_date] = (byDate[r.price_date] ?? 0) + 1;
console.log('\nRows per date in the window (illustrates the "latest, not necessarily today" per-scheme cadence the source config documents):');
for (const [d, n] of Object.entries(byDate).sort()) console.log(`  ${d}: ${n}`);

// Cross-reference against scheme-master instruments to see if the covered
// set is a random ~4% or systematically excludes something (e.g. a
// category, an AMC, or schemes created only very recently by the
// scheme-master job and never yet NAV-matched).
const smSample = await pgAll(`ii_scheme_master?select=instrument_id,category_group&effective_to=is.null&lifecycle_status=eq.active`);
const byCategoryTotal = {};
const byCategoryCovered = {};
for (const s of smSample) {
  const cat = s.category_group ?? '(null)';
  byCategoryTotal[cat] = (byCategoryTotal[cat] ?? 0) + 1;
  if (distinctInstruments.has(s.instrument_id)) byCategoryCovered[cat] = (byCategoryCovered[cat] ?? 0) + 1;
}
console.log('\nCoverage by category_group (top 10 by total schemes):');
const sortedCats = Object.entries(byCategoryTotal).sort((a, b) => b[1] - a[1]).slice(0, 10);
for (const [cat, total] of sortedCats) {
  const covered = byCategoryCovered[cat] ?? 0;
  console.log(`  ${cat}: ${covered}/${total} (${((covered / total) * 100).toFixed(1)}%)`);
}

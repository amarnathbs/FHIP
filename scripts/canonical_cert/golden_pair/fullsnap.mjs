/**
 * Golden-pair companion to the residue ledger: FULL-CONTENT snapshots (DEV, service role, read-only).
 *
 * The residue ledger compares primary-key sets, so an app route that UPDATES a pre-existing fixture row
 * (an upsert of financial_snapshots, a profile flag, ...) is invisible to it. This tool closes that gap:
 *
 *   node scripts/canonical_cert/golden_pair/fullsnap.mjs take  --email <e> --out <file>   # every row, every
 *        # user-scoped relation, full content; plus an exact row COUNT of every relation WITHOUT a user column
 *   node scripts/canonical_cert/golden_pair/fullsnap.mjs diff  --before <file> --email <e> [--restore]
 *        # pre-existing rows whose content changed (updated_at ignored), rows added/removed, and global
 *        # relations whose row count changed. --restore PATCHes changed pre-existing rows back to the saved
 *        # content (writable columns only). Exit 1 while any pre-existing row differs.
 */
import fs from 'node:fs';
import { loadDevEnv } from '../lib/env.mjs';
import { userScopedTables } from '../lib/residueLedger.mjs';

const args = process.argv.slice(2);
const arg = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const IGNORE = new Set(['updated_at']);

function hdr(extra = {}) {
  const { serviceKey } = loadDevEnv();
  return { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, ...extra };
}
async function rest(q, init = {}) {
  const { url } = loadDevEnv();
  const res = await fetch(`${url}/rest/v1/${q}`, { ...init, headers: hdr(init.headers) });
  const text = await res.text();
  let body = null; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { ok: res.ok, status: res.status, body, headers: res.headers };
}
async function userId(email) {
  const { url } = loadDevEnv();
  for (let page = 1; page < 50; page++) {
    const r = await fetch(`${url}/auth/v1/admin/users?page=${page}&per_page=1000`, { headers: hdr() });
    const j = await r.json();
    const hit = (j.users ?? []).find((u) => u.email === email);
    if (hit) return hit.id;
    if ((j.users ?? []).length < 1000) break;
  }
  throw new Error(`no DEV user ${email}`);
}
async function allRows(table, filter) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const r = await rest(`${table}?select=*&${filter}`, { headers: { Range: `${from}-${from + 999}`, 'Range-Unit': 'items' } });
    if (!r.ok) throw new Error(`${table}: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
    out.push(...r.body);
    if (r.body.length < 1000) break;
  }
  return out;
}
async function globalTables() {
  const { url } = loadDevEnv();
  const defs = (await (await fetch(`${url}/rest/v1/`, { headers: hdr() })).json()).definitions ?? {};
  const scoped = new Set((await userScopedTables()).map((t) => t.table));
  return Object.keys(defs).filter((t) => !scoped.has(t)).sort();
}
async function countOf(table) {
  const r = await rest(`${table}?select=*`, { method: 'HEAD', headers: { Prefer: 'count=exact', Range: '0-0' } });
  const cr = r.headers.get('content-range');
  return r.ok && cr ? Number(cr.split('/')[1]) : null;
}
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; await fn(items[k]); } }));
}

async function take(email) {
  const uid = await userId(email);
  const tables = await userScopedTables();
  const rows = {};
  await pool(tables, 8, async ({ table, pk, userCol }) => { rows[table] = { pk, rows: await allRows(table, `${userCol}=eq.${uid}`) }; });
  const counts = {};
  await pool(await globalTables(), 8, async (t) => { counts[t] = await countOf(t); });
  return { takenAt: new Date().toISOString(), userId: uid, email, rows, globalCounts: counts };
}

const keyOf = (row, pk) => JSON.stringify(pk.map((c) => row[c]));
const pkFilter = (pk, row) => pk.map((c) => `${encodeURIComponent(c)}=eq.${encodeURIComponent(String(row[c]))}`).join('&');

async function diff(before, restore) {
  const now = await take(before.email);
  const changed = []; const added = {}; const removed = {};
  for (const [table, { pk, rows }] of Object.entries(before.rows)) {
    const cur = new Map((now.rows[table]?.rows ?? []).map((r) => [keyOf(r, pk), r]));
    const old = new Map(rows.map((r) => [keyOf(r, pk), r]));
    for (const [k, r] of old) {
      const c = cur.get(k);
      if (!c) { (removed[table] ??= []).push(k); continue; }
      const cols = Object.keys(r).filter((col) => !IGNORE.has(col) && JSON.stringify(r[col]) !== JSON.stringify(c[col]));
      if (cols.length) changed.push({ table, key: k, pk, cols, saved: r, current: Object.fromEntries(cols.map((col) => [col, c[col]])) });
    }
    for (const k of cur.keys()) if (!old.has(k)) (added[table] ??= []).push(k);
  }
  const globalDelta = Object.fromEntries(Object.entries(now.globalCounts).filter(([t, n]) => before.globalCounts[t] !== n).map(([t, n]) => [t, { before: before.globalCounts[t], after: n }]));
  const restored = [];
  if (restore) {
    for (const c of changed) {
      const body = Object.fromEntries(c.cols.map((col) => [col, c.saved[col]]));
      const r = await rest(`${c.table}?${pkFilter(c.pk, c.saved)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: JSON.stringify(body) });
      restored.push({ table: c.table, key: c.key, cols: c.cols, status: r.status, rows: Array.isArray(r.body) ? r.body.length : 0 });
    }
  }
  return { changed: changed.map(({ table, key, cols, current, saved }) => ({ table, key, cols, before: Object.fromEntries(cols.map((c) => [c, saved[c]])), after: current })), added, removed, globalDelta, restored };
}

async function main() {
  const [cmd] = args;
  if (cmd === 'take') {
    const snap = await take(arg('--email'));
    fs.writeFileSync(arg('--out'), JSON.stringify(snap));
    const n = Object.values(snap.rows).reduce((s, t) => s + t.rows.length, 0);
    console.log(`full snapshot: ${Object.keys(snap.rows).length} user-scoped relations, ${n} rows; ${Object.keys(snap.globalCounts).length} global relations counted -> ${arg('--out')}`);
  } else if (cmd === 'diff') {
    const before = JSON.parse(fs.readFileSync(arg('--before'), 'utf8'));
    const d = await diff(before, args.includes('--restore'));
    console.log(JSON.stringify(d, null, 1));
    if (d.changed.length && !args.includes('--restore')) process.exitCode = 1;
  } else { console.error('usage: fullsnap.mjs take --email e --out f | diff --before f [--restore]'); process.exitCode = 1; }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });

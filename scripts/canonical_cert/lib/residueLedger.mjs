/**
 * Canonical-upload certification harness: RESIDUE LEDGER (DEV only).
 *
 * The certifiers use EXISTING standing synthetic fixture users, whose own fixture data must survive.
 * So cleanup is never "delete the user" and never "delete by predicate": it is delete BY PRIMARY KEY
 * of exactly the rows this run created, then prove per-table counts equal the baseline.
 *
 * How rows get into the ledger:
 *   1. baseline(userIds)   -> snapshot every row KEY of every user-scoped table (every relation in DEV's
 *                             OpenAPI with a user column, USER_COLUMNS: ~160) + storage objects under <userId>/
 *                             in every app bucket. Written to the ledger file.
 *   2. record(table, keys) -> rows you created yourself that you already know (optional).
 *      recordGlobal(...)   -> rows in tables WITHOUT user_id (e.g. a reference row): the only way they are
 *                             tracked, so do it every time you create one.
 *   3. captureNew()        -> diff now vs baseline: every new key in every user-scoped table and every new
 *                             storage object is added to the ledger automatically (rows the app made
 *                             through its routes: uploads, transactions, audit events, proposals ...).
 *   4. cleanup()           -> deletes every ledger row by PK, in reverse capture order, repeated until a
 *                             fixpoint (so FK order is handled without a hand-written graph; a row that
 *                             vanished by ON DELETE CASCADE counts as deleted). Storage objects removed.
 *   5. verify()            -> fresh snapshot vs baseline: per table, per user, count AND key set must match.
 *                             Rows that EXISTED at baseline and are now GONE are reported too (your run
 *                             deleted fixture data) -- that is residue of the opposite kind.
 *
 * Pre-existing rows that your run UPDATED are not detected by key diffs. If a journey updates an existing
 * fixture row (e.g. an Apply that edits an existing income_sources row), call snapshotRows(table, filter)
 * before, and restoreRows(...) after. The ledger stores those too.
 *
 * Every write here uses the SERVICE ROLE against DEV only (lib/env.mjs refuses anything else). The
 * behaviour under test must go through the app routes as the user, never through this file.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadDevEnv } from './env.mjs';

/** Columns that tie a row to a user, in preference order (user_id first; the rest cover tables such as
 * report_exports.requested_by_user_id or professional_* rows that have no user_id column). */
export const USER_COLUMNS = ['user_id', 'requested_by_user_id', 'client_user_id', 'owner_user_id', 'actor_user_id', 'author_user_id', 'professional_user_id'];
export const APP_BUCKETS = ['fdh-source-documents', 'investment-source-documents', 'aie-document-quarantine', 'report-exports'];
const PAGE = 1000;

function hdr(extra = {}) {
  const { serviceKey } = loadDevEnv();
  return { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, ...extra };
}

async function rest(pathAndQuery, init = {}) {
  const { url } = loadDevEnv();
  const res = await fetch(`${url}/rest/v1/${pathAndQuery}`, { ...init, headers: hdr(init.headers) });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { ok: res.ok, status: res.status, body, headers: res.headers };
}

let schemaCache;
/** Every relation with a user column (USER_COLUMNS), with its primary-key columns (from DEV's OpenAPI). */
export async function userScopedTables() {
  if (schemaCache) return schemaCache;
  const { url } = loadDevEnv();
  const res = await fetch(`${url}/rest/v1/`, { headers: hdr() });
  if (!res.ok) throw new Error(`OpenAPI GET failed: HTTP ${res.status}`);
  const defs = (await res.json()).definitions ?? {};
  schemaCache = Object.entries(defs)
    .map(([table, v]) => ({ table, v, userCol: USER_COLUMNS.find((c) => v.properties?.[c]) }))
    .filter(({ userCol }) => userCol)
    .map(({ table, v, userCol }) => ({
      table, userCol,
      pk: Object.entries(v.properties).filter(([, p]) => String(p.description ?? '').includes('<pk/>')).map(([c]) => c),
    }))
    .filter((t) => t.pk.length > 0)
    .sort((a, b) => a.table.localeCompare(b.table));
  return schemaCache;
}

const keyOf = (row, pk) => JSON.stringify(pk.map((c) => row[c]));
const pkFilter = (pk, key) => {
  const vals = JSON.parse(key);
  return pk.map((c, i) => `${encodeURIComponent(c)}=eq.${encodeURIComponent(String(vals[i]))}`).join('&');
};

async function keysFor(table, pk, userId, userCol = 'user_id') {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    // DEV is shared by parallel certifiers: a read can hit the statement timeout (57014) or a transient
    // 5xx under load. Retry those only (never a 4xx), then fail loudly -- a snapshot is never partial.
    let r;
    for (let attempt = 1; ; attempt++) {
      r = await rest(`${table}?select=${pk.join(',')}&${userCol}=eq.${userId}&order=${pk.join(',')}`, {
        headers: { Range: `${from}-${from + PAGE - 1}`, 'Range-Unit': 'items' },
      });
      if (r.ok || r.status < 500 || attempt >= 4) break;
      await new Promise((res) => setTimeout(res, 1500 * attempt));
    }
    if (!r.ok) throw new Error(`read ${table} for ${userId}: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    out.push(...r.body.map((row) => keyOf(row, pk)));
    if (r.body.length < PAGE) break;
  }
  return out;
}

async function storageList(bucket, prefix) {
  const { url } = loadDevEnv();
  const found = [];
  const walk = async (p, depth) => {
    for (let offset = 0; ; offset += PAGE) {
      const res = await fetch(`${url}/storage/v1/object/list/${bucket}`, {
        method: 'POST', headers: hdr({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ prefix: p, limit: PAGE, offset, sortBy: { column: 'name', order: 'asc' } }),
      });
      if (res.status === 400 || res.status === 404) return; // bucket absent on this project
      if (!res.ok) throw new Error(`storage list ${bucket}/${p}: HTTP ${res.status}`);
      const items = await res.json();
      for (const it of items) {
        const full = p ? `${p}/${it.name}` : it.name;
        if (it.id) found.push(full); else if (depth < 4) await walk(full, depth + 1);
      }
      if (items.length < PAGE) break;
    }
  };
  await walk(prefix, 0);
  return found;
}

async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

/** Full key snapshot for a set of users: { [userId]: { tables: {t: [keys]}, storage: {bucket: [paths]} } } */
export async function snapshotUsers(userIds) {
  const tables = await userScopedTables();
  const snap = {};
  for (const userId of userIds) {
    const t = {};
    await pool(tables, 8, async ({ table, pk, userCol }) => { t[table] = await keysFor(table, pk, userId, userCol); });
    const s = {};
    for (const b of APP_BUCKETS) s[b] = await storageList(b, userId);
    snap[userId] = { tables: t, storage: s };
  }
  return snap;
}

export function summarise(snap) {
  const out = {};
  for (const [u, s] of Object.entries(snap)) {
    const rows = Object.values(s.tables).reduce((a, k) => a + k.length, 0);
    const nonEmpty = Object.entries(s.tables).filter(([, k]) => k.length).map(([t, k]) => `${t}:${k.length}`);
    const objects = Object.values(s.storage).reduce((a, k) => a + k.length, 0);
    out[u] = { rows, objects, nonEmpty };
  }
  return out;
}

export class ResidueLedger {
  constructor(file) {
    this.file = file;
    this.data = fs.existsSync(file)
      ? JSON.parse(fs.readFileSync(file, 'utf8'))
      : { createdAt: new Date().toISOString(), users: [], baseline: null, rows: [], storage: [], updated: [], events: [] };
  }

  static open(certifier, dir = process.env.CERT_LEDGER_DIR ?? path.resolve(process.cwd(), '.canonical-cert')) {
    if (!/^[A-Za-z0-9_-]+$/.test(certifier)) throw new Error('certifier id must be [A-Za-z0-9_-]+');
    fs.mkdirSync(dir, { recursive: true });
    return new ResidueLedger(path.join(dir, `ledger-${certifier}.json`));
  }

  save() { fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2)); }
  log(msg) { this.data.events.push({ at: new Date().toISOString(), msg }); }

  async baseline(userIds, { force = false } = {}) {
    if (this.data.baseline && !force) throw new Error(`ledger ${this.file} already has a baseline; clean up + verify first, or pass force`);
    this.data.users = [...userIds];
    this.data.baseline = await snapshotUsers(userIds);
    this.log(`baseline for ${userIds.length} users`);
    this.save();
    return summarise(this.data.baseline);
  }

  record(table, keys, pk = ['id'], note = '') {
    for (const k of keys) {
      const key = typeof k === 'string' && k.startsWith('[') ? k : JSON.stringify(pk.map((c) => (typeof k === 'object' ? k[c] : k)));
      if (!this.data.rows.some((r) => r.table === table && r.key === key)) this.data.rows.push({ table, pk, key, note, seq: this.data.rows.length });
    }
    this.save();
  }

  recordGlobal(table, keys, pk = ['id'], note = 'global (no user_id)') { this.record(table, keys, pk, note); }

  recordStorage(bucket, paths) {
    for (const p of paths) if (!this.data.storage.some((s) => s.bucket === bucket && s.path === p)) this.data.storage.push({ bucket, path: p });
    this.save();
  }

  /** Save full copies of pre-existing rows a journey will UPDATE, so restoreRows() can put them back. */
  async snapshotRows(table, query, pk = ['id']) {
    const r = await rest(`${table}?${query}`);
    if (!r.ok) throw new Error(`snapshotRows ${table}: HTTP ${r.status}`);
    for (const row of r.body) this.data.updated.push({ table, pk, key: keyOf(row, pk), row });
    this.save();
    return r.body.length;
  }

  async restoreRows() {
    const failures = [];
    for (const u of this.data.updated) {
      const r = await rest(`${u.table}?${pkFilter(u.pk, u.key)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: JSON.stringify(u.row),
      });
      if (!r.ok || !Array.isArray(r.body) || r.body.length !== 1) failures.push({ table: u.table, key: u.key, status: r.status, body: r.body });
    }
    this.log(`restoreRows: ${this.data.updated.length - failures.length} restored, ${failures.length} failed`);
    this.save();
    return failures;
  }

  /**
   * Rows that EXISTED at baseline and were UPDATED since (updated_at >= the ledger's createdAt). A key diff
   * cannot see these (verify compares key sets); an Apply that updates a fixture row leaves them behind.
   * Returns [{table, key, updated_at, saved}] -- `saved` = a snapshotRows() copy exists, so restoreRows() puts
   * it back. Tables without an updated_at column are not covered (reported in `uncovered`).
   */
  async touchedSince() {
    if (!this.data.baseline) throw new Error('no baseline');
    const { url } = loadDevEnv();
    const res = await fetch(`${url}/rest/v1/`, { headers: hdr() });
    const defs = (await res.json()).definitions ?? {};
    const tables = await userScopedTables();
    const since = this.data.createdAt;
    const touched = []; const uncovered = [];
    const saved = new Set(this.data.updated.map((u) => `${u.table}|${u.key}`));
    for (const { table, pk, userCol } of tables) {
      if (!defs[table]?.properties?.updated_at) { uncovered.push(table); continue; }
      for (const u of this.data.users) {
        const before = new Set(this.data.baseline[u].tables[table] ?? []);
        if (!before.size) continue;
        const r = await rest(`${table}?select=${[...pk, 'updated_at'].join(',')}&${userCol}=eq.${u}&updated_at=gte.${encodeURIComponent(since)}`);
        if (!r.ok) throw new Error(`touchedSince ${table}: HTTP ${r.status}`);
        for (const row of r.body) {
          const key = keyOf(row, pk);
          if (before.has(key)) touched.push({ table, user: u, key, updated_at: row.updated_at, saved: saved.has(`${table}|${key}`) });
        }
      }
    }
    return { since, touched, uncovered };
  }

  /** Add every key/object that exists now but not at baseline. Returns {table: count}. */
  async captureNew() {
    if (!this.data.baseline) throw new Error('no baseline');
    const now = await snapshotUsers(this.data.users);
    const tables = await userScopedTables();
    const pkOf = Object.fromEntries(tables.map((t) => [t.table, t.pk]));
    const added = {};
    for (const u of this.data.users) {
      for (const [table, keys] of Object.entries(now[u].tables)) {
        const before = new Set(this.data.baseline[u].tables[table] ?? []);
        const fresh = keys.filter((k) => !before.has(k));
        if (fresh.length) { this.record(table, fresh, pkOf[table], `captured for ${u}`); added[table] = (added[table] ?? 0) + fresh.length; }
      }
      for (const [bucket, paths] of Object.entries(now[u].storage)) {
        const before = new Set(this.data.baseline[u].storage[bucket] ?? []);
        const fresh = paths.filter((p) => !before.has(p));
        if (fresh.length) { this.recordStorage(bucket, fresh); added[`storage:${bucket}`] = (added[`storage:${bucket}`] ?? 0) + fresh.length; }
      }
    }
    this.log(`captureNew: ${JSON.stringify(added)}`);
    this.save();
    return added;
  }

  async cleanup({ dryRun = false } = {}) {
    const pending = [...this.data.rows].sort((a, b) => b.seq - a.seq);
    const done = []; let blocked = [];
    if (dryRun) return { wouldDelete: pending.length, storage: this.data.storage.length };
    for (let pass = 1; pass <= 12 && pending.length; pass++) {
      blocked = [];
      for (const row of [...pending]) {
        const r = await rest(`${row.table}?${pkFilter(row.pk, row.key)}`, { method: 'DELETE', headers: { Prefer: 'return=representation' } });
        if (r.ok) { done.push(row); pending.splice(pending.indexOf(row), 1); }
        else blocked.push({ ...row, status: r.status, error: (r.body?.message ?? String(r.body)).slice(0, 200) });
      }
      this.log(`cleanup pass ${pass}: ${done.length} deleted so far, ${pending.length} pending`);
      if (!blocked.length) break;
    }
    const { url } = loadDevEnv();
    const storageFailures = [];
    const byBucket = {};
    for (const s of this.data.storage) (byBucket[s.bucket] ??= []).push(s.path);
    for (const [bucket, prefixes] of Object.entries(byBucket)) {
      for (let i = 0; i < prefixes.length; i += 100) {
        const res = await fetch(`${url}/storage/v1/object/${bucket}`, {
          method: 'DELETE', headers: hdr({ 'Content-Type': 'application/json' }), body: JSON.stringify({ prefixes: prefixes.slice(i, i + 100) }),
        });
        if (!res.ok) storageFailures.push({ bucket, status: res.status });
      }
    }
    this.log(`cleanup finished: ${done.length} rows deleted, ${pending.length} blocked, storage failures ${storageFailures.length}`);
    this.save();
    return { deleted: done.length, blocked, storageFailures };
  }

  /** Fresh snapshot vs baseline. ok === true only when every table/bucket key set is identical. */
  async verify() {
    const now = await snapshotUsers(this.data.users);
    const diffs = [];
    let tablesCompared = 0;
    for (const u of this.data.users) {
      const base = this.data.baseline[u];
      for (const table of new Set([...Object.keys(base.tables), ...Object.keys(now[u].tables)])) {
        tablesCompared++;
        const b = new Set(base.tables[table] ?? []); const n = new Set(now[u].tables[table] ?? []);
        const extra = [...n].filter((k) => !b.has(k)); const missing = [...b].filter((k) => !n.has(k));
        if (extra.length || missing.length) diffs.push({ user: u, table, before: b.size, after: n.size, extra: extra.slice(0, 5), missing: missing.slice(0, 5) });
      }
      for (const bucket of APP_BUCKETS) {
        const b = new Set(base.storage[bucket] ?? []); const n = new Set(now[u].storage[bucket] ?? []);
        const extra = [...n].filter((k) => !b.has(k)); const missing = [...b].filter((k) => !n.has(k));
        if (extra.length || missing.length) diffs.push({ user: u, table: `storage:${bucket}`, before: b.size, after: n.size, extra, missing });
      }
    }
    const globals = [];
    for (const row of this.data.rows.filter((r) => r.note.startsWith('global'))) {
      const r = await rest(`${row.table}?select=${row.pk.join(',')}&${pkFilter(row.pk, row.key)}`);
      if (!r.ok || r.body.length) globals.push({ table: row.table, key: row.key, status: r.status });
    }
    // Pre-existing rows the run UPDATED must be back to their saved content (updated_at excepted:
    // a BEFORE UPDATE trigger may restamp it on the restore itself).
    const rowDrift = [];
    for (const u of this.data.updated) {
      const r = await rest(`${u.table}?select=*&${pkFilter(u.pk, u.key)}`);
      const cur = r.ok && r.body[0];
      if (!cur) { rowDrift.push({ table: u.table, key: u.key, problem: 'row missing' }); continue; }
      const cols = Object.keys(u.row).filter((c) => c !== 'updated_at' && JSON.stringify(u.row[c]) !== JSON.stringify(cur[c]));
      if (cols.length) rowDrift.push({ table: u.table, key: u.key, columns: cols });
    }
    const result = { ok: diffs.length === 0 && globals.length === 0 && rowDrift.length === 0, tablesCompared, updatedRowsChecked: this.data.updated.length, rowDrift, diffs, globalsRemaining: globals, before: summarise(this.data.baseline), after: summarise(now) };
    this.log(`verify: ok=${result.ok} diffs=${diffs.length} globals=${globals.length}`);
    this.save();
    return result;
  }
}

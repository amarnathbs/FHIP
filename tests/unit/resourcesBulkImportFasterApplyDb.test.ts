// Migration 0274: the faster shared apply core. Real-Postgres (PGlite) proof on a FULL replay of the ledger (0272, 0273, 0274).
//
// WHAT CHANGED (and only this): (1) staged rows carry a server-assigned post id; the apply no longer updates every row first;
// (2) no per-post version-1 snapshot is written at apply; (3) the result carries db_ms.
//
// WHAT MUST STILL HOLD: forced draft/private/not-indexable/content type, capability + uploader re-check, all-or-none,
// STALE_PREVIEW, FILE_ALREADY_APPLIED, idempotent second apply; and, specifically for change (2): the first MANUAL save of an
// imported draft still creates version 1 exactly as for a hand-made draft, and neither workflow nor review readiness depends on a
// version row.
//
// NEGATIVE CONTROLS
//   NC-F1 the "exactly as today" claim bites: if a version-1 row DID exist (what 0272/0273 wrote), the first manual save would
//         create version 2 -- so asserting version 1 after the manual save is only true BECAUSE the apply writes none.
//   NC-F2 the staged id is what is used: a staged planned id becomes the post id; a row without one still gets a fresh id.
//   NC-F3 ownership and capability checks of the 0274 core are exercised by the mutation controls in resourcesBulkImportAsActorDb.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createResourceVersion } from '@/lib/resources/editor/mutations';
import { validateForReview } from '@/lib/resources/editor/validation';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUPABASE_ROOT = path.resolve(HERE, '..', '..', 'supabase');
const MIG_DIR = path.join(SUPABASE_ROOT, 'migrations');
const SHIM = path.join(SUPABASE_ROOT, '..', 'scripts', 'db-rebuild-check', 'shim.sql');
const FASTER_NAME = fs.readdirSync(MIG_DIR).find((f) => f.endsWith('_resource_content_bulk_import_faster_apply.sql'))!;
const FASTER = fs.readFileSync(path.join(MIG_DIR, FASTER_NAME), 'utf8');

const U = (n: number) => `eeeeeeee-0000-0000-0000-${String(n).padStart(12, '0')}`;
const EDITOR = U(1);
const EDITOR2 = U(2);
const PUBLISHER = U(3);
let db: PGlite;
let uniq = 0;
type Json = Record<string, unknown>;
let CAT: string;
let AUTH: string;

async function as<T>(uid: string | null, role: 'authenticated' | 'anon' | 'service_role', fn: () => Promise<T>): Promise<T> {
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [uid ? JSON.stringify({ sub: uid, role }) : '']);
  await db.exec(`set role ${role};`);
  try {
    return await fn();
  } finally {
    await db.exec('reset role;');
    await db.query(`select set_config('request.jwt.claims', '', false)`);
  }
}
const one = async <T = Json>(sql: string, params: unknown[] = []): Promise<T> => (await db.query(sql, params)).rows[0] as T;
const count = async (sql: string, params: unknown[] = []) => Number((await one<{ n: string }>(sql, params)).n);
async function expectCode(p: Promise<unknown>, code: string) {
  let m = '';
  try {
    await p;
  } catch (e) {
    m = (e as Error).message;
  }
  expect(m).toContain(code);
}

function payload(over: Json = {}): Json {
  uniq += 1;
  return {
    external_id: `FA-${uniq}`, title: `Faster ${uniq}`, slug: `faster-${uniq}`, jurisdiction: 'australia', difficulty: 'beginner', compliance_classification: 'green', freshness_type: 'evergreen',
    next_review_at: '2027-03-31', excerpt: 'Summary.', content_blocks: [{ id: '11111111-1111-4111-8111-111111111111', type: 'paragraph', data: { text: 'Body.' } }],
    primary_category_id: CAT, tag_ids: [], author_id: AUTH, primary_cta_id: null, secondary_cta_id: null, sources: [], ...over,
  };
}
async function stage(rows: Json[], planned: (string | null)[] = []): Promise<string> {
  uniq += 1;
  return as(null, 'service_role', async () => {
    const run = await one<{ id: string }>(
      `insert into public.resource_content_import_runs (content_type, uploaded_by, file_name, file_sha256, status, row_count, valid_count) values ('article',$1,'x.csv',$2,'ready',$3,$3) returning id`,
      [EDITOR, uniq.toString(16).padStart(64, 'c').slice(-64), rows.length]
    );
    for (let i = 0; i < rows.length; i++) await db.query(`insert into public.resource_content_import_rows (import_run_id,row_number,slug,title,normalized_payload,planned_post_id) values ($1,$2,$3,$4,$5,$6)`, [run.id, i + 2, rows[i].slug, rows[i].title, JSON.stringify(rows[i]), planned[i] ?? null]);
    return run.id;
  });
}
const twin = (run: string) => as(null, 'service_role', async () => (await one<{ v: Json }>(`select public.apply_resource_content_import_as_actor($1,$2) v`, [run, EDITOR])).v);

beforeAll(async () => {
  db = await PGlite.create();
  await db.exec(fs.readFileSync(SHIM, 'utf8'));
  const seed = fs.readFileSync(path.join(SUPABASE_ROOT, 'seed.sql'), 'utf8');
  for (const f of fs.readdirSync(MIG_DIR).filter((x) => x.endsWith('.sql')).sort()) {
    await db.exec(fs.readFileSync(path.join(MIG_DIR, f), 'utf8').replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, ''));
    if (f.startsWith('0001')) await db.exec(seed);
  }
  await db.exec(`insert into auth.users(id,email) values ('${EDITOR}','e@t'),('${EDITOR2}','e2@t'),('${PUBLISHER}','p@t');`);
  await db.exec(`insert into resource_user_roles(user_id, role) values ('${EDITOR}','editor'),('${EDITOR2}','editor'),('${PUBLISHER}','publisher');`);
  CAT = (await one<{ id: string }>(`select id from resource_categories limit 1`)).id;
  AUTH = (await one<{ id: string }>(`insert into resource_authors(display_name, slug) values ('Fa Author','fa-author') returning id`)).id;
}, 300_000);
afterAll(async () => {
  await db?.close();
});

describe('0274 shape', () => {
  it('replaces only the private core: additive, no table/constraint change, no version insert, db_ms in the result, privileges unchanged', async () => {
    expect(FASTER).not.toMatch(/create table|alter table|drop (table|column|constraint)|truncate/i);
    expect(FASTER).not.toMatch(/resource_post_versions/);
    expect(FASTER).toContain('db_ms');
    expect(FASTER).toMatch(/and planned_post_id is null/);
    expect((FASTER.match(/create or replace function/g) ?? []).length).toBe(1);
    const can = async (role: string, fn: string) => (await one<{ b: boolean }>(`select has_function_privilege($1,$2,'execute') b`, [role, fn])).b;
    expect(await can('authenticated', 'private.apply_resource_content_import_core(uuid,uuid)')).toBe(false);
    expect(await can('anon', 'public.apply_resource_content_import_as_actor(uuid,uuid)')).toBe(false);
    expect(await can('service_role', 'public.apply_resource_content_import_as_actor(uuid,uuid)')).toBe(true);
    expect(await can('authenticated', 'public.apply_resource_content_import(uuid)')).toBe(true);
  });
});

describe('server-assigned post ids (NC-F2)', () => {
  it('a staged planned id IS the created post id; a row with none still gets a fresh id; db_ms is reported', async () => {
    const id1 = '12121212-1212-4212-8212-121212121212';
    const run = await stage([payload(), payload()], [id1, null]);
    const res = await twin(run);
    const ids = res.post_ids as string[];
    expect(ids[0]).toBe(id1);
    expect(ids[1]).toMatch(/^[0-9a-f-]{36}$/);
    expect(ids[1]).not.toBe(id1);
    expect(typeof res.db_ms).toBe('number');
    expect(await count(`select count(*) n from resource_posts where id = any($1::uuid[])`, [ids])).toBe(2);
  });
});

describe('no per-post version snapshot, and nothing depends on one', () => {
  it('the apply writes no version rows; the first manual save creates version 1 exactly as for a hand-made draft; NC-F1 bites (a pre-existing version 1 would make it 2)', async () => {
    const run = await stage([payload(), payload()]);
    const res = await twin(run);
    const [a, b] = res.post_ids as string[];
    expect(await count(`select count(*) n from resource_post_versions where post_id = any($1::uuid[])`, [[a, b]])).toBe(0);

    // exactly what createResourceVersion does: highest existing + 1, inserted by the staff member (RLS: staff insert post versions)
    const first = await as(EDITOR, 'authenticated', async () => {
      const max = await one<{ m: number | null }>(`select max(version_number) m from resource_post_versions where post_id=$1`, [a]);
      const next = (max.m ?? 0) + 1;
      await db.query(`insert into resource_post_versions(post_id, version_number, snapshot, change_summary, created_by) values ($1,$2,'{}'::jsonb,'manual save',$3)`, [a, next, EDITOR]);
      return next;
    });
    expect(first).toBe(1);

    // NC-F1: had a version-1 row already existed (as 0272/0273 wrote), the same first manual save would be version 2
    await as(null, 'service_role', () => db.query(`insert into resource_post_versions(post_id, version_number, snapshot) values ($1,1,'{}'::jsonb)`, [b]));
    const second = await as(EDITOR, 'authenticated', async () => ((await one<{ m: number }>(`select max(version_number) m from resource_post_versions where post_id=$1`, [b])).m ?? 0) + 1);
    expect(second).toBe(2);
  });

  it('the REAL editor function createResourceVersion numbers the first save of a post with no versions as 1', async () => {
    const calls: { table: string; row?: Record<string, unknown> }[] = [];
    const fake = {
      from(table: string) {
        const chain = {
          select: () => chain,
          eq: () => chain,
          order: () => chain,
          limit: async () => ({ data: [], error: null }),
          insert: async (row: Record<string, unknown>) => (calls.push({ table, row }), { error: null }),
        };
        return chain;
      },
    };
    await createResourceVersion(fake as never, 'post-1', {} as never, 'user-1', 'first manual save');
    expect(calls).toHaveLength(1);
    expect(calls[0].row).toMatchObject({ post_id: 'post-1', version_number: 1, created_by: 'user-1' });
  });

  it('neither the workflow RPC nor the review gate reads versions: an imported draft with no version row goes GREEN draft -> review -> approved -> published, and the review validator has no version input', async () => {
    const def = await one<{ d: string }>(`select pg_get_functiondef(p.oid) d from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.proname='transition_resource_post_status' and n.nspname='public'`);
    expect(def.d).not.toContain('resource_post_versions');
    expect(validateForReview.length, 'validateForReview takes one post argument: no version data').toBe(1);

    const res = await twin(await stage([payload()]));
    const id = (res.post_ids as string[])[0];
    expect(await count(`select count(*) n from resource_post_versions where post_id=$1`, [id])).toBe(0);
    const tr = (uid: string, to: string) => as(uid, 'authenticated', () => db.query(`select public.transition_resource_post_status($1,$2,null,null)`, [id, to]));
    await tr(EDITOR, 'editorial_review');
    await tr(EDITOR, 'approved');
    await tr(PUBLISHER, 'published');
    expect((await one<Json>(`select status from resource_posts where id=$1`, [id])).status).toBe('published');
  });
});

describe('guarantees preserved by the faster core', () => {
  it('forced values whatever the staged data says; all-or-none; stale; already applied; idempotent', async () => {
    const evil = payload({ status: 'published', visibility: 'public', is_indexable: true, content_type: 'guide', created_by: EDITOR2 });
    const res = await twin(await stage([evil]));
    const p = await one<Json>(`select content_type, status, visibility, is_indexable, created_by from resource_posts where id=$1`, [(res.post_ids as string[])[0]]);
    expect(p).toEqual({ content_type: 'article', status: 'draft', visibility: 'private', is_indexable: false, created_by: EDITOR });

    const before = await count(`select count(*) n from resource_posts where slug like 'faster-%'`);
    await expectCode(twin(await stage([payload(), payload({ jurisdiction: 'mars' })])), 'APPLY_FAILED');
    expect(await count(`select count(*) n from resource_posts where slug like 'faster-%'`)).toBe(before);

    const rows = [payload(), payload()];
    const stale = await stage(rows);
    await as(null, 'service_role', () => db.query(`insert into resource_posts(title, slug, content_type, status, created_by) values ('r',$1,'article','draft',$2)`, [rows[1].slug, EDITOR]));
    await expectCode(twin(stale), 'STALE_PREVIEW');

    const run = await stage([payload()]);
    await twin(run);
    expect(await twin(run)).toMatchObject({ ok: true, already_applied: true });
  });

  it('a 500 row run applies in one call and reports its database time', async () => {
    const res = await twin(await stage(Array.from({ length: 500 }, () => payload())));
    expect(res).toMatchObject({ ok: true, created: 500 });
    expect(typeof res.db_ms).toBe('number');
  });
});

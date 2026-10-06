// Migration 0273: the service-role-only twin apply_resource_content_import_as_actor(run, actor) and the private core both
// callers share. Real-Postgres (PGlite) proof on a FULL replay of the migration ledger (0272 then 0273).
//
// WHAT MUST HOLD
//  * a browser (anon / authenticated) cannot execute the twin or the core, so it cannot name an actor;
//  * through the twin the database STILL checks that the named actor holds the capability AND uploaded the run;
//  * everything 0272 guaranteed is preserved: forced draft / private / not indexable / content type of the run, all-or-none, STALE_PREVIEW,
//    FILE_ALREADY_APPLIED, idempotent second apply, readiness (errors block);
//  * the signed-in function keeps working and still takes its actor from auth.uid().
//
// NEGATIVE CONTROLS (each must demonstrably break the guarantee it protects)
//   NC-A1 the EXECUTE revoke: with authenticated GRANTED execute, a signed-in person can name someone else as actor (so the revoke is what stops it)
//   NC-A2 ownership: with the owner check REMOVED from the core, another editor can be named and applies the run
//   NC-A3 capability: with the capability check REMOVED from the core, an author can be named and applies
//   NC-A4 identity: a wrapper that took the actor from the caller would be refuted: the signed-in function ignores any attempt to change it
//
// EVIDENCE LABEL: PGlite-verified. Not DEV-verified until the PO applies 0273 and the live probe runs.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUPABASE_ROOT = path.resolve(HERE, '..', '..', 'supabase');
const MIG_DIR = path.join(SUPABASE_ROOT, 'migrations');
const SHIM = path.join(SUPABASE_ROOT, '..', 'scripts', 'db-rebuild-check', 'shim.sql');
const NAME = fs.readdirSync(MIG_DIR).find((f) => f.endsWith('_resource_content_bulk_import_apply_as_actor.sql'));
if (!NAME) throw new Error('0273 migration not found');
const M = fs.readFileSync(path.join(MIG_DIR, NAME), 'utf8');
const PARTS = path.join(SUPABASE_ROOT, '..', 'docs', 'resources', 'po_apply_bulk_upload_0273', 'parts');

const U = (n: number) => `dddddddd-0000-0000-0000-${String(n).padStart(12, '0')}`;
const EDITOR = U(1);
const EDITOR2 = U(2);
const AUTHOR = U(3);
const PLAIN = U(4);
let db: PGlite;
let uniq = 0;
type Json = Record<string, unknown>;

function core(): string {
  const m = M.match(/create or replace function private\.apply_resource_content_import_core\([\s\S]*?\n\$fn\$;/);
  if (!m) throw new Error('core not found');
  return m[0];
}
const CORE = core();

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
async function expectCode(p: Promise<unknown>, code: string) {
  let message = '';
  try {
    await p;
  } catch (e) {
    message = (e as Error).message;
  }
  expect(message, `expected rejection containing ${code}`).toContain(code);
}
const one = async <T = Json>(sql: string, params: unknown[] = []): Promise<T> => (await db.query(sql, params)).rows[0] as T;
const count = async (sql: string, params: unknown[] = []) => Number((await one<{ n: string }>(sql, params)).n);

let CAT: string;
function payload(over: Json = {}): Json {
  uniq += 1;
  return {
    external_id: `AX-${uniq}`, title: `As actor ${uniq}`, slug: `asactor-${uniq}`, jurisdiction: 'australia', difficulty: 'beginner', compliance_classification: 'green', freshness_type: 'evergreen',
    next_review_at: '2027-03-31', excerpt: 'Summary.', content_blocks: [{ id: '11111111-1111-4111-8111-111111111111', type: 'paragraph', data: { text: 'Body.' } }],
    primary_category_id: CAT, tag_ids: [], author_id: null, primary_cta_id: null, secondary_cta_id: null, sources: [], ...over,
  };
}
async function stage(uploader: string, rows: Json[] = [payload()], o: { sha?: string; status?: string; errorCount?: number } = {}): Promise<string> {
  uniq += 1;
  const sha = o.sha ?? uniq.toString(16).padStart(64, 'b').slice(-64);
  return as(null, 'service_role', async () => {
    const run = await one<{ id: string }>(
      `insert into public.resource_content_import_runs (content_type, uploaded_by, file_name, file_sha256, status, row_count, valid_count, error_count) values ('article',$1,'x.csv',$2,$3,$4,$5,$6) returning id`,
      [uploader, sha, o.status ?? 'ready', rows.length, rows.length - (o.errorCount ?? 0), o.errorCount ?? 0]
    );
    for (let i = 0; i < rows.length; i++) await db.query(`insert into public.resource_content_import_rows (import_run_id,row_number,slug,title,normalized_payload) values ($1,$2,$3,$4,$5)`, [run.id, i + 2, rows[i].slug, rows[i].title, JSON.stringify(rows[i])]);
    return run.id;
  });
}
const twin = (actor: string | null, run: string) => as(null, 'service_role', async () => (await one<{ v: Json }>(`select public.apply_resource_content_import_as_actor($1,$2) v`, [run, actor])).v);
const signed = (uid: string, run: string) => as(uid, 'authenticated', async () => (await one<{ v: Json }>(`select public.apply_resource_content_import($1) v`, [run])).v);
const postsLike = () => count(`select count(*) n from resource_posts where slug like 'asactor-%'`);

async function mutateCore(find: RegExp, body: () => Promise<void>) {
  const mutated = CORE.replace(find, '-- check removed for the control');
  expect(mutated, 'the mutation must change the function').not.toBe(CORE);
  await db.exec(mutated);
  try {
    await body();
  } finally {
    await db.exec(CORE);
  }
}

beforeAll(async () => {
  db = await PGlite.create();
  await db.exec(fs.readFileSync(SHIM, 'utf8'));
  const seed = fs.readFileSync(path.join(SUPABASE_ROOT, 'seed.sql'), 'utf8');
  for (const f of fs.readdirSync(MIG_DIR).filter((x) => x.endsWith('.sql')).sort()) {
    await db.exec(fs.readFileSync(path.join(MIG_DIR, f), 'utf8').replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, ''));
    if (f.startsWith('0001')) await db.exec(seed);
  }
  await db.exec(`insert into auth.users(id,email) values ('${EDITOR}','e@t'),('${EDITOR2}','e2@t'),('${AUTHOR}','a@t'),('${PLAIN}','p@t');`);
  await db.exec(`insert into resource_user_roles(user_id, role) values ('${EDITOR}','editor'),('${EDITOR2}','editor'),('${AUTHOR}','author');`);
  CAT = (await one<{ id: string }>(`select id from resource_categories limit 1`)).id;
}, 300_000);
afterAll(async () => {
  await db?.close();
});

describe('0273 shape', () => {
  it('the two parts joined are byte-equal to the migration; it is additive (no table, no constraint, no resource_posts change)', () => {
    expect(Buffer.concat([fs.readFileSync(path.join(PARTS, '0273a.sql')), fs.readFileSync(path.join(PARTS, '0273b.sql'))]).equals(Buffer.from(M))).toBe(true);
    expect(M).not.toMatch(/create table|alter table|drop (table|column|constraint)|truncate/i);
    expect(M).toMatch(/^-- ---------------------------------------------------------------------------\n-- PART B starts here/m);
  });

  it('privileges: anon and authenticated can execute NEITHER the twin NOR the core; service role can execute the twin; the signed-in function is unchanged', async () => {
    const can = async (role: string, fn: string) => (await one<{ b: boolean }>(`select has_function_privilege($1, $2, 'execute') b`, [role, fn])).b;
    const TWIN = 'public.apply_resource_content_import_as_actor(uuid,uuid)';
    const CORE_SIG = 'private.apply_resource_content_import_core(uuid,uuid)';
    for (const r of ['anon', 'authenticated']) {
      expect(await can(r, TWIN), `${r} twin`).toBe(false);
      expect(await can(r, CORE_SIG), `${r} core`).toBe(false);
    }
    expect(await can('service_role', TWIN)).toBe(true);
    expect(await can('authenticated', 'public.apply_resource_content_import(uuid)')).toBe(true);
    expect(await can('anon', 'public.apply_resource_content_import(uuid)')).toBe(false);
  });

  it('all three are SECURITY DEFINER with a fixed empty search_path', async () => {
    const rows = (await db.query(`select proname, prosecdef, proconfig from pg_proc where proname in ('apply_resource_content_import','apply_resource_content_import_as_actor','apply_resource_content_import_core')`)).rows as { proname: string; prosecdef: boolean; proconfig: string[] | null }[];
    expect(rows.length).toBe(3);
    for (const r of rows) {
      expect(r.prosecdef, r.proname).toBe(true);
      expect(r.proconfig ?? [], r.proname).toContain('search_path=""');
    }
  });
});

describe('a browser cannot name an actor', () => {
  it('a signed-in person, an anonymous caller and an admin-level browser session are all refused (permission denied) and nothing is created', async () => {
    const run = await stage(EDITOR);
    const b = await postsLike();
    for (const [uid, role] of [[EDITOR, 'authenticated'], [EDITOR2, 'authenticated'], [null, 'anon']] as const) {
      await expectCode(as(uid, role, () => db.query(`select public.apply_resource_content_import_as_actor($1,$2)`, [run, EDITOR])), 'permission denied');
    }
    await expectCode(as(EDITOR, 'authenticated', () => db.query(`select private.apply_resource_content_import_core($1,$2)`, [run, EDITOR])), 'permission denied');
    expect(await postsLike()).toBe(b);
  });

  it('NC-A1 the EXECUTE revoke is what stops it: with authenticated GRANTED execute, editor2 CAN name someone else (the editor) as actor and apply their run', async () => {
    const run = await stage(EDITOR);
    await db.exec('grant execute on function public.apply_resource_content_import_as_actor(uuid, uuid) to authenticated;');
    try {
      const res = await as(EDITOR2, 'authenticated', async () => (await one<{ v: Json }>(`select public.apply_resource_content_import_as_actor($1,$2) v`, [run, EDITOR])).v);
      expect(res.ok, 'with the revoke undone a signed-in person can impersonate the owner').toBe(true);
    } finally {
      await db.exec('revoke all on function public.apply_resource_content_import_as_actor(uuid, uuid) from public, anon, authenticated;');
    }
    const run2 = await stage(EDITOR);
    await expectCode(as(EDITOR2, 'authenticated', () => db.query(`select public.apply_resource_content_import_as_actor($1,$2)`, [run2, EDITOR])), 'permission denied');
  });
});

describe('through the twin the database still checks the actor', () => {
  it('the actor must hold the capability AND have uploaded the run: author, plain user, another editor, an unknown id and null are all refused with 0 created', async () => {
    const run = await stage(EDITOR);
    const b = await postsLike();
    await expectCode(twin(AUTHOR, run), 'FORBIDDEN');
    await expectCode(twin(PLAIN, run), 'FORBIDDEN');
    await expectCode(twin(EDITOR2, run), 'FORBIDDEN');
    await expectCode(twin('99999999-9999-4999-8999-999999999999', run), 'FORBIDDEN');
    await expectCode(twin(null, run), 'NOT_AUTHENTICATED');
    expect(await postsLike()).toBe(b);
  });

  it('NC-A2 ownership: with the owner check REMOVED from the core, another editor named as actor applies the run', async () => {
    const run = await stage(EDITOR);
    await mutateCore(/if v_run\.uploaded_by is distinct from v_actor then\s*raise exception 'FORBIDDEN: only the person who uploaded this file can apply it';\s*end if;/, async () => {
      expect((await twin(EDITOR2, run)).ok).toBe(true);
    });
  });

  it('NC-A3 capability: with the capability check REMOVED from the core, an author named as actor applies the run', async () => {
    const run = await stage(AUTHOR);
    await expectCode(twin(AUTHOR, run), 'FORBIDDEN');
    await mutateCore(/if not private\.can_bulk_import_resource_content\(v_actor\) then\s*raise exception 'FORBIDDEN: the bulk import capability is required';\s*end if;/, async () => {
      expect((await twin(AUTHOR, run)).ok).toBe(true);
    });
  });
});

describe('everything 0272 guaranteed is preserved through the twin', () => {
  it('creates private drafts with the forced values, whatever the staged data says; the actor is the creator; audit and versions are written; a second call is a no-op', async () => {
    const evil = payload({ status: 'published', visibility: 'public', is_indexable: true, content_type: 'guide', created_by: EDITOR2, published_at: '2020-01-01T00:00:00Z' });
    const run = await stage(EDITOR, [evil, payload()]);
    const res = await twin(EDITOR, run);
    expect(res).toMatchObject({ ok: true, already_applied: false, created: 2 });
    const posts = (await db.query(`select content_type, status, visibility, is_indexable, created_by, published_at from resource_posts where id = any($1::uuid[])`, [res.post_ids])).rows as Json[];
    for (const p of posts) expect(p).toEqual({ content_type: 'article', status: 'draft', visibility: 'private', is_indexable: false, created_by: EDITOR, published_at: null });
    expect(await count(`select count(*) n from resource_audit_log where metadata->>'import_run_id' = $1`, [run])).toBe(2);
    expect(await count(`select count(*) n from resource_post_versions where post_id = any($1::uuid[])`, [res.post_ids])).toBe(2);
    expect(await twin(EDITOR, run)).toMatchObject({ ok: true, already_applied: true });
    expect(await count(`select count(*) n from resource_posts where id = any($1::uuid[])`, [res.post_ids])).toBe(2);
  });

  it('all-or-none: a row the database refuses leaves nothing; STALE_PREVIEW; FILE_ALREADY_APPLIED; errors block', async () => {
    const b = await postsLike();
    await expectCode(twin(EDITOR, await stage(EDITOR, [payload(), payload({ jurisdiction: 'mars' })])), 'APPLY_FAILED');
    expect(await postsLike()).toBe(b);

    const rows = [payload(), payload()];
    const stale = await stage(EDITOR, rows);
    await as(null, 'service_role', () => db.query(`insert into resource_posts(title, slug, content_type, status, created_by) values ('r', $1, 'article', 'draft', $2)`, [rows[1].slug, EDITOR]));
    await expectCode(twin(EDITOR, stale), 'STALE_PREVIEW');
    expect(await postsLike(), 'only the racing post exists').toBe(b + 1);

    const sha = 'e'.repeat(64);
    await twin(EDITOR, await stage(EDITOR, [payload()], { sha }));
    const before = await postsLike();
    await expectCode(twin(EDITOR, await stage(EDITOR, [payload()], { sha })), 'FILE_ALREADY_APPLIED');
    expect(await postsLike()).toBe(before);

    await expectCode(twin(EDITOR, await stage(EDITOR, [payload()], { status: 'has_errors', errorCount: 1 })), 'IMPORT_NOT_READY');
    expect(await postsLike()).toBe(before);
  });

  it('the signed-in function still works, still takes its actor from auth.uid(), and another signed-in person cannot apply the run (NC-A4)', async () => {
    const run = await stage(EDITOR);
    await expectCode(signed(EDITOR2, run), 'FORBIDDEN');
    await expectCode(signed(AUTHOR, run), 'FORBIDDEN');
    await expectCode(as(null, 'authenticated', () => db.query(`select public.apply_resource_content_import($1)`, [run])), 'NOT_AUTHENTICATED');
    await expectCode(as(null, 'anon', () => db.query(`select public.apply_resource_content_import($1)`, [run])), 'permission denied');
    const res = await signed(EDITOR, run);
    expect(res).toMatchObject({ ok: true, created: 1 });
    const creator = await one<{ created_by: string }>(`select created_by from resource_posts where id = $1`, [(res.post_ids as string[])[0]]);
    expect(creator.created_by).toBe(EDITOR);
  });

  it('a large run applies through the twin as one transaction (500 rows) and is idempotent on the second call', async () => {
    const rows = Array.from({ length: 500 }, () => payload());
    const run = await stage(EDITOR, rows);
    const t = Date.now();
    const res = await twin(EDITOR, run);
    const ms = Date.now() - t;
    expect(res).toMatchObject({ ok: true, created: 500 });
    expect((res.post_ids as string[]).length).toBe(500);
    expect(ms).toBeLessThan(60_000);
    expect(await twin(EDITOR, run)).toMatchObject({ already_applied: true });
  });
});

// Resources Bulk Upload (Articles + Money Updates) -- real-Postgres (PGlite) proof of the DATABASE half.
//
// The WHOLE migration ledger (including 0272) is replayed into an isolated in-memory Postgres, then every rule is
// exercised through the real SECURITY DEFINER function as the real roles (anon / authenticated / service_role) with
// auth.uid() driven by request.jwt.claims. Nothing is reimplemented here.
//
// NEGATIVE CONTROLS (each must demonstrably fail something):
//   NC-DB1  status injection:     the function with status hard-coded REMOVED lets a staged status through -> assertion goes red
//   NC-DB2  visibility injection: same for visibility
//   NC-DB3  atomicity:            with the early already-applied check REMOVED the late unique index still refuses, and the
//                                 whole transaction (posts, sources, links, versions, audit) rolls back
//   NC-DB4  ownership:            with the owner check REMOVED a second editor can apply someone else's run
//   NC-DB5  capability:           with the capability check REMOVED an author can apply
//   NC-DB6  stale preview:        with the stale checks REMOVED a slug taken after the preview is not noticed
//
// CONCURRENCY -- HONEST LIMIT: PGlite is a single connection, so two simultaneous applies cannot be raced here. The
// guarantee rests on (1) FOR UPDATE on the run row and (2) the partial unique index uq_rcir_applied_file, which this suite
// DOES exercise (NC-DB3). A real parallel-request probe runs in the live DEV suite.
//
// EVIDENCE LABEL: PGlite-verified. Not DEV- or production-verified.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUPABASE_ROOT = path.resolve(HERE, '..', '..', 'supabase');
const MIG_DIR = path.join(SUPABASE_ROOT, 'migrations');
const SHIM = path.join(SUPABASE_ROOT, '..', 'scripts', 'db-rebuild-check', 'shim.sql');
const MIG_NAME = fs.readdirSync(MIG_DIR).find((f) => f.endsWith('_resource_content_bulk_import.sql'));
if (!MIG_NAME) throw new Error('bulk import migration not found');
const MIGRATION = fs.readFileSync(path.join(MIG_DIR, MIG_NAME), 'utf8');

const U = (n: number) => `cccccccc-0000-0000-0000-${String(n).padStart(12, '0')}`;
const SUPER = U(1);
const RADMIN = U(2);
const EDITOR = U(3);
const EDITOR2 = U(4);
const AUTHOR = U(5);
const COMPLIANCE = U(6);
const PUBLISHER = U(7);
const ANALYST = U(8);
const PLAIN = U(9);

let db: PGlite;
let uniq = 0;
type Json = Record<string, unknown>;

function extractFn(name: string): string {
  const m = MIGRATION.match(new RegExp(`create or replace function (?:public\\.|private\\.)?${name}\\([\\s\\S]*?\\n\\$fn\\$;`));
  if (!m) throw new Error(`could not extract ${name}`);
  return m[0];
}
const APPLY_FN = extractFn('apply_resource_content_import');

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

async function one<T = Json>(sql: string, params: unknown[] = []): Promise<T> {
  return (await db.query(sql, params)).rows[0] as T;
}
async function count(sql: string, params: unknown[] = []): Promise<number> {
  return Number((await one<{ n: string }>(sql, params)).n);
}

// -- fixtures -----------------------------------------------------------------
let CAT: string;
let TAG_A: string;
let TAG_B: string;
let AUTH_ID: string;
let CTA_ID: string;

function payload(kind: 'article' | 'money_update', over: Json = {}): Json {
  uniq += 1;
  const base: Json = {
    external_id: `EXT-${uniq}`,
    title: `Imported ${kind} ${uniq}`,
    slug: `imported-${kind.replace('_', '-')}-${uniq}`,
    slug_generated: false,
    jurisdiction: 'australia',
    difficulty: 'beginner',
    compliance_classification: 'green',
    freshness_type: 'evergreen',
    event_date: null,
    affected_audience: null,
    next_review_at: '2027-03-31',
    expires_at: null,
    excerpt: 'A short summary of the imported item.',
    content_blocks: [
      { id: '11111111-1111-4111-8111-111111111111', type: 'heading', data: { level: 2, text: 'Main' } },
      { id: '22222222-2222-4222-8222-222222222222', type: 'paragraph', data: { text: 'Body text.' } },
    ],
    primary_category_id: CAT,
    tag_ids: [TAG_A, TAG_B],
    author_id: AUTH_ID,
    primary_cta_id: CTA_ID,
    secondary_cta_id: null,
    seo_title: null,
    seo_description: null,
    sources: [{ source_name: 'Reserve Bank', document_title: 'Statement', url: 'https://www.rba.gov.au/x', source_type: 'regulator', publication_date: '2026-08-12', is_public: true }],
  };
  if (kind === 'money_update') {
    base.freshness_type = 'time_sensitive';
    base.event_date = '2026-09-30';
    base.affected_audience = 'Home loan holders';
    base.author_id = null;
  }
  return { ...base, ...over };
}

interface StageOpts {
  type?: 'article' | 'money_update';
  uploader: string;
  rows?: Json[];
  sha?: string;
  status?: string;
  errorCount?: number;
  rowErrors?: Json[][];
  fileName?: string;
}
async function stageRun(o: StageOpts): Promise<string> {
  const type = o.type ?? 'article';
  const rows = o.rows ?? [payload(type)];
  uniq += 1;
  const sha = o.sha ?? uniq.toString(16).padStart(64, 'a').slice(-64);
  return as(null, 'service_role', async () => {
    const run = await one<{ id: string }>(
      `insert into public.resource_content_import_runs (content_type, uploaded_by, file_name, file_sha256, template_version, status, row_count, valid_count, error_count)
       values ($1,$2,$3,$4,'1.0',$5,$6,$7,$8) returning id`,
      [type, o.uploader, o.fileName ?? 'upload.csv', sha, o.status ?? 'ready', rows.length, rows.length - (o.errorCount ?? 0), o.errorCount ?? 0]
    );
    for (let i = 0; i < rows.length; i++) {
      const p = rows[i];
      await db.query(
        `insert into public.resource_content_import_rows (import_run_id, row_number, external_id, slug, title, normalized_payload, validation_errors)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [run.id, i + 2, p.external_id ?? null, p.slug ?? null, p.title ?? null, JSON.stringify(p), JSON.stringify(o.rowErrors?.[i] ?? [])]
      );
    }
    return run.id;
  });
}

async function apply(actor: string | null, runId: string, role: 'authenticated' | 'anon' = 'authenticated'): Promise<Json> {
  return as(actor, role, async () => (await one<{ v: Json }>(`select public.apply_resource_content_import($1) v`, [runId])).v);
}

async function totals() {
  return {
    posts: await count(`select count(*) n from resource_posts where created_by is not null and (content_id like 'EXT-%' or slug like 'imported-%')`),
    sources: await count(`select count(*) n from resource_sources where source_name like 'Reserve Bank%' or source_name like 'Orphan%'`),
    cats: await count(`select count(*) n from resource_post_categories rc join resource_posts p on p.id = rc.post_id where p.slug like 'imported-%'`),
    tags: await count(`select count(*) n from resource_post_tags rt join resource_posts p on p.id = rt.post_id where p.slug like 'imported-%'`),
    links: await count(`select count(*) n from resource_post_sources ps join resource_posts p on p.id = ps.post_id where p.slug like 'imported-%'`),
    versions: await count(`select count(*) n from resource_post_versions v join resource_posts p on p.id = v.post_id where p.slug like 'imported-%'`),
    audit: await count(`select count(*) n from resource_audit_log where metadata->>'created_via' = 'bulk_import'`),
  };
}

async function withMutation(find: string | RegExp, replace: string, body: () => Promise<void>) {
  const mutated = APPLY_FN.replace(find, replace);
  expect(mutated, 'the mutation must change the function text').not.toBe(APPLY_FN);
  await db.exec(mutated);
  try {
    await body();
  } finally {
    await db.exec(APPLY_FN);
  }
}

beforeAll(async () => {
  db = await PGlite.create();
  await db.exec(fs.readFileSync(SHIM, 'utf8'));
  const seed = fs.readFileSync(path.join(SUPABASE_ROOT, 'seed.sql'), 'utf8');
  const files = fs.readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    await db.exec(fs.readFileSync(path.join(MIG_DIR, f), 'utf8').replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, ''));
    if (f.startsWith('0001')) await db.exec(seed);
  }
  const users = [SUPER, RADMIN, EDITOR, EDITOR2, AUTHOR, COMPLIANCE, PUBLISHER, ANALYST, PLAIN];
  await db.exec(`insert into auth.users(id,email) values ${users.map((u, i) => `('${u}','u${i}@pg.test')`).join(',')};`);
  await db.exec(`insert into admin_users(user_id) values ('${SUPER}');`);
  const roles: [string, string][] = [
    [RADMIN, 'resource_admin'],
    [EDITOR, 'editor'],
    [EDITOR2, 'editor'],
    [AUTHOR, 'author'],
    [COMPLIANCE, 'compliance_reviewer'],
    [PUBLISHER, 'publisher'],
    [ANALYST, 'analyst'],
  ];
  for (const [u, r] of roles) await db.exec(`insert into resource_user_roles(user_id, role) values ('${u}','${r}');`);
  CAT = (await one<{ id: string }>(`select id from resource_categories where slug = 'financial-health'`)).id;
  TAG_A = (await one<{ id: string }>(`insert into resource_tags(name, slug) values ('Alpha','alpha-tag') returning id`)).id;
  TAG_B = (await one<{ id: string }>(`insert into resource_tags(name, slug) values ('Beta','beta-tag') returning id`)).id;
  AUTH_ID = (await one<{ id: string }>(`insert into resource_authors(display_name, slug) values ('Pat Author','pat-author') returning id`)).id;
  CTA_ID = (await one<{ id: string }>(`insert into resource_ctas(name, label, destination_type, destination_url) values ('Open dashboard','Open','fhip_module','/dashboard') returning id`)).id;
}, 300_000);

afterAll(async () => {
  await db?.close();
});

// ---------------------------------------------------------------------------
describe('migration shape', () => {
  it('both staging tables have RLS and give API roles no write privilege; only server-side code writes', async () => {
    for (const t of ['resource_content_import_runs', 'resource_content_import_rows']) {
      const rls = await one<{ r: boolean }>(`select relrowsecurity r from pg_class where oid=$1::regclass`, [`public.${t}`]);
      expect(rls.r, `${t} must have RLS`).toBe(true);
      const w = (await db.query(`select privilege_type p from information_schema.role_table_grants where table_name=$1 and grantee in ('anon','authenticated','public') and privilege_type <> 'SELECT'`, [t])).rows;
      expect(w, `${t}: no write privilege for API roles`).toEqual([]);
      const anonSel = (await db.query(`select 1 from information_schema.role_table_grants where table_name=$1 and grantee='anon' and privilege_type='SELECT'`, [t])).rows;
      expect(anonSel, `${t}: anon has no SELECT at all`).toEqual([]);
    }
  });

  it('anon can execute none of the three public functions or the capability helper; authenticated can execute the two staff ones but not the purge', async () => {
    const fns = ['public.apply_resource_content_import(uuid)', 'public.resource_content_import_lookup(text[],text[],text[])', 'public.purge_expired_resource_content_import_staging()', 'private.can_bulk_import_resource_content(uuid)'];
    for (const f of fns) {
      expect((await one<{ b: boolean }>(`select has_function_privilege('anon', $1, 'execute') b`, [f])).b, `anon must not execute ${f}`).toBe(false);
    }
    expect((await one<{ b: boolean }>(`select has_function_privilege('authenticated', 'public.purge_expired_resource_content_import_staging()', 'execute') b`)).b).toBe(false);
    expect((await one<{ b: boolean }>(`select has_function_privilege('authenticated', 'public.apply_resource_content_import(uuid)', 'execute') b`)).b).toBe(true);
  });

  it('the functions are SECURITY DEFINER with a fixed empty search_path', async () => {
    const rows = (await db.query(`select proname, prosecdef, proconfig from pg_proc where proname in ('apply_resource_content_import','resource_content_import_lookup','purge_expired_resource_content_import_staging','can_bulk_import_resource_content')`)).rows as { proname: string; prosecdef: boolean; proconfig: string[] | null }[];
    expect(rows.length).toBe(4);
    for (const r of rows) {
      expect(r.prosecdef, r.proname).toBe(true);
      expect(r.proconfig ?? [], r.proname).toContain('search_path=""');
    }
  });

  it('adds no resource_posts column, constraint or policy of its own', async () => {
    expect(MIGRATION).not.toMatch(/alter table (public\.)?resource_posts/i);
    expect(MIGRATION).not.toMatch(/drop constraint/i);
  });
});

// ---------------------------------------------------------------------------
describe('capability resources.content.bulk_import', () => {
  it('is held by super admin, resource admin and editor ONLY', async () => {
    const allowed = [SUPER, RADMIN, EDITOR, EDITOR2];
    const denied = [AUTHOR, COMPLIANCE, PUBLISHER, ANALYST, PLAIN];
    for (const u of allowed) expect((await as(null, 'service_role', () => one<{ b: boolean }>(`select private.can_bulk_import_resource_content($1) b`, [u]))).b, u).toBe(true);
    for (const u of denied) expect((await as(null, 'service_role', () => one<{ b: boolean }>(`select private.can_bulk_import_resource_content($1) b`, [u]))).b, u).toBe(false);
  });

  it('DENIED at the apply RPC for author, compliance reviewer, publisher, analyst and a plain customer; anon cannot even execute it', async () => {
    const runId = await stageRun({ uploader: EDITOR });
    for (const u of [AUTHOR, COMPLIANCE, PUBLISHER, ANALYST, PLAIN]) await expectCode(apply(u, runId), 'FORBIDDEN');
    await expectCode(apply(null, runId, 'anon'), 'permission denied');
    await expectCode(apply(null, runId, 'authenticated'), 'NOT_AUTHENTICATED');
    expect(await count(`select count(*) n from resource_posts where slug like 'imported-article-%' and created_by is not null`)).toBe(0);
  });

  it('DENIED at the lookup RPC for the same roles', async () => {
    for (const u of [AUTHOR, COMPLIANCE, PUBLISHER, ANALYST, PLAIN]) {
      await expectCode(as(u, 'authenticated', () => db.query(`select public.resource_content_import_lookup(array['x'],array['y'],array['https://z'])`)), 'FORBIDDEN');
    }
    const ok = await as(EDITOR, 'authenticated', () => one<{ v: Json }>(`select public.resource_content_import_lookup(array['nope'],array['nope'],array['https://nope']) v`));
    expect(ok.v).toEqual({ slugs: [], content_ids: [], post_ids: [], sources: [] });
  });
});

// ---------------------------------------------------------------------------
describe('staging tables: cross-actor isolation', () => {
  it('an editor reads only their own runs; another editor sees none; a resource admin and super admin see all; nobody writes directly', async () => {
    const runA = await stageRun({ uploader: EDITOR });
    const seeOwn = await as(EDITOR, 'authenticated', () => count(`select count(*) n from public.resource_content_import_runs where id = $1`, [runA]));
    const seeOther = await as(EDITOR2, 'authenticated', () => count(`select count(*) n from public.resource_content_import_runs where id = $1`, [runA]));
    const seeAdmin = await as(RADMIN, 'authenticated', () => count(`select count(*) n from public.resource_content_import_runs where id = $1`, [runA]));
    const seeSuper = await as(SUPER, 'authenticated', () => count(`select count(*) n from public.resource_content_import_runs where id = $1`, [runA]));
    expect([seeOwn, seeOther, seeAdmin, seeSuper]).toEqual([1, 0, 1, 1]);
    const rowsOwn = await as(EDITOR, 'authenticated', () => count(`select count(*) n from public.resource_content_import_rows where import_run_id = $1`, [runA]));
    const rowsOther = await as(EDITOR2, 'authenticated', () => count(`select count(*) n from public.resource_content_import_rows where import_run_id = $1`, [runA]));
    expect([rowsOwn, rowsOther]).toEqual([1, 0]);
    const noAuthor = await as(AUTHOR, 'authenticated', () => count(`select count(*) n from public.resource_content_import_runs`));
    expect(noAuthor).toBe(0);
    await expectCode(as(EDITOR, 'authenticated', () => db.query(`update public.resource_content_import_runs set status='applied' where id=$1`, [runA])), 'permission denied');
    await expectCode(as(EDITOR, 'authenticated', () => db.query(`insert into public.resource_content_import_runs(content_type,file_name,file_sha256) values ('article','x',repeat('a',64))`)), 'permission denied');
    await expectCode(as(null, 'anon', () => db.query(`select count(*) from public.resource_content_import_runs`)), 'permission denied');
  });
});

// ---------------------------------------------------------------------------
describe('apply: Article', () => {
  it('creates every row as a PRIVATE DRAFT with links, versions and audit; clears the payload; second apply is a no-op', async () => {
    const shared = { source_name: 'Reserve Bank', document_title: 'Statement', url: 'https://www.rba.gov.au/x', source_type: 'regulator', publication_date: '2026-08-12', is_public: true };
    const rows = [payload('article', { sources: [shared] }), payload('article', { sources: [shared, { source_name: 'Reserve Bank 2', document_title: null, url: null, source_type: null, publication_date: null, is_public: false }] }), payload('article', { tag_ids: [], primary_category_id: null, author_id: null, primary_cta_id: null, sources: [] })];
    const before = await totals();
    const runId = await stageRun({ uploader: EDITOR, rows });
    const res = await apply(EDITOR, runId);
    expect(res.ok).toBe(true);
    expect(res.created).toBe(3);
    expect((res.post_ids as string[]).length).toBe(3);

    const ids = res.post_ids as string[];
    const posts = (await db.query(`select * from resource_posts where id = any($1::uuid[]) order by created_at, slug`, [ids])).rows as Json[];
    expect(posts.length).toBe(3);
    for (const p of posts) {
      expect(p.content_type).toBe('article');
      expect(p.status).toBe('draft');
      expect(p.visibility).toBe('private');
      expect(p.is_indexable).toBe(false);
      expect(p.created_by).toBe(EDITOR);
      expect(p.updated_by).toBe(EDITOR);
      expect(p.published_at).toBeNull();
      expect(p.scheduled_at).toBeNull();
      expect(p.editorial_approved_by).toBeNull();
      expect(p.compliance_approved_by).toBeNull();
      expect(Array.isArray(p.content_blocks)).toBe(true);
    }
    const first = posts.find((p) => p.author_id) as Json;
    expect(first.primary_category_id).toBe(CAT);
    expect(first.primary_cta_id).toBe(CTA_ID);
    expect(String(first.content_id)).toMatch(/^EXT-/);

    const after = await totals();
    expect(after.posts - before.posts).toBe(3);
    expect(after.cats - before.cats).toBe(2); // third row has no category
    expect(after.tags - before.tags).toBe(4);
    expect(after.sources - before.sources).toBe(2); // the shared source is created ONCE, plus the name-only one
    expect(after.links - before.links).toBe(3);
    expect(after.versions - before.versions).toBe(3);
    expect(after.audit - before.audit).toBe(3);

    const audit = await one<{ metadata: Json }>(`select metadata from resource_audit_log where entity_id=$1 and action='created'`, [ids[0]]);
    expect(audit.metadata).toMatchObject({ created_via: 'bulk_import', import_run_id: runId, import_row_number: 2 });
    const runAudit = await count(`select count(*) n from resource_audit_log where entity_type='resource_content_import_run' and entity_id=$1 and action='applied'`, [runId]);
    expect(runAudit).toBe(1);

    const run = await one<Json>(`select status, created_post_count, applied_at from resource_content_import_runs where id=$1`, [runId]);
    expect(run.status).toBe('applied');
    expect(run.created_post_count).toBe(3);
    expect(run.applied_at).toBeTruthy();
    const payloads = (await db.query(`select normalized_payload p, result_status s, result_post_id r from resource_content_import_rows where import_run_id=$1`, [runId])).rows as Json[];
    for (const r of payloads) {
      expect(r.p).toEqual({});
      expect(r.s).toBe('created');
      expect(r.r).toBeTruthy();
    }

    const again = await apply(EDITOR, runId);
    expect(again).toMatchObject({ ok: true, already_applied: true });
    expect((await totals()).posts - before.posts).toBe(3);
  });

  it('an exact existing source is REUSED, a different one is created: no fuzzy merge', async () => {
    const existing = await as(null, 'service_role', () => one<{ id: string }>(`insert into resource_sources(source_name, document_title, url, source_type, is_public) values ('Orphan Reuse Co','Doc','https://reuse.example/a','regulator',true) returning id`));
    const exact = { source_name: 'Orphan Reuse Co', document_title: 'Doc', url: 'https://reuse.example/a', source_type: 'news', publication_date: null, is_public: true };
    const nearly = { source_name: 'Orphan Reuse Co', document_title: 'Doc', url: 'https://reuse.example/A', source_type: 'news', publication_date: null, is_public: true };
    const runId = await stageRun({ uploader: EDITOR, rows: [payload('article', { sources: [exact, nearly] })] });
    const res = await apply(EDITOR, runId);
    const post = (res.post_ids as string[])[0];
    const linked = (await db.query(`select s.id, s.url from resource_post_sources ps join resource_sources s on s.id = ps.source_id where ps.post_id=$1 order by ps.sort_order`, [post])).rows as { id: string; url: string }[];
    expect(linked.length).toBe(2);
    expect(linked[0].id).toBe(existing.id);
    expect(linked[1].id).not.toBe(existing.id);
    expect(linked[1].url).toBe('https://reuse.example/A');
    expect(await count(`select count(*) n from resource_sources where source_name='Orphan Reuse Co'`)).toBe(2);
  });
});

describe('apply: Money Update', () => {
  it('forces time_sensitive, keeps event date and audience, and ignores an Article-only author', async () => {
    const runId = await stageRun({ type: 'money_update', uploader: RADMIN, rows: [payload('money_update', { author_id: AUTH_ID })] });
    const res = await apply(RADMIN, runId);
    const p = await one<Json>(`select *, to_char(event_date, 'YYYY-MM-DD') as event_date_text from resource_posts where id=$1`, [(res.post_ids as string[])[0]]);
    expect(p).toMatchObject({ content_type: 'money_update', status: 'draft', visibility: 'private', is_indexable: false, freshness_type: 'time_sensitive', affected_audience: 'Home loan holders' });
    expect(p.event_date_text).toBe('2026-09-30');
    expect(p.author_id).toBeNull();
  });

  it('an Article row cannot smuggle an event date or audience in', async () => {
    const runId = await stageRun({ uploader: EDITOR, rows: [payload('article', { event_date: '2026-01-01', affected_audience: 'x' })] });
    const res = await apply(EDITOR, runId);
    const p = await one<Json>(`select event_date, affected_audience from resource_posts where id=$1`, [(res.post_ids as string[])[0]]);
    expect(p).toEqual({ event_date: null, affected_audience: null });
  });
});

// ---------------------------------------------------------------------------
describe('injection: the staged data cannot choose state', () => {
  const evil = { status: 'published', visibility: 'public', is_indexable: true, content_type: 'guide', created_by: SUPER, published_at: '2020-01-01T00:00:00Z', editorial_approved_by: SUPER, scheduled_at: '2020-01-01T00:00:00Z' };

  async function assertForced(): Promise<void> {
    const runId = await stageRun({ uploader: EDITOR, rows: [payload('article', evil)] });
    const res = await apply(EDITOR, runId);
    const p = await one<Json>(`select content_type, status, visibility, is_indexable, created_by, published_at, scheduled_at, editorial_approved_by from resource_posts where id=$1`, [(res.post_ids as string[])[0]]);
    expect(p).toEqual({ content_type: 'article', status: 'draft', visibility: 'private', is_indexable: false, created_by: EDITOR, published_at: null, scheduled_at: null, editorial_approved_by: null });
  }

  it('status, visibility, content type, indexable, actor, publish and approval fields are all forced', async () => {
    await assertForced();
  });

  it('NC-DB1 status injection: with the hard-coded status REMOVED a staged status lands (so the hard-coded value is what protects it)', async () => {
    await withMutation(/'private',\s*\n\s*'draft',/, `'private',\n      coalesce(r.normalized_payload->>'status', 'draft'),`, async () => {
      const runId = await stageRun({ uploader: EDITOR, rows: [payload('article', { status: 'editorial_review' })] });
      const res = await apply(EDITOR, runId);
      const p = await one<Json>(`select status from resource_posts where id=$1`, [(res.post_ids as string[])[0]]);
      expect(p.status, 'the mutated function really does let a staged status through').toBe('editorial_review');
    });
    await assertForced(); // restored: the real function forces draft again
  });

  it('NC-DB2 visibility injection: with the hard-coded visibility REMOVED a staged public visibility lands', async () => {
    await withMutation(/'private',\s*\n\s*'draft',/, `coalesce(r.normalized_payload->>'visibility', 'private'),\n      'draft',`, async () => {
      const runId = await stageRun({ uploader: EDITOR, rows: [payload('article', { visibility: 'public' })] });
      const res = await apply(EDITOR, runId);
      const p = await one<Json>(`select visibility from resource_posts where id=$1`, [(res.post_ids as string[])[0]]);
      expect(p.visibility, 'the mutated function really does let public through, so the guarantee depends on the hard-coded value').toBe('public');
    });
    await assertForced();
  });
});

// ---------------------------------------------------------------------------
describe('all-or-none, stale preview, readiness', () => {
  it('a row the database refuses makes the WHOLE apply fail with APPLY_FAILED: zero posts, links, sources, versions or audit; run not applied', async () => {
    const before = await totals();
    const rows = [payload('article'), payload('article'), payload('article', { jurisdiction: 'mars' })];
    const runId = await stageRun({ uploader: EDITOR, rows });
    await expectCode(apply(EDITOR, runId), 'APPLY_FAILED');
    expect(await totals()).toEqual(before);
    const run = await one<Json>(`select status, applied_at from resource_content_import_runs where id=$1`, [runId]);
    expect(run).toMatchObject({ status: 'ready', applied_at: null });
  });

  it('NC-DB3 atomicity: with the early already-applied check REMOVED the late unique index still refuses and EVERYTHING rolls back, new sources included', async () => {
    const sha = 'd'.repeat(64);
    const first = await stageRun({ uploader: EDITOR, sha, rows: [payload('article')] });
    await apply(EDITOR, first);
    const before = await totals();
    const second = await stageRun({ uploader: EDITOR, sha, rows: [payload('article', { sources: [{ source_name: 'Orphan Late Co', document_title: null, url: 'https://late.example/', source_type: null, publication_date: null, is_public: true }] })] });
    await withMutation(/if exists \(\s*select 1 from public\.resource_content_import_runs o[\s\S]*?raise exception 'FILE_ALREADY_APPLIED: this exact file was already applied';\s*end if;/, '-- early check removed for the control', async () => {
      await expectCode(apply(EDITOR, second), 'FILE_ALREADY_APPLIED');
    });
    expect(await totals(), 'a late failure must leave no post, link, version, audit row or source behind').toEqual(before);
    expect(await count(`select count(*) n from resource_sources where source_name = 'Orphan Late Co'`)).toBe(0);
    expect((await one<Json>(`select status from resource_content_import_runs where id=$1`, [second])).status).toBe('ready');
    // and with the real function the same file is refused up front
    await expectCode(apply(EDITOR, second), 'FILE_ALREADY_APPLIED');
    expect(await totals()).toEqual(before);
  });

  it('a slug taken AFTER the preview stops the whole apply with STALE_PREVIEW (0 created); the same for an external id and a deactivated category', async () => {
    const before = await totals();
    const rows = [payload('article'), payload('article')];
    const runId = await stageRun({ uploader: EDITOR, rows });
    await as(null, 'service_role', () => db.query(`insert into resource_posts(title, slug, content_type, status, created_by) values ('Racer', $1, 'article', 'draft', $2)`, [rows[1].slug, EDITOR]));
    await expectCode(apply(EDITOR, runId), 'STALE_PREVIEW');
    expect((await totals()).posts - before.posts, 'only the racing post exists').toBe(1);

    const rows2 = [payload('article'), payload('article')];
    const run2 = await stageRun({ uploader: EDITOR, rows: rows2 });
    await as(null, 'service_role', () => db.query(`insert into resource_posts(title, slug, content_id, content_type, status, created_by) values ('Racer2', $1, $2, 'article', 'draft', $3)`, [`racer-two-${uniq}`, rows2[0].external_id, EDITOR]));
    await expectCode(apply(EDITOR, run2), 'STALE_PREVIEW');

    const rows3 = [payload('article')];
    const run3 = await stageRun({ uploader: EDITOR, rows: rows3 });
    await db.exec(`update resource_categories set is_active=false where id='${CAT}'`);
    try {
      await expectCode(apply(EDITOR, run3), 'STALE_PREVIEW');
    } finally {
      await db.exec(`update resource_categories set is_active=true where id='${CAT}'`);
    }
    expect(await count(`select count(*) n from resource_posts where slug = $1`, [rows3[0].slug])).toBe(0);
  });

  it('NC-DB6: with the stale-slug check REMOVED the slug race is only caught by the unique constraint, still all-or-none (defence in depth)', async () => {
    const rows = [payload('article'), payload('article')];
    const runId = await stageRun({ uploader: EDITOR, rows });
    await as(null, 'service_role', () => db.query(`insert into resource_posts(title, slug, content_type, status, created_by) values ('Racer3', $1, 'article', 'draft', $2)`, [rows[0].slug, EDITOR]));
    const before = await totals();
    await withMutation(/select r\.row_number into v_n\s*from public\.resource_content_import_rows r\s*join public\.resource_posts p on p\.slug[\s\S]*?now exists'\;\s*end if;/, '-- stale slug check removed for the control', async () => {
      await expectCode(apply(EDITOR, runId), 'STALE_PREVIEW');
    });
    expect(await totals()).toEqual(before);
  });

  it('a mixed file (error_count 1) and a row that still carries an error are both refused: IMPORT_NOT_READY, 0 created', async () => {
    const before = await totals();
    const mixed = await stageRun({ uploader: EDITOR, status: 'has_errors', errorCount: 1, rows: [payload('article'), payload('article')] });
    await expectCode(apply(EDITOR, mixed), 'IMPORT_NOT_READY');
    const sneaky = await stageRun({ uploader: EDITOR, rows: [payload('article'), payload('article')], rowErrors: [[], [{ code: 'INVALID_DATE' }]] });
    await expectCode(apply(EDITOR, sneaky), 'IMPORT_NOT_READY');
    const incomplete = await stageRun({ uploader: EDITOR, rows: [payload('article', { content_blocks: [] })] });
    await expectCode(apply(EDITOR, incomplete), 'IMPORT_NOT_READY');
    const badSlug = await stageRun({ uploader: EDITOR, rows: [payload('article', { slug: 'Bad Slug!' })] });
    await expectCode(apply(EDITOR, badSlug), 'IMPORT_NOT_READY');
    expect(await totals()).toEqual(before);
  });

  it('an expired run, a rejected run and a run that does not exist are refused', async () => {
    const expired = await stageRun({ uploader: EDITOR, rows: [payload('article')] });
    await db.exec(`update resource_content_import_runs set expires_at = now() - interval '1 hour' where id = '${expired}'`);
    await expectCode(apply(EDITOR, expired), 'IMPORT_NOT_READY');
    const rejected = await stageRun({ uploader: EDITOR, status: 'rejected', rows: [] });
    await expectCode(apply(EDITOR, rejected), 'IMPORT_NOT_READY');
    await expectCode(apply(EDITOR, '99999999-9999-4999-8999-999999999999'), 'IMPORT_NOT_READY');
  });

  it('the same successful file again creates nothing: FILE_ALREADY_APPLIED', async () => {
    const sha = 'e'.repeat(64);
    const a = await stageRun({ uploader: EDITOR, sha, rows: [payload('article')] });
    await apply(EDITOR, a);
    const before = await totals();
    const b = await stageRun({ uploader: EDITOR, sha, rows: [payload('article')] });
    await expectCode(apply(EDITOR, b), 'FILE_ALREADY_APPLIED');
    expect(await totals()).toEqual(before);
    // a different CONTENT TYPE with the same bytes is a different file for this rule
    const c = await stageRun({ type: 'money_update', uploader: EDITOR, sha, rows: [payload('money_update')] });
    expect((await apply(EDITOR, c)).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('ownership', () => {
  it("another editor cannot apply someone else's run (FORBIDDEN, 0 created)", async () => {
    const before = await totals();
    const runId = await stageRun({ uploader: EDITOR, rows: [payload('article')] });
    await expectCode(apply(EDITOR2, runId), 'FORBIDDEN');
    await expectCode(apply(RADMIN, runId), 'FORBIDDEN');
    expect(await totals()).toEqual(before);
  });

  it('NC-DB4 ownership: with the owner check REMOVED a second editor CAN apply it (so the check is what stops them)', async () => {
    const runId = await stageRun({ uploader: EDITOR, rows: [payload('article')] });
    await withMutation(/if v_run\.uploaded_by is distinct from v_actor then\s*raise exception 'FORBIDDEN: only the person who uploaded this file can apply it';\s*end if;/, '-- owner check removed for the control', async () => {
      const res = await apply(EDITOR2, runId);
      expect(res.ok).toBe(true);
    });
  });

  it('NC-DB5 capability: with the capability check REMOVED an author CAN apply', async () => {
    const runId = await stageRun({ uploader: AUTHOR, rows: [payload('article')] });
    await expectCode(apply(AUTHOR, runId), 'FORBIDDEN');
    await withMutation(/if not private\.can_bulk_import_resource_content\(v_actor\) then\s*raise exception 'FORBIDDEN: the bulk import capability is required';\s*end if;/, '-- capability check removed for the control', async () => {
      const res = await apply(AUTHOR, runId);
      expect(res.ok).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
describe('imported drafts are hidden from the public and keep the workflow', () => {
  it('anonymous and ordinary customers cannot read an imported draft; staff can', async () => {
    const runId = await stageRun({ uploader: EDITOR, rows: [payload('article'), payload('money_update')] });
    const ids = ((await apply(EDITOR, runId)).post_ids as string[]) ?? [];
    expect(ids.length).toBe(2);
    expect(await as(null, 'anon', () => count(`select count(*) n from resource_posts where id = any($1::uuid[])`, [ids]))).toBe(0);
    expect(await as(PLAIN, 'authenticated', () => count(`select count(*) n from resource_posts where id = any($1::uuid[])`, [ids]))).toBe(0);
    expect(await as(ANALYST, 'authenticated', () => count(`select count(*) n from resource_posts where id = any($1::uuid[])`, [ids]))).toBe(0);
    expect(await as(EDITOR, 'authenticated', () => count(`select count(*) n from resource_posts where id = any($1::uuid[])`, [ids]))).toBe(2);
    const search = await as(null, 'anon', () => count(`select count(*) n from public.search_resource_posts('imported', null, null, null, 50, 0)`));
    expect(search).toBe(0);
    expect(await as(null, 'anon', () => count(`select count(*) n from resource_post_sources where post_id = any($1::uuid[])`, [ids]))).toBe(0);
  });

  it('GREEN: draft -> editorial_review -> approved -> published still needs the real roles; RED can never publish; AMBER needs compliance', async () => {
    const mk = async (compliance: string) => {
      const runId = await stageRun({ uploader: EDITOR, rows: [payload('article', { compliance_classification: compliance })] });
      return ((await apply(EDITOR, runId)).post_ids as string[])[0];
    };
    const transition = (uid: string, id: string, to: string) => as(uid, 'authenticated', () => db.query(`select public.transition_resource_post_status($1,$2,null,null)`, [id, to]));

    const green = await mk('green');
    await expectCode(transition(AUTHOR, green, 'published'), 'Only approved content');
    await transition(EDITOR, green, 'editorial_review');
    await expectCode(transition(PUBLISHER, green, 'published'), 'approved');
    await transition(EDITOR, green, 'approved');
    await transition(PUBLISHER, green, 'published');
    expect((await one<Json>(`select status from resource_posts where id=$1`, [green])).status).toBe('published');

    const red = await mk('red');
    await transition(EDITOR, red, 'editorial_review');
    await transition(EDITOR, red, 'approved');
    await expectCode(transition(RADMIN, red, 'published'), 'RED content');

    const amber = await mk('amber');
    await transition(EDITOR, amber, 'editorial_review');
    await expectCode(transition(EDITOR, amber, 'approved'), 'Compliance Reviewer');
    await transition(COMPLIANCE, amber, 'approved');
    await transition(PUBLISHER, amber, 'published');
    expect((await one<Json>(`select compliance_approved_by from resource_posts where id=$1`, [amber])).compliance_approved_by).toBe(COMPLIANCE);
  });
});

// ---------------------------------------------------------------------------
describe('lookup and clean-up', () => {
  it('the lookup finds existing slugs, content ids, post ids and sources in ONE call', async () => {
    const p = await as(null, 'service_role', () => one<{ id: string; slug: string }>(`insert into resource_posts(title, slug, content_id, content_type, status, created_by) values ('Lookup One', $1, $2, 'article', 'draft', $3) returning id, slug`, [`lookup-slug-${++uniq}`, `LK-${uniq}`, EDITOR]));
    await as(null, 'service_role', () => db.query(`insert into resource_sources(source_name, url) values ('Orphan Lookup','https://lookup.example/z')`));
    const r = await as(EDITOR, 'authenticated', () => one<{ v: { slugs: string[]; content_ids: string[]; post_ids: string[]; sources: { url: string }[] } }>(`select public.resource_content_import_lookup($1::text[], $2::text[], $3::text[]) v`, [[p.slug, 'absent-slug'], [`LK-${uniq}`, p.id], ['https://lookup.example/z', 'https://absent.example/']]));
    expect(r.v.slugs).toEqual([p.slug]);
    expect(r.v.content_ids).toEqual([`LK-${uniq}`]);
    expect(r.v.post_ids).toEqual([p.id]);
    expect(r.v.sources.map((s) => s.url)).toEqual(['https://lookup.example/z']);
  });

  it('purge clears the staged rows of an expired unapplied run, leaves the run record as history, and never touches an applied run; users cannot call it', async () => {
    const stale = await stageRun({ uploader: EDITOR, rows: [payload('article'), payload('article')] });
    await db.exec(`update resource_content_import_runs set expires_at = now() - interval '1 day' where id = '${stale}'`);
    const keep = await stageRun({ uploader: EDITOR, rows: [payload('article')] });
    const applied = await stageRun({ uploader: EDITOR, rows: [payload('article')] });
    await apply(EDITOR, applied);
    await expectCode(as(EDITOR, 'authenticated', () => db.query(`select public.purge_expired_resource_content_import_staging()`)), 'permission denied');
    await as(null, 'service_role', () => db.query(`select public.purge_expired_resource_content_import_staging()`));
    expect(await count(`select count(*) n from resource_content_import_rows where import_run_id=$1`, [stale])).toBe(0);
    expect((await one<Json>(`select status from resource_content_import_runs where id=$1`, [stale])).status).toBe('expired');
    expect(await count(`select count(*) n from resource_content_import_rows where import_run_id=$1`, [keep])).toBe(1);
    expect((await one<Json>(`select status from resource_content_import_runs where id=$1`, [applied])).status).toBe('applied');
  });
});

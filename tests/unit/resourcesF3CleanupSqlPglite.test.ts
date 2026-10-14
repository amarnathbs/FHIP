// PO review F3: the production hand-over SQL that removes empty "Untitled" drafts
// (docs/resources/po_apply_f3_cleanup/). Evidence label: PGlite-verified on an
// isolated in-memory Postgres with a minimal replica of the tables involved (not the
// full migration replay, not DEV, not production).
//
// NAMED NEGATIVE CONTROLS
//   NC-F3-1  with the "never edited" rule removed, the edited placeholder IS deleted (so the rule is what protects it);
//   NC-F3-2  with the published/status rule removed, the published row IS deleted;
//   NC-F3-3  each hazard rule of the editor-safe lint flags a deliberately bad snippet.
import { describe, expect, it, beforeAll, beforeEach, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.resolve(__dirname, '..', '..', 'docs', 'resources', 'po_apply_f3_cleanup');
const LOOK = fs.readFileSync(path.join(DIR, '01_look_first.sql'), 'utf8');
const REMOVE = fs.readFileSync(path.join(DIR, '02_remove.sql'), 'utf8');

const SCHEMA = `
create table public.resource_posts (id uuid primary key, title text, content_type text, status text, published_at timestamptz, created_at timestamptz, updated_at timestamptz, excerpt text, primary_category_id uuid);
create table public.resource_post_versions (id serial primary key, post_id uuid references public.resource_posts(id) on delete cascade);
create table public.resource_post_categories (post_id uuid references public.resource_posts(id) on delete cascade);
create table public.resource_post_tags (post_id uuid references public.resource_posts(id) on delete cascade);
create table public.resource_related_content (source_post_id uuid references public.resource_posts(id) on delete cascade, related_post_id uuid references public.resource_posts(id) on delete cascade);
create table public.resource_context_links (resource_post_id uuid references public.resource_posts(id) on delete cascade);
create table public.resource_workflow_history (post_id uuid references public.resource_posts(id) on delete cascade, to_status text);
create table public.resource_audit_log (id serial primary key, entity_type text, entity_id uuid, action text, actor_user_id uuid, before_state jsonb, metadata jsonb);
`;

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const T0 = '2026-08-17T10:00:00Z';
const post = (n: number, o: Record<string, unknown> = {}) => ({ title: 'Untitled Article', content_type: 'article', status: 'draft', published_at: null, created_at: T0, updated_at: T0, excerpt: null, primary_category_id: null, ...o, id: id(n) });
const ROWS = [
  post(1), // pristine, matches
  post(2, { title: 'Untitled Guide', content_type: 'guide' }), // pristine, matches
  post(3, { updated_at: '2026-08-18T10:00:00Z' }), // edited after creation: keep
  post(4, { status: 'published', published_at: '2026-09-01T00:00:00Z' }), // published: keep
  post(5, { title: 'Untitled Video', content_type: 'video' }), // video: keep
  post(6, { title: 'A real title' }), // real title: keep
  post(7, { excerpt: 'has text' }), // excerpt: keep
  post(8), // has a saved version: keep
];

let db: PGlite;
async function seed() {
  await db.exec('truncate public.resource_posts, public.resource_audit_log restart identity cascade');
  for (const r of ROWS) {
    await db.query('insert into public.resource_posts (id,title,content_type,status,published_at,created_at,updated_at,excerpt,primary_category_id) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [r.id, r.title, r.content_type, r.status, r.published_at, r.created_at, r.updated_at, r.excerpt, r.primary_category_id]);
  }
  await db.query('insert into public.resource_post_versions (post_id) values ($1)', [id(8)]);
}
const remaining = async () => (await db.query<{ id: string }>('select id from public.resource_posts order by id')).rows.map((r) => r.id);

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
}, 120_000);
afterAll(async () => {
  await db.close();
});
beforeEach(seed, 60_000);

describe('F3 cleanup SQL (PGlite)', () => {
  it('step 1 lists exactly the two pristine placeholders and changes nothing', async () => {
    const res = await db.query<{ id: string }>(LOOK);
    expect(res.rows.map((r) => r.id).sort()).toEqual([id(1), id(2)]);
    expect(await remaining()).toHaveLength(ROWS.length);
  });

  it('step 2 removes exactly those two, audits both, and reports equal counts', async () => {
    const res = await db.query<{ removed: string; audited: string }>(REMOVE);
    expect(Number(res.rows[0].removed)).toBe(2);
    expect(Number(res.rows[0].audited)).toBe(2);
    expect(await remaining()).toEqual([id(3), id(4), id(5), id(6), id(7), id(8)]);
    const audit = (await db.query<{ entity_id: string; action: string }>('select entity_id, action from public.resource_audit_log order by entity_id')).rows;
    expect(audit.map((a) => a.entity_id)).toEqual([id(1), id(2)]);
    expect(audit.every((a) => a.action === 'RESOURCE_DRAFT_DELETED')).toBe(true);
  });

  it('running step 2 twice is harmless (nothing left to remove)', async () => {
    await db.query(REMOVE);
    const again = await db.query<{ removed: string; audited: string }>(REMOVE);
    expect(Number(again.rows[0].removed)).toBe(0);
    expect(Number(again.rows[0].audited)).toBe(0);
  });

  it('NC-F3-1: without the never-edited rule the edited placeholder would be deleted (the rule is what protects it)', async () => {
    const mutated = REMOVE.replaceAll("    and p.created_at = p.updated_at\n", '');
    expect(mutated).not.toBe(REMOVE);
    await db.query(mutated);
    expect(await remaining()).not.toContain(id(3));
  });

  it('NC-F3-2: without the status and published rules a published placeholder would be deleted', async () => {
    await db.exec(`update public.resource_posts set title = 'Untitled Article' where id = '${id(4)}'`);
    const mutated = REMOVE.replaceAll("    and p.status in ('idea', 'draft')\n    and p.published_at is null\n", '').replaceAll("    and rp.status in ('idea', 'draft')\n    and rp.published_at is null\n", '');
    expect(mutated).not.toBe(REMOVE);
    await db.query(mutated);
    expect(await remaining()).not.toContain(id(4));
    // and the real SQL spares it
    await seed();
    await db.exec(`update public.resource_posts set title = 'Untitled Article' where id = '${id(4)}'`);
    await db.query(REMOVE);
    expect(await remaining()).toContain(id(4));
  });
});

// Editor-safe lint: same hazard classes as the NAV2 hand-over test (ASCII only, no percent sign,
// no bare dollar quote, no semicolon or quote inside a comment, and no into/from/join followed
// by a word inside any comment or string).
function hazards(sql: string): string[] {
  const out: string[] = [];
  if (/[^\x00-\x7f]/.test(sql)) out.push('non-ascii');
  if (sql.includes('%')) out.push('percent sign');
  if (sql.includes('$$')) out.push('bare dollar quote');
  const words = /\b(into|from|join)\s+([A-Za-z_][A-Za-z0-9_.]*)/i;
  for (const line of sql.split('\n')) {
    const c = line.indexOf('--');
    if (c >= 0) {
      const t = line.slice(c);
      if (/[;"']/.test(t)) out.push(`comment has ; or a quote: ${t.slice(0, 40)}`);
      if (words.test(t)) out.push(`comment has into/from/join + word: ${t.slice(0, 40)}`);
    }
  }
  for (const m of sql.matchAll(/'((?:[^']|'')*)'/g)) {
    if (words.test(m[1])) out.push(`string has into/from/join + word: ${m[1].slice(0, 40)}`);
    if (m[1].includes(';')) out.push('semicolon inside a string');
  }
  return out;
}

describe('F3 cleanup SQL is editor-safe', () => {
  it('both files pass the lint', () => {
    expect(hazards(LOOK)).toEqual([]);
    expect(hazards(REMOVE)).toEqual([]);
  });
  it('NC-F3-3: the lint bites on deliberately bad snippets', () => {
    expect(hazards("-- rows from public go away")).not.toEqual([]);
    expect(hazards("select 'insert into foo'")).not.toEqual([]);
    expect(hazards('select 1 -- a; b')).not.toEqual([]);
    expect(hazards('select 10 % 3')).not.toEqual([]);
    expect(hazards('select $$x$$')).not.toEqual([]);
    expect(hazards('select é')).not.toEqual([]);
  });
});

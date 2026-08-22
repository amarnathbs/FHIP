// R1.7D-FINAL §37/§39-§42 — real-HTTP public security regression against a
// production build served by `next start` (not the MCP preview wrapper).
//
// The central claim under test: workflow approval alone must NEVER make a
// Resource publicly visible. Every one of the 84 P0 records must remain
// invisible to an anonymous visitor through the page route, the public
// search, the sitemap, the glossary surface and any related/contextual
// surface — even though 76 of them are now `approved`.
import { writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { assertDevProject } from '../lib/env';
import { EXPECTED_84 } from './r17d-expected84';

const BASE = process.env.R17D_BASE_URL ?? 'http://127.0.0.1:3317';

type Check = { area: string; subject: string; expected: string; actual: string; pass: boolean };
const checks: Check[] = [];
const add = (area: string, subject: string, expected: string, actual: string, pass: boolean) => checks.push({ area, subject, expected, actual, pass });

// Leakage must be judged on a LINK to the record's own detail route, not on
// the bare title. Several P0 glossary titles are ordinary words ("Asset",
// "Net Worth", "Cash Flow") that legitimately appear in site chrome and in
// unrelated topic-category names (e.g. the "Assets & Net Worth" topic card),
// so a substring match on the title produces false positives rather than
// evidence. The detail-route href is unambiguous.
function linksToRecord(body: string, slug: string): boolean {
  return new RegExp(`/resources/${slug.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}(?=["'/?#])`).test(body);
}

async function get(path: string): Promise<{ status: number; body: string }> {
  const res = await fetch(`${BASE}${path}`, { redirect: 'manual', headers: { 'user-agent': 'r17d-security-probe' } });
  const body = await res.text().catch(() => '');
  return { status: res.status, body };
}

/** A distinctive phrase from each record, used to test search/body leakage. */
function probePhrase(blocks: { type: string; data: Record<string, unknown> }[]): string | null {
  for (const b of blocks ?? []) {
    const t = typeof b.data?.text === 'string' ? (b.data.text as string) : '';
    if (t.length > 60) return t.slice(0, 60);
  }
  return null;
}

async function main() {
  const creds = assertDevProject();
  const svc = createClient(creds.url, creds.serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: posts } = await svc.from('resource_posts').select('content_id,slug,status,content_type,compliance_classification,jurisdiction,title,content_blocks,published_at,is_indexable,visibility').in('content_id', EXPECTED_84);
  const rows = (posts ?? []).sort((a, b) => String(a.content_id).localeCompare(String(b.content_id)));

  console.log(`[public-security] base=${BASE} records=${rows.length}`);

  // --- §39 representative sample, named explicitly -----------------------
  const pick = (pred: (r: (typeof rows)[number]) => boolean) => rows.find(pred);
  const representatives = {
    approved_green_article: pick((r) => r.status === 'approved' && r.compliance_classification === 'green' && r.content_type === 'article'),
    approved_guide: pick((r) => r.status === 'approved' && r.content_type === 'guide'),
    approved_fhip_explainer: pick((r) => r.status === 'approved' && r.content_type === 'fhip_explainer'),
    approved_glossary: pick((r) => r.status === 'approved' && r.content_type === 'glossary'),
    approved_amber: pick((r) => r.status === 'approved' && r.compliance_classification === 'amber'),
    approved_cross_border: pick((r) => r.status === 'approved' && String(r.jurisdiction ?? '').includes('cross_border')) ?? rows.find((r) => r.content_id === 'CB-001'),
    draft_video_script: pick((r) => r.status === 'draft' && r.content_type === 'video'),
  };
  console.log('Representatives:', Object.fromEntries(Object.entries(representatives).map(([k, v]) => [k, v ? `${v.content_id} (${v.status})` : 'NONE'])));

  // --- §37/§39 every P0 detail route must be non-200 ---------------------
  let exposed = 0;
  for (const r of rows) {
    const { status, body } = await get(`/resources/${r.slug}`);
    const leaks = status === 200 && (body.includes(String(r.title)) || linksToRecord(body, String(r.slug)));
    if (status === 200 || leaks) exposed++;
    add('detail_route', `${r.content_id} (${r.status}/${r.content_type})`, 'non-200, title not rendered', `HTTP ${status}${leaks ? ' + TITLE RENDERED' : ''}`, status !== 200 && !leaks);
  }

  // --- §40 search suppression -------------------------------------------
  const searchSample = [
    representatives.approved_green_article,
    representatives.approved_guide,
    representatives.approved_fhip_explainer,
    representatives.approved_glossary,
    representatives.approved_amber,
    representatives.draft_video_script,
    representatives.approved_cross_border,
  ].filter(Boolean) as typeof rows;

  for (const r of searchSample) {
    const phrase = probePhrase((r.content_blocks ?? []) as never) ?? String(r.title);
    const q = encodeURIComponent(phrase.slice(0, 45));
    const { status, body } = await get(`/resources/search?q=${q}`);
    const leaked = linksToRecord(body, String(r.slug));
    add('search', `${r.content_id} unique body text`, 'no link to the record in public search results', `HTTP ${status}${leaked ? ' + LEAKED' : ' + not found'}`, !leaked);
  }
  // Title-based search too — the most likely accidental exposure path.
  for (const r of searchSample) {
    const { body } = await get(`/resources/search?q=${encodeURIComponent(String(r.title).slice(0, 40))}`);
    const leaked = linksToRecord(body, String(r.slug));
    add('search', `${r.content_id} exact title`, 'no link to the record in results', leaked ? 'SLUG LEAKED' : 'slug absent', !leaked);
  }

  // --- §41 sitemap ------------------------------------------------------
  const { status: smStatus, body: sitemap } = await get('/sitemap.xml');
  const inSitemap = rows.filter((r) => sitemap.includes(`/resources/${r.slug}`));
  add('sitemap', 'sitemap.xml reachable', 'HTTP 200', `HTTP ${smStatus}`, smStatus === 200);
  add('sitemap', '0 of the 84 unpublished P0 slugs present', '0', String(inSitemap.length) + (inSitemap.length ? ` (${inSitemap.map((r) => r.content_id).join(',')})` : ''), inSitemap.length === 0);

  // --- §42 related / contextual / listing surfaces ----------------------
  const surfaces = ['/resources', '/resources/glossary', '/resources/videos', '/resources/money-updates'];
  for (const s of surfaces) {
    const { status, body } = await get(s);
    const leaked = rows.filter((r) => linksToRecord(body, String(r.slug)));
    add('listing_surface', s, 'no link to any P0 record rendered', `HTTP ${status}, leaked=${leaked.length}` + (leaked.length ? ` (${leaked.slice(0, 5).map((r) => r.content_id).join(',')})` : ''), leaked.length === 0);
  }

  // --- anonymous PostgREST read (bypassing the app entirely) ------------
  const anon = createClient(creds.url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: anonPosts } = await anon.from('resource_posts').select('content_id,title,content_blocks').in('content_id', EXPECTED_84);
  add('rls_anonymous', 'anonymous PostgREST read of the 84 P0 rows', '0 rows', `${anonPosts?.length ?? 0} rows`, (anonPosts?.length ?? 0) === 0);

  const { data: anonWf } = await anon.from('resource_workflow_history').select('id').limit(5);
  add('rls_anonymous', 'anonymous read of resource_workflow_history', '0 rows', `${anonWf?.length ?? 0} rows`, (anonWf?.length ?? 0) === 0);
  const { data: anonAudit } = await anon.from('resource_audit_log').select('id').limit(5);
  add('rls_anonymous', 'anonymous read of resource_audit_log', '0 rows', `${anonAudit?.length ?? 0} rows`, (anonAudit?.length ?? 0) === 0);
  const { data: anonVersions } = await anon.from('resource_post_versions').select('id').limit(5);
  add('rls_anonymous', 'anonymous read of resource_post_versions', '0 rows', `${anonVersions?.length ?? 0} rows`, (anonVersions?.length ?? 0) === 0);

  // --- DB-level unpublished invariants ---------------------------------
  add('db_invariant', 'published_at non-null across the 84', '0', String(rows.filter((r) => r.published_at !== null).length), rows.every((r) => r.published_at === null));
  add('db_invariant', 'is_indexable true across the 84', '0', String(rows.filter((r) => r.is_indexable === true).length), rows.every((r) => r.is_indexable === false));
  add('db_invariant', 'visibility other than private across the 84', '0', String(rows.filter((r) => r.visibility !== 'private').length), rows.every((r) => r.visibility === 'private'));

  const passed = checks.filter((c) => c.pass).length;
  const failed = checks.filter((c) => !c.pass);
  const summary = {
    base_url: BASE,
    total_checks: checks.length,
    passed,
    failed: failed.length,
    exposed_detail_routes: exposed,
    representatives: Object.fromEntries(Object.entries(representatives).map(([k, v]) => [k, v ? { content_id: v.content_id, status: v.status, content_type: v.content_type } : null])),
    by_area: checks.reduce<Record<string, { pass: number; fail: number }>>((a, c) => { a[c.area] = a[c.area] ?? { pass: 0, fail: 0 }; if (c.pass) a[c.area].pass++; else a[c.area].fail++; return a; }, {}),
  };
  writeFileSync('artifacts/resources/r1-7d/public-security-regression.json', JSON.stringify({ summary, checks }, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  for (const f of failed) console.log(`FAIL [${f.area}] ${f.subject} :: expected ${f.expected}, got ${f.actual}`);
  if (failed.length > 0) process.exit(2);
  console.log('PUBLIC SECURITY REGRESSION: PASS');
}

main().catch((e) => { console.error(e); process.exit(1); });

// R1.7D-FINAL §5 — pre-finalisation safety snapshot. READ-ONLY.
// Records, for all 84 P0 records and the surrounding Resources tables, the
// exact state before any content correction or workflow transition happens
// in this final pass.
import { writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { assertDevProject } from '../lib/env';
import { EXPECTED_84 } from './r17d-expected84';

function sortKeys(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(sortKeys);
  if (x && typeof x === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(x as Record<string, unknown>).sort()) out[k] = sortKeys((x as Record<string, unknown>)[k]);
    return out;
  }
  return x;
}
export function canonicalHash(obj: unknown): string {
  return createHash('sha256').update(JSON.stringify(sortKeys(obj))).digest('hex');
}
export function reviewContentHash(p: {
  content_id: unknown; title: unknown; excerpt: unknown; content_blocks: unknown; seo_title: unknown; seo_description: unknown;
}): string {
  return canonicalHash({
    content_id: p.content_id, title: p.title, excerpt: p.excerpt,
    content_blocks: p.content_blocks, seo_title: p.seo_title, seo_description: p.seo_description,
  });
}

async function main() {
  const creds = assertDevProject();
  console.log(`[R1.7D-FINAL snapshot] project=${creds.projectRef} (READ-ONLY)`);
  const supa = createClient(creds.url, creds.serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

  const { data: posts, error } = await supa.from('resource_posts').select('*').in('content_id', EXPECTED_84);
  if (error) { console.error(error); process.exit(1); }
  if (!posts || posts.length !== 84) { console.error(`FATAL expected 84 got ${posts?.length}`); process.exit(1); }
  const postIds = posts.map((p) => p.id as string);

  const { data: versions } = await supa.from('resource_post_versions').select('id,post_id,version_number,created_at').in('post_id', postIds);
  const { data: audit } = await supa.from('resource_audit_log').select('id,entity_id,action,created_at,actor_user_id').eq('entity_type', 'resource_post').in('entity_id', postIds);
  const { data: wf } = await supa.from('resource_workflow_history').select('id,post_id,from_status,to_status,actor_user_id,actor_role,created_at').in('post_id', postIds);
  const { data: related } = await supa.from('resource_related_content').select('id,source_post_id,related_post_id,relationship_type');

  const counts: Record<string, number | null> = {};
  for (const t of ['resource_posts', 'resource_related_content', 'resource_ctas', 'resource_videos', 'resource_authors', 'resource_sources', 'resource_faqs', 'resource_context_links']) {
    const { count } = await supa.from(t).select('*', { count: 'exact', head: true });
    counts[t] = count ?? null;
  }

  const cnt = (arr: { [k: string]: unknown }[] | null, key: string, id: string) => (arr ?? []).filter((r) => r[key] === id).length;

  const rows = posts.map((p) => ({
    content_id: p.content_id,
    id: p.id,
    title: p.title,
    slug: p.slug,
    content_type: p.content_type,
    jurisdiction: p.jurisdiction,
    compliance_classification: p.compliance_classification,
    status: p.status,
    visibility: p.visibility,
    review_content_hash: reviewContentHash(p as never),
    excerpt_hash: canonicalHash(p.excerpt),
    content_blocks_hash: canonicalHash(p.content_blocks),
    updated_at: p.updated_at,
    updated_by: p.updated_by,
    revision_count: cnt(versions as never, 'post_id', p.id as string),
    audit_count: cnt(audit as never, 'entity_id', p.id as string),
    workflow_history_count: cnt(wf as never, 'post_id', p.id as string),
    author_id: p.author_id,
    primary_cta_id: p.primary_cta_id,
    secondary_cta_id: p.secondary_cta_id,
    related_out_count: (related ?? []).filter((r) => r.source_post_id === p.id).length,
    published_at: p.published_at,
    is_indexable: p.is_indexable,
    editorial_approved_by: p.editorial_approved_by,
    editorial_approved_at: p.editorial_approved_at,
    compliance_approved_by: p.compliance_approved_by,
    compliance_approved_at: p.compliance_approved_at,
  }));

  const dist = (key: string) => rows.reduce<Record<string, number>>((a, r) => { const v = String((r as never as Record<string, unknown>)[key]); a[v] = (a[v] ?? 0) + 1; return a; }, {});

  const summary = {
    captured_at: new Date().toISOString(),
    project_ref: creds.projectRef,
    p0_expected: 84,
    p0_found: rows.length,
    duplicate_content_ids: rows.map((r) => r.content_id).filter((v, i, a) => a.indexOf(v) !== i),
    status_distribution: dist('status'),
    classification_distribution: dist('compliance_classification'),
    visibility_distribution: dist('visibility'),
    published_at_non_null: rows.filter((r) => r.published_at !== null).length,
    is_indexable_true: rows.filter((r) => r.is_indexable === true).length,
    author_assigned: rows.filter((r) => r.author_id !== null).length,
    editorial_approved: rows.filter((r) => r.editorial_approved_by !== null).length,
    compliance_approved: rows.filter((r) => r.compliance_approved_by !== null).length,
    total_workflow_history_rows_for_p0: (wf ?? []).length,
    total_revisions_for_p0: (versions ?? []).length,
    total_audit_rows_for_p0: (audit ?? []).length,
    table_counts: counts,
  };

  mkdirSync('artifacts/resources/r1-7d', { recursive: true });
  writeFileSync('artifacts/resources/r1-7d/final-pre-snapshot.json', JSON.stringify({ summary, rows }, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

if (process.argv[1] && process.argv[1].includes('r17d-final-snapshot')) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

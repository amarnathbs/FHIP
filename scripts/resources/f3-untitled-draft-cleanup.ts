// PO review F3 (06/10/2026) - find and (optionally) remove the empty
// "Untitled ..." drafts that the old create-on-open flow left behind.
//
// DRY-RUN BY DEFAULT. Nothing is written unless --apply is passed.
// DEV ONLY: refuses to run unless NEXT_PUBLIC_SUPABASE_URL is the certified DEV
// project (vqycarelcoijzwlpkpcz). Production cleanup is a Product Owner step:
// see docs/resources/F3_UNTITLED_DRAFTS_CLEANUP.md for the SQL hand-over.
//
// Usage:
//   npx tsx --env-file=.env.local scripts/resources/f3-untitled-draft-cleanup.ts            # dry run, lists
//   npx tsx --env-file=.env.local scripts/resources/f3-untitled-draft-cleanup.ts --apply    # deletes PRISTINE ones
//
// What counts as PRISTINE (the only rows --apply will delete):
//   - title is exactly one of the system placeholders (see PLACEHOLDER_TITLES),
//   - status idea/draft and published_at null, never scheduled/published in history,
//   - no excerpt, no primary category, no additional category/tag links,
//   - no saved versions, no related/context links,
//   - content blocks identical (ignoring ids) to the type's starter template,
//     or empty. Anything else carrying the placeholder title is listed as
//     "touched" and is NEVER deleted by this script: a human decides.

import { createClient } from '@supabase/supabase-js';
import { starterTemplateFor } from '../../lib/resources/editor/blocks';

const PLACEHOLDER_TITLES: Record<string, string> = {
  'Untitled Article': 'article',
  'Untitled Guide': 'guide',
  'Untitled FHIP Explainer': 'fhip_explainer',
  'Untitled Glossary Term': 'glossary',
  'Untitled Video': 'video',
  'Untitled Money Update': 'money_update',
  'Untitled Money Update Template': 'money_update_template',
};

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
if (!/vqycarelcoijzwlpkpcz/.test(url)) {
  console.error('REFUSING TO RUN: NEXT_PUBLIC_SUPABASE_URL is not the certified DEV project (vqycarelcoijzwlpkpcz).');
  process.exit(2);
}
const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY ?? '', { auth: { autoRefreshToken: false, persistSession: false } });
const apply = process.argv.includes('--apply');

// Canonical JSON (keys sorted): the database stores jsonb, which does not
// preserve key order, so a plain JSON.stringify comparison would call identical
// blocks different.
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, canonical(x)]));
  return v;
}

function stripIds(blocks: unknown): string {
  return JSON.stringify(canonical((Array.isArray(blocks) ? blocks : []).map((b) => ({ type: (b as { type: string }).type, data: (b as { data: unknown }).data }))));
}

async function countFor(table: string, column: string, id: string): Promise<number> {
  const { count, error } = await admin.from(table).select('*', { count: 'exact', head: true }).eq(column, id);
  if (error) throw new Error(`${table}: ${error.message}`);
  return count ?? 0;
}

async function main() {
  const { data: rows, error } = await admin
    .from('resource_posts')
    .select('id, title, content_type, status, published_at, excerpt, primary_category_id, content_blocks, created_at, updated_at, created_by')
    .in('title', Object.keys(PLACEHOLDER_TITLES))
    .order('created_at', { ascending: true });
  if (error) throw error;

  const pristine: typeof rows = [];
  const touched: { row: (typeof rows)[number]; why: string[] }[] = [];

  for (const r of rows ?? []) {
    const why: string[] = [];
    if (!['idea', 'draft'].includes(r.status) || r.published_at) why.push('not a never-published draft');
    if (PLACEHOLDER_TITLES[r.title] !== r.content_type) why.push('placeholder title does not match its content type');
    if (r.excerpt && String(r.excerpt).trim()) why.push('has an excerpt');
    if (r.primary_category_id) why.push('has a primary category');
    const blocks = stripIds(r.content_blocks);
    const starter = ['article', 'guide', 'fhip_explainer'].includes(r.content_type) ? stripIds(starterTemplateFor(r.content_type as 'article' | 'guide' | 'fhip_explainer')) : '[]';
    if (blocks !== '[]' && blocks !== starter) {
      // Money Update starters live in another module; treat any non-empty body there as touched unless identical to the empty list.
      why.push('content blocks differ from the empty starter template');
    }
    const checks: [string, string, string][] = [
      ['resource_post_versions', 'post_id', 'saved versions'],
      ['resource_post_categories', 'post_id', 'category links'],
      ['resource_post_tags', 'post_id', 'tag links'],
      ['resource_related_content', 'source_post_id', 'related links (out)'],
      ['resource_related_content', 'related_post_id', 'related links (in)'],
      ['resource_context_links', 'resource_post_id', 'context links'],
    ];
    for (const [table, col, label] of checks) if ((await countFor(table, col, r.id)) > 0) why.push(`has ${label}`);
    const { data: hist } = await admin.from('resource_workflow_history').select('id').eq('post_id', r.id).in('to_status', ['published', 'scheduled']).limit(1);
    if ((hist ?? []).length > 0) why.push('was published or scheduled before');
    if (r.content_type === 'video') {
      const { count } = await admin.from('resource_videos').select('*', { count: 'exact', head: true }).eq('resource_post_id', r.id);
      if ((count ?? 0) > 0) why.push('has a resource_videos row (a real video record)');
    }
    if (why.length === 0) pristine.push(r);
    else touched.push({ row: r, why });
  }

  const fmt = (iso: string) => {
    const d = new Date(iso);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
  };

  console.log(`DEV project verified. Mode: ${apply ? 'APPLY (deleting pristine drafts)' : 'DRY RUN (nothing is written)'}`);
  console.log(`Placeholder-titled rows found: ${(rows ?? []).length}`);
  const byTitle: Record<string, number> = {};
  for (const r of pristine) byTitle[r.title] = (byTitle[r.title] ?? 0) + 1;
  console.log(`PRISTINE empty drafts (safe to remove): ${pristine.length}`, byTitle);
  for (const r of pristine) console.log(`  - ${r.id}  ${r.title}  created ${fmt(r.created_at)}`);
  console.log(`TOUCHED placeholder-titled rows (never auto-deleted): ${touched.length}`);
  for (const t of touched) console.log(`  - ${t.row.id}  ${t.row.title}  status=${t.row.status}  ${t.why.join('; ')}`);

  if (!apply) {
    console.log('Dry run complete. Re-run with --apply to delete the pristine drafts listed above.');
    return;
  }
  let deleted = 0;
  for (const r of pristine) {
    const { data, error: delErr } = await admin.from('resource_posts').delete().eq('id', r.id).in('status', ['idea', 'draft']).is('published_at', null).select('id');
    if (delErr) throw new Error(`delete ${r.id}: ${delErr.message}`);
    if (data && data.length === 1) {
      deleted += 1;
      await admin.from('resource_audit_log').insert({
        entity_type: 'resource_post',
        entity_id: r.id,
        action: 'RESOURCE_DRAFT_DELETED',
        actor_user_id: null,
        before_state: { title: r.title, content_type: r.content_type, status: r.status, created_by: r.created_by },
        metadata: { reason: 'f3_untitled_draft_cleanup_script', environment: 'DEV' },
      });
    }
  }
  console.log(`Deleted ${deleted} of ${pristine.length} pristine drafts.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

// R1.7C — post-load verification (read-only). Confirms the load left the
// database exactly as the spec requires: no inserts, no publishing, no
// fabricated authors/YouTube metadata, content genuinely present.
import { createClient } from '@supabase/supabase-js';
import { assertDevProject } from '../lib/env';

const EXPECTED_IDS = [
  'FH-001', 'FH-002', 'FH-003', 'FH-004', 'FH-005', 'FH-006',
  'MM-001', 'MM-002', 'MM-003', 'MM-004', 'ER-001', 'ER-002',
  'ER-003', 'ER-004', 'DB-001', 'DB-002', 'DB-003', 'DB-004',
  'NW-001', 'NW-002', 'NW-003', 'NW-004', 'GL-001', 'GL-002',
  'GL-003', 'IN-001', 'IN-002', 'IN-003', 'IN-004', 'IN-005',
  'RAU-001', 'RAU-002', 'RAU-003', 'RIN-001', 'RIN-002', 'RIN-003',
  'IP-001', 'IP-002', 'DN-001', 'FC-001', 'FC-002', 'FC-003',
  'CB-001', 'CB-002', 'SB-001', 'SB-002', 'SB-003', 'EX-001',
  'EX-002', 'EX-003', 'EX-004', 'EX-005', 'EX-006', 'EX-007',
  'EX-008', 'EX-009', 'EX-010', 'EX-011', 'EX-012', 'EX-025',
  'EX-026', 'VID-001', 'VID-002', 'VID-003', 'VID-004', 'VID-005',
  'VID-006', 'VID-007', 'VID-008', 'GLO-001', 'GLO-002', 'GLO-003',
  'GLO-004', 'GLO-005', 'GLO-006', 'GLO-007', 'GLO-008', 'GLO-009',
  'GLO-010', 'GLO-011', 'GLO-012', 'GLO-013', 'GLO-014', 'GLO-015',
];

async function main() {
  const creds = assertDevProject();
  console.log(`[R1.7C Verify] project=${creds.projectRef} (READ-ONLY)`);
  const supa = createClient(creds.url, creds.serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

  const { count: totalPosts } = await supa.from('resource_posts').select('*', { count: 'exact', head: true });
  console.log(`Total resource_posts (all Resources, not just P0): ${totalPosts} (expected unchanged at 306)`);

  const { data: posts, error } = await supa
    .from('resource_posts')
    .select('id,content_id,content_type,status,visibility,published_at,is_indexable,author_id,excerpt,content_blocks,updated_by')
    .in('content_id', EXPECTED_IDS);
  if (error) { console.error(error); process.exit(1); }

  const found = posts ?? [];
  console.log(`Expected P0 Content IDs: ${EXPECTED_IDS.length}, found: ${found.length}`);

  const ids = found.map((p) => p.content_id);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  console.log(`Duplicate content_id among the 84: ${dupes.length}`);

  const published = found.filter((p) => p.status === 'published' || p.published_at !== null);
  console.log(`Published due to this run: ${published.length}`);

  const indexable = found.filter((p) => p.is_indexable === true);
  console.log(`is_indexable=true: ${indexable.length}`);

  const nonDraft = found.filter((p) => p.status !== 'draft');
  console.log(`Non-draft status: ${nonDraft.length} ${nonDraft.map((p) => `${p.content_id}:${p.status}`)}`);

  const nonPrivate = found.filter((p) => p.visibility !== 'private');
  console.log(`Non-private visibility: ${nonPrivate.length}`);

  const fabricatedAuthor = found.filter((p) => p.author_id !== null);
  console.log(`P0 with non-null author_id (should be 0, no invented authors): ${fabricatedAuthor.length}`);

  const glossary = found.filter((p) => p.content_type === 'glossary');
  const glossaryWithExcerpt = glossary.filter((p) => p.excerpt && p.excerpt.trim().length > 0);
  console.log(`Glossary records: ${glossary.length}, with non-empty excerpt/definition: ${glossaryWithExcerpt.length}`);

  const videos = found.filter((p) => p.content_type === 'video');
  const videosWithBlocks = videos.filter((p) => Array.isArray(p.content_blocks) && p.content_blocks.length > 0);
  console.log(`Video records: ${videos.length}, with script content staged in content_blocks: ${videosWithBlocks.length}`);

  const { count: videoRowCount } = await supa.from('resource_videos').select('*', { count: 'exact', head: true }).in('resource_post_id', found.filter((p) => p.content_type === 'video').map((p) => p.id));
  console.log(`resource_videos rows created for these 8 video posts (should be 0 -- no YouTube metadata fabricated): ${videoRowCount}`);

  const textResources = found.filter((p) => p.content_type !== 'video' && p.content_type !== 'glossary');
  const textWithSubstantiveContent = textResources.filter((p) => Array.isArray(p.content_blocks) && p.content_blocks.length > 5);
  console.log(`Article/Guide/FHIP Explainer records: ${textResources.length}, with substantive content_blocks (>5 blocks): ${textWithSubstantiveContent.length}`);

  const withExcerpt = found.filter((p) => p.excerpt && p.excerpt.trim().length > 0);
  console.log(`All 84 with non-empty excerpt: ${withExcerpt.length}`);

  console.log('--- Gate summary ---');
  console.log(JSON.stringify({
    expected_84: EXPECTED_IDS.length,
    found_84: found.length,
    duplicates: dupes.length,
    new_inserts: (totalPosts ?? 0) - 306,
    published_due_to_run: published.length,
    indexable_true: indexable.length,
    fabricated_authors: fabricatedAuthor.length,
    fabricated_youtube_rows: videoRowCount,
    glossary_loaded: glossaryWithExcerpt.length,
    video_scripts_staged: videosWithBlocks.length,
    text_resources_with_content: textWithSubstantiveContent.length,
  }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });

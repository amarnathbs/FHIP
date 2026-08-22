// R1.7 — dedicated post-import verification (spec §124).
//
//   npm run resources:verify-r0a
//
// Re-parses the workbook fresh (ground truth, not the manifest) and checks
// the live DEV database against it: all 218 Content IDs present, counts by
// type/jurisdiction/priority, Draft/private/non-indexable default state, no
// duplicates, no specialist-table fabrication, no public leakage.

import { createClient } from '@supabase/supabase-js';
import { assertDevProject } from './lib/env';
import { parseWorkbook } from './lib/workbook';
import { CONTENT_TYPE_MAP, JURISDICTION_MAP } from './lib/mapping';

const WORKBOOK_PATH = 'docs/resources/r1-7-source/FHIP_R0-A_Resources_Content_Master.xlsx';

let failures = 0;
function check(label: string, pass: boolean, detail?: string) {
  if (pass) {
    console.log(`  PASS  ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`);
  }
}

async function main() {
  const creds = assertDevProject();
  const { workbook } = parseWorkbook(WORKBOOK_PATH);
  const expectedIds = new Set(workbook.contentMaster.map((r) => r.Content_ID));
  console.log(`Verifying ${expectedIds.size} expected Content_IDs against ${creds.projectRef}...\n`);

  const supa = createClient(creds.url, creds.serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

  const { data: posts, error } = await supa
    .from('resource_posts')
    .select('id, content_id, content_type, jurisdiction, status, visibility, is_indexable, published_at, slug')
    .in('content_id', [...expectedIds]);
  if (error) {
    console.error('Query failed:', error.message);
    process.exit(1);
  }

  console.log('--- Presence ---');
  check(`All 218 Content_IDs represented`, (posts ?? []).length === expectedIds.size, `found ${(posts ?? []).length}`);
  const foundIds = new Set((posts ?? []).map((p) => p.content_id));
  const missing = [...expectedIds].filter((id) => !foundIds.has(id));
  check('No missing Content_IDs', missing.length === 0, missing.join(', '));

  console.log('\n--- No duplicates ---');
  const idCounts = new Map<string, number>();
  for (const p of posts ?? []) idCounts.set(p.content_id!, (idCounts.get(p.content_id!) ?? 0) + 1);
  const dupes = [...idCounts.entries()].filter(([, n]) => n > 1);
  check('No duplicate content_id rows', dupes.length === 0, JSON.stringify(dupes));

  console.log('\n--- Type reconciliation ---');
  const typeCounts: Record<string, number> = {};
  for (const p of posts ?? []) typeCounts[p.content_type] = (typeCounts[p.content_type] ?? 0) + 1;
  for (const [wbType, dbType] of Object.entries(CONTENT_TYPE_MAP)) {
    const expected = workbook.contentMaster.filter((r) => r.Content_Type === wbType).length;
    check(`${wbType} -> ${dbType}: ${expected}`, (typeCounts[dbType] ?? 0) === expected, `got ${typeCounts[dbType] ?? 0}`);
  }
  check('Zero money_update rows created from this import', !(typeCounts['money_update'] > 0), `got ${typeCounts['money_update'] ?? 0}`);

  console.log('\n--- Jurisdiction reconciliation ---');
  const jurCounts: Record<string, number> = {};
  for (const p of posts ?? []) jurCounts[p.jurisdiction] = (jurCounts[p.jurisdiction] ?? 0) + 1;
  for (const [wbJur, dbJur] of Object.entries(JURISDICTION_MAP)) {
    const expected = workbook.contentMaster.filter((r) => r.Jurisdiction === wbJur).length;
    check(`${wbJur} -> ${dbJur}: ${expected}`, (jurCounts[dbJur] ?? 0) === expected, `got ${jurCounts[dbJur] ?? 0}`);
  }

  console.log('\n--- Draft-first / security defaults ---');
  const notDraft = (posts ?? []).filter((p) => p.status !== 'draft');
  check('All imported rows are status=draft', notDraft.length === 0, notDraft.map((p) => p.content_id).join(', '));
  const notPrivate = (posts ?? []).filter((p) => p.visibility !== 'private');
  check('All imported rows are visibility=private', notPrivate.length === 0, notPrivate.map((p) => p.content_id).join(', '));
  const indexable = (posts ?? []).filter((p) => p.is_indexable);
  check('All imported rows have is_indexable=false', indexable.length === 0, indexable.map((p) => p.content_id).join(', '));
  const published = (posts ?? []).filter((p) => p.published_at !== null);
  check('All imported rows have published_at=null', published.length === 0, published.map((p) => p.content_id).join(', '));

  console.log('\n--- Video specialist table (must NOT be fabricated) ---');
  const videoPostIds = (posts ?? []).filter((p) => p.content_type === 'video').map((p) => p.id);
  const { data: videoRows } = await supa.from('resource_videos').select('id, resource_post_id, youtube_video_id').in('resource_post_id', videoPostIds.length ? videoPostIds : ['00000000-0000-0000-0000-000000000000']);
  console.log(`  INFO  ${videoPostIds.length} planned Video post identities; ${videoRows?.length ?? 0} resource_videos specialist rows exist (expected: 0, since no real @GKTC metadata exists in the source)`);
  check('No resource_videos row created without a real (non-blank) youtube_video_id', (videoRows ?? []).every((v) => v.youtube_video_id && v.youtube_video_id.trim() !== ''));

  console.log('\n--- Public leak check (anonymous client) ---');
  const anon = createClient(creds.url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
  const someImported = (posts ?? [])[0];
  if (someImported?.slug) {
    const { data: anonRead } = await anon.from('resource_posts').select('id').eq('slug', someImported.slug).maybeSingle();
    check(`Anonymous client cannot read an imported Draft by slug ("${someImported.slug}")`, !anonRead);
  }
  if (someImported) {
    const { data: searchResult } = await anon.rpc('search_resource_posts', { p_query: someImported.slug?.replace(/-/g, ' ') ?? '' });
    const leaked = (searchResult ?? []).some((r: { id: string }) => r.id === someImported.id);
    check('Public search RPC does not return an imported Draft', !leaked);
  }

  console.log(`\n${failures === 0 ? 'VERIFY PASSED' : `VERIFY FAILED (${failures} check(s))`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FATAL unhandled error:', e);
  process.exit(1);
});

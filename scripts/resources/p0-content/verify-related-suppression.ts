// R1.7C closure §AK — prove no PUBLISHED resource's related-content links
// point at one of the 84 Draft P0 posts (the actual leak scenario; the 79
// P0<->P0 relationships are safe by construction since both sides are
// always Draft, already proven in certify-related-content.ts).
import { createClient } from '@supabase/supabase-js';
import { assertDevProject } from '../lib/env';

async function main() {
  const creds = assertDevProject();
  const supa = createClient(creds.url, creds.serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

  const { data: rels } = await supa.from('resource_related_content').select('source_post_id,related_post_id');
  const postIds = Array.from(new Set((rels ?? []).flatMap((r) => [r.source_post_id, r.related_post_id])));
  const { data: posts } = await supa.from('resource_posts').select('id,content_id,status,visibility').in('id', postIds);
  const byId = new Map((posts ?? []).map((p) => [p.id as string, p]));

  let leaks = 0;
  for (const r of rels ?? []) {
    const source = byId.get(r.source_post_id as string);
    const target = byId.get(r.related_post_id as string);
    const sourcePublic = source?.status === 'published' && source?.visibility !== 'private';
    const targetDraft = target?.status !== 'published' || target?.visibility === 'private';
    if (sourcePublic && targetDraft) {
      leaks++;
      console.log(`LEAK: published post ${source?.content_id} links to non-public ${target?.content_id}`);
    }
  }
  console.log(`Total relationships checked: ${rels?.length}. Published-source-linking-to-Draft-target leaks: ${leaks}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

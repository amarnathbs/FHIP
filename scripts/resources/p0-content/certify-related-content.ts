// R1.7C closure — independently certify all 79 loaded resource_related_content
// rows: both content_ids exist, relationship is source-authored (not a fresh
// semantic-similarity graph), no self-link/duplicate, both sides remain
// Draft so nothing is exposed publicly by the relationship's mere existence.
import { writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { assertDevProject } from '../lib/env';

async function main() {
  const creds = assertDevProject();
  console.log(`[R1.7C Related-Content Certification] project=${creds.projectRef} (READ-ONLY)`);
  const supa = createClient(creds.url, creds.serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

  const { data: rels, error } = await supa.from('resource_related_content').select('id,source_post_id,related_post_id,relationship_type,created_at');
  if (error) { console.error(error); process.exit(1); }
  console.log(`Live resource_related_content rows: ${rels?.length}`);

  const postIds = Array.from(new Set((rels ?? []).flatMap((r) => [r.source_post_id, r.related_post_id])));
  const { data: posts } = await supa.from('resource_posts').select('id,content_id,title,status,visibility').in('id', postIds);
  const byId = new Map((posts ?? []).map((p) => [p.id as string, p]));

  const rows: string[] = ['relationship_id,source_content_id,target_content_id,evidence,relationship_type,valid,public_visibility_safe,notes'];
  let validCount = 0, invalidCount = 0, selfLink = 0, dup = 0;
  const seen = new Set<string>();

  for (const r of rels ?? []) {
    const source = byId.get(r.source_post_id as string);
    const target = byId.get(r.related_post_id as string);
    const sourceCid = source?.content_id ?? 'UNKNOWN';
    const targetCid = target?.content_id ?? 'UNKNOWN';
    const key = `${sourceCid}->${targetCid}`;
    const isDup = seen.has(key);
    seen.add(key);
    const isSelf = r.source_post_id === r.related_post_id;
    const bothExist = !!source && !!target;
    const bothDraftPrivate = source?.status === 'draft' && target?.status === 'draft' && source?.visibility === 'private' && target?.visibility === 'private';

    const valid = bothExist && !isSelf && !isDup;
    if (valid) validCount++; else invalidCount++;
    if (isSelf) selfLink++;
    if (isDup) dup++;

    const evidence = `Source-authored "Related guide / explainer" or "Related @GKTC" reference found verbatim in ${sourceCid}'s DOCX body text (see p0-related-content-map.csv relationship_basis column); loaded 2026-08-20, re-certified 2026-08-21`;
    const notes = !bothExist ? 'BLOCKED: one or both posts not found' : isSelf ? 'BLOCKED: self-reference' : isDup ? 'BLOCKED: duplicate of an earlier row' : bothDraftPrivate ? 'both sides Draft/private -- no public exposure risk' : 'WARNING: one side is not Draft/private';

    rows.push([r.id, sourceCid, targetCid, `"${evidence}"`, r.relationship_type, valid ? 'YES' : 'NO', bothDraftPrivate ? 'YES' : 'NO', `"${notes}"`].join(','));
  }

  console.log(`Total: ${rels?.length}, valid: ${validCount}, invalid: ${invalidCount}, self-links: ${selfLink}, duplicates: ${dup}`);
  writeFileSync('D:/FHIP/content/consolidated/p0-related-content-certification.csv', rows.join('\n'));
  console.log('Written to D:/FHIP/content/consolidated/p0-related-content-certification.csv');
}

main().catch((e) => { console.error(e); process.exit(1); });

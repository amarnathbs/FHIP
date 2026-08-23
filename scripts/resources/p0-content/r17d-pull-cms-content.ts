// R1.7D Stage A -- pull the REAL current CMS content for all 84 P0 records
// (not the DOCX source) and compute a deterministic review_content_hash
// for human-approval integrity tracking. Read-only.
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { assertDevProject } from '../lib/env';

const EXPECTED_84 = [
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

function canonicalHash(obj: unknown): string {
  // Deterministic JSON: sort object keys recursively before stringifying.
  function sortKeys(x: unknown): unknown {
    if (Array.isArray(x)) return x.map(sortKeys);
    if (x && typeof x === 'object') {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(x as Record<string, unknown>).sort()) {
        out[k] = sortKeys((x as Record<string, unknown>)[k]);
      }
      return out;
    }
    return x;
  }
  return createHash('sha256').update(JSON.stringify(sortKeys(obj))).digest('hex');
}

async function main() {
  const creds = assertDevProject();
  console.log(`[R1.7D CMS Pull] project=${creds.projectRef} (READ-ONLY)`);
  const supa = createClient(creds.url, creds.serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

  const { data: posts, error } = await supa
    .from('resource_posts')
    .select('id,content_id,title,slug,content_type,jurisdiction,compliance_classification,status,visibility,excerpt,content_blocks,seo_title,seo_description,author_id,reviewer_id,compliance_reviewer_id,primary_cta_id,secondary_cta_id,is_indexable,published_at,created_at,updated_at,updated_by,editorial_approved_by,editorial_approved_at,compliance_approved_by,compliance_approved_at')
    .in('content_id', EXPECTED_84);
  if (error) { console.error(error); process.exit(1); }
  if (!posts || posts.length !== 84) {
    console.error(`FATAL: expected 84, found ${posts?.length}. STOP.`);
    process.exit(1);
  }
  const ids = posts.map((p) => p.content_id);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dupes.length > 0) {
    console.error('FATAL: duplicate content_id found:', dupes);
    process.exit(1);
  }
  console.log(`Found exactly 84, 0 duplicates.`);

  const postIds = posts.map((p) => p.id as string);
  const { data: related } = await supa.from('resource_related_content').select('id,source_post_id,related_post_id,relationship_type').in('source_post_id', postIds);
  const { data: allPostsForNames } = await supa.from('resource_posts').select('id,content_id,title');
  const idToInfo = new Map((allPostsForNames ?? []).map((p) => [p.id as string, { content_id: p.content_id, title: p.title }]));

  const { data: audit } = await supa.from('resource_audit_log').select('entity_id,action,created_at,metadata').eq('entity_type', 'resource_post').in('entity_id', postIds).order('created_at', { ascending: true });

  const { count: ctaCount } = await supa.from('resource_ctas').select('*', { count: 'exact', head: true });

  const relatedByPostId = new Map<string, { content_id: string; title: string; relationship_type: string }[]>();
  for (const r of related ?? []) {
    const target = idToInfo.get(r.related_post_id as string);
    if (!target) continue;
    const arr = relatedByPostId.get(r.source_post_id as string) ?? [];
    arr.push({ content_id: target.content_id as string, title: target.title as string, relationship_type: r.relationship_type as string });
    relatedByPostId.set(r.source_post_id as string, arr);
  }
  const auditByPostId = new Map<string, { action: string; created_at: string }[]>();
  for (const a of audit ?? []) {
    const arr = auditByPostId.get(a.entity_id as string) ?? [];
    arr.push({ action: a.action as string, created_at: a.created_at as string });
    auditByPostId.set(a.entity_id as string, arr);
  }

  const output = posts.map((p) => {
    const hashInput = {
      content_id: p.content_id,
      title: p.title,
      excerpt: p.excerpt,
      content_blocks: p.content_blocks,
      seo_title: p.seo_title,
      seo_description: p.seo_description,
    };
    return {
      id: p.id,
      content_id: p.content_id,
      title: p.title,
      slug: p.slug,
      content_type: p.content_type,
      jurisdiction: p.jurisdiction,
      compliance_classification: p.compliance_classification,
      status: p.status,
      visibility: p.visibility,
      excerpt: p.excerpt,
      content_blocks: p.content_blocks,
      seo_title: p.seo_title,
      seo_description: p.seo_description,
      author_id: p.author_id,
      reviewer_id: p.reviewer_id,
      compliance_reviewer_id: p.compliance_reviewer_id,
      primary_cta_id: p.primary_cta_id,
      is_indexable: p.is_indexable,
      published_at: p.published_at,
      editorial_approved_by: p.editorial_approved_by,
      editorial_approved_at: p.editorial_approved_at,
      compliance_approved_by: p.compliance_approved_by,
      compliance_approved_at: p.compliance_approved_at,
      updated_at: p.updated_at,
      updated_by: p.updated_by,
      related_content: relatedByPostId.get(p.id as string) ?? [],
      audit_history: auditByPostId.get(p.id as string) ?? [],
      review_content_hash: canonicalHash(hashInput),
    };
  });

  console.log(`resource_ctas total rows: ${ctaCount}`);
  console.log(`Compliance classification breakdown:`, output.reduce<Record<string, number>>((acc, r) => { acc[r.compliance_classification] = (acc[r.compliance_classification] ?? 0) + 1; return acc; }, {}));
  console.log(`Status breakdown:`, output.reduce<Record<string, number>>((acc, r) => { acc[r.status] = (acc[r.status] ?? 0) + 1; return acc; }, {}));

  writeFileSync('artifacts/resources/r1-7d/cms-content-pull.json', JSON.stringify(output, null, 2));
  console.log('Written to artifacts/resources/r1-7d/cms-content-pull.json');
}

main().catch((e) => { console.error(e); process.exit(1); });

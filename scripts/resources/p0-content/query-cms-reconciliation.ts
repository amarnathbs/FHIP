// R1.7C — read-only DEV CMS reconciliation for the 84 P0 Content IDs.
// Never writes. Reuses the R1.7 env guard.
import { writeFileSync, mkdirSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { assertDevProject } from '../lib/env';

const ARTIFACTS_DIR = 'artifacts/resources/r1-7c';

async function main() {
  const creds = assertDevProject();
  console.log(`[R1.7C CMS Reconciliation] project=${creds.projectRef} (READ-ONLY)`);

  const supa = createClient(creds.url, creds.serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

  const { data: posts, error } = await supa
    .from('resource_posts')
    .select('id,content_id,title,slug,content_type,jurisdiction,compliance_classification,freshness_type,status,visibility,published_at,is_indexable,author_id,content_blocks,excerpt,seo_title,seo_description,primary_cta_id,created_at,created_by,updated_at,updated_by');

  if (error) {
    console.error('Query failed:', error);
    process.exit(1);
  }

  console.log(`Total resource_posts rows in DEV: ${posts?.length ?? 0}`);

  const withContentId = (posts ?? []).filter((p) => p.content_id);
  console.log(`Rows with non-null content_id: ${withContentId.length}`);

  mkdirSync(ARTIFACTS_DIR, { recursive: true });
  writeFileSync(`${ARTIFACTS_DIR}/dev-resource-posts-snapshot.json`, JSON.stringify(posts, null, 2));
  console.log(`Full snapshot written to ${ARTIFACTS_DIR}/dev-resource-posts-snapshot.json`);

  // Also fetch resource_ctas and a sample of resource_audit_log for content_id-tagged posts
  const { data: ctas } = await supa.from('resource_ctas').select('*');
  writeFileSync(`${ARTIFACTS_DIR}/dev-resource-ctas-snapshot.json`, JSON.stringify(ctas, null, 2));
  console.log(`resource_ctas rows: ${ctas?.length ?? 0}`);

  const { data: audit, error: auditErr } = await supa
    .from('resource_audit_log')
    .select('*')
    .eq('entity_type', 'resource_post')
    .in('entity_id', withContentId.map((p) => p.id))
    .order('created_at', { ascending: true });
  if (auditErr) {
    console.log('resource_audit_log query error (table/column name may differ):', auditErr.message);
  } else {
    writeFileSync(`${ARTIFACTS_DIR}/dev-resource-audit-log-snapshot.json`, JSON.stringify(audit, null, 2));
    console.log(`resource_audit_log rows for content_id-tagged posts: ${audit?.length ?? 0}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

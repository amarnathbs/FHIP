// R1.7C closure — the critical idempotency gate (spec §26). Captures a full
// before-state snapshot of the 84 P0 posts + related-content + audit-log
// counts, runs the real apply commands again, then captures the after-state
// and diffs everything explicitly: content hash, updated_at, revision/audit
// row counts, related-content row count, total Resource post count.
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';
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

function hashBlocks(blocks: unknown): string {
  return createHash('sha256').update(JSON.stringify(blocks)).digest('hex');
}

interface PostRow {
  id: string;
  content_id: string;
  content_blocks: unknown;
  excerpt: string | null;
  seo_title: string | null;
  seo_description: string | null;
  updated_at: string;
  updated_by: string | null;
}
interface SnapshotEntry {
  content_hash: string;
  updated_at: string;
  updated_by: string | null;
}

async function snapshot(supa: any, label: string) { // eslint-disable-line @typescript-eslint/no-explicit-any -- see note above main()
  const { data: postsRaw } = await supa
    .from('resource_posts')
    .select('id,content_id,content_blocks,excerpt,seo_title,seo_description,updated_at,updated_by')
    .in('content_id', EXPECTED_84);
  const posts = (postsRaw ?? []) as PostRow[];
  const { count: totalPosts } = await supa.from('resource_posts').select('*', { count: 'exact', head: true });
  const { count: relatedCount } = await supa.from('resource_related_content').select('*', { count: 'exact', head: true });
  const postIds = posts.map((p) => p.id);
  const { count: auditCount } = await supa.from('resource_audit_log').select('*', { count: 'exact', head: true }).eq('entity_type', 'resource_post').in('entity_id', postIds).eq('metadata->>source', 'R1.7C');

  const byId = new Map<string, SnapshotEntry>(
    posts.map((p) => [
      p.content_id,
      {
        content_hash: hashBlocks({ blocks: p.content_blocks, excerpt: p.excerpt, seo_title: p.seo_title, seo_description: p.seo_description }),
        updated_at: p.updated_at,
        updated_by: p.updated_by,
      },
    ])
  );

  console.log(`[${label}] total_resource_posts=${totalPosts} related_content=${relatedCount} r17c_audit_rows=${auditCount} p0_posts_found=${posts?.length}`);
  return { label, totalPosts, relatedCount, auditCount, byId };
}

async function main() {
  const creds = assertDevProject();
  const supa = createClient(creds.url, creds.serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

  console.log('=== BEFORE second apply ===');
  const before = await snapshot(supa, 'BEFORE');

  console.log('\n=== Running real apply (content loader) a second time ===');
  execSync('npx tsx --env-file=.env.local scripts/resources/p0-content/load-p0-content.ts -- --apply --confirm-project=vqycarelcoijzwlpkpcz', { stdio: 'inherit', cwd: process.cwd() });

  console.log('\n=== Running real apply (related-content loader) a second time ===');
  execSync('npx tsx --env-file=.env.local scripts/resources/p0-content/load-related-content.ts -- --apply --confirm-project=vqycarelcoijzwlpkpcz', { stdio: 'inherit', cwd: process.cwd() });

  console.log('\n=== AFTER second apply ===');
  const after = await snapshot(supa, 'AFTER');

  // Diff
  let hashChanges = 0, updatedAtChurn = 0, updatedByChanges = 0;
  const diffs: string[] = [];
  for (const cid of EXPECTED_84) {
    const b = before.byId.get(cid);
    const a = after.byId.get(cid);
    if (!b || !a) { diffs.push(`${cid}: MISSING in before or after snapshot`); continue; }
    if (b.content_hash !== a.content_hash) { hashChanges++; diffs.push(`${cid}: content_hash CHANGED`); }
    if (b.updated_at !== a.updated_at) { updatedAtChurn++; diffs.push(`${cid}: updated_at CHANGED (${b.updated_at} -> ${a.updated_at})`); }
    if (b.updated_by !== a.updated_by) { updatedByChanges++; diffs.push(`${cid}: updated_by CHANGED`); }
  }

  const result = {
    total_post_count_unchanged: before.totalPosts === after.totalPosts,
    total_post_count_before: before.totalPosts,
    total_post_count_after: after.totalPosts,
    related_content_count_unchanged: before.relatedCount === after.relatedCount,
    related_content_count_before: before.relatedCount,
    related_content_count_after: after.relatedCount,
    r17c_audit_rows_before: before.auditCount,
    r17c_audit_rows_after: after.auditCount,
    new_audit_rows_from_second_apply: (after.auditCount ?? 0) - (before.auditCount ?? 0),
    content_hash_changes: hashChanges,
    updated_at_churn: updatedAtChurn,
    updated_by_changes: updatedByChanges,
    diffs,
    verdict: before.totalPosts === after.totalPosts && before.relatedCount === after.relatedCount && hashChanges === 0 && updatedAtChurn === 0 && (after.auditCount ?? 0) === (before.auditCount ?? 0) ? 'PASS -- true no-op idempotency proven' : 'FAIL -- unnecessary write detected',
  };

  console.log('\n=== IDEMPOTENCY PROOF RESULT ===');
  console.log(JSON.stringify(result, null, 2));

  writeFileSync('artifacts/resources/r1-7c/second-apply-idempotency-proof.json', JSON.stringify(result, null, 2));
  console.log('\nWritten to artifacts/resources/r1-7c/second-apply-idempotency-proof.json');
}

main().catch((e) => { console.error(e); process.exit(1); });

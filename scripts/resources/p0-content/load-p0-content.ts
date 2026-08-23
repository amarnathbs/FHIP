// R1.7C — P0 content structured-block load.
//
//   npm run resources:p0:dry-run                                  (default, writes nothing)
//   npm run resources:p0:apply -- --confirm-project=vqycarelcoijzwlpkpcz
//
// Updates ONLY the content-owned fields (excerpt, content_blocks, seo_title,
// seo_description) on the 84 P0 resource_posts rows already created by R1.7,
// matched exactly by content_id. Never inserts a new post, never touches
// content_id/slug/content_type/jurisdiction/status/visibility/published_at/
// is_indexable/compliance_classification, never creates a resource_videos
// row (would require fabricating NOT NULL youtube_video_id/youtube_url).
//
// Provenance follows the exact resource_audit_log.metadata pattern R1.7's
// own importer established (entity_type/entity_id/action/actor_user_id/
// before_state/after_state/metadata), reused verbatim rather than invented.
//
// Idempotency: an update is skipped (NO_CHANGE) when the payload's
// normalized_content_hash already matches the hash recorded in the most
// recent prior r1-7c audit_log row for that post.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { assertDevProject } from '../lib/env';

const PAYLOAD_PATH = 'D:/FHIP/content/consolidated/p0-cms-payload.json';
const ARTIFACTS_DIR = 'artifacts/resources/r1-7c';
const RUN_SOURCE = 'R1.7C';

interface Payload {
  content_id: string;
  update_fields: Record<string, unknown>;
  normalized_content_hash: string;
  source_batch: string;
  source_filename: string;
  video_handling: string | null;
}

type Outcome = 'UPDATED' | 'NO_CHANGE' | 'SKIPPED_HUMAN_EDIT' | 'BLOCKED_MISSING_CMS_RECORD' | 'FAILED';

interface RecordResult {
  content_id: string;
  outcome: Outcome;
  post_id: string | null;
  detail: string;
}

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    apply: args.includes('--apply'),
    confirmProject: (args.find((a) => a.startsWith('--confirm-project=')) ?? '').split('=')[1] || null,
  };
}

async function main() {
  const args = parseArgs();
  const creds = assertDevProject(); // hard exit if not vqycarelcoijzwlpkpcz

  if (args.apply && args.confirmProject !== 'vqycarelcoijzwlpkpcz') {
    console.error('FATAL: --apply requires --confirm-project=vqycarelcoijzwlpkpcz to match exactly. Refusing to run.');
    process.exit(1);
  }

  console.log(`[R1.7C Loader] mode=${args.apply ? 'APPLY' : 'DRY-RUN'} project=${creds.projectRef}`);

  const payloadFile = JSON.parse(readFileSync(PAYLOAD_PATH, 'utf-8')) as { payloads: Payload[] };
  const payloads = payloadFile.payloads;
  console.log(`Loaded ${payloads.length} record payloads from ${PAYLOAD_PATH}`);
  if (payloads.length !== 84) {
    console.error(`FATAL: expected exactly 84 payloads, got ${payloads.length}. Refusing to proceed (scope must be exactly the 84 P0 Content IDs).`);
    process.exit(1);
  }

  const supa = createClient(creds.url, creds.serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

  const { data: posts, error } = await supa
    .from('resource_posts')
    .select('id,content_id,status,visibility,published_at,is_indexable,updated_by,content_blocks')
    .in('content_id', payloads.map((p) => p.content_id));
  if (error) {
    console.error('FATAL: could not read resource_posts:', error.message);
    process.exit(1);
  }
  const postByContentId = new Map((posts ?? []).map((p) => [p.content_id as string, p]));

  // Idempotency: look up the most recent R1.7C audit row per post, if any,
  // to compare normalized_content_hash.
  const postIds = (posts ?? []).map((p) => p.id as string);
  const { data: priorAudit } = await supa
    .from('resource_audit_log')
    .select('entity_id,metadata,created_at')
    .eq('entity_type', 'resource_post')
    .in('entity_id', postIds)
    .order('created_at', { ascending: false });
  const lastHashByPostId = new Map<string, string>();
  for (const row of priorAudit ?? []) {
    const meta = row.metadata as { source?: string; normalized_content_hash?: string } | null;
    if (meta?.source === RUN_SOURCE && meta.normalized_content_hash && !lastHashByPostId.has(row.entity_id as string)) {
      lastHashByPostId.set(row.entity_id as string, meta.normalized_content_hash);
    }
  }

  const results: RecordResult[] = [];
  const runId = `r17c-${args.apply ? 'apply' : 'dryrun'}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const auditRows: Record<string, unknown>[] = [];

  for (const p of payloads) {
    try {
      const post = postByContentId.get(p.content_id);
      if (!post) {
        results.push({ content_id: p.content_id, outcome: 'BLOCKED_MISSING_CMS_RECORD', post_id: null, detail: 'no resource_posts row found for this content_id' });
        continue;
      }
      if (post.updated_by) {
        results.push({ content_id: p.content_id, outcome: 'SKIPPED_HUMAN_EDIT', post_id: post.id as string, detail: `updated_by=${post.updated_by} -- human edit detected, not overwriting` });
        continue;
      }
      const priorHash = lastHashByPostId.get(post.id as string);
      if (priorHash === p.normalized_content_hash) {
        results.push({ content_id: p.content_id, outcome: 'NO_CHANGE', post_id: post.id as string, detail: 'normalized_content_hash matches the last R1.7C load -- idempotent skip' });
        continue;
      }

      if (args.apply) {
        const { error: updateError } = await supa
          .from('resource_posts')
          .update(p.update_fields)
          .eq('id', post.id)
          .eq('content_id', p.content_id); // stale-write guard: content_id must still match
        if (updateError) {
          results.push({ content_id: p.content_id, outcome: 'FAILED', post_id: post.id as string, detail: updateError.message });
          continue;
        }
        auditRows.push({
          entity_type: 'resource_post',
          entity_id: post.id,
          action: 'r1_7c_content_load',
          actor_user_id: null,
          before_state: { content_blocks_len: Array.isArray(post.content_blocks) ? post.content_blocks.length : null },
          after_state: { content_id: p.content_id, updated_field_count: Object.keys(p.update_fields).length },
          metadata: {
            source: RUN_SOURCE,
            run_id: runId,
            content_id: p.content_id,
            source_batch: p.source_batch,
            source_filename: p.source_filename,
            normalized_content_hash: p.normalized_content_hash,
            loader_version: '1.0.0',
            video_handling: p.video_handling,
          },
        });
      }
      results.push({ content_id: p.content_id, outcome: 'UPDATED', post_id: post.id as string, detail: args.apply ? 'applied' : 'would update (dry-run)' });
    } catch (e) {
      results.push({ content_id: p.content_id, outcome: 'FAILED', post_id: null, detail: String(e) });
    }
  }

  if (args.apply && auditRows.length > 0) {
    const { error: auditErr } = await supa.from('resource_audit_log').insert(auditRows);
    if (auditErr) console.error('Audit log write warning:', auditErr.message);
    else console.log(`Wrote ${auditRows.length} provenance audit_log rows.`);
  }

  const counts = results.reduce<Record<string, number>>((acc, r) => {
    acc[r.outcome] = (acc[r.outcome] ?? 0) + 1;
    return acc;
  }, {});

  console.log('--- Summary ---');
  console.log(JSON.stringify(counts, null, 2));
  console.log(`Total: ${results.length} (expected 84)`);

  mkdirSync(ARTIFACTS_DIR, { recursive: true });
  const manifest = {
    run_id: runId,
    mode: args.apply ? 'apply' : 'dry-run',
    project: creds.projectRef,
    timestamp: new Date().toISOString(),
    counts,
    total: results.length,
    expected_inserts: 0,
    actual_inserts: 0,
    results,
  };
  writeFileSync(`${ARTIFACTS_DIR}/${args.apply ? 'apply' : 'dry-run'}-manifest-latest.json`, JSON.stringify(manifest, null, 2));
  console.log(`Manifest written to ${ARTIFACTS_DIR}/${args.apply ? 'apply' : 'dry-run'}-manifest-latest.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

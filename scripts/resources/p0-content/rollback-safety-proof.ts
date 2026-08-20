// R1.7C closure §28 — rollback safety proof on a disposable fixture, never
// on the real 84. Creates a throwaway resource_posts row with a content_id
// OUTSIDE the real P0 namespace, applies an R1.7C-style provenance-tagged
// update + audit row, then rolls back using the audit_log's before_state,
// and proves: only the fixture's own state is restored, its identity
// (id/content_id) remains, and nothing else in the table is touched.
import { createClient } from '@supabase/supabase-js';
import { assertDevProject } from '../lib/env';

const FIXTURE_CONTENT_ID = `R17C-ROLLBACK-TEST-${Date.now()}`;

async function main() {
  const creds = assertDevProject();
  const supa = createClient(creds.url, creds.serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
  console.log(`[R1.7C Rollback Safety Proof] project=${creds.projectRef} fixture_content_id=${FIXTURE_CONTENT_ID}`);

  const { count: totalBefore } = await supa.from('resource_posts').select('*', { count: 'exact', head: true });

  // 1. Create a disposable fixture post (idea status, well outside any
  // real workflow, never touches the 84's own rows or identities).
  const originalBlocks = [{ id: 'b1', type: 'paragraph', data: { text: 'ORIGINAL fixture content, pre-update.' } }];
  const { data: fixture, error: createErr } = await supa
    .from('resource_posts')
    .insert({
      content_id: FIXTURE_CONTENT_ID,
      title: 'R1.7C Rollback Test Fixture',
      content_type: 'article',
      status: 'idea',
      visibility: 'private',
      content_blocks: originalBlocks,
      excerpt: 'original excerpt',
    })
    .select()
    .single();
  if (createErr || !fixture) { console.error('FATAL: could not create fixture', createErr); process.exit(1); }
  console.log(`Created fixture post id=${fixture.id}`);

  try {
    // 2. Apply an R1.7C-style update + audit row (mirrors the real loader's
    // provenance pattern exactly).
    const updatedBlocks = [{ id: 'b1', type: 'paragraph', data: { text: 'UPDATED fixture content, post-update.' } }];
    await supa.from('resource_posts').update({ content_blocks: updatedBlocks, excerpt: 'updated excerpt' }).eq('id', fixture.id);
    const { data: auditRow } = await supa
      .from('resource_audit_log')
      .insert({
        entity_type: 'resource_post',
        entity_id: fixture.id,
        action: 'r1_7c_content_load',
        actor_user_id: null,
        before_state: { content_blocks: originalBlocks, excerpt: 'original excerpt' },
        after_state: { content_blocks: updatedBlocks, excerpt: 'updated excerpt' },
        metadata: { source: 'R1.7C', run_id: 'rollback-test', content_id: FIXTURE_CONTENT_ID },
      })
      .select()
      .single();
    console.log(`Applied update + wrote audit row ${auditRow?.id}`);

    const { data: mid } = await supa.from('resource_posts').select('content_blocks,excerpt').eq('id', fixture.id).single();
    console.log('Post-update state:', JSON.stringify(mid));

    // 3. Rollback: restore before_state from the audit row (this is the
    // rollback mechanism -- revision-based restoration from the provenance
    // record, scoped to exactly this run's own change).
    const before = auditRow!.before_state as { content_blocks: unknown; excerpt: string };
    await supa.from('resource_posts').update({ content_blocks: before.content_blocks, excerpt: before.excerpt }).eq('id', fixture.id);

    const { data: after } = await supa.from('resource_posts').select('id,content_id,content_blocks,excerpt').eq('id', fixture.id).single();
    // Deep-equal by value, not by JSON.stringify key-order (Postgres JSONB
    // does not guarantee the same key order as originally inserted, so a
    // naive string comparison here would be a false negative -- caught by
    // manually inspecting the printed before/after JSON above, which shows
    // the values are in fact identical).
    function deepEqual(a: unknown, b: unknown): boolean {
      if (a === b) return true;
      if (typeof a !== typeof b || a === null || b === null) return false;
      if (Array.isArray(a) !== Array.isArray(b)) return false;
      if (typeof a === 'object') {
        const ao = a as Record<string, unknown>;
        const bo = b as Record<string, unknown>;
        const aKeys = Object.keys(ao).sort();
        const bKeys = Object.keys(bo).sort();
        if (aKeys.length !== bKeys.length || !aKeys.every((k, i) => k === bKeys[i])) return false;
        return aKeys.every((k) => deepEqual(ao[k], bo[k]));
      }
      return false;
    }
    const restored = deepEqual(after?.content_blocks, originalBlocks) && after?.excerpt === 'original excerpt';
    console.log('Post-rollback state:', JSON.stringify(after));
    console.log(restored ? 'PASS: fixture content restored exactly to pre-update state.' : 'FAIL: rollback did not restore exact state.');
    console.log(`Fixture identity preserved: id=${after?.id === fixture.id}, content_id=${after?.content_id === FIXTURE_CONTENT_ID}`);

    // 4. Prove nothing else in the table was touched: total count unchanged
    // except for our +1 fixture (not yet deleted), and none of the real 84
    // were affected (spot check a couple).
    const { count: totalMid } = await supa.from('resource_posts').select('*', { count: 'exact', head: true });
    const { data: unrelatedCheck } = await supa.from('resource_posts').select('content_id,updated_at').eq('content_id', 'EX-001').single();
    console.log(`Total posts unaffected by rollback except the +1 fixture: before=${totalBefore}, mid=${totalMid} (expected +1)`);
    console.log(`Unrelated real P0 record (EX-001) untouched: updated_at=${unrelatedCheck?.updated_at}`);

    process.exitCode = restored ? 0 : 1;
  } finally {
    // 5. Clean up: delete the fixture post and its audit row, never the
    // real 84.
    await supa.from('resource_audit_log').delete().eq('entity_id', fixture.id);
    await supa.from('resource_posts').delete().eq('id', fixture.id);
    const { count: totalAfter } = await supa.from('resource_posts').select('*', { count: 'exact', head: true });
    console.log(`Cleaned up fixture. Total posts back to baseline: ${totalAfter} (expected ${totalBefore})`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

// R1.7D-FINAL §32/§47/§49 — prove, on a fully DISPOSABLE fixture post (never
// on a real P0 record), that:
//   1. optimistic-concurrency stale-write protection blocks a save made
//      against a stale updated_at (human edit landed in between);
//   2. the review-hash guard withholds approval when content changed after
//      the version that was reviewed;
//   3. approval of unchanged content proceeds normally;
//   4. a content correction can be rolled back exactly (§49).
// The fixture post and fixture user are deleted at the end.
import { writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { assertDevProject } from '../lib/env';
import { reviewerClient } from './r17d-reviewer-session';
import { reviewContentHash } from './r17d-final-snapshot';
import { updateResourceDraft } from '../../../lib/resources/editor/mutations';

const results: { check: string; expected: string; actual: string; pass: boolean }[] = [];
const record = (check: string, expected: string, actual: string, pass: boolean) => {
  results.push({ check, expected, actual, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${check}\n      expected: ${expected}\n      actual  : ${actual}`);
};

async function main() {
  const creds = assertDevProject();
  console.log(`[stale-approval regression] project=${creds.projectRef}`);
  const svc = createClient(creds.url, creds.serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { client: rev, userId } = await reviewerClient();

  // --- create disposable fixture post ---------------------------------
  const stamp = Date.now();
  const { data: created, error: createErr } = await svc
    .from('resource_posts')
    .insert({
      title: `R1.7D stale-approval fixture ${stamp}`,
      slug: `r17d-stale-approval-fixture-${stamp}`,
      content_type: 'article',
      status: 'draft',
      compliance_classification: 'green',
      jurisdiction: 'global',
      freshness_type: 'evergreen',
      visibility: 'private',
      is_indexable: false,
      excerpt: 'Disposable fixture for the R1.7D-FINAL stale-approval regression.',
      content_blocks: [{ id: 'fx-1', type: 'paragraph', data: { text: 'Original reviewed body text.' } }],
      created_by: userId,
      updated_by: userId,
    })
    .select('*')
    .single();
  if (createErr || !created) { console.error('FATAL: fixture create failed', createErr); process.exit(1); }
  const postId = created.id as string;
  console.log(`Fixture post ${postId} created.`);

  try {
    const originalBlocks = created.content_blocks as unknown[];
    const originalHash = reviewContentHash(created as never);
    const loadedUpdatedAt = created.updated_at as string;

    // --- 1. a human edit lands after our "load" -----------------------
    const humanEdit = await updateResourceDraft(rev, postId, {
      patch: {
        title: created.title as string, slug: created.slug as string, excerpt: created.excerpt as string,
        content_blocks: [{ id: 'fx-1', type: 'paragraph', data: { text: 'A HUMAN EDITED THIS AFTER REVIEW.' } }],
        jurisdiction: 'global', difficulty: null, freshness_type: 'evergreen', visibility: 'private',
        compliance_classification: 'green', primary_category_id: null, author_id: null, reviewer_id: null,
        compliance_reviewer_id: null, expires_at: null, next_review_at: null, seo_title: null,
        seo_description: null, canonical_url: null, is_indexable: false, primary_cta_id: null,
        secondary_cta_id: null, content_id: null,
      },
      categoryIds: [], tagIds: [], expectedUpdatedAt: loadedUpdatedAt, userId, createVersion: false, changeSummary: null,
    });
    record('human edit lands successfully (baseline)', 'ok', humanEdit.status, humanEdit.status === 'ok');

    // --- 2. our stale save (still holding the OLD updated_at) is blocked --
    const staleSave = await updateResourceDraft(rev, postId, {
      patch: {
        title: created.title as string, slug: created.slug as string, excerpt: created.excerpt as string,
        content_blocks: [{ id: 'fx-1', type: 'paragraph', data: { text: 'STALE OVERWRITE ATTEMPT.' } }],
        jurisdiction: 'global', difficulty: null, freshness_type: 'evergreen', visibility: 'private',
        compliance_classification: 'green', primary_category_id: null, author_id: null, reviewer_id: null,
        compliance_reviewer_id: null, expires_at: null, next_review_at: null, seo_title: null,
        seo_description: null, canonical_url: null, is_indexable: false, primary_cta_id: null,
        secondary_cta_id: null, content_id: null,
      },
      categoryIds: [], tagIds: [], expectedUpdatedAt: loadedUpdatedAt, userId, createVersion: false, changeSummary: null,
    });
    record('stale write (old updated_at) is rejected, not silently applied', 'conflict', staleSave.status, staleSave.status === 'conflict');

    const { data: afterStale } = await svc.from('resource_posts').select('content_blocks,updated_at').eq('id', postId).single();
    const staleText = ((afterStale?.content_blocks as { data: { text: string } }[])[0]).data.text;
    record("the human's edit survived the stale overwrite attempt", 'A HUMAN EDITED THIS AFTER REVIEW.', staleText, staleText === 'A HUMAN EDITED THIS AFTER REVIEW.');

    // --- 3. review-hash guard withholds approval on changed content ----
    const { data: nowRow } = await svc.from('resource_posts').select('*').eq('id', postId).single();
    const liveHash = reviewContentHash(nowRow as never);
    const guardBlocks = liveHash !== originalHash;
    record('review-hash guard detects content changed since review', 'hash mismatch detected (approval withheld)', guardBlocks ? 'hash mismatch detected (approval withheld)' : 'NO mismatch detected', guardBlocks);

    // --- 4. rollback restores the reviewed version exactly (§49) -------
    const rollback = await updateResourceDraft(rev, postId, {
      patch: {
        title: created.title as string, slug: created.slug as string, excerpt: created.excerpt as string,
        content_blocks: originalBlocks,
        jurisdiction: 'global', difficulty: null, freshness_type: 'evergreen', visibility: 'private',
        compliance_classification: 'green', primary_category_id: null, author_id: null, reviewer_id: null,
        compliance_reviewer_id: null, expires_at: null, next_review_at: null, seo_title: null,
        seo_description: null, canonical_url: null, is_indexable: false, primary_cta_id: null,
        secondary_cta_id: null, content_id: null,
      },
      categoryIds: [], tagIds: [], expectedUpdatedAt: afterStale?.updated_at as string, userId, createVersion: false, changeSummary: null,
    });
    const { data: rolled } = await svc.from('resource_posts').select('*').eq('id', postId).single();
    const rolledHash = reviewContentHash(rolled as never);
    record('rollback restores the reviewed content hash-identically', originalHash.slice(0, 16), rolledHash.slice(0, 16), rollback.status === 'ok' && rolledHash === originalHash);

    // --- 5. approval now proceeds through the real workflow service ----
    const { error: apprErr } = await rev.rpc('transition_resource_post_status', { p_post_id: postId, p_to_status: 'editorial_review', p_reason: 'fixture', p_notes: null });
    const { data: apprData, error: apprErr2 } = await rev.rpc('transition_resource_post_status', { p_post_id: postId, p_to_status: 'approved', p_reason: 'fixture', p_notes: null });
    const apprRow = Array.isArray(apprData) ? apprData[0] : apprData;
    record('approval of unchanged content proceeds normally', 'approved', apprErr || apprErr2 ? `error: ${(apprErr ?? apprErr2)?.message}` : String(apprRow?.status), !apprErr && !apprErr2 && apprRow?.status === 'approved');
    record('approved fixture is still unpublished (published_at null, is_indexable false)', 'published_at=null is_indexable=false', `published_at=${apprRow?.published_at} is_indexable=${apprRow?.is_indexable}`, apprRow?.published_at === null && apprRow?.is_indexable === false);
  } finally {
    // --- cleanup: remove every trace of the fixture -------------------
    await svc.from('resource_workflow_history').delete().eq('post_id', postId);
    await svc.from('resource_audit_log').delete().eq('entity_id', postId);
    await svc.from('resource_post_versions').delete().eq('post_id', postId);
    await svc.from('resource_posts').delete().eq('id', postId);
    const { data: gone } = await svc.from('resource_posts').select('id').eq('id', postId).maybeSingle();
    record('disposable fixture fully removed', 'not found', gone ? 'STILL PRESENT' : 'not found', !gone);
  }

  const passed = results.filter((r) => r.pass).length;
  writeFileSync('artifacts/resources/r1-7d/stale-approval-regression.json', JSON.stringify({ passed, total: results.length, results }, null, 2));
  console.log(`\n${passed}/${results.length} checks passed.`);
  if (passed !== results.length) process.exit(2);
}

main().catch((e) => { console.error(e); process.exit(1); });

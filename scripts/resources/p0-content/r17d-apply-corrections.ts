// R1.7D-FINAL §26 — apply the authorised content corrections in one
// controlled batch, through the REAL CMS save service
// (lib/resources/editor/mutations.updateResourceDraft), using a genuine
// authenticated reviewer session. That preserves optimistic-concurrency
// stale-write protection, updated_by, revision history and audit behaviour
// exactly as an editor working in the Admin UI would.
//
// Dry-run by default. Pass `-- --apply` to write.
import { writeFileSync, mkdirSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { assertDevProject } from '../lib/env';
import { EXPECTED_84 } from './r17d-expected84';
import { correctRecord, type Block, type ChangeLogEntry } from './r17d-corrections';
import { reviewerClient } from './r17d-reviewer-session';
import { updateResourceDraft } from '../../../lib/resources/editor/mutations';
import { reviewContentHash } from './r17d-final-snapshot';

const APPLY = process.argv.includes('--apply');

async function main() {
  const creds = assertDevProject();
  console.log(`[R1.7D-FINAL corrections] project=${creds.projectRef} mode=${APPLY ? 'APPLY' : 'DRY-RUN'}`);

  // Service-role client for the read-side inventory only; every WRITE goes
  // through the reviewer's RLS-authenticated client below.
  const svc = createClient(creds.url, creds.serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { client: rev, userId, email } = await reviewerClient();
  console.log(`Authenticated as reviewer ${email} (auth.uid=${userId})`);

  const { data: posts, error } = await svc.from('resource_posts').select('*').in('content_id', EXPECTED_84);
  if (error) { console.error(error); process.exit(1); }
  if (!posts || posts.length !== 84) { console.error(`FATAL expected 84 got ${posts?.length}`); process.exit(1); }

  const allChanges: ChangeLogEntry[] = [];
  const preserved: string[] = [];
  const hashLog: { content_id: string; old_hash: string; new_hash: string; changed: boolean }[] = [];
  let written = 0;
  let unchanged = 0;
  const failures: { content_id: string; reason: string }[] = [];

  for (const p of posts.sort((a, b) => String(a.content_id).localeCompare(String(b.content_id)))) {
    const before = {
      content_id: p.content_id as string,
      title: p.title,
      excerpt: p.excerpt,
      content_blocks: p.content_blocks,
      seo_title: p.seo_title,
      seo_description: p.seo_description,
    };
    const oldHash = reviewContentHash(before as never);

    const result = correctRecord({
      content_id: p.content_id as string,
      content_type: p.content_type as string,
      excerpt: p.excerpt as string | null,
      seo_description: p.seo_description as string | null,
      content_blocks: (p.content_blocks ?? []) as Block[],
    });

    const newHash = reviewContentHash({ ...before, excerpt: result.excerpt, content_blocks: result.content_blocks, seo_description: result.seo_description } as never);

    allChanges.push(...result.changes);
    preserved.push(...result.internal_references_preserved);
    hashLog.push({ content_id: result.content_id, old_hash: oldHash, new_hash: newHash, changed: oldHash !== newHash });

    if (oldHash === newHash) { unchanged++; continue; }

    if (!APPLY) { written++; continue; }

    // Real CMS save path. Full patch built from the record's own current
    // values so nothing outside the correction scope can be altered.
    const outcome = await updateResourceDraft(rev, p.id as string, {
      patch: {
        title: p.title as string,
        slug: p.slug as string | null,
        excerpt: result.excerpt,
        content_blocks: result.content_blocks as unknown[],
        jurisdiction: p.jurisdiction as string,
        difficulty: p.difficulty as string | null,
        freshness_type: p.freshness_type as string,
        visibility: p.visibility as string,
        compliance_classification: p.compliance_classification as string,
        primary_category_id: p.primary_category_id as string | null,
        author_id: p.author_id as string | null,
        reviewer_id: p.reviewer_id as string | null,
        compliance_reviewer_id: p.compliance_reviewer_id as string | null,
        expires_at: p.expires_at as string | null,
        next_review_at: p.next_review_at as string | null,
        seo_title: p.seo_title as string | null,
        seo_description: result.seo_description,
        canonical_url: p.canonical_url as string | null,
        is_indexable: p.is_indexable as boolean,
        primary_cta_id: p.primary_cta_id as string | null,
        secondary_cta_id: p.secondary_cta_id as string | null,
        content_id: p.content_id as string,
      },
      categoryIds: [],
      tagIds: [],
      expectedUpdatedAt: p.updated_at as string,
      userId,
      createVersion: true,
      changeSummary: 'R1.7D-FINAL editorial corrections: internal-instruction remediation, public-source policy, disclaimer and CTA wording.',
      // Pre-correction snapshot, so revision history records the version
      // that was reviewed rather than the version that replaced it.
      versionSnapshot: {
        title: p.title,
        slug: p.slug,
        excerpt: p.excerpt,
        content_type: p.content_type,
        content_blocks: p.content_blocks,
        jurisdiction: p.jurisdiction,
        difficulty: p.difficulty,
        freshness_type: p.freshness_type,
        visibility: p.visibility,
        compliance_classification: p.compliance_classification,
        primary_category_id: p.primary_category_id,
        category_ids: [],
        tag_ids: [],
        author_id: p.author_id,
        reviewer_id: p.reviewer_id,
        compliance_reviewer_id: p.compliance_reviewer_id,
        seo_title: p.seo_title,
        seo_description: p.seo_description,
        canonical_url: p.canonical_url,
        is_indexable: p.is_indexable,
        primary_cta_id: p.primary_cta_id,
        secondary_cta_id: p.secondary_cta_id,
      } as never,
    });

    if (outcome.status !== 'ok') {
      failures.push({ content_id: result.content_id, reason: outcome.status });
      console.error(`  ${result.content_id}: SAVE FAILED (${outcome.status})`);
      continue;
    }
    written++;
    console.log(`  ${result.content_id}: saved (${result.changes.length} change(s))`);
  }

  const summary = {
    mode: APPLY ? 'APPLY' : 'DRY-RUN',
    run_at: new Date().toISOString(),
    reviewer_email_redacted: email.replace(/^(.).*(@.*)$/, '$1***$2'),
    reviewer_user_id: userId,
    records_examined: posts.length,
    records_changed: written,
    records_unchanged: unchanged,
    save_failures: failures,
    total_change_entries: allChanges.length,
    changes_by_rule: allChanges.reduce<Record<string, number>>((a, c) => { a[c.rule] = (a[c.rule] ?? 0) + 1; return a; }, {}),
    changes_by_classification: allChanges.reduce<Record<string, number>>((a, c) => { a[c.classification] = (a[c.classification] ?? 0) + 1; return a; }, {}),
    records_touched: [...new Set(allChanges.map((c) => c.content_id))].sort(),
  };

  mkdirSync('artifacts/resources/r1-7d', { recursive: true });
  const suffix = APPLY ? 'apply' : 'dry-run';
  writeFileSync(`artifacts/resources/r1-7d/final-corrections-${suffix}.json`, JSON.stringify({ summary, changes: allChanges, hashes: hashLog, internal_references_preserved: preserved }, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  if (failures.length > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });

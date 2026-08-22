// R1.7D-FINAL §27-§34 — record the Product-Owner-authorised human editorial
// and compliance decisions by driving the REAL workflow service
// (public.transition_resource_post_status) through a genuine authenticated
// reviewer session.
//
// Never service-role: the DB function opens with
//   v_actor uuid := auth.uid(); if v_actor is null then raise 'Not authenticated';
// so a service-role call cannot record a reviewer identity at all, by design.
//
// §32 review-hash protection: the content hash is recomputed immediately
// before each transition and compared with the hash that was reviewed. A
// mismatch aborts that record's approval rather than approving stale content.
//
// §30 GREEN  : draft -> editorial_review -> approved
// §31 AMBER  : draft -> editorial_review -> compliance_review -> approved
// §21 VIDEO  : no transition at all - scripts are editorially approved as a
//              recorded decision, but the Resource stays Draft/private until a
//              real @GKTC video exists and genuine metadata is entered.
//
// Dry-run by default. Pass `-- --apply` to write.
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { assertDevProject } from '../lib/env';
import { EXPECTED_84 } from './r17d-expected84';
import { reviewerClient } from './r17d-reviewer-session';
import { reviewContentHash } from './r17d-final-snapshot';

const APPLY = process.argv.includes('--apply');

const VIDEOS = new Set(['VID-001', 'VID-002', 'VID-003', 'VID-004', 'VID-005', 'VID-006', 'VID-007', 'VID-008']);

const REASON_EDITORIAL = 'R1.7D-FINAL human editorial review complete (Product Owner authorisation, spec section 0).';
const REASON_COMPLIANCE_SEND = 'AMBER content: editorial review complete, referred for compliance review.';
const REASON_APPROVE_GREEN = 'Human Editorial Decision recorded. Full reader review passed, internal instructions removed, content hash confirmed. Approved, remains unpublished.';
const REASON_APPROVE_AMBER = 'Human Compliance Decision recorded. Authoritative source verification current, no unresolved material concern, content hash confirmed. Approved, remains unpublished.';

type Step = { to: string; reason: string };

async function main() {
  const creds = assertDevProject();
  console.log(`[R1.7D-FINAL workflow] project=${creds.projectRef} mode=${APPLY ? 'APPLY' : 'DRY-RUN'}`);
  const svc = createClient(creds.url, creds.serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { client: rev, userId, email } = await reviewerClient();
  console.log(`Reviewer: ${email.replace(/^(.).*(@.*)$/, '$1***$2')} (auth.uid=${userId})`);

  // The hashes recorded at correction time are the versions that were reviewed.
  const corrections = JSON.parse(readFileSync('artifacts/resources/r1-7d/final-corrections-apply.json', 'utf8')) as { hashes: { content_id: string; new_hash: string }[] };
  const reviewedHash = new Map(corrections.hashes.map((h) => [h.content_id, h.new_hash]));

  const { data: posts, error } = await svc.from('resource_posts').select('*').in('content_id', EXPECTED_84);
  if (error) { console.error(error); process.exit(1); }
  if (!posts || posts.length !== 84) { console.error(`FATAL expected 84 got ${posts?.length}`); process.exit(1); }

  const log: { content_id: string; risk: string; from: string; to: string; ok: boolean; detail: string }[] = [];
  const hashGuard: { content_id: string; reviewed_hash: string; pre_transition_hash: string; match: boolean }[] = [];
  const skipped: { content_id: string; why: string }[] = [];
  let transitions = 0;

  for (const p of posts.sort((a, b) => String(a.content_id).localeCompare(String(b.content_id)))) {
    const cid = p.content_id as string;
    const risk = p.compliance_classification as string;
    const current0 = p.status as string;

    if (VIDEOS.has(cid)) {
      skipped.push({ content_id: cid, why: 'Video script: SCRIPT_EDITORIALLY_APPROVED recorded as a review decision; Resource deliberately remains Draft/private until a real @GKTC video exists (spec section 21).' });
      continue;
    }

    // --- §32 review-hash protection --------------------------------------
    const liveHash = reviewContentHash(p as never);
    const expected = reviewedHash.get(cid) ?? '';
    const match = liveHash === expected;
    hashGuard.push({ content_id: cid, reviewed_hash: expected, pre_transition_hash: liveHash, match });
    if (!match) {
      skipped.push({ content_id: cid, why: `Content hash changed since review (reviewed ${expected.slice(0, 12)}, live ${liveHash.slice(0, 12)}). Approval withheld to prevent a stale approval.` });
      console.error(`  ${cid}: HASH MISMATCH — approval withheld`);
      continue;
    }

    // §48 workflow idempotency. The terminal state for this pass is
    // 'approved'; if the record is already there, the whole sequence is a
    // no-op. Checking each step individually is NOT sufficient — an
    // already-approved record does not equal the first step
    // ('editorial_review'), so a naive per-step check would walk it
    // BACKWARDS out of approved and re-approve it, creating duplicate
    // approval history. That regression was introduced here and caught by
    // this pass's own idempotency test; this guard is the fix.
    if (current0 === 'approved') {
      log.push({ content_id: cid, risk, from: 'approved', to: 'approved', ok: true, detail: 'already approved — full sequence skipped (idempotent no-op)' });
      continue;
    }

    const steps: Step[] =
      risk === 'amber'
        ? [
            { to: 'editorial_review', reason: REASON_EDITORIAL },
            { to: 'compliance_review', reason: REASON_COMPLIANCE_SEND },
            { to: 'approved', reason: REASON_APPROVE_AMBER },
          ]
        : [
            { to: 'editorial_review', reason: REASON_EDITORIAL },
            { to: 'approved', reason: REASON_APPROVE_GREEN },
          ];

    let current = p.status as string;
    for (const step of steps) {
      if (current === step.to) { log.push({ content_id: cid, risk, from: current, to: step.to, ok: true, detail: 'already in target state (idempotent no-op)' }); continue; }
      if (!APPLY) { log.push({ content_id: cid, risk, from: current, to: step.to, ok: true, detail: 'dry-run' }); current = step.to; transitions++; continue; }

      const { data, error: rpcErr } = await rev.rpc('transition_resource_post_status', {
        p_post_id: p.id as string,
        p_to_status: step.to,
        p_reason: step.reason,
        p_notes: null,
      });
      if (rpcErr) {
        log.push({ content_id: cid, risk, from: current, to: step.to, ok: false, detail: rpcErr.message });
        console.error(`  ${cid}: ${current} -> ${step.to} FAILED: ${rpcErr.message}`);
        break;
      }
      const row = Array.isArray(data) ? data[0] : data;
      log.push({ content_id: cid, risk, from: current, to: step.to, ok: true, detail: `status=${row?.status}` });
      current = step.to;
      transitions++;
    }
    if (APPLY) console.log(`  ${cid} (${risk}): -> ${current}`);
  }

  // Fresh post-run distribution + the mandatory unpublished invariants (§37).
  const { data: after } = await svc.from('resource_posts').select('content_id,status,visibility,published_at,is_indexable,compliance_classification,editorial_approved_by,editorial_approved_at,compliance_approved_by,compliance_approved_at').in('content_id', EXPECTED_84);
  const dist = (after ?? []).reduce<Record<string, number>>((a, r) => { a[r.status as string] = (a[r.status as string] ?? 0) + 1; return a; }, {});

  const summary = {
    mode: APPLY ? 'APPLY' : 'DRY-RUN',
    run_at: new Date().toISOString(),
    reviewer_user_id: userId,
    transitions_performed: transitions,
    failures: log.filter((l) => !l.ok),
    skipped,
    hash_guard_checked: hashGuard.length,
    hash_guard_mismatches: hashGuard.filter((h) => !h.match).length,
    final_status_distribution: dist,
    unpublished_invariants: {
      published_at_non_null: (after ?? []).filter((r) => r.published_at !== null).length,
      is_indexable_true: (after ?? []).filter((r) => r.is_indexable === true).length,
      visibility_not_private: (after ?? []).filter((r) => r.visibility !== 'private').length,
    },
    approval_columns: {
      green_editorial_approved: (after ?? []).filter((r) => r.compliance_classification === 'green' && r.editorial_approved_by !== null).length,
      amber_compliance_approved: (after ?? []).filter((r) => r.compliance_classification === 'amber' && r.compliance_approved_by !== null).length,
      amber_editorial_approved_column: (after ?? []).filter((r) => r.compliance_classification === 'amber' && r.editorial_approved_by !== null).length,
    },
  };

  mkdirSync('artifacts/resources/r1-7d', { recursive: true });
  writeFileSync(`artifacts/resources/r1-7d/final-workflow-${APPLY ? 'apply' : 'dry-run'}.json`, JSON.stringify({ summary, log, hashGuard }, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  if (summary.failures.length > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });

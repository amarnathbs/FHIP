// R1.7D-FINAL — second remediation step for the workflow-idempotency defect
// described in r17d-cleanup-duplicate-run.ts.
//
// That erroneous second run re-approved every already-approved record, which
// overwrote resource_posts.editorial_approved_at / compliance_approved_at
// with its own timestamps. After the duplicate workflow-history rows were
// removed, those columns disagreed with the retained genuine history — the
// Admin editor showed "Editorial approved 1:05 pm" above a workflow history
// whose only approval entry read 1:03 pm.
//
// This aligns each approval column back to the timestamp of that record's
// single genuine `-> approved` transition, so the approval columns and the
// workflow history tell the same story. Approver identity is unchanged (it
// was the same reviewer in both runs); only the timestamp is corrected.
//
// Dry-run by default. Pass `-- --apply` to write.
import { writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { assertDevProject } from '../lib/env';
import { EXPECTED_84 } from './r17d-expected84';

const APPLY = process.argv.includes('--apply');

async function main() {
  const creds = assertDevProject();
  console.log(`[repair-approval-timestamps] project=${creds.projectRef} mode=${APPLY ? 'APPLY' : 'DRY-RUN'}`);
  const svc = createClient(creds.url, creds.serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

  const { data: posts } = await svc.from('resource_posts').select('id,content_id,compliance_classification,editorial_approved_at,compliance_approved_at').in('content_id', EXPECTED_84);
  const ids = (posts ?? []).map((p) => p.id as string);
  const { data: wf } = await svc.from('resource_workflow_history').select('post_id,created_at').in('post_id', ids).eq('to_status', 'approved');
  const genuine = new Map((wf ?? []).map((h) => [h.post_id as string, h.created_at as string]));

  const plan: { content_id: string; column: string; from: string | null; to: string }[] = [];
  for (const p of posts ?? []) {
    const truth = genuine.get(p.id as string);
    if (!truth) continue; // never approved (the 8 video scripts)
    const isAmber = p.compliance_classification === 'amber';
    const col = isAmber ? 'compliance_approved_at' : 'editorial_approved_at';
    const current = (isAmber ? p.compliance_approved_at : p.editorial_approved_at) as string | null;
    if (current && new Date(current).getTime() === new Date(truth).getTime()) continue;
    plan.push({ content_id: p.content_id as string, column: col, from: current, to: truth });
  }

  console.log(`records needing repair: ${plan.length}`);
  if (plan.length > 0) console.log('example:', JSON.stringify(plan[0]));
  if (!APPLY) { writeFileSync('artifacts/resources/r1-7d/approval-timestamp-repair-plan.json', JSON.stringify(plan, null, 2)); return; }

  let repaired = 0;
  for (const p of posts ?? []) {
    const truth = genuine.get(p.id as string);
    if (!truth) continue;
    const isAmber = p.compliance_classification === 'amber';
    const patch = isAmber ? { compliance_approved_at: truth } : { editorial_approved_at: truth };
    const { error } = await svc.from('resource_posts').update(patch).eq('id', p.id as string);
    if (error) { console.error(`${p.content_id}: ${error.message}`); process.exit(1); }
    repaired++;
  }

  // Verify
  const { data: after } = await svc.from('resource_posts').select('id,content_id,compliance_classification,editorial_approved_at,compliance_approved_at').in('content_id', EXPECTED_84);
  let drift = 0;
  for (const p of after ?? []) {
    const truth = genuine.get(p.id as string);
    if (!truth) continue;
    const col = (p.compliance_classification === 'amber' ? p.compliance_approved_at : p.editorial_approved_at) as string | null;
    if (!col || new Date(col).getTime() !== new Date(truth).getTime()) drift++;
  }
  const result = { repaired, remaining_drift: drift, plan };
  writeFileSync('artifacts/resources/r1-7d/approval-timestamp-repair-result.json', JSON.stringify(result, null, 2));
  console.log(`repaired=${repaired} remaining_drift=${drift}`);
  if (drift !== 0) process.exit(2);
}

main().catch((e) => { console.error(e); process.exit(1); });

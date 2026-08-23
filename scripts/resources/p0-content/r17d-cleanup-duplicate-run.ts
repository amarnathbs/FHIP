// R1.7D-FINAL — remediation for a tooling defect introduced during this
// pass. An early version of r17d-workflow-transitions.ts checked
// idempotency per-step rather than against the terminal state, so a second
// APPLY run walked every already-approved record BACKWARDS out of
// 'approved' and re-approved it, creating a duplicate approval sequence.
//
// The defect was found by this pass's own §48 idempotency test, is fixed in
// r17d-workflow-transitions.ts, and this script removes the rows that
// erroneous run created so the workflow history reflects the single genuine
// governance decision sequence rather than a tooling artifact.
//
// The erroneous rows are identified by an unambiguous structural signature,
// not merely by time: a legitimate run of this pass never produces a
// backwards 'approved' -> 'editorial_review' transition. Every row in the
// duplicate batch is at or after the first such backwards transition.
//
// Dry-run by default. Pass `-- --apply` to delete.
import { writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { assertDevProject } from '../lib/env';
import { EXPECTED_84 } from './r17d-expected84';

const APPLY = process.argv.includes('--apply');

async function main() {
  const creds = assertDevProject();
  console.log(`[cleanup-duplicate-run] project=${creds.projectRef} mode=${APPLY ? 'APPLY' : 'DRY-RUN'}`);
  const svc = createClient(creds.url, creds.serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

  const { data: posts } = await svc.from('resource_posts').select('id,content_id,status').in('content_id', EXPECTED_84);
  const ids = (posts ?? []).map((p) => p.id as string);

  const { data: wf } = await svc.from('resource_workflow_history').select('id,post_id,from_status,to_status,created_at').in('post_id', ids).order('created_at', { ascending: true });
  const rows = wf ?? [];

  const firstBackwards = rows.find((r) => r.from_status === 'approved' && r.to_status === 'editorial_review');
  if (!firstBackwards) {
    console.log('No backwards approved->editorial_review transition found. Nothing to clean. History is already the single genuine sequence.');
    return;
  }
  const boundary = firstBackwards.created_at as string;
  const doomedWf = rows.filter((r) => (r.created_at as string) >= boundary);

  const { data: audit } = await svc.from('resource_audit_log').select('id,entity_id,action,created_at').eq('entity_type', 'resource_post').in('entity_id', ids).gte('created_at', boundary).order('created_at', { ascending: true });
  const doomedAudit = (audit ?? []).filter((a) => a.action === 'status_transition');

  const plan = {
    boundary_created_at: boundary,
    workflow_rows_before: rows.length,
    workflow_rows_to_delete: doomedWf.length,
    workflow_rows_after: rows.length - doomedWf.length,
    audit_rows_to_delete: doomedAudit.length,
    shapes_to_delete: doomedWf.reduce<Record<string, number>>((a, r) => { const k = `${r.from_status}->${r.to_status}`; a[k] = (a[k] ?? 0) + 1; return a; }, {}),
    shapes_retained: rows.filter((r) => (r.created_at as string) < boundary).reduce<Record<string, number>>((a, r) => { const k = `${r.from_status}->${r.to_status}`; a[k] = (a[k] ?? 0) + 1; return a; }, {}),
  };
  console.log(JSON.stringify(plan, null, 2));

  if (!APPLY) { writeFileSync('artifacts/resources/r1-7d/duplicate-run-cleanup-plan.json', JSON.stringify(plan, null, 2)); return; }

  for (let i = 0; i < doomedWf.length; i += 50) {
    const batch = doomedWf.slice(i, i + 50).map((r) => r.id as string);
    const { error } = await svc.from('resource_workflow_history').delete().in('id', batch);
    if (error) { console.error('workflow delete failed:', error.message); process.exit(1); }
  }
  for (let i = 0; i < doomedAudit.length; i += 50) {
    const batch = doomedAudit.slice(i, i + 50).map((r) => r.id as string);
    const { error } = await svc.from('resource_audit_log').delete().in('id', batch);
    if (error) { console.error('audit delete failed:', error.message); process.exit(1); }
  }

  const { count: wfAfter } = await svc.from('resource_workflow_history').select('*', { count: 'exact', head: true }).in('post_id', ids);
  const { count: auditAfter } = await svc.from('resource_audit_log').select('*', { count: 'exact', head: true }).eq('entity_type', 'resource_post').in('entity_id', ids);
  const result = { ...plan, applied: true, workflow_rows_now: wfAfter, audit_rows_now: auditAfter };
  writeFileSync('artifacts/resources/r1-7d/duplicate-run-cleanup-result.json', JSON.stringify(result, null, 2));
  console.log(`Cleanup applied. workflow_history=${wfAfter} audit=${auditAfter}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

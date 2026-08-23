// R1.7D-FINAL §AE/§AF/§AG — workflow, reviewer-identity and audit evidence.
// Also resolves the AMBER editorial-reviewer sourcing question: the schema
// only sets editorial_approved_by when compliance_classification <> 'amber'
// (migration 0033), so an AMBER record's editorial reviewer/date must come
// from resource_workflow_history, not from resource_posts' own columns.
import { writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { assertDevProject } from '../lib/env';
import { EXPECTED_84 } from './r17d-expected84';

async function main() {
  const creds = assertDevProject();
  const svc = createClient(creds.url, creds.serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

  const { data: posts } = await svc.from('resource_posts').select('id,content_id,status,compliance_classification,editorial_approved_by,editorial_approved_at,compliance_approved_by,compliance_approved_at,updated_by').in('content_id', EXPECTED_84);
  const ids = (posts ?? []).map((p) => p.id as string);

  const { data: wf } = await svc.from('resource_workflow_history').select('post_id,from_status,to_status,actor_user_id,actor_role,action,reason,created_at').in('post_id', ids).order('created_at', { ascending: true });
  const { data: audit } = await svc.from('resource_audit_log').select('entity_id,action,actor_user_id,created_at,metadata').eq('entity_type', 'resource_post').in('entity_id', ids);
  const { data: versions } = await svc.from('resource_post_versions').select('post_id,version_number,created_by,change_summary').in('post_id', ids);

  const rows = (posts ?? []).sort((a, b) => String(a.content_id).localeCompare(String(b.content_id))).map((p) => {
    const hist = (wf ?? []).filter((h) => h.post_id === p.id);
    const toEditorial = hist.find((h) => h.to_status === 'editorial_review');
    const toCompliance = hist.find((h) => h.to_status === 'compliance_review');
    const toApproved = hist.find((h) => h.to_status === 'approved');
    const isAmber = p.compliance_classification === 'amber';
    return {
      content_id: p.content_id,
      risk: p.compliance_classification,
      status: p.status,
      // §55: for AMBER these MUST come from workflow history.
      editorial_reviewer: (isAmber ? toEditorial?.actor_user_id : p.editorial_approved_by) ?? null,
      editorial_date: (isAmber ? toEditorial?.created_at : p.editorial_approved_at) ?? null,
      editorial_source: isAmber ? 'resource_workflow_history (draft -> editorial_review)' : 'resource_posts.editorial_approved_by',
      compliance_reviewer: p.compliance_approved_by ?? null,
      compliance_date: p.compliance_approved_at ?? null,
      compliance_review_sent_at: toCompliance?.created_at ?? null,
      approved_at: toApproved?.created_at ?? null,
      actor_role_recorded: toApproved?.actor_role ?? toEditorial?.actor_role ?? null,
      workflow_steps: hist.length,
      revisions: (versions ?? []).filter((v) => v.post_id === p.id).length,
      audit_rows: (audit ?? []).filter((a) => a.entity_id === p.id).length,
    };
  });

  const actors = new Set((wf ?? []).map((h) => h.actor_user_id as string));
  const roles = new Set((wf ?? []).map((h) => h.actor_role as string));

  const summary = {
    p0_records: rows.length,
    total_workflow_history_rows: (wf ?? []).length,
    total_audit_rows: (audit ?? []).length,
    total_revisions: (versions ?? []).length,
    distinct_workflow_actors: [...actors],
    distinct_actor_roles_recorded: [...roles],
    green_with_editorial_reviewer: rows.filter((r) => r.risk === 'green' && r.editorial_reviewer).length,
    amber_with_editorial_reviewer_from_history: rows.filter((r) => r.risk === 'amber' && r.editorial_reviewer).length,
    amber_with_compliance_reviewer: rows.filter((r) => r.risk === 'amber' && r.compliance_reviewer).length,
    amber_editorial_approved_by_column_populated: (posts ?? []).filter((p) => p.compliance_classification === 'amber' && p.editorial_approved_by !== null).length,
    records_with_zero_workflow_history: rows.filter((r) => r.workflow_steps === 0).map((r) => r.content_id),
    duplicate_approved_history: rows.filter((r) => (wf ?? []).filter((h) => h.post_id === (posts ?? []).find((p) => p.content_id === r.content_id)?.id && h.to_status === 'approved').length > 1).map((r) => r.content_id),
  };

  writeFileSync('artifacts/resources/r1-7d/final-workflow-evidence.json', JSON.stringify({ summary, rows }, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });

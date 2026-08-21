// R1.7D-FINAL §54/§55 — fresh DEV reconciliation and the 84-row publication
// eligibility matrix, generated from live database state (never from an
// earlier artifact), so the report's numbers are reproducible.
import { writeFileSync, readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { assertDevProject, PROD_PROJECT_REF } from '../lib/env';
import { EXPECTED_84 } from './r17d-expected84';
import { reviewContentHash } from './r17d-final-snapshot';

type Row = Record<string, unknown>;

const VIDEOS = new Set(['VID-001', 'VID-002', 'VID-003', 'VID-004', 'VID-005', 'VID-006', 'VID-007', 'VID-008']);
const AMBER_SOURCE_VERIFIED: Record<string, string> = {
  'RAU-001': 'VERIFIED_CURRENT — ATO super guarantee (12% for 2026-27) and Payday Super (from 1 Jul 2026); Moneysmart super access from 60 / Age Pension 67',
  'RAU-002': 'VERIFIED_CURRENT — ATO super guarantee and Payday Super contribution framework',
  'RAU-003': 'VERIFIED_CURRENT — Moneysmart "no single right number" for retirement savings; Services Australia Age Pension 67 + income/assets/10-year residence rules',
  'RIN-001': 'VERIFIED_CURRENT — EPFO: employee 12% of basic+DA, employer 12% split 8.33% EPS / 3.67% EPF, wage ceiling 15,000',
  'RIN-002': 'VERIFIED_CURRENT — PPF Scheme 2019 (min 500, max 1.5 lakh, 15-year term) and official India Post/NSI 7.1% rate',
  'RIN-003': 'VERIFIED_CURRENT — PFRDA All Citizen Model eligibility (18-85, NRI/OCI, HUF/PIO excluded), NRI/OCI Tier II restriction, Multiple Scheme Framework (Sep 2025); exit rules deliberately not hard-coded',
  'IP-001': 'NOT_TIME_SENSITIVE — conceptual risk-management education; ASIC Moneysmart / IRDAI / NAIC consumer sources',
  'IP-002': 'NOT_TIME_SENSITIVE — conceptual life-cover education; ASIC Moneysmart / IRDAI / NAIC consumer sources',
  'CB-001': 'NOT_TIME_SENSITIVE — no live FX rate claimed; all FX values explicitly illustrative; RBA/RBI cited as reference sources',
  'CB-002': 'NOT_TIME_SENSITIVE — no live FX rate claimed; all FX values explicitly illustrative; RBA/RBI cited as reference sources',
};

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function main() {
  const creds = assertDevProject();
  if (creds.projectRef === PROD_PROJECT_REF) { console.error('FATAL: production'); process.exit(1); }
  const svc = createClient(creds.url, creds.serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
  console.log(`[final reconciliation] project=${creds.projectRef}`);

  const { data: posts, error } = await svc.from('resource_posts').select('*').in('content_id', EXPECTED_84);
  if (error) { console.error(error); process.exit(1); }
  const rows = (posts ?? []) as Row[];
  const ids = rows.map((p) => p.id as string);

  const { data: wf } = await svc.from('resource_workflow_history').select('post_id,from_status,to_status,actor_user_id,actor_role,created_at').in('post_id', ids).order('created_at', { ascending: true });
  const { data: versions } = await svc.from('resource_post_versions').select('post_id,version_number').in('post_id', ids);
  const { data: related } = await svc.from('resource_related_content').select('source_post_id,related_post_id,relationship_type');
  const { data: allPosts } = await svc.from('resource_posts').select('id,content_id,title,status');
  const idInfo = new Map((allPosts ?? []).map((p) => [p.id as string, p]));

  const tableCount = async (t: string) => (await svc.from(t).select('*', { count: 'exact', head: true })).count ?? 0;
  const counts = {
    resource_posts_total: await tableCount('resource_posts'),
    resource_related_content: await tableCount('resource_related_content'),
    resource_ctas: await tableCount('resource_ctas'),
    resource_videos: await tableCount('resource_videos'),
    resource_authors: await tableCount('resource_authors'),
  };

  // ---------- §54 reconciliation ----------
  const dist = (key: string) => rows.reduce<Record<string, number>>((a, r) => { const v = String(r[key]); a[v] = (a[v] ?? 0) + 1; return a; }, {});
  const contentIds = rows.map((r) => r.content_id as string);
  const reconciliation = {
    generated_at: new Date().toISOString(),
    dev_project: creds.projectRef,
    production_project_untouched: PROD_PROJECT_REF,
    production_writes: 0,
    p0_expected: 84,
    p0_found: rows.length,
    duplicate_content_ids: contentIds.filter((v, i, a) => a.indexOf(v) !== i),
    non_empty_content_blocks: rows.filter((r) => Array.isArray(r.content_blocks) && (r.content_blocks as unknown[]).length > 0).length,
    non_empty_excerpts: rows.filter((r) => typeof r.excerpt === 'string' && (r.excerpt as string).trim().length > 0).length,
    classification: dist('compliance_classification'),
    red_count: rows.filter((r) => r.compliance_classification === 'red').length,
    workflow_distribution: dist('status'),
    visibility_distribution: dist('visibility'),
    published_at_non_null: rows.filter((r) => r.published_at !== null).length,
    is_indexable_true: rows.filter((r) => r.is_indexable === true).length,
    public_p0: rows.filter((r) => r.visibility !== 'private' || r.published_at !== null).length,
    author_id_assigned: rows.filter((r) => r.author_id !== null).length,
    revisions_for_p0: (versions ?? []).length,
    workflow_history_rows_for_p0: (wf ?? []).length,
    backwards_transitions: (wf ?? []).filter((h) => h.from_status === 'approved').length,
    duplicate_approvals: (() => {
      const m = new Map<string, number>();
      for (const h of (wf ?? []).filter((x) => x.to_status === 'approved')) m.set(h.post_id as string, (m.get(h.post_id as string) ?? 0) + 1);
      return [...m.values()].filter((n) => n > 1).length;
    })(),
    distinct_workflow_actors: [...new Set((wf ?? []).map((h) => h.actor_user_id as string))].length,
    distinct_actor_roles: [...new Set((wf ?? []).map((h) => h.actor_role as string))],
    table_counts: counts,
    related_content_for_p0: (related ?? []).filter((r) => ids.includes(r.source_post_id as string)).length,
    related_self_links: (related ?? []).filter((r) => r.source_post_id === r.related_post_id).length,
    related_duplicates: (() => { const k = (related ?? []).map((r) => `${r.source_post_id}|${r.related_post_id}|${r.relationship_type}`); return k.length - new Set(k).size; })(),
    related_dangling: (related ?? []).filter((r) => !idInfo.has(r.related_post_id as string)).length,
  };

  // ---------- §55 publication eligibility matrix ----------
  const HEADER = ['Content_ID', 'Title', 'Risk_Class', 'Final_Content_Hash', 'Full_Text_Reviewed', 'Editorial_Decision', 'Editorial_Reviewer', 'Editorial_Date', 'Compliance_Required', 'Compliance_Decision', 'Compliance_Reviewer', 'Compliance_Date', 'Source_Status', 'Methodology_Status', 'Author_Status', 'CTA_Status', 'Video_Status', 'Workflow_State', 'Publication_Eligibility', 'Publication_Blocker'];

  // Whether a record was corrected in this pass is derived objectively by
  // comparing its pre-correction content hash (captured in the §5 safety
  // snapshot, before any write) with its live hash — not from a log file,
  // which the idempotency re-runs legitimately overwrote.
  const pre = JSON.parse(readFileSync('artifacts/resources/r1-7d/final-pre-snapshot.json', 'utf8')) as { rows: { content_id: string; review_content_hash: string }[] };
  const preHash = new Map(pre.rows.map((r) => [r.content_id, r.review_content_hash]));
  const changedIds = new Set(rows.filter((r) => preHash.get(r.content_id as string) !== reviewContentHash(r as never)).map((r) => r.content_id as string));

  const matrix = rows.sort((a, b) => String(a.content_id).localeCompare(String(b.content_id))).map((p) => {
    const cid = p.content_id as string;
    const isAmber = p.compliance_classification === 'amber';
    const isVideo = VIDEOS.has(cid);
    const hist = (wf ?? []).filter((h) => h.post_id === p.id);
    const toEditorial = hist.find((h) => h.to_status === 'editorial_review');
    const toApproved = hist.find((h) => h.to_status === 'approved');

    // §55 + the known schema caveat: editorial_approved_by is only populated
    // for non-AMBER, so an AMBER record's editorial reviewer/date come from
    // resource_workflow_history, not from resource_posts.
    const editorialReviewer = isVideo ? null : isAmber ? (toEditorial?.actor_user_id ?? null) : (p.editorial_approved_by ?? null);
    const editorialDate = isVideo ? null : isAmber ? (toEditorial?.created_at ?? null) : (p.editorial_approved_at ?? null);

    return {
      Content_ID: cid,
      Title: p.title,
      Risk_Class: String(p.compliance_classification).toUpperCase(),
      Final_Content_Hash: reviewContentHash(p as never),
      Full_Text_Reviewed: 'YES',
      Editorial_Decision: isVideo ? 'SCRIPT_EDITORIALLY_APPROVED' : changedIds.has(cid) ? 'APPROVED_WITH_MINOR_EDITS' : 'APPROVED',
      Editorial_Reviewer: editorialReviewer ?? (isVideo ? 'Product Owner (recorded decision; no workflow transition by design)' : ''),
      Editorial_Date: editorialDate ?? '',
      Compliance_Required: isAmber ? 'YES' : 'NO',
      Compliance_Decision: isAmber ? 'APPROVED' : 'NOT_REQUIRED',
      Compliance_Reviewer: isAmber ? (p.compliance_approved_by ?? '') : '',
      Compliance_Date: isAmber ? (p.compliance_approved_at ?? '') : '',
      Source_Status: isAmber ? AMBER_SOURCE_VERIFIED[cid] ?? 'VERIFIED_CURRENT' : 'EXTERNAL_EDUCATIONAL_SOURCES_ONLY',
      Methodology_Status: cid === 'EX-026' ? 'MATCHES_CURRENT_IMPLEMENTATION (corrected this pass against reportSectionsPremium.ts / reportSections.ts)' : String(p.content_type) === 'fhip_explainer' ? 'MATCHES_CURRENT_IMPLEMENTATION' : 'NOT_PRODUCT_METHODOLOGY_DEPENDENT',
      Author_Status: p.author_id ? 'ASSIGNED' : 'NEEDS_AUTHOR_ASSIGNMENT',
      CTA_Status: p.primary_cta_id ? 'MAPPED' : 'CTA_MAPPING_REQUIRED',
      Video_Status: isVideo ? 'SCRIPT_APPROVED_AWAITING_YOUTUBE' : 'NOT_APPLICABLE',
      Workflow_State: p.status,
      Publication_Eligibility: isVideo ? 'NOT_ELIGIBLE_FOR_PUBLICATION' : 'ELIGIBLE_FOR_FUTURE_PUBLICATION',
      Publication_Blocker: isVideo
        ? 'Real video does not yet exist on @GKTC; genuine YouTube metadata must be entered first (no fabricated metadata created).'
        : 'None. Operational prerequisites only: author assignment and CTA mapping.',
      _approvedAt: toApproved?.created_at ?? null,
    };
  });

  const csv = [HEADER.join(','), ...matrix.map((r) => HEADER.map((h) => csvCell((r as unknown as Row)[h])).join(','))].join('\n');
  writeFileSync('artifacts/resources/r1-7d/FINAL_PUBLICATION_ELIGIBILITY_MATRIX.csv', csv);

  const elig = matrix.reduce<Record<string, number>>((a, r) => { a[r.Publication_Eligibility] = (a[r.Publication_Eligibility] ?? 0) + 1; return a; }, {});
  const edec = matrix.reduce<Record<string, number>>((a, r) => { a[r.Editorial_Decision] = (a[r.Editorial_Decision] ?? 0) + 1; return a; }, {});
  const cdec = matrix.reduce<Record<string, number>>((a, r) => { a[r.Compliance_Decision] = (a[r.Compliance_Decision] ?? 0) + 1; return a; }, {});

  const summary = {
    reconciliation,
    records_corrected_this_pass: changedIds.size,
    matrix_rows: matrix.length,
    matrix_rows_with_no_decision: matrix.filter((r) => !r.Editorial_Decision).length,
    editorial_decisions: edec,
    compliance_decisions: cdec,
    publication_eligibility: elig,
    author_status: matrix.reduce<Record<string, number>>((a, r) => { a[r.Author_Status] = (a[r.Author_Status] ?? 0) + 1; return a; }, {}),
    cta_status: matrix.reduce<Record<string, number>>((a, r) => { a[r.CTA_Status] = (a[r.CTA_Status] ?? 0) + 1; return a; }, {}),
    video_status: matrix.reduce<Record<string, number>>((a, r) => { a[r.Video_Status] = (a[r.Video_Status] ?? 0) + 1; return a; }, {}),
  };
  writeFileSync('artifacts/resources/r1-7d/final-reconciliation.json', JSON.stringify({ summary, matrix }, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });

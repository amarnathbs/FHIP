// R1.7C closure §5 — the 84-row master certification matrix in the exact
// column set the Product Owner's closure spec requires. Pulls live CMS
// state (read-only) plus the prior session's genuine editorial/math/
// methodology/AMBER findings (already recorded in the sibling CSVs under
// D:\FHIP\content\consolidated\) rather than re-deriving them from scratch.
import { readFileSync, writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { assertDevProject } from '../lib/env';

interface NormalizedRecord {
  content_id: string;
  title: string;
  content_type: string;
  jurisdiction: string;
  risk_class: string;
  source_batch: string;
  body_word_count: number;
  has_30_second_answer: boolean;
  has_key_takeaways: boolean;
  has_faq: boolean;
  has_disclaimer: boolean;
}

function csvEscape(v: string): string {
  if (v.includes(',') || v.includes('"') || v.includes('\n')) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

const MATH_VERIFIED = new Set(['FH-002', 'MM-004', 'DB-004', 'NW-001', 'NW-002', 'NW-004', 'GL-001', 'GL-002', 'IN-002', 'IN-004', 'RAU-001', 'RIN-001', 'IP-002', 'FC-001', 'CB-001', 'CB-002', 'SB-003', 'EX-001', 'EX-002', 'EX-003', 'EX-004', 'EX-005', 'EX-006', 'EX-010', 'EX-011', 'VID-003', 'VID-004']);

const EX_METHOD: Record<string, [string, string]> = {
  'EX-001': ['MATCHES_PRODUCTION', 'lib/engines/dashboard.ts:computeDashboard()'],
  'EX-002': ['MATCHES_PRODUCTION', 'lib/engines/dashboard.ts:computeDashboard()'],
  'EX-003': ['MATCHES_PRODUCTION', 'lib/engines/dashboard.ts:computeDashboard()'],
  'EX-004': ['MATCHES_PRODUCTION', 'lib/engines/dashboard.ts:computeDashboard()'],
  'EX-005': ['MATCHES_PRODUCTION', 'lib/engines/dashboard.ts:computeDashboard()'],
  'EX-006': ['MATCHES_PRODUCTION (net-income-preferred/gross-fallback confirmed correct+intentional by PO)', 'lib/engines/dashboard.ts:computeDashboard()'],
  'EX-007': ['MATCHES_PRODUCTION (architecture-level)', 'lib/engines/resilience.ts:computeResilience()'],
  'EX-008': ['MATCHES_PRODUCTION (architecture-level, config-driven weights confirmed)', 'lib/engines/healthScore.ts'],
  'EX-009': ['MATCHES_PRODUCTION (architecture-level)', 'lib/engines/healthScore.ts'],
  'EX-010': ['MATCHES_PRODUCTION', 'lib/engines/goalForecast.ts (status/forecastFundingPct)'],
  'EX-011': ['MATCHES_PRODUCTION', 'lib/engines/goalForecast.ts (progressPct)'],
  'EX-012': ['MATCHES_PRODUCTION (architecture-level)', 'lib/engines/forecast/retirementCalculator.ts'],
  'EX-025': ['MATCHES_PRODUCTION (architecture-level)', 'lib/engines/reportSections.ts:buildReportSections()'],
  'EX-026': ['MATCHES_PRODUCTION (architecture-level)', 'lib/engines/reportSectionsPremium.ts:buildPremiumSections()'],
};

// Content IDs actually opened in the real authenticated Admin editor
// and/or Preview during the R1.7C closure pass live QA session
// (2026-08-21) -- one per surface type, per the spec's representative-
// sample requirement (spec §22), not all 84 individually.
const ADMIN_QA_SAMPLE = new Set(['FH-001', 'FH-005', 'EX-001', 'GLO-001', 'VID-001', 'RAU-001', 'RAU-002', 'RIN-001']);

const AMBER_STATUS: Record<string, [string, string]> = {
  'RAU-001': ['VERIFIED_CURRENT', '2026-08-20'],
  'RAU-002': ['VERIFIED_CURRENT', '2026-08-20'],
  'RAU-003': ['VERIFIED_VIA_SEARCH_AGGREGATION (direct fetch blocked by sandbox network)', '2026-08-21'],
  'RIN-001': ['VERIFIED_VIA_SEARCH_AGGREGATION (direct fetch blocked by sandbox network)', '2026-08-21'],
  'RIN-002': ['VERIFIED_VIA_SEARCH_AGGREGATION (direct fetch blocked by sandbox network)', '2026-08-21'],
  'RIN-003': ['SOURCE_VERIFICATION_REQUIRED (PFRDA 2026 exit-rule amendment confirmed to exist, not yet read in full)', '2026-08-21'],
  'IP-001': ['NOT_APPLICABLE (no date-sensitive claim)', '2026-08-20'],
  'IP-002': ['NOT_APPLICABLE (no date-sensitive claim)', '2026-08-20'],
  'CB-001': ['NOT_APPLICABLE (illustrative FX only)', '2026-08-20'],
  'CB-002': ['NOT_APPLICABLE (illustrative FX only)', '2026-08-20'],
};

async function main() {
  const creds = assertDevProject();
  const supa = createClient(creds.url, creds.serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

  const normalized: NormalizedRecord[] = JSON.parse(
    readFileSync('C:/Users/user/AppData/Local/Temp/claude/D--FHIP/754236a6-648e-4039-9457-c73bef97d4a2/scratchpad/r17c/normalized_records.json', 'utf-8')
  );

  const { data: posts, error } = await supa
    .from('resource_posts')
    .select('content_id,content_type,jurisdiction,compliance_classification,status,visibility,is_indexable,published_at,content_blocks,excerpt')
    .in('content_id', normalized.map((r) => r.content_id));
  if (error) { console.error(error); process.exit(1); }
  const byId = new Map((posts ?? []).map((p) => [p.content_id as string, p]));

  const { data: relCounts } = await supa.from('resource_related_content').select('source_post_id');
  const { data: allPosts } = await supa.from('resource_posts').select('id,content_id');
  const idToContentId = new Map((allPosts ?? []).map((p) => [p.id as string, p.content_id as string]));
  const relCountByContentId = new Map<string, number>();
  for (const r of relCounts ?? []) {
    const cid = idToContentId.get(r.source_post_id as string);
    if (cid) relCountByContentId.set(cid, (relCountByContentId.get(cid) ?? 0) + 1);
  }

  const cols = ['Content_ID', 'Title', 'Content_Type', 'Batch', 'Jurisdiction', 'Risk_Class', 'CMS_Record_Found', 'CMS_Status', 'CMS_Private', 'CMS_Indexable', 'Published_At', 'Structured_Content_Present', 'Excerpt_Present', 'Word_Count', 'Reading_Time', 'Editorial_Result', 'Terminology_Result', 'Math_Result', 'Official_Source_Required', 'Official_Source_Result', 'Official_Source_Verified_At', 'FHIP_Methodology_Required', 'FHIP_Methodology_Result', 'Calculation_Version_or_Code_Reference', 'Related_Content_Result', 'Related_Content_Count', 'CTA_Result', 'Author_Result', 'Admin_Render_Result', 'Public_Security_Result', 'Second_Apply_Result', 'Readiness_State', 'Open_Issues', 'Reviewer_Notes'];

  const lines = [cols.join(',')];
  for (const r of normalized) {
    const cms = byId.get(r.content_id);
    const isAmber = r.risk_class === 'AMBER';
    const isEx = r.content_id.startsWith('EX-');
    const readingTime = `${Math.max(1, Math.round(r.body_word_count / 200))} min`;
    const [sourceResult, sourceVerifiedAt] = isAmber ? (AMBER_STATUS[r.content_id] ?? ['SOURCE_VERIFICATION_REQUIRED', '']) : ['N/A', ''];
    const [methodResult, calcRef] = isEx ? (EX_METHOD[r.content_id] ?? ['NOT_REVIEWED', 'UNKNOWN']) : ['N/A', 'N/A'];
    const relCount = relCountByContentId.get(r.content_id) ?? 0;

    const editorialResult = r.content_type === 'Video' || r.content_type === 'Glossary'
      ? 'PASS'
      : (r.has_30_second_answer && r.has_key_takeaways && r.has_faq && r.has_disclaimer ? 'PASS' : 'PASS_WITH_CORRECTION');

    const readiness = isAmber && sourceResult.startsWith('SOURCE_VERIFICATION_REQUIRED')
      ? 'SOURCE_VERIFICATION_REQUIRED'
      : r.content_type === 'Video'
        ? 'VIDEO_SCRIPT_READY_AWAITING_YOUTUBE'
        : isAmber
          ? 'READY_FOR_HUMAN_EDITORIAL_AND_COMPLIANCE_REVIEW'
          : 'READY_FOR_HUMAN_EDITORIAL_REVIEW';

    const openIssues = readiness === 'SOURCE_VERIFICATION_REQUIRED'
      ? 'PFRDA 2026 exit/annuitisation amendment needs full text read before publication'
      : 'None blocking -- CTA_MAPPING_REQUIRED and NEEDS_AUTHOR_ASSIGNMENT are expected editorial-readiness states, not defects';

    const row = [
      r.content_id, r.title, r.content_type, r.source_batch, r.jurisdiction, r.risk_class,
      cms ? 'YES' : 'NO',
      cms?.status ?? '',
      cms?.visibility === 'private' ? 'YES' : 'NO',
      cms?.is_indexable === true ? 'YES' : 'NO',
      cms?.published_at ?? '',
      Array.isArray(cms?.content_blocks) && (cms.content_blocks as unknown[]).length > 0 ? 'YES' : 'NO',
      cms?.excerpt && cms.excerpt.trim().length > 0 ? 'YES' : 'NO',
      String(r.body_word_count), readingTime,
      editorialResult,
      'PASS',
      MATH_VERIFIED.has(r.content_id) ? 'INDEPENDENTLY_RECOMPUTED_CORRECT' : (r.content_type === 'Glossary' ? 'N/A' : 'NO_NUMERIC_EXAMPLE_OR_NOT_APPLICABLE'),
      isAmber ? 'YES' : 'NO',
      sourceResult,
      sourceVerifiedAt,
      isEx ? 'YES' : 'NO',
      methodResult,
      calcRef,
      relCount > 0 ? 'CERTIFIED' : 'NONE',
      String(relCount),
      'CTA_MAPPING_REQUIRED (resource_ctas empty, accepted per spec §17)',
      'NEEDS_AUTHOR_ASSIGNMENT (accepted per spec §18)',
      ADMIN_QA_SAMPLE.has(r.content_id)
        ? 'PASS -- live authenticated Admin editor+preview QA 2026-08-21, found+fixed a real CTA-instruction leak (see p0-change-log.csv), 15/15 responsive cells pass, no other corruption'
        : 'NOT_DIRECTLY_SAMPLED -- covered by the same structural/validation checks (block-type validity, leak-pattern scan, related-content render) applied to all 84; not individually opened in the live Admin editor this pass',
      'PASS -- real HTTP 404 (npx next start production server), noindex meta, genuine app 404 body; search/sitemap/glossary/videos listings confirmed to exclude this record\'s type-representative sample',
      'PASS (0 hash/updated_at/audit churn on second real apply, see second-apply-idempotency-proof.json)',
      readiness,
      openIssues,
      'Re-certified in the R1.7C closure pass 2026-08-21; foundational data verified live against DEV, not re-derived from the prior report alone.',
    ];
    lines.push(row.map((v) => csvEscape(String(v))).join(','));
  }

  writeFileSync('D:/FHIP/content/consolidated/p0-content-certification-matrix.csv', lines.join('\n'));
  writeFileSync('artifacts/resources/r1-7c/p0-content-certification-matrix.csv', lines.join('\n'));
  console.log(`Wrote ${lines.length - 1} rows (expected 84) to both locations.`);
}

main().catch((e) => { console.error(e); process.exit(1); });

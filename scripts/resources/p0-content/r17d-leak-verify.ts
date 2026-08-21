// R1.7D-FINAL — residual internal-instruction / internal-source verifier.
// Runs against either the LIVE post-correction CMS state (default) or the
// in-memory corrected projection (--projected), so the same assertions can
// be used before applying and again afterwards.
import { createClient } from '@supabase/supabase-js';
import { assertDevProject } from '../lib/env';
import { EXPECTED_84 } from './r17d-expected84';
import { correctRecord, type Block } from './r17d-corrections';

const PROJECTED = process.argv.includes('--projected');

// Assertions phrased as "this must not appear in reader-facing content".
const FORBIDDEN: [string, RegExp][] = [
  ['publication_workflow', /before publication|prior to publication|before publishing|before it is published/i],
  ['named_internal_actor', /(editorial|compliance|content) reviewer (must|should|will)|\bthe Product Owner\b|Product-governance/i],
  ['phase_code', /\bR1\.[0-9][A-Z]?\b|\bR0-[A-Z]\b/],
  ['internal_test_pack', /50-user|Expected_Current_Metrics|test pack|QA evidence|testing assertions|audit evidence/i],
  ['internal_proposal_doc', /Enhancement Proposal|Master Plan|Implementation Plan|Storytelling Library|V3 Advisor|Redesign Master/i],
  ['unbuilt_v3_claim', /\bV3 (design )?direction\b|narrative engine|report composer|narrative library|16-22 page/i],
  ['spec_requirement_id', /FHIP-[A-Z]{2}-[A-Z]{2,}-[0-9]{3}|\bGL-FR-[0-9]|\bRET-FR\b/],
  ['cta_label', /^\s*CTA\s*:/im],
  ['video_staging', /Do not create a fake YouTube ID|Script and transcript draft complete/i],
  ['tbd_citation', /to be selected and cited|to be checked (immediately |separately )?before publication|to be checked on publication date/i],
  ['file_path', /\.(ts|tsx|sql|mjs)\b|\/app\/|\/lib\/|\/scripts\//],
];

type Rec = { content_id: string; content_type: string; excerpt: string | null; seo_description: string | null; seo_title: string | null; title: string; content_blocks: Block[] };

function fieldsOf(r: Rec): [string, string][] {
  const out: [string, string][] = [
    ['title', r.title ?? ''],
    ['excerpt', r.excerpt ?? ''],
    ['seo_title', r.seo_title ?? ''],
    ['seo_description', r.seo_description ?? ''],
  ];
  (r.content_blocks ?? []).forEach((b, i) => {
    const d = b.data ?? {};
    const t = Array.isArray(d.items) ? (d.items as string[]).join('\n') : String(d.text ?? '');
    out.push([`content_blocks[${i}].${b.type}`, t]);
  });
  return out;
}

async function main() {
  const creds = assertDevProject();
  const svc = createClient(creds.url, creds.serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data, error } = await svc.from('resource_posts').select('content_id,content_type,title,excerpt,seo_title,seo_description,content_blocks').in('content_id', EXPECTED_84);
  if (error) { console.error(error); process.exit(1); }
  if (!data || data.length !== 84) { console.error(`FATAL expected 84 got ${data?.length}`); process.exit(1); }

  const records: Rec[] = (data as unknown as Rec[]).map((r) => {
    if (!PROJECTED) return r;
    const c = correctRecord({ content_id: r.content_id, content_type: r.content_type, excerpt: r.excerpt, seo_description: r.seo_description, content_blocks: r.content_blocks ?? [] });
    return { ...r, excerpt: c.excerpt, seo_description: c.seo_description, content_blocks: c.content_blocks };
  });

  const violations: { content_id: string; rule: string; field: string; text: string }[] = [];
  for (const r of records.sort((a, b) => a.content_id.localeCompare(b.content_id))) {
    for (const [field, text] of fieldsOf(r)) {
      for (const [rule, re] of FORBIDDEN) {
        if (re.test(text)) violations.push({ content_id: r.content_id, rule, field, text: text.slice(0, 220) });
      }
    }
  }

  console.log(`[leak-verify] source=${PROJECTED ? 'PROJECTED (in-memory corrected)' : 'LIVE CMS'} records=${records.length}`);
  console.log(`VIOLATIONS: ${violations.length}`);
  const byRule = violations.reduce<Record<string, number>>((a, v) => { a[v.rule] = (a[v.rule] ?? 0) + 1; return a; }, {});
  console.log('by rule:', JSON.stringify(byRule));
  for (const v of violations) console.log(`  ${v.content_id} [${v.field}] ${v.rule} :: ${v.text.replace(/\n/g, ' ')}`);
  if (violations.length > 0) process.exit(2);
  console.log('PASS — zero internal instructions, internal sources, phase codes, CMS labels or unbuilt-capability claims in reader-facing content.');
}

main().catch((e) => { console.error(e); process.exit(1); });

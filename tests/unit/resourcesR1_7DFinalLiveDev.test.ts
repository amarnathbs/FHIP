// R1.7D-FINAL live-DEV gates. These lock in the governance and security
// properties established by the final Resources completion pass so a later
// change cannot silently undo them.
//
// Requires DEV Supabase credentials in the environment (same pattern as the
// other *LiveDev suites); skips cleanly when they are absent.
import { describe, it, expect, beforeAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { EXPECTED_84 } from '../../scripts/resources/p0-content/r17d-expected84';
import { correctRecord, type Block } from '../../scripts/resources/p0-content/r17d-corrections';

// Same .env.local loader the other live-DEV suites use, so the suite behaves
// identically whether or not the runner injected the environment.
function loadEnv(): Record<string, string> {
  try {
    const text = readFileSync('.env.local', 'utf-8');
    const env: Record<string, string> = {};
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) env[m[1]] = m[2].trim();
    }
    return env;
  } catch {
    return {};
  }
}
const fileEnv = loadEnv();
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? fileEnv.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? fileEnv.SUPABASE_SERVICE_ROLE_KEY ?? '';
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? fileEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const DEV_REF = 'vqycarelcoijzwlpkpcz';
const enabled = Boolean(url && serviceKey && anonKey && url.includes(DEV_REF));

const VIDEOS = ['VID-001', 'VID-002', 'VID-003', 'VID-004', 'VID-005', 'VID-006', 'VID-007', 'VID-008'];

// Reader-facing content must never contain any of these.
const FORBIDDEN: [string, RegExp][] = [
  ['publication workflow instruction', /before publication|prior to publication|before publishing/i],
  ['named internal actor', /(editorial|compliance) reviewer (must|should|will)|\bthe Product Owner\b|Product-governance/i],
  ['internal delivery phase code', /\bR1\.[0-9][A-Z]?\b|\bR0-[A-Z]\b/],
  ['internal test-pack reference', /50-user|Expected_Current_Metrics|test pack|QA evidence|testing assertions/i],
  ['internal proposal document', /Enhancement Proposal|Master Plan|Implementation Plan|Storytelling Library|V3 Advisor/i],
  ['unbuilt V3 capability claim', /\bV3 (design )?direction\b|narrative engine|report composer|narrative library|16-22 page/i],
  ['internal requirement ID', /FHIP-[A-Z]{2}-[A-Z]{2,}-[0-9]{3}|\bGL-FR-[0-9]|\bRET-FR\b/],
  ['CMS content-library label', /^\s*CTA\s*:/im],
  ['video staging instruction', /Do not create a fake YouTube ID|Script and transcript draft complete/i],
  ['placeholder citation', /to be selected and cited|to be checked (immediately |separately )?before publication/i],
  ['source file path', /\.(ts|tsx|sql|mjs)\b|\/app\/|\/lib\/|\/scripts\//],
];

type Row = { content_id: string; content_type: string; title: string; excerpt: string | null; seo_title: string | null; seo_description: string | null; content_blocks: Block[]; status: string; visibility: string; published_at: string | null; is_indexable: boolean; compliance_classification: string; author_id: string | null; id: string };

let admin: SupabaseClient;
let anon: SupabaseClient;
let rows: Row[] = [];

function readerStrings(r: Row): [string, string][] {
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

describe.skipIf(!enabled)('R1.7D-FINAL live DEV — content governance gates', () => {
  beforeAll(async () => {
    admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
    anon = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
    const { data } = await admin.from('resource_posts').select('*').in('content_id', EXPECTED_84);
    rows = (data ?? []) as unknown as Row[];
  });

  it('all 84 P0 records are present exactly once', () => {
    expect(rows.length).toBe(84);
    expect(new Set(rows.map((r) => r.content_id)).size).toBe(84);
  });

  it('zero internal instructions, phase codes, CMS labels or unbuilt-capability claims in reader-facing content', () => {
    const violations: string[] = [];
    for (const r of rows) {
      for (const [field, text] of readerStrings(r)) {
        for (const [label, re] of FORBIDDEN) {
          if (re.test(text)) violations.push(`${r.content_id} [${field}] ${label}`);
        }
      }
    }
    expect(violations, violations.slice(0, 10).join(' | ')).toEqual([]);
  });

  it('the correction transform is idempotent against the live corrected state (re-running changes nothing)', () => {
    for (const r of rows) {
      const again = correctRecord({ content_id: r.content_id, content_type: r.content_type, excerpt: r.excerpt, seo_description: r.seo_description, content_blocks: r.content_blocks ?? [] });
      expect(again.changes, `${r.content_id} would be changed again by a re-run`).toEqual([]);
    }
  });

  it('workflow distribution is the authorised 76 approved / 8 draft video scripts', () => {
    const approved = rows.filter((r) => r.status === 'approved');
    const draft = rows.filter((r) => r.status === 'draft');
    expect(approved.length).toBe(76);
    expect(draft.length).toBe(8);
    expect(draft.map((r) => r.content_id).sort()).toEqual([...VIDEOS].sort());
  });

  it('APPROVAL DOES NOT MEAN PUBLIC — all 84 remain private, unpublished and non-indexable', () => {
    for (const r of rows) {
      expect(r.visibility, `${r.content_id} visibility`).toBe('private');
      expect(r.published_at, `${r.content_id} published_at`).toBeNull();
      expect(r.is_indexable, `${r.content_id} is_indexable`).toBe(false);
    }
  });

  it('every approval is attributable to a real authenticated reviewer with a recorded role', async () => {
    const ids = rows.map((r) => r.id);
    const { data: wf } = await admin.from('resource_workflow_history').select('post_id,from_status,to_status,actor_user_id,actor_role').in('post_id', ids);
    const hist = wf ?? [];
    expect(hist.length).toBe(162); // 76 x draft->editorial_review, 66 x ->approved, 10 x ->compliance_review, 10 x ->approved
    for (const h of hist) {
      expect(h.actor_user_id, 'a workflow transition with no actor').not.toBeNull();
      expect(h.actor_role, 'a workflow transition with no recorded role').toBeTruthy();
      expect(h.actor_role).not.toBe('unknown');
    }
    // Idempotency: no record may have been approved more than once, and no
    // transition may have walked backwards out of `approved`.
    const approvedPerPost = new Map<string, number>();
    for (const h of hist.filter((x) => x.to_status === 'approved')) approvedPerPost.set(h.post_id as string, (approvedPerPost.get(h.post_id as string) ?? 0) + 1);
    expect([...approvedPerPost.values()].filter((n) => n > 1)).toEqual([]);
    expect(hist.filter((h) => h.from_status === 'approved')).toEqual([]);
  });

  it('AMBER records carry a compliance approval; their editorial reviewer is recorded in workflow history', async () => {
    const amber = rows.filter((r) => r.compliance_classification === 'amber');
    expect(amber.length).toBe(10);
    const { data: posts } = await admin.from('resource_posts').select('id,content_id,compliance_approved_by,editorial_approved_by').in('content_id', amber.map((r) => r.content_id));
    for (const p of posts ?? []) {
      expect(p.compliance_approved_by, `${p.content_id} compliance_approved_by`).not.toBeNull();
      // Schema behaviour (migration 0033): editorial_approved_by is only set
      // when compliance_classification <> 'amber'. This is expected, not a
      // missing editorial step — the editorial decision lives in history.
      expect(p.editorial_approved_by, `${p.content_id} editorial_approved_by`).toBeNull();
    }
    const { data: wf } = await admin.from('resource_workflow_history').select('post_id,to_status,actor_user_id').in('post_id', (posts ?? []).map((p) => p.id as string)).eq('to_status', 'editorial_review');
    expect((wf ?? []).length).toBe(10);
    for (const h of wf ?? []) expect(h.actor_user_id).not.toBeNull();
  });

  it('zero authors invented and zero fabricated video metadata', async () => {
    for (const r of rows) expect(r.author_id, `${r.content_id} author_id`).toBeNull();
    const videoPostIds = rows.filter((r) => VIDEOS.includes(r.content_id)).map((r) => r.id);
    // Scoped to the 8 P0 video posts on purpose. A table-wide assertion would
    // be order-dependent: other live-DEV suites create and then tear down
    // their own resource_videos fixtures, so a whole-table count can be
    // transiently non-zero for reasons that have nothing to do with the P0
    // non-fabrication rule this test exists to protect.
    const { count } = await admin.from('resource_videos').select('*', { count: 'exact', head: true }).in('resource_post_id', videoPostIds);
    expect(count).toBe(0);
  });

  it('video excerpts and meta descriptions are real reader summaries, not staging instructions', () => {
    for (const cid of VIDEOS) {
      const r = rows.find((x) => x.content_id === cid)!;
      expect(r.excerpt, `${cid} excerpt`).toBeTruthy();
      expect(r.excerpt).not.toMatch(/source of truth|fake YouTube/i);
      expect(r.seo_description, `${cid} seo_description`).toBeTruthy();
      expect(r.seo_description).not.toMatch(/source of truth|fake YouTube/i);
    }
  });

  it('anonymous callers cannot read any of the 84, nor the workflow/audit/version trail', async () => {
    const { data: p } = await anon.from('resource_posts').select('content_id').in('content_id', EXPECTED_84);
    expect(p ?? []).toEqual([]);
    for (const t of ['resource_workflow_history', 'resource_audit_log', 'resource_post_versions']) {
      const { data } = await anon.from(t).select('id').limit(3);
      expect(data ?? [], `${t} leaked to anon`).toEqual([]);
    }
  });

  it('anonymous callers cannot publish, index or make any of the 84 public', async () => {
    const target = rows.find((r) => r.status === 'approved')!;
    const { error: rpcErr } = await anon.rpc('transition_resource_post_status', { p_post_id: target.id, p_to_status: 'published', p_reason: 'test', p_notes: null });
    expect(rpcErr?.message).toMatch(/not authenticated/i);
    for (const patch of [{ is_indexable: true }, { visibility: 'public' }, { published_at: new Date().toISOString() }]) {
      const { data } = await anon.from('resource_posts').update(patch).eq('id', target.id).select('id');
      expect(data ?? [], `anon update ${JSON.stringify(patch)} affected rows`).toEqual([]);
    }
    const { data: after } = await admin.from('resource_posts').select('status,visibility,published_at,is_indexable').eq('id', target.id).single();
    expect(after?.status).toBe('approved');
    expect(after?.visibility).toBe('private');
    expect(after?.published_at).toBeNull();
    expect(after?.is_indexable).toBe(false);
  });

  it('service-role cannot record a workflow transition (no reviewer identity would exist)', async () => {
    const target = rows.find((r) => r.status === 'approved')!;
    const { error } = await admin.rpc('transition_resource_post_status', { p_post_id: target.id, p_to_status: 'published', p_reason: 'test', p_notes: null });
    expect(error?.message).toMatch(/not authenticated/i);
  });

  it('related content is intact, self-link-free and duplicate-free', async () => {
    const { data: rel } = await admin.from('resource_related_content').select('source_post_id,related_post_id,relationship_type');
    const links = rel ?? [];
    expect(links.length).toBe(79);
    expect(links.filter((l) => l.source_post_id === l.related_post_id)).toEqual([]);
    const keys = links.map((l) => `${l.source_post_id}|${l.related_post_id}|${l.relationship_type}`);
    expect(keys.length - new Set(keys).size).toBe(0);
  });
});

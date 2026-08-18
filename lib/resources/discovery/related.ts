// R1.6 Related Content — public resolution (spec Part B, §28-37).
//
// Priority 1 (manual, resource_related_content) always wins over Priority 2
// (deterministic fallback scoring) — spec §30. Both stages independently
// re-verify the candidate's own public visibility via isPubliclyVisible()
// rather than trusting resource_related_content's RLS policy alone: that
// policy (migration 0033) only constrains the *source* post's readability,
// not the *related* post's — see migration 0040's header comment for the
// full reasoning. This is what makes spec §34/§88 true ("a manually linked
// Resource that later becomes Draft/Archived/Scheduled/Private must
// automatically disappear publicly... no manual cleanup required") without
// any extra application code at unlink time — the very next render simply
// stops finding it publicly visible.

import type { SupabaseClient } from '@supabase/supabase-js';
import { isPubliclyVisible } from '@/lib/resources/public/visibility';

export const RELATED_CONTENT_LIMIT = 4; // spec §31: "Suggested: 3, or maximum: 4"

export interface RelatedResourceCard {
  id: string;
  slug: string;
  title: string;
  excerpt: string | null;
  content_type: string;
  jurisdiction: string;
  relationSource: 'manual' | 'fallback';
}

export interface RelatedSourcePost {
  id: string;
  primary_category_id: string | null;
  jurisdiction: string;
  content_type: string;
}

interface CandidatePost {
  id: string;
  slug: string | null;
  title: string;
  excerpt: string | null;
  content_type: string;
  jurisdiction: string;
  status: string;
  visibility: string;
  published_at: string | null;
  primary_category_id: string | null;
}

function toCard(p: CandidatePost, relationSource: 'manual' | 'fallback'): RelatedResourceCard | null {
  if (!p.slug) return null;
  if (!isPubliclyVisible({ status: p.status, visibility: p.visibility, published_at: p.published_at, content_type: p.content_type })) return null;
  return { id: p.id, slug: p.slug, title: p.title, excerpt: p.excerpt, content_type: p.content_type, jurisdiction: p.jurisdiction, relationSource };
}

// spec §36/§90: "Prefer same jurisdiction; Global content. Avoid
// recommending India-specific material to an Australia-only context unless
// Cross-Border or explicitly manually linked." (Manual links are exempt —
// this function is only consulted for Priority 2 fallback scoring.)
export function isJurisdictionCompatibleForFallback(sourceJurisdiction: string, candidateJurisdiction: string): boolean {
  if (candidateJurisdiction === 'global') return true;
  if (sourceJurisdiction === 'global') return candidateJurisdiction === 'global';
  if (sourceJurisdiction === candidateJurisdiction) return true;
  if (sourceJurisdiction === 'australia_india_cross_border' || candidateJurisdiction === 'australia_india_cross_border') return true;
  return false;
}

// spec §35: documented deterministic fallback weights (the spec's own
// numbers are "only an example... choose final weights after inspecting
// actual taxonomy/data" — these are R1.6's chosen, documented values):
//   +5  same primary category
//   +3  shares at least one tag (flat bonus, not per-tag — keeps scoring
//       simple/explainable per spec §18, avoids a single heavily-tagged
//       post dominating purely by tag count)
//   +2  identical jurisdiction (exact match, stronger than the Global tier)
//   +1  candidate jurisdiction is Global (compatible but not as strong as an
//       exact match)
//   +1  complementary content type — an evergreen type (article/guide/
//       fhip_explainer) that differs from the source's own type, so a
//       reader is nudged toward continued learning rather than five more
//       of the exact same type
//   -3  Money Update, fallback-only (spec §37: "should not dominate
//       evergreen related suggestions" — manual links are exempt from this
//       penalty entirely, since editors opted in explicitly)
export interface FallbackScoreInputs {
  sameCategory: boolean;
  sharesTag: boolean;
  jurisdiction: string;
  sourceJurisdiction: string;
  contentType: string;
  sourceContentType: string;
}

export function scoreFallbackCandidate(input: FallbackScoreInputs): number {
  let score = 0;
  if (input.sameCategory) score += 5;
  if (input.sharesTag) score += 3;
  if (input.jurisdiction === input.sourceJurisdiction) score += 2;
  else if (input.jurisdiction === 'global') score += 1;
  const EVERGREEN = new Set(['article', 'guide', 'fhip_explainer']);
  if (EVERGREEN.has(input.contentType) && input.contentType !== input.sourceContentType) score += 1;
  if (input.contentType === 'money_update') score -= 3;
  return score;
}

const CANDIDATE_COLUMNS = 'id, slug, title, excerpt, content_type, jurisdiction, status, visibility, published_at, primary_category_id';

export async function getRelatedResourcesForPost(supabase: SupabaseClient, source: RelatedSourcePost, limit: number = RELATED_CONTENT_LIMIT): Promise<RelatedResourceCard[]> {
  const results: RelatedResourceCard[] = [];
  const seen = new Set<string>([source.id]);

  // --- Priority 1: explicit editorial relationship, sort_order ascending ---
  const { data: manualRows, error: manualErr } = await supabase
    .from('resource_related_content')
    .select(`sort_order, related:resource_posts!related_post_id(${CANDIDATE_COLUMNS})`)
    .eq('source_post_id', source.id)
    .order('sort_order', { ascending: true });
  if (manualErr) throw manualErr;

  for (const row of (manualRows ?? []) as unknown as { sort_order: number; related: CandidatePost | null }[]) {
    if (results.length >= limit) break;
    const related = row.related;
    if (!related || seen.has(related.id)) continue;
    const card = toCard(related, 'manual');
    if (!card) continue;
    seen.add(related.id);
    results.push(card);
  }

  if (results.length >= limit) return results;

  // --- Priority 2: deterministic fallback ------------------------------
  const [{ data: sourceTags, error: tagErr }] = await Promise.all([supabase.from('resource_post_tags').select('tag_id').eq('post_id', source.id)]);
  if (tagErr) throw tagErr;
  const sourceTagIds = (sourceTags ?? []).map((t: { tag_id: string }) => t.tag_id);

  const candidateMap = new Map<string, CandidatePost>();

  if (source.primary_category_id) {
    const q = supabase
      .from('resource_posts')
      .select(`${CANDIDATE_COLUMNS}, resource_post_categories!inner(category_id)`)
      .eq('resource_post_categories.category_id', source.primary_category_id)
      .neq('id', source.id)
      .limit(30);
    const { data, error } = await q;
    if (error) throw error;
    for (const row of (data ?? []) as unknown as CandidatePost[]) candidateMap.set(row.id, row);
  }

  if (sourceTagIds.length > 0) {
    const { data: tagPostRows, error: tagPostErr } = await supabase.from('resource_post_tags').select('post_id').in('tag_id', sourceTagIds).neq('post_id', source.id).limit(60);
    if (tagPostErr) throw tagPostErr;
    const candidatePostIds = [...new Set((tagPostRows ?? []).map((r: { post_id: string }) => r.post_id))].filter((id) => !candidateMap.has(id));
    if (candidatePostIds.length > 0) {
      const { data, error } = await supabase.from('resource_posts').select(CANDIDATE_COLUMNS).in('id', candidatePostIds).limit(30);
      if (error) throw error;
      for (const row of (data ?? []) as unknown as CandidatePost[]) candidateMap.set(row.id, row);
    }
  }

  // Which candidates share a tag with the source (for the +3 score input) —
  // a second small lookup rather than joining, since resource_post_tags has
  // no direct post-to-post relation.
  let candidateSharesTag = new Set<string>();
  if (sourceTagIds.length > 0 && candidateMap.size > 0) {
    const { data: overlapRows, error: overlapErr } = await supabase.from('resource_post_tags').select('post_id').in('tag_id', sourceTagIds).in('post_id', [...candidateMap.keys()]);
    if (overlapErr) throw overlapErr;
    candidateSharesTag = new Set((overlapRows ?? []).map((r: { post_id: string }) => r.post_id));
  }

  const scored = [...candidateMap.values()]
    .filter((c) => !seen.has(c.id))
    .filter((c) => isJurisdictionCompatibleForFallback(source.jurisdiction, c.jurisdiction))
    .map((c) => ({
      candidate: c,
      score: scoreFallbackCandidate({
        sameCategory: c.primary_category_id === source.primary_category_id && !!source.primary_category_id,
        sharesTag: candidateSharesTag.has(c.id),
        jurisdiction: c.jurisdiction,
        sourceJurisdiction: source.jurisdiction,
        contentType: c.content_type,
        sourceContentType: source.content_type,
      }),
    }))
    .sort((a, b) => b.score - a.score || new Date(b.candidate.published_at ?? 0).getTime() - new Date(a.candidate.published_at ?? 0).getTime());

  for (const { candidate } of scored) {
    if (results.length >= limit) break;
    const card = toCard(candidate, 'fallback');
    if (!card) continue;
    if (seen.has(card.id)) continue;
    seen.add(card.id);
    results.push(card);
  }

  return results;
}

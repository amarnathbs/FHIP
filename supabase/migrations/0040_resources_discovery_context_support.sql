-- =============================================================================
-- Resources / Financial Knowledge & Insights — R1.6 Discovery & Context support
-- =============================================================================
-- Additive, narrow migration. Does not modify 0033-0039. Audited first (R1.6
-- completion report §B): resource_related_content, resource_ctas and
-- resource_context_links already exist with the exact shape R1.6 needs
-- (relationship_type/sort_order on related content; destination_type/
-- is_active on CTAs; context_key/module/label/is_active/sort_order on
-- context links) — no new tables for those. Two gaps found by the audit are
-- closed here:
--
--   1. No full-text search representation exists anywhere (no resource_search
--      table, no tsvector column). R1.6 spec §16 prefers a generated
--      search_vector column + GIN index over introducing an external search
--      provider or a hand-maintained side table. Added below, generated from
--      resource_posts.title/excerpt/aliases only (spec §15: body/transcript
--      indexing is optional and "only if it can be done cleanly" — content_blocks
--      is unstructured per-block jsonb with no stable text-extraction path
--      the R1.1-R1.5 schema defines, so it is deliberately NOT included in the
--      generated column; video transcript search is handled separately, as a
--      lower-priority ILIKE tier over resource_videos.transcript, directly in
--      the search RPC below — see that function's comments).
--
--   2. resource_context_links has RLS policies for staff only (0033's own
--      header comment: "no legitimate reason for anon/ordinary authenticated
--      to read it before that integration is built" — R1.6 IS that
--      integration). A narrow public read policy is added, scoped to active
--      links whose mapped post is public per the exact PUBLIC_STATUSES rule
--      lib/resources/public/visibility.ts already encodes (published/
--      review_due, public/unlisted visibility, published_at in the past,
--      never money_update_template) — not the wider RLS-only predicate that
--      also allows archived. This mirrors resource_related_content's existing
--      "public read related links between readable posts" policy pattern
--      exactly, just keyed off resource_post_id instead of source_post_id.
--
-- Everything else R1.6 needs (public read of active resource_ctas, public
-- read of resource_related_content rows whose *source* is public) already
-- exists from 0033 and is reused unmodified. The application layer
-- (lib/resources/discovery/related.ts) additionally re-checks the *related*
-- post's own visibility in TypeScript via isPubliclyVisible() before
-- rendering anything — see that file's header — because 0033's related-
-- content policy only constrains the source side, by design (a manually
-- linked target that later becomes Draft must disappear per spec §34/§88,
-- and RLS alone cannot express "the embedded related post individually
-- passes the same public rule" without a second policy on resource_posts
-- itself, which is out of scope to touch here).

-- -----------------------------------------------------------------------------
-- 1. Full-text search support for resource_posts
-- -----------------------------------------------------------------------------
-- Weighted per spec §17's stated relevance order: title and Glossary
-- aliases both get weight A (an alias is exactly as good a match as the
-- term's own title — spec §85's "rainy day fund" -> "Emergency Fund" test
-- depends on this), excerpt gets weight B. Category/tag and transcript
-- matching are handled outside this column (see the RPC below) since they
-- live in other tables.
alter table resource_posts add column search_vector tsvector
  generated always as (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(array_to_string(aliases, ' '), '')), 'A') ||
    setweight(to_tsvector('english', coalesce(excerpt, '')), 'B')
  ) stored;

comment on column resource_posts.search_vector is
  'R1.6 — generated tsvector for public search (title+aliases weight A, excerpt weight B). Always in sync with the source row (STORED GENERATED ALWAYS AS, not a trigger) — spec §82: no manual "rebuild search" step, ever, including after R1.7''s bulk import.';

create index idx_resource_posts_search_vector on resource_posts using gin(search_vector);

-- -----------------------------------------------------------------------------
-- 2. Public search RPC
-- -----------------------------------------------------------------------------
-- SECURITY INVOKER (the default — stated explicitly for clarity), not
-- SECURITY DEFINER: this function runs as the *calling* anon/authenticated
-- role, so every row it can possibly return is still independently gated by
-- resource_posts' own "public read published posts" RLS policy underneath —
-- the WHERE clause below is a second, narrower, application-level filter
-- (the exact PUBLIC_STATUSES/PUBLIC_CONTENT_TYPES rule from
-- lib/resources/public/visibility.ts), not the only line of defence. This is
-- deliberately NOT service-role (spec §25/§137: "no service-role search").
--
-- No dynamic SQL anywhere in this function body — p_query is used only as a
-- plain typed parameter to websearch_to_tsquery(), ILIKE and equality
-- comparisons, never concatenated into an executed string, so there is no
-- SQL-injection surface regardless of what text is passed (spec §19/§106).
create or replace function public.search_resource_posts(
  p_query text,
  p_content_type text default null,
  p_jurisdiction text default null,
  p_limit int default 12,
  p_offset int default 0
)
returns table (
  id uuid,
  slug text,
  title text,
  excerpt text,
  content_type text,
  jurisdiction text,
  difficulty text,
  published_at timestamptz,
  updated_at timestamptz,
  event_date date,
  is_featured boolean,
  featured_priority int,
  rank_score real,
  total_count bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  with q as (
    select
      websearch_to_tsquery('english', coalesce(p_query, '')) as tsq,
      lower(btrim(coalesce(p_query, ''))) as raw
  ),
  scored as (
    select
      p.id, p.slug, p.title, p.excerpt, p.content_type, p.jurisdiction, p.difficulty,
      p.published_at, p.updated_at, p.event_date, p.is_featured, p.featured_priority,
      -- Deterministic tiered score (spec §17/§18: understandable from code,
      -- no opaque "AI relevance"). Bands are spaced far enough apart that a
      -- lower-tier match can never outrank a higher tier; ts_rank_cd only
      -- breaks ties *within* the title/excerpt tiers.
      (
        case when lower(p.title) = (select raw from q) then 1000000 else 0 end
        + case when (select raw from q) <> '' and p.title ilike '%' || (select raw from q) || '%' then 100000 else 0 end
        + case when exists (
            select 1 from unnest(coalesce(p.aliases, array[]::text[])) as al(term)
            where lower(al.term) = (select raw from q)
          ) then 90000 else 0 end
        + case when exists (
            select 1 from unnest(coalesce(p.aliases, array[]::text[])) as al(term)
            where (select raw from q) <> '' and lower(al.term) like '%' || (select raw from q) || '%'
          ) then 80000 else 0 end
        + case when (select raw from q) <> '' and p.excerpt ilike '%' || (select raw from q) || '%' then 5000 else 0 end
        + case when exists (
            select 1 from public.resource_post_categories rpc
            join public.resource_categories rc on rc.id = rpc.category_id
            where rpc.post_id = p.id and (select raw from q) <> '' and lower(rc.name) like '%' || (select raw from q) || '%'
          ) then 500 else 0 end
        + case when exists (
            select 1 from public.resource_post_tags rpt
            join public.resource_tags rt on rt.id = rpt.tag_id
            where rpt.post_id = p.id and (select raw from q) <> '' and lower(rt.name) like '%' || (select raw from q) || '%'
          ) then 300 else 0 end
        -- Video transcript — lowest tier, per spec §84 ("must not push an
        -- irrelevant Video above an exact title match").
        + case when p.content_type = 'video' and exists (
            select 1 from public.resource_videos v
            where v.resource_post_id = p.id and (select raw from q) <> '' and v.transcript ilike '%' || (select raw from q) || '%'
          ) then 50 else 0 end
        + coalesce(ts_rank_cd(p.search_vector, (select tsq from q)), 0) * 10
      )::real as rank_score,
      count(*) over () as total_count
    from public.resource_posts p
    where
      -- Exact mirror of lib/resources/public/visibility.ts's
      -- applyPublicPostVisibility()/PUBLIC_STATUSES/PUBLIC_CONTENT_TYPES —
      -- spec §25's "reuse the certified equivalent" backstop.
      p.status in ('published', 'review_due')
      and p.visibility in ('public', 'unlisted')
      and p.published_at is not null
      and p.published_at <= now()
      and p.content_type in ('article', 'guide', 'fhip_explainer', 'video', 'glossary', 'money_update')
      and (p_content_type is null or p_content_type = 'all' or p.content_type = p_content_type)
      and (
        p_jurisdiction is null or p_jurisdiction = 'all'
        or (p_jurisdiction = 'global' and p.jurisdiction = 'global')
        or (p_jurisdiction <> 'global' and p.jurisdiction in (p_jurisdiction, 'global'))
      )
      and (
        (select raw from q) = ''
        or p.search_vector @@ (select tsq from q)
        or p.title ilike '%' || (select raw from q) || '%'
        or exists (select 1 from unnest(coalesce(p.aliases, array[]::text[])) as al(term) where lower(al.term) like '%' || (select raw from q) || '%')
        or exists (
            select 1 from public.resource_videos v
            where v.resource_post_id = p.id and v.transcript ilike '%' || (select raw from q) || '%'
          )
      )
  )
  select id, slug, title, excerpt, content_type, jurisdiction, difficulty, published_at, updated_at, event_date, is_featured, featured_priority, rank_score, total_count
  from scored
  order by rank_score desc, published_at desc nulls last, id
  limit greatest(p_limit, 0)
  offset greatest(p_offset, 0);
$$;

revoke all on function public.search_resource_posts(text, text, text, int, int) from public;
grant execute on function public.search_resource_posts(text, text, text, int, int) to anon, authenticated;

comment on function public.search_resource_posts is
  'R1.6 public Resources search (spec Part A). SECURITY INVOKER — runs under the caller''s own RLS, never service-role. Deterministic tiered ranking, no AI. Never returns money_update_template, draft, or any other non-public row — WHERE clause mirrors lib/resources/public/visibility.ts exactly, and the caller''s own RLS is a second, independent backstop underneath it.';

-- -----------------------------------------------------------------------------
-- 3. Public read of active FHIP contextual mappings (for readable posts only)
-- -----------------------------------------------------------------------------
-- Additive alongside 0033's existing "staff read context links" / "staff
-- manage context links" policies — this does not replace either. Mirrors
-- resource_related_content's "public read related links between readable
-- posts" policy pattern, keyed on resource_post_id instead of source_post_id,
-- and additionally requires is_active (spec §63: "Draft mapping does not
-- leak" / §98). Same PUBLIC_STATUSES subset as the search RPC above
-- (published/review_due only — deliberately narrower than the raw RLS-level
-- predicate elsewhere in this schema, which also allows archived; R1.5's
-- documented product decision excludes archived from every public surface,
-- and context links follow that same decision rather than inventing a wider
-- one here).
create policy "public read active context links to public posts" on resource_context_links for select
  using (
    is_active
    and exists (
      select 1 from resource_posts p
      where p.id = resource_post_id
        and p.status in ('published', 'review_due')
        and p.visibility in ('public', 'unlisted')
        and p.published_at is not null
        and p.published_at <= now()
        and p.content_type <> 'money_update_template'
    )
  );

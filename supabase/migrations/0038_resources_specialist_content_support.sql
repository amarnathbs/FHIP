-- =============================================================================
-- Resources / Financial Knowledge & Insights — R1.4 specialist content delta
-- =============================================================================
-- Additive, minimal (spec §10: "Before creating it, prove the existing schema
-- cannot support the required feature cleanly. Keep changes additive and
-- narrow."). Does not touch 0033-0037.
--
-- Pre-implementation audit (spec §9) found resource_posts/resource_videos/
-- resource_faqs/resource_post_faqs/resource_sources/resource_post_sources/
-- resource_context_links/resource_related_content already cover the large
-- majority of R1.4's data model with zero schema changes:
--   - Video: resource_videos already has youtube_video_id/url/channel,
--     duration, thumbnail_url, transcript, chapters (jsonb array),
--     embed_enabled. No change needed.
--   - Glossary: term/short-definition/detailed-explanation/example map to
--     resource_posts.title/excerpt/content_blocks exactly as R1.3 already
--     uses them for other content types. Related Terms maps directly onto
--     the existing resource_related_content table (relationship_type
--     'related', self-reference and duplicate-pair already blocked by its
--     existing constraints). No change needed for either.
--   - Money Update structured sections (What Happened / Why It Matters /
--     Who May Be Affected / Financial Health Impact / FHIP Relevance /
--     Official Sources) map onto content_blocks the same way R1.3's
--     starterTemplateFor() pre-populates headings for Article/Guide/FHIP
--     Explainer — a new specialist starter template function, not a schema
--     change. Authoritative-source linking reuses resource_sources /
--     resource_post_sources exactly as-is.
--   - FAQ ordering-per-post: resource_post_faqs.sort_order already exists
--     (spec §37: "If the current relationship table supports ordering,
--     allow post-specific FAQ order" — it already does).
--
-- Three genuine, narrow gaps remain, addressed below:
--
-- 1. resource_posts.event_date — Money Update's "Event Date" (spec §42) is
--    the real-world date the financial development occurred, which is a
--    distinct concept from every existing date column on resource_posts
--    (scheduled_at/published_at are FHIP-editorial-workflow dates;
--    expires_at/next_review_at are freshness dates). It is also a required
--    list column and filter/sort target (spec §41), which needs a real,
--    indexable column rather than something encoded inside content_blocks.
--
-- 2. resource_posts.affected_audience — Money Update's "Affected Audience"
--    (spec §42) is listed as a field distinct from "Summary / 30-second
--    explanation" (which reuses the existing `excerpt` column, same as
--    every other content type). No existing column represents it.
--
-- 3. resource_posts.aliases — Glossary's "Aliases / Synonyms" (spec §26)
--    must be searchable (spec §25/§72: "search by term/aliases/definition")
--    and duplicate-checkable, which requires a real queryable column, not
--    free text embedded in content_blocks. text[] rather than a join table:
--    aliases are simple short strings scoped entirely to one glossary term
--    (not a shared/reusable taxonomy the way tags are), so a normalised
--    child table would be overhead disproportionate to the actual need.
--
-- A fourth, narrower gap: resource_faqs (spec §34) needs a few fields the
-- R1.1 foundation table doesn't carry — short_answer (spec §34: "Short
-- Answer / Required" is conceptually distinct from the existing
-- answer_blocks, which better represents the optional "Expanded Answer"),
-- category_id (spec §33/§34 list this as both a list column and an editable
-- field; resource_categories already exists and is reused as-is, no new
-- taxonomy concept), compliance_classification (spec §34: "if FAQ schema
-- contains/needs governance classification" — narrow, GREEN-default, same
-- three-value model as resource_posts, so a shared FAQ can be judged for
-- editorial risk the same way a post can), and updated_by (spec §57: "If
-- FAQ schema supports updated_at, use equivalent stale protection where
-- practical" — resource_faqs already has updated_at; updated_by is the
-- companion audit column every other Resources table already carries).

-- -----------------------------------------------------------------------------
-- 1. resource_posts: three new nullable columns for Money Update / Glossary.
-- -----------------------------------------------------------------------------
alter table resource_posts add column event_date date;
alter table resource_posts add column affected_audience text;
alter table resource_posts add column aliases text[];

comment on column resource_posts.event_date is
  'R1.4 — the real-world date a Money Update''s financial development occurred (not an FHIP editorial-workflow date). Null for content types other than money_update/money_update_template.';
comment on column resource_posts.affected_audience is
  'R1.4 — Money Update''s "Who may be affected" short summary field (spec §42). Null for content types other than money_update/money_update_template.';
comment on column resource_posts.aliases is
  'R1.4 — Glossary term aliases/search synonyms (spec §26), e.g. {Emergency Fund, Rainy Day Fund, Cash Buffer}. Null/empty for content types other than glossary.';

create index idx_resource_posts_event_date on resource_posts(event_date);
-- GIN + pg_trgm would give substring-in-array search; this project's other
-- text search (sanitizeSearchTerm + ilike, lib/resources/admin/queries.ts)
-- does not use trigram indexes anywhere else either, and the Glossary table
-- is tiny (dozens of rows, spec §1's approved master lists 50 definitions
-- total) — a sequential scan over `aliases` is not a real performance
-- concern at this scale, so no extension/index is added for it here.

-- Column-scoped UPDATE grant (spec §57/§99 pattern, migration 0033/0037):
-- these three columns must be explicitly added to the authenticated
-- column-allowlist or they are silently unwritable by ordinary staff saves
-- (PostgREST enforces column grants; the existing grant list from 0033 is a
-- fixed allowlist, not "every column except the ones explicitly revoked").
grant update (event_date, affected_audience, aliases) on resource_posts to authenticated;

-- -----------------------------------------------------------------------------
-- 2. resource_faqs: governance/categorisation/short-answer columns.
-- -----------------------------------------------------------------------------
alter table resource_faqs add column short_answer text;
alter table resource_faqs add column category_id uuid references resource_categories(id) on delete set null;
alter table resource_faqs add column compliance_classification text not null default 'green'
  check (compliance_classification in ('green', 'amber', 'red'));
alter table resource_faqs add column updated_by uuid references auth.users(id) on delete set null;

comment on column resource_faqs.short_answer is
  'R1.4 — required standalone-usable short answer (spec §34/§35). Nullable at the DB level (table pattern established by 0033: required-for-workflow fields are nullable in the DB and enforced by application-level validation, e.g. resource_posts.primary_category_id) — enforced by lib/resources/faq/validation.ts before a FAQ can be marked active.';
comment on column resource_faqs.category_id is
  'R1.4 — optional FAQ category, reusing the existing resource_categories taxonomy (spec §106: do not build a parallel category concept).';
comment on column resource_faqs.compliance_classification is
  'R1.4 — GREEN/AMBER/RED governance classification for a standalone FAQ (spec §34), same three-value model as resource_posts.compliance_classification. FAQs are never routed through public.transition_resource_post_status (they are not resource_posts rows) — this column is informational/editorial only in R1.4, there is no FAQ-specific compliance workflow RPC.';

create index idx_resource_faqs_category on resource_faqs(category_id);
create index idx_resource_faqs_compliance on resource_faqs(compliance_classification);

-- resource_faqs already has unrestricted (non-column-scoped) insert/update
-- grants to `authenticated` from migration 0033
-- (`grant insert, update, delete on resource_sources, resource_faqs to
-- authenticated;`), gated by the existing "staff manage faqs" RLS policy —
-- no grant change needed for the new columns.

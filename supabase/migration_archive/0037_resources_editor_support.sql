-- =============================================================================
-- Resources / Financial Knowledge & Insights — R1.3 editor support delta
-- =============================================================================
-- Additive, minimal (spec §8: "Avoid a migration if the current schema
-- already supports the requirement" — checked first; it does not for this
-- one specific column). Does not touch 0033-0036.
--
-- Genuine gap found during the R1.3 pre-implementation schema audit:
-- 0033's column-scoped UPDATE grant on resource_posts (the "authors insert
-- own drafts" / "staff update posts" RLS-plus-column-privilege pair that
-- lets content-workflow staff edit ordinary content fields directly, without
-- going through the SECURITY DEFINER transition RPC) lists every editable
-- content column EXCEPT compliance_classification:
--
--   grant update (
--     title, slug, excerpt, content_blocks, content_type, jurisdiction, difficulty,
--     freshness_type, visibility, primary_category_id, featured_image_id, author_id,
--     reviewer_id, compliance_reviewer_id, expires_at, last_reviewed_at, next_review_at,
--     seo_title, seo_description, canonical_url, social_image_id, is_indexable,
--     primary_cta_id, secondary_cta_id, is_featured, featured_priority, updated_by, updated_at
--   ) on resource_posts to authenticated;
--
-- R1.1 never needed this column writable (no editor existed yet — INSERT is
-- unrestricted, so a post's *initial* classification could be set at
-- creation, but never revised afterwards by anyone other than service-role).
-- R1.3 spec §53-56 requires the editor to let authorised staff manage GREEN/
-- AMBER/RED as ordinary content metadata (same governance tier as
-- jurisdiction/difficulty — any Resources-workflow staff member, not a
-- privileged-only operation), so this is a genuine, narrow requirement this
-- migration exists to satisfy.
--
-- This does NOT weaken the R1.1 security boundary: it only widens the
-- *column* privilege ceiling for a role/row-set that already has RLS UPDATE
-- access to the row (private.is_resource_staff() via the existing "staff
-- update posts" policy, unchanged here). It does not touch `status` or any
-- of the four approval columns / scheduled_at / published_at — those remain
-- exclusively reachable through public.transition_resource_post_status(),
-- exactly as before. The existing hard backstops
-- (chk_resource_posts_amber_requires_compliance,
-- chk_resource_posts_red_never_publishes) are unaffected and continue to
-- apply regardless of what compliance_classification value a direct UPDATE
-- sets, because those constraints are keyed off `status`, and `status` is
-- still only writable via the RPC.

grant update (compliance_classification) on resource_posts to authenticated;

comment on column resource_posts.compliance_classification is
  'GREEN/AMBER/RED editorial-compliance classification. Editable by any Resources content-workflow staff role via ordinary column UPDATE (RLS: "staff update posts") as of migration 0037 — R1.1 (0033) omitted this column from the authenticated UPDATE grant, which blocked reclassification after creation. status and the four approval columns remain reachable only via public.transition_resource_post_status().';

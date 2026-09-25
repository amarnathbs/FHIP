-- 0202 -- Investment Intelligence AI-extraction reviews: the owner may READ
-- their staged reviews; only the server writes them. (2026-09-25, other-PDF
-- AI proof.) REQUIRES 0160 (which creates the table) to be applied first.
--
-- WHY. 0160 gave the owner a `for all` policy on ii_ai_extraction_reviews.
-- With AI review-before-write restored in the application (an AI read is
-- staged here and written to canonical ii_* rows only when the user accepts),
-- this table is the gate between an AI reading and the user's holdings. Under
-- the `for all` policy the owner could, over PostgREST, directly:
--   * INSERT a review row with any holdings they like, never produced by any
--     upload or AI call, then accept it -- which also inserts provisional rows
--     into the SHARED instrument universe (ii_instruments), not just their own
--     data;
--   * UPDATE an accepted review back to pending_review (or rewrite its
--     extracted_holdings) and accept it again, defeating the accept-once
--     claim.
-- The application writes this table only with the service role
-- (aiFallbackDocumentExtraction.ts, aiExtractionReviewApply.ts); the one
-- user-client read is GET /api/investment-intelligence/ai-extraction-reviews/
-- {id}, which stays allowed.
--
-- Same shape as 0197 (fdh_ai_fallback_drafts). Replaces a POLICY only; no
-- CHECK constraint is dropped or recreated, no data is touched, no
-- per-environment values. Idempotent.

drop policy if exists "own ii_ai_extraction_reviews" on ii_ai_extraction_reviews;
drop policy if exists "owner reads own ii_ai_extraction_reviews" on ii_ai_extraction_reviews;
create policy "owner reads own ii_ai_extraction_reviews" on ii_ai_extraction_reviews
  for select using (auth.uid() = user_id);

alter table ii_ai_extraction_reviews enable row level security;

revoke all on table ii_ai_extraction_reviews from anon;
revoke insert, update, delete, truncate on table ii_ai_extraction_reviews from authenticated;
grant select on table ii_ai_extraction_reviews to authenticated;
grant all on table ii_ai_extraction_reviews to service_role;

comment on table ii_ai_extraction_reviews is
  '0160/0202: AI-read holdings staged for the owner''s review; written only by the server; accepted (written to canonical ii_* rows) at most once.';

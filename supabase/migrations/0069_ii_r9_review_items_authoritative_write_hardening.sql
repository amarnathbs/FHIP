-- Investment Intelligence R9 -- close a same-user authoritative-write gap
-- on ii_review_items, found live during R9's own live-DEV certification
-- (LIVE-R9-019b/019c).
--
-- NUMBERING NOTE: this migration was drafted as 0068 during initial work,
-- then renumbered to 0069 because a separate, parallel FDH release (R8 --
-- Transaction Categorisation & Merchant Intelligence) independently and
-- legitimately claimed 0068 on its own sibling branch and is already live
-- on DEV under that number. Rather than repeat the exact class of
-- migration-number collision this project has now hit multiple times,
-- R9's own follow-up work simply moves to the next genuinely free number.
-- No renumbering of any already-applied migration (0067 or 0068) occurs
-- here.
--
-- ===========================================================================
-- FINDING (2026-08-23, R9 live-DEV certification,
-- scripts/ii_r9_live_dev_certification.mjs, LIVE-R9-019b/019c): SAME-USER
-- FORGERY -- CONFIRMED, NOT HYPOTHETICAL.
-- ===========================================================================
-- migration 0067's own RLS policy on ii_review_items is a single
-- "for all using (auth.uid() = user_id) with check (auth.uid() = user_id)"
-- -- the exact defect class this project has now found and fixed
-- repeatedly (ii_r4/r5_analytics_results, fdh_statement_uploads.
-- reconciliation_status, fdh_transactions' own R8 classification fields):
-- row-level ownership is enforced, but every COLUMN on an owned row is
-- freely writable, including columns that are meant to be exclusively
-- system/engine-authoritative.
--
-- LIVE, REPRODUCED, CONFIRMED (this session's own live-DEV run):
--   * Authenticated as a REAL user (own JWT, not anon/service-role), a raw
--     PATCH to `/rest/v1/ii_review_items?id=eq.<their own real row>` with
--     body `{"severity":"high","status":"resolved"}` returned HTTP 200 and
--     the row's severity/status were genuinely changed -- a user can
--     directly overwrite their own review item's system-computed severity
--     and short-circuit it straight to 'resolved' (a status only the
--     engine should ever set), completely bypassing the deterministic
--     rule engine.
--   * A second PATCH forging `evidence` (`{"forged":true,
--     "unallocatedValue":999999999}`) against the same row ALSO succeeded.
-- Both were restored to their correct values via the service-role client
-- immediately after being reproduced; no incorrect data was left in DEV.
--
-- FIX: split the single "for all" policy into a SELECT-only policy for the
-- owning user (mirrors the exact precedent set by migration 0062's fix for
-- ii_capital_gains_computations/ii_tax_lot_consumptions/ii_tax_lots), and
-- add a BEFORE UPDATE trigger that permits the authenticated role to make
-- ONLY the two legitimate, already-shipped user actions -- 'open' ->
-- 'acknowledged' and {'open','acknowledged'} -> 'dismissed', together with
-- their own paired timestamp/note columns -- while blocking every other
-- column change and every other status transition outright. Both
-- acknowledgeReviewItem() and dismissReviewItem()
-- (lib/services/investment-intelligence/reviewCentreData.ts) already write
-- through the ordinary RLS-scoped client, not service-role, so this
-- trigger's permitted-transition set is derived directly from what that
-- already-shipped code actually does -- verified by re-running both
-- LIVE-R9-017 (the legitimate acknowledge/resolve/dismiss lifecycle case)
-- and LIVE-R9-019b/019c against this fix before it was considered done.
-- INSERT and DELETE are blocked outright for the authenticated role: every
-- ii_review_items row is created exclusively by
-- runReviewCentreRefresh()/resolveVanishedItems() via the service-role
-- admin client, and rows are never meant to be hard-deleted by a user.
-- ===========================================================================

drop policy if exists "own ii_review_items" on ii_review_items;
create policy "read own ii_review_items" on ii_review_items
  for select using (auth.uid() = user_id);
-- RLS grants row-level UPDATE on an owned row (matching the established
-- precedent: RLS controls WHICH rows, the trigger below controls WHICH
-- COLUMNS) -- acknowledgeReviewItem()/dismissReviewItem() write through
-- this ordinary RLS-scoped path, not service-role. No insert/delete policy
-- exists for the authenticated role at all: every row is created
-- exclusively by the service-role engine, and rows are never meant to be
-- hard-deleted by a user.
create policy "update own ii_review_items" on ii_review_items
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

create or replace function ii_review_items_assert_authoritative_write() returns trigger as $$
begin
  if auth.role() = 'authenticated' then
    -- Every column except status/user_note/acknowledged_at/dismissed_at/
    -- updated_at must be byte-identical to the existing row -- these are
    -- exclusively engine-authoritative.
    if new.review_type is distinct from old.review_type
      or new.category is distinct from old.category
      or new.severity is distinct from old.severity
      or new.compliance_classification is distinct from old.compliance_classification
      or new.title is distinct from old.title
      or new.description is distinct from old.description
      or new.evidence is distinct from old.evidence
      or new.source_module is distinct from old.source_module
      or new.source_record_id is distinct from old.source_record_id
      or new.source_record_version is distinct from old.source_record_version
      or new.review_engine_version is distinct from old.review_engine_version
      or new.rule_key is distinct from old.rule_key
      or new.rule_version is distinct from old.rule_version
      or new.identity_key is distinct from old.identity_key
      or new.as_of_date is distinct from old.as_of_date
      or new.superseded_by_id is distinct from old.superseded_by_id
      or new.resolved_at is distinct from old.resolved_at
      or new.user_id is distinct from old.user_id
    then
      raise exception 'ii_review_items: authoritative fields may not be written directly by the authenticated role';
    end if;

    -- The status transition itself must be exactly one of the two shipped
    -- user actions. Anything else (including a no-op same-value "change"
    -- used to smuggle a status value through, or any transition into
    -- 'resolved'/'superseded'/'open') is rejected.
    if new.status is distinct from old.status then
      if not (
        (old.status = 'open' and new.status = 'acknowledged')
        or (old.status in ('open', 'acknowledged') and new.status = 'dismissed')
      ) then
        raise exception 'ii_review_items: status may only move open->acknowledged or {open,acknowledged}->dismissed via the authenticated role';
      end if;
    end if;
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger trg_ii_review_items_authoritative_write
  before update on ii_review_items
  for each row execute function ii_review_items_assert_authoritative_write();

-- INSERT/DELETE: no authenticated-role policy exists for either (only the
-- SELECT policy above), so both are already refused by RLS with no
-- authenticated grant -- documented here for completeness, no additional
-- object needed.

-- Investment Intelligence R11 -- close a same-user authoritative-write gap
-- on ii_transactions and ii_reconciliation_cases, found live during R11's
-- own terminal-closure professional-access live-DEV certification
-- (LIVE-R11-P11: "Same-user authoritative forgery").
--
-- NUMBERING: allocated fresh at 0087, the next genuinely free number after
-- R11's own frozen 0082/0083/0086 (see R11_ACCEPTANCE_REPORT.md /
-- migration-collision-history docs -- 0084 is SMSF/Jurisdiction
-- Segregation, 0085 is FDH-8's split-approval work, both already live on
-- DEV under those numbers on their own branches). 0082/0083/0086 are NOT
-- touched, edited, or renumbered by this migration -- this file is purely
-- additive, matching the exact precedent set by 0065 (R7 reconciliation-
-- status forgery) and 0069 (R9 ii_review_items authoritative-write
-- hardening), both closing the identical defect class on other II/FDH
-- tables in prior rounds.
--
-- ===========================================================================
-- FINDING (2026-08-25, R11 terminal-closure live-DEV professional-access
-- certification, scripts/r11_professional_live_dev_tests.ts, LIVE-R11-P11):
-- SAME-USER AUTHORITATIVE FORGERY -- CONFIRMED LIVE, NOT HYPOTHETICAL.
-- ===========================================================================
-- Both ii_transactions (migration 0033) and ii_reconciliation_cases
-- (migration 0035) carry a single "for all using (auth.uid() = user_id)
-- with check (auth.uid() = user_id)" policy -- the exact recurring defect
-- class this project has now found and fixed repeatedly (ii_review_items in
-- 0069, fdh_statement_uploads.reconciliation_status in 0065, R8's
-- classification fields in 0068): row-level OWNERSHIP is enforced, but
-- every COLUMN on an owned row is freely writable by the owning user,
-- including columns meant to be exclusively system/engine-authoritative.
--
-- LIVE, REPRODUCED, CONFIRMED this round (real DEV, real user JWT, real own
-- row, restored via service-role immediately after reproduction -- see
-- R11_ACCEPTANCE_REPORT.md for the exact reproduction transcript):
--   * A raw PATCH to /rest/v1/ii_transactions?id=eq.<own real row>` with
--     body {"status":"review_required"} returned HTTP 200 and genuinely
--     changed the row -- a user can directly force their own transaction
--     into review_required (or any other status), a value meant to be
--     exclusively set by documentProcessing.ts's cross-source conflict
--     detection.
--   * A raw PATCH to `/rest/v1/ii_reconciliation_cases?id=eq.<own real
--     case>` with body {"status":"resolved","resolution_method":
--     "auto_resolved_cross_source_precedence","resolved_by_actor_type":
--     "system"} ALSO returned HTTP 200 -- a user can impersonate the
--     SYSTEM's own auto-resolution outcome on their own conflict case,
--     which is a materially different and more trusted signal downstream
--     (R11's precedence-based auto-resolution, spec section 30) than an
--     ordinary user manually clicking "resolve".
--
-- FIX
-- ---
-- ii_transactions: NO legitimate authenticated-role write path exists
-- anywhere in the app (verified: every insert/update in
-- manualImporter.ts/documentProcessing.ts uses the service-role admin
-- client exclusively; grep across app/ + lib/ for `.update(`/`.insert(`/
-- `.upsert(` against 'ii_transactions' finds zero authenticated-client call
-- sites). The "for all" policy is replaced with SELECT-only for the owner,
-- exactly the same shape as professional_relationships / ii_review_items'
-- INSERT/DELETE handling -- no authenticated grant at all means RLS refuses
-- outright, no trigger needed.
--
-- ii_reconciliation_cases DOES have one legitimate authenticated write path
-- -- app/api/investment-intelligence/reconciliation-cases/[id]/resolve/route.ts,
-- which lets a user resolve their OWN case (status -> 'resolved',
-- resolved_at/resolution_method/resolved_by set, resolved_by_actor_type
-- always hardcoded 'user' by that route, never client-supplied). RLS is
-- split into SELECT + a narrower UPDATE policy (still row-scoped by
-- ownership), and a BEFORE UPDATE trigger closes the column/value gap the
-- route's own hardcoding does NOT protect against once a caller bypasses
-- the route and goes straight to PostgREST: resolved_by_actor_type can
-- never become 'system' via the authenticated role (only service-role,
-- i.e. documentProcessing.ts's real auto-resolution, may set it), the R11
-- auto-resolution method value can never be self-assigned by a user, every
-- other discrepancy-classification/provenance column
-- (discrepancy_type/discrepancy_details/subject_type/subject_id/severity/
-- source_document_id/evidence/opened_at/user_id) is immutable to the
-- authenticated role, resolved_by must equal the caller's own auth.uid()
-- (never impersonate a different resolver), and the only status transition
-- permitted is into 'resolved' (mirrors the one shipped user action;
-- INSERT/DELETE remain refused outright, as before -- no authenticated
-- policy grants either).
--
-- Deliberately NOT touched (documented, out of R11's remit, pre-existing
-- R2-era laxity, flagged separately for its own follow-up): the resolve
-- route's own zod enum currently also accepts 'admin_override' and
-- 'auto_resolved_on_reparse' as a plain user-submitted resolutionMethod
-- value, which is a softer instance of the same provenance-labelling
-- concern but predates R11, is not part of R11's cross-source feature, and
-- redesigning that route's validation is out of this round's authorised
-- scope (do not expand professional functionality / redesign R11).
-- ===========================================================================

drop policy if exists "own ii_transactions" on ii_transactions;
create policy "read own ii_transactions" on ii_transactions
  for select using (auth.uid() = user_id);
-- No insert/update/delete policy for authenticated at all -- every write is
-- exclusively via the service-role admin client (documentProcessing.ts /
-- manualImporter.ts), verified above; RLS refuses any authenticated write
-- outright, matching professional_relationships' identical write model.

drop policy if exists "own ii_reconciliation_cases" on ii_reconciliation_cases;
create policy "read own ii_reconciliation_cases" on ii_reconciliation_cases
  for select using (auth.uid() = user_id);
create policy "resolve own ii_reconciliation_cases" on ii_reconciliation_cases
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
-- No insert/delete policy for authenticated -- every case is opened
-- exclusively by documentProcessing.ts via the service-role client, and
-- cases are never meant to be hard-deleted by a user.

create or replace function ii_reconciliation_cases_assert_authoritative_write() returns trigger as $$
begin
  if auth.role() = 'authenticated' then
    -- Every column except status/resolved_at/resolution_method/resolved_by
    -- must be byte-identical to the existing row -- these are exclusively
    -- system/engine-authoritative (discrepancy classification, subject
    -- identity, severity, source provenance, evidence, ownership).
    if new.subject_type is distinct from old.subject_type
      or new.subject_id is distinct from old.subject_id
      or new.discrepancy_type is distinct from old.discrepancy_type
      or new.discrepancy_details is distinct from old.discrepancy_details
      or new.severity is distinct from old.severity
      or new.source_document_id is distinct from old.source_document_id
      or new.evidence is distinct from old.evidence
      or new.opened_at is distinct from old.opened_at
      or new.user_id is distinct from old.user_id
    then
      raise exception 'ii_reconciliation_cases: authoritative fields may not be written directly by the authenticated role';
    end if;

    -- The one shipped user action (resolve/[id]/resolve/route.ts) only ever
    -- moves status -> 'resolved'. Any other transition (including a no-op
    -- same-value "change" used to smuggle a value through, or a move into
    -- 'user_reviewing'/'dismissed'/back to 'open') is rejected.
    if new.status is distinct from old.status and new.status <> 'resolved' then
      raise exception 'ii_reconciliation_cases: status may only move to resolved via the authenticated role';
    end if;

    -- System provenance can never be claimed by an authenticated user --
    -- this is the exact field the live forgery attempt (LIVE-R11-P11)
    -- exploited.
    if new.resolved_by_actor_type is distinct from old.resolved_by_actor_type
       and new.resolved_by_actor_type = 'system' then
      raise exception 'ii_reconciliation_cases: resolved_by_actor_type may not be set to system by the authenticated role';
    end if;

    -- R11's own precedence-based auto-resolution method is exclusively
    -- system-authoritative (documentProcessing.ts) -- a user resolving
    -- their own case can never self-label it as the engine's automatic
    -- cross-source precedence outcome.
    if new.resolution_method is distinct from old.resolution_method
       and new.resolution_method = 'auto_resolved_cross_source_precedence' then
      raise exception 'ii_reconciliation_cases: resolution_method auto_resolved_cross_source_precedence may not be self-assigned by the authenticated role';
    end if;

    -- A resolver can only ever claim to be themselves, never impersonate a
    -- different actor id.
    if new.resolved_by is distinct from old.resolved_by
       and new.resolved_by is distinct from auth.uid() then
      raise exception 'ii_reconciliation_cases: resolved_by must equal the caller''s own auth.uid()';
    end if;
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger trg_ii_reconciliation_cases_authoritative_write
  before update on ii_reconciliation_cases
  for each row execute function ii_reconciliation_cases_assert_authoritative_write();

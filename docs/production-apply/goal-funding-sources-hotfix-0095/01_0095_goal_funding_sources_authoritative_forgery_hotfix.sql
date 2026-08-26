-- goal_funding_sources same-user/cross-tenant authoritative-forgery hotfix.
-- STANDALONE SECURITY FIX, extracted from migration 0093 ("Education Fund /
-- Children Investment -> Goal Linkage").
--
-- WHY THIS EXISTS AS ITS OWN MIGRATION, SEPARATE FROM 0093:
-- 0093 bundles this genuine security fix together with unrelated Goal
-- Linkage feature work (retiring education_fund/children_investment from
-- new-investment creation, and a conservative deterministic backfill
-- auto-linking legacy investment rows to education goals). Goal Linkage's
-- own feature certification and UI are a separate release with its own
-- timeline. The security defect below, by contrast, is fully certified
-- (PGlite negative control with a genuine RED->GREEN + live-DEV
-- reproduction against the real DEV database, both independently
-- reproduced) and affects an already-live production table (migration 0009)
-- -- it should not wait on Goal Linkage's unrelated feature timeline. This
-- migration is the exact security-only subsection of 0093's section 2,
-- verbatim, with no dependency on 0093's section 1 (catalogue
-- deactivation) or section 3 (backfill) -- confirmed by inspection, this
-- file touches only goal_funding_sources' trigger and RLS policy.
--
-- 0093 itself is NOT modified, edited, or renumbered by this file -- it
-- remains exactly as committed on the education-goal-linkage branch, not
-- yet merged. Applying 0093 in full at a later date (when Goal Linkage
-- ships) will re-run this same trigger-function/trigger/policy definition
-- -- `create or replace function`, `drop trigger if exists` + `create
-- trigger`, and `drop policy if exists` + `create policy` are all safe to
-- re-run (the CREATE POLICY step is NOT silently idempotent on its own --
-- see the note this project already learned from the 0094 hotfix hitting
-- `42710: policy already exists` on a naive second run -- but re-applying
-- 0093 in full after this hotfix requires deleting the old policy name
-- first, which 0093's own `drop policy if exists "own goal funding
-- sources"` already does correctly, since 0095 and 0093 use the IDENTICAL
-- policy name "own goal funding sources", not two different names --
-- confirmed by direct comparison below).
--
-- THE DEFECT (found live during Goal Linkage's own GL-0 discovery, not
-- hypothetical -- the same defect class this project has now found and
-- fixed seven times: 0065, 0069, 0087, SMSF 0090, this same day's II
-- 0094, and this): migration 0009's original goal_funding_sources RLS
-- policy was `auth.uid() = user_id` on BOTH using and with check -- it
-- never verifies that goal_id, linked_asset_id, linked_investment_id or
-- linked_retirement_id actually belong to that same user_id. A user whose
-- own user_id is legitimately their own could still reference another
-- tenant's goal or another tenant's asset/investment/retirement row purely
-- by guessing its UUID -- the foreign key only proves the referenced row
-- exists, not who owns it (the exact Property<->Liability-Linking finding
-- that produced the 0078 fix).
--
-- Independently reproduced live, today, against real DEV (not
-- theoretical): Tenant A linked their own goal to Tenant B's PRIVATE
-- investment using only Tenant A's own JWT -- genuine HTTP 201, the forged
-- cross-tenant reference genuinely persisted, then cleaned up via service
-- role. goal_funding_sources also exists in production (confirmed via
-- read-only REST) -- this defect class is schema-level, not DEV-specific,
-- so it is reasonably suspected to also be live in production, though not
-- behaviorally confirmed there without your separate authorization to
-- create synthetic data in production.
--
-- THE FIX: a TRIGGER is used (not RLS alone), because TWO live write paths
-- reach this table -- the goals-side route (a normal RLS-governed
-- user-scoped client) AND the Investment-Intelligence-side sync
-- (lib/services/investment-intelligence/goalAllocations.ts, which writes
-- through the SERVICE-ROLE admin client and therefore bypasses RLS
-- entirely). RLS alone would leave the II write path unguarded at the
-- database layer. A BEFORE INSERT/UPDATE trigger fires for every role,
-- service_role included -- true defense in depth. Legitimate writes are
-- unaffected: every existing caller already only ever submits a
-- goal_id/linked_*_id it has separately verified belongs to the same
-- user_id, so this trigger never rejects real traffic, only forged
-- cross-tenant references. RLS's own WITH CHECK also gains the identical
-- ownership clauses, so a direct PostgREST call under a real user JWT is
-- rejected by RLS before it ever reaches the trigger (belt and suspenders).

begin;

create or replace function gfs_enforce_ownership() returns trigger as $$
begin
  if not exists (select 1 from user_goals where id = new.goal_id and user_id = new.user_id) then
    raise exception 'goal_funding_sources: goal % is not owned by user %', new.goal_id, new.user_id
      using errcode = '42501';
  end if;
  if new.linked_asset_id is not null and not exists (select 1 from assets where id = new.linked_asset_id and user_id = new.user_id) then
    raise exception 'goal_funding_sources: linked asset % is not owned by user %', new.linked_asset_id, new.user_id
      using errcode = '42501';
  end if;
  if new.linked_investment_id is not null and not exists (select 1 from investments where id = new.linked_investment_id and user_id = new.user_id) then
    raise exception 'goal_funding_sources: linked investment % is not owned by user %', new.linked_investment_id, new.user_id
      using errcode = '42501';
  end if;
  if new.linked_retirement_id is not null and not exists (select 1 from retirement_accounts where id = new.linked_retirement_id and user_id = new.user_id) then
    raise exception 'goal_funding_sources: linked retirement account % is not owned by user %', new.linked_retirement_id, new.user_id
      using errcode = '42501';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists trg_gfs_enforce_ownership on goal_funding_sources;
create trigger trg_gfs_enforce_ownership
  before insert or update of goal_id, user_id, linked_asset_id, linked_investment_id, linked_retirement_id
  on goal_funding_sources
  for each row execute function gfs_enforce_ownership();

-- RLS WITH CHECK hardening -- the same ownership checks as the trigger
-- above, expressed at the policy layer too. USING is unchanged (auth.uid()
-- = user_id already correctly scopes reads/updates/deletes to one's own
-- rows); only WITH CHECK gains the referenced-row ownership clauses.
drop policy if exists "own goal funding sources" on goal_funding_sources;
create policy "own goal funding sources" on goal_funding_sources
  for all
  using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and goal_id in (select id from user_goals where user_id = auth.uid())
    and (linked_asset_id is null or linked_asset_id in (select id from assets where user_id = auth.uid()))
    and (linked_investment_id is null or linked_investment_id in (select id from investments where user_id = auth.uid()))
    and (linked_retirement_id is null or linked_retirement_id in (select id from retirement_accounts where user_id = auth.uid()))
  );

commit;

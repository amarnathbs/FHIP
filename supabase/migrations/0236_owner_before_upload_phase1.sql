-- 0236 -- Owner-before-upload, PHASE 1: the document-level owner.
--
-- The user now says WHICH OWNER a document belongs to before the file is sent
-- (Self, Spouse / another household member, Joint with each owner's share,
-- Trust, HUF -- India only, Company -- only if the user created one, SMSF -- AU
-- only). Phase 1 covers the bank-statement upload and the India CAS upload.
-- This migration gives the DOCUMENT somewhere to keep that answer.
--
-- WHAT THIS ADDS (everything nullable, no rewrite, no backfill):
--   fdh_statement_uploads   owner_member_id, owner_business_entity_id,
--                           owner_role, owner_selection_source,
--                           owner_allocation (jsonb; joint split, AU investment)
--   ii_source_documents     owner_business_entity_id, owner_role,
--                           owner_selection_source, owner_allocation (jsonb),
--                           owner_review (jsonb)
--                           (owner_member_id already exists since 0032)
--
-- WHAT THIS DELIBERATELY DOES NOT DO
--   * It does not touch ii_ownership_allocation (0153). A joint / entity-owned
--     statement's per-ACCOUNT split is written there by the application, as PC5
--     already does. This migration only stores, on the document, the JSON of
--     what the user chose (`owner_allocation`) so the intent survives a later
--     amendment of an account's allocation. Reusing 0153 rather than creating a
--     second allocation table keeps one place that enforces one-owner-kind per
--     row, amendment-by-supersession and the RLS shape.
--   * It does not widen any existing CHECK constraint (the trap that silently
--     revoked sibling values in 0185 vs 0180): every constraint here is NEW and
--     named for this migration.
--   * It does not backfill. Existing documents keep NULL owner columns until
--     the PO runs docs/ownership/owner_before_upload_phase1_backfill.sql, a
--     reviewable script that copies owners from existing records and marks the
--     rest 'legacy_unset'. Nothing is invented.
--   * It changes no RLS policy. Both tables keep their existing "own rows"
--     policies. The new columns are writable by the owner of the row exactly
--     like every other column on it, so the cross-tenant guard below is what
--     stops a caller attaching ANOTHER user's household member or entity.
--
-- "EXACTLY ONE OWNER KIND", AS 0153 DOES -- adapted. 0153's rows are always
-- one member OR one entity. A DOCUMENT may also be 'joint' (no single id; the
-- split is in owner_allocation) or 'smsf' (no id; the SMSF lives in smsf_funds,
-- it is not a business entity), so the document rule is "AT MOST one of member /
-- entity", plus: an entity id requires an entity-compatible owner_role, a joint
-- selection requires a valid allocation, and a user-selected owner requires an
-- owner_role.
--
-- DISCIPLINE: additive, idempotent (safe to run twice), guarded (refuses to run
-- on a database missing the tables it extends), RLS-safe (no policy touched).

-- ---------------------------------------------------------------------------
-- Guard: refuse to run against a database that lacks what this extends.
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.fdh_statement_uploads') is null then
    raise exception '0236: public.fdh_statement_uploads does not exist -- apply the FDH migrations first';
  end if;
  if to_regclass('public.ii_source_documents') is null then
    raise exception '0236: public.ii_source_documents does not exist -- apply the Investment Intelligence migrations first';
  end if;
  if to_regclass('public.household_members') is null or to_regclass('public.business_entities') is null then
    raise exception '0236: public.household_members / public.business_entities do not exist';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- A. fdh_statement_uploads
-- ---------------------------------------------------------------------------
alter table public.fdh_statement_uploads
  add column if not exists owner_member_id uuid references public.household_members(id) on delete set null,
  add column if not exists owner_business_entity_id uuid references public.business_entities(id) on delete set null,
  add column if not exists owner_role text,
  add column if not exists owner_selection_source text,
  add column if not exists owner_allocation jsonb;

comment on column public.fdh_statement_uploads.owner_role is
  'Owner-before-upload (0236): the canonical FHIP owner role the user chose for THIS document (lib/constants OWNER_VALUES). NULL = not recorded (legacy). Never nulled by the purge lifecycle.';
comment on column public.fdh_statement_uploads.owner_selection_source is
  'Owner-before-upload (0236): user_selected = chosen on the upload form; backfill_from_account / backfill_from_document = copied from an existing record by the reviewed backfill script; legacy_unset = no owner was ever recorded.';

-- ---------------------------------------------------------------------------
-- B. ii_source_documents (owner_member_id exists since 0032)
-- ---------------------------------------------------------------------------
alter table public.ii_source_documents
  add column if not exists owner_business_entity_id uuid references public.business_entities(id) on delete set null,
  add column if not exists owner_role text,
  add column if not exists owner_selection_source text,
  add column if not exists owner_allocation jsonb,
  add column if not exists owner_review jsonb;

comment on column public.ii_source_documents.owner_allocation is
  'Owner-before-upload (0236): for a joint statement, the split the user chose -- a JSON array of {ownerMemberId | ownerBusinessEntityId, basisPoints} summing to exactly 10000. The per-account split itself lives in ii_ownership_allocation (0153).';
comment on column public.ii_source_documents.owner_review is
  'Owner-before-upload (0236): NON-BLOCKING owner notes written by processing -- {conflicts: folios already filed under a different owner and left unchanged pending the user''s confirmation, warnings: printed-holder-name disagreements, appliedAccountIds}. Advisory; never a blocking reconciliation case.';

-- ---------------------------------------------------------------------------
-- C. Joint allocation shape check (pure, immutable -- usable in a CHECK).
-- ---------------------------------------------------------------------------
create or replace function public.owner_before_upload_allocation_ok(p_alloc jsonb)
returns boolean
language plpgsql
immutable
as $$
declare
  v_elem jsonb;
  v_total bigint := 0;
  v_count int := 0;
  v_seen text[] := '{}';
  v_key text;
  v_bp numeric;
begin
  if p_alloc is null or jsonb_typeof(p_alloc) <> 'array' then
    return false;
  end if;
  for v_elem in select * from jsonb_array_elements(p_alloc) loop
    v_count := v_count + 1;
    if jsonb_typeof(v_elem) <> 'object' then return false; end if;
    -- exactly one owner identity per element
    if (v_elem ? 'ownerMemberId') = (v_elem ? 'ownerBusinessEntityId') then return false; end if;
    v_key := coalesce(v_elem->>'ownerMemberId', v_elem->>'ownerBusinessEntityId');
    if v_key is null or v_key = any(v_seen) then return false; end if;
    v_seen := v_seen || v_key;
    if jsonb_typeof(v_elem->'basisPoints') <> 'number' then return false; end if;
    v_bp := (v_elem->>'basisPoints')::numeric;
    if v_bp <> trunc(v_bp) or v_bp <= 0 or v_bp > 10000 then return false; end if;
    v_total := v_total + v_bp::bigint;
  end loop;
  return v_count >= 2 and v_total = 10000;
end;
$$;

-- ---------------------------------------------------------------------------
-- D. Constraints (all NEW, named for this migration; added only if absent).
-- ---------------------------------------------------------------------------
do $$
declare
  v_owner_roles constant text := '''self'', ''spouse'', ''joint'', ''child'', ''family_trust'', ''company'', ''smsf'', ''other''';
  v_sources constant text := '''user_selected'', ''backfill_from_account'', ''backfill_from_document'', ''legacy_unset''';
begin
  -- fdh_statement_uploads
  if not exists (select 1 from pg_constraint where conname = 'chk_fdh_uploads_owner_role_0236' and conrelid = 'public.fdh_statement_uploads'::regclass) then
    execute format('alter table public.fdh_statement_uploads add constraint chk_fdh_uploads_owner_role_0236 check (owner_role is null or owner_role in (%s))', v_owner_roles);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'chk_fdh_uploads_owner_source_0236' and conrelid = 'public.fdh_statement_uploads'::regclass) then
    execute format('alter table public.fdh_statement_uploads add constraint chk_fdh_uploads_owner_source_0236 check (owner_selection_source is null or owner_selection_source in (%s))', v_sources);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'chk_fdh_uploads_owner_one_kind_0236' and conrelid = 'public.fdh_statement_uploads'::regclass) then
    alter table public.fdh_statement_uploads add constraint chk_fdh_uploads_owner_one_kind_0236
      check (owner_member_id is null or owner_business_entity_id is null);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'chk_fdh_uploads_owner_entity_role_0236' and conrelid = 'public.fdh_statement_uploads'::regclass) then
    alter table public.fdh_statement_uploads add constraint chk_fdh_uploads_owner_entity_role_0236
      check (owner_business_entity_id is null or owner_role in ('family_trust', 'company', 'other'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'chk_fdh_uploads_owner_chosen_has_role_0236' and conrelid = 'public.fdh_statement_uploads'::regclass) then
    alter table public.fdh_statement_uploads add constraint chk_fdh_uploads_owner_chosen_has_role_0236
      check (owner_selection_source is distinct from 'user_selected' or owner_role is not null);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'chk_fdh_uploads_owner_joint_alloc_0236' and conrelid = 'public.fdh_statement_uploads'::regclass) then
    -- A user-selected JOINT document with percentages (AU investment) must carry a valid split;
    -- any stored split must be valid. (A bank / liability joint carries no split: owner_allocation stays NULL.)
    alter table public.fdh_statement_uploads add constraint chk_fdh_uploads_owner_joint_alloc_0236
      check (owner_allocation is null or public.owner_before_upload_allocation_ok(owner_allocation));
  end if;

  -- ii_source_documents
  if not exists (select 1 from pg_constraint where conname = 'chk_ii_source_documents_owner_role_0236' and conrelid = 'public.ii_source_documents'::regclass) then
    execute format('alter table public.ii_source_documents add constraint chk_ii_source_documents_owner_role_0236 check (owner_role is null or owner_role in (%s))', v_owner_roles);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'chk_ii_source_documents_owner_source_0236' and conrelid = 'public.ii_source_documents'::regclass) then
    execute format('alter table public.ii_source_documents add constraint chk_ii_source_documents_owner_source_0236 check (owner_selection_source is null or owner_selection_source in (%s))', v_sources);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'chk_ii_source_documents_owner_one_kind_0236' and conrelid = 'public.ii_source_documents'::regclass) then
    alter table public.ii_source_documents add constraint chk_ii_source_documents_owner_one_kind_0236
      check (owner_member_id is null or owner_business_entity_id is null);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'chk_ii_source_documents_owner_entity_role_0236' and conrelid = 'public.ii_source_documents'::regclass) then
    alter table public.ii_source_documents add constraint chk_ii_source_documents_owner_entity_role_0236
      check (owner_business_entity_id is null or owner_role in ('family_trust', 'company', 'other'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'chk_ii_source_documents_owner_chosen_has_role_0236' and conrelid = 'public.ii_source_documents'::regclass) then
    alter table public.ii_source_documents add constraint chk_ii_source_documents_owner_chosen_has_role_0236
      check (owner_selection_source is distinct from 'user_selected' or owner_role is not null);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'chk_ii_source_documents_owner_joint_alloc_0236' and conrelid = 'public.ii_source_documents'::regclass) then
    -- A user-selected JOINT document must carry a valid split; any stored split must be valid.
    alter table public.ii_source_documents add constraint chk_ii_source_documents_owner_joint_alloc_0236
      check (
        (owner_allocation is null or public.owner_before_upload_allocation_ok(owner_allocation))
        and (owner_selection_source is distinct from 'user_selected' or owner_role is distinct from 'joint' or owner_allocation is not null)
      );
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- E. Cross-tenant guard (mirrors 0153's ii_ownership_allocation_assert_owner):
--    a valid foreign key is NOT proof the referenced row is the caller's. A user
--    can write these columns on their own row, so without this a caller could
--    attach ANOTHER tenant's household member / entity id to their document.
-- ---------------------------------------------------------------------------
create or replace function public.owner_before_upload_assert_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid;
begin
  if new.owner_member_id is not null then
    select user_id into v_owner from public.household_members where id = new.owner_member_id;
    if v_owner is null or v_owner <> new.user_id then
      raise exception '%.owner_member_id does not belong to user_id %', tg_table_name, new.user_id
        using errcode = 'check_violation';
    end if;
  end if;
  if new.owner_business_entity_id is not null then
    select user_id into v_owner from public.business_entities where id = new.owner_business_entity_id;
    if v_owner is null or v_owner <> new.user_id then
      raise exception '%.owner_business_entity_id does not belong to user_id %', tg_table_name, new.user_id
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.owner_before_upload_assert_owner() from public;
revoke all on function public.owner_before_upload_assert_owner() from anon, authenticated;

drop trigger if exists trg_fdh_statement_uploads_owner_0236 on public.fdh_statement_uploads;
create trigger trg_fdh_statement_uploads_owner_0236
  before insert or update of user_id, owner_member_id, owner_business_entity_id on public.fdh_statement_uploads
  for each row execute function public.owner_before_upload_assert_owner();

drop trigger if exists trg_ii_source_documents_owner_0236 on public.ii_source_documents;
create trigger trg_ii_source_documents_owner_0236
  before insert or update of user_id, owner_member_id, owner_business_entity_id on public.ii_source_documents
  for each row execute function public.owner_before_upload_assert_owner();

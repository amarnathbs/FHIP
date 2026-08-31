-- =============================================================================
-- FDH-12 — HOTFIX: `retirement_accounts` import-provenance columns shipped
-- WITHOUT the two guards their own precedent pairs them with.
--
-- FOUND BY LIVE-DEV CERTIFICATION, 2026-08-30, against real hosted DEV Postgres
-- after migration 0112 was applied.
--
-- -----------------------------------------------------------------------------
-- THE DEFECT
-- -----------------------------------------------------------------------------
-- Migration 0112 PART A widened `retirement_accounts.source_type` to accept
-- `'retirement_statement_import'`, and PART G added
-- `retirement_accounts.last_import_application_id` and `last_imported_at`. Its
-- own comment says these columns "mirror income_sources (0091 Part C) and
-- liabilities (0096) exactly".
--
-- The COLUMNS were mirrored. The GUARDS were not. Both 0091 and 0096 pair
-- these exact three columns with TWO triggers, and 0112 shipped neither:
--
--   1. A PROVENANCE-WRITE guard
--      (`fdh9_income_sources_assert_provenance_write`, 0091 D.5;
--       `fdh10_liabilities_assert_provenance_write`, 0096) — only the
--      import-bridge RPC, running under `fhip.import_bridge_internal_write`,
--      may move source_type / last_import_application_id / last_imported_at.
--
--   2. An IMPORT-LINK OWNERSHIP guard
--      (`fdh9_assert_income_import_link_owner`, 0091) — the reverse pointer
--      must stay same-tenant, "so a forged UPDATE cannot attribute one user's
--      Income row to another user's import".
--
-- REPRODUCED LIVE ON DEV, as an ordinary authenticated user over PostgREST,
-- against their own row (no service role, no SQL access):
--
--   PATCH retirement_accounts source_type='retirement_statement_import'
--       -> 200 SUCCEEDED   (a hand-typed account now claims to be a
--                           certified statement import that never happened)
--   PATCH retirement_accounts last_import_application_id=<own app id>
--       -> 200 SUCCEEDED   (forged apply provenance)
--   PATCH retirement_accounts last_import_application_id=null, last_imported_at=null
--       -> 200 SUCCEEDED   (real apply provenance erased)
--
--   CROSS-TENANT: Tenant B PATCHed B's OWN retirement account to
--   last_import_application_id = <Tenant A's fhip_import_applications.id>
--       -> 200 SUCCEEDED, and B's row then read
--          last_import_application_id = A's application id.
--
--   POSITIVE CONTROL, same user, same request shape, same column name, on the
--   FDH-9 table that DOES carry the guard:
--   PATCH income_sources last_import_application_id=<app id>
--       -> 400 P0001 "income_sources: source_type/last_import_application_id/
--                     last_imported_at are import-bridge provenance and may
--                     not be written directly by the authenticated role"
--
-- So this is not a missing capability; it is one table that was left out of an
-- existing, working, certified pattern. Spec section 96 forbids exactly this
-- ("owning the row must not let the user forge ... applied canonical state via
-- direct REST"), and spec sections 98/102's cross-tenant reference rule is
-- what the second guard exists for.
--
-- -----------------------------------------------------------------------------
-- THE FIX
-- -----------------------------------------------------------------------------
-- The 0091 functions, transposed to `retirement_accounts` with no other
-- change. Deliberately mirrored rather than generalised: a single shared guard
-- across three canonical registers would be a larger refactor than a hotfix
-- warrants, and the per-table shape is what the other two are already
-- certified in.
--
-- WHAT STAYS EXACTLY AS USER-EDITABLE AS IT IS TODAY. The write guard is
-- `before update` only and fires solely on those three provenance columns.
-- Adding a retirement account by hand, renaming it, correcting its balance,
-- changing its owner, deactivating it — all untouched. `lib/validation/
-- retirement.ts` never accepts `source_type` from a client in the first place,
-- so no existing app path sends it.
--
-- WHY NO `auth.role()` ESCAPE. Mirrors 0091 D.5 exactly: the GUC is the ONLY
-- way through, so not even a service-role client may rewrite import provenance
-- outside `fdh12_apply_retirement_proposal()`. That function already brackets
-- every provenance write it performs with the GUC (0112 PART I), so it is
-- unaffected. No other code path in the repository writes
-- `retirement_accounts.source_type`: Investment Intelligence publishing writes
-- only `investments`, and the FDH-12 processing service is forbidden from
-- naming `retirement_accounts` at all (`tests/unit/fdh1Isolation.test.ts`).
--
-- IDEMPOTENT. `create or replace function` + `drop trigger if exists`; no
-- schema change, no data change. Safe to re-run.
-- =============================================================================


-- ---------------------------------------------------------------------------
-- 1. IMPORT-LINK OWNERSHIP (spec sections 98, 102).
--    The reverse pointer must stay same-tenant, so a forged UPDATE cannot
--    attribute one user's retirement account to another user's import.
-- ---------------------------------------------------------------------------
create or replace function fdh12_assert_retirement_import_link_owner() returns trigger as $$
declare
  ref_owner uuid;
begin
  if new.last_import_application_id is not null then
    select user_id into ref_owner from fhip_import_applications where id = new.last_import_application_id;
    if ref_owner is null then
      raise exception 'retirement_accounts: last_import_application_id % does not exist', new.last_import_application_id;
    end if;
    if ref_owner <> new.user_id then
      raise exception 'retirement_accounts: cross-tenant reference — import application % belongs to a different user', new.last_import_application_id;
    end if;
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists trg_retirement_accounts_import_link_owner on retirement_accounts;
create trigger trg_retirement_accounts_import_link_owner
  before insert or update of user_id, last_import_application_id on retirement_accounts
  for each row execute function fdh12_assert_retirement_import_link_owner();


-- ---------------------------------------------------------------------------
-- 2. PROVENANCE IS AUTHORITATIVE (spec section 96), while the rest of the row
--    stays exactly as user-editable as it is today.
-- ---------------------------------------------------------------------------
create or replace function fdh12_retirement_accounts_assert_provenance_write() returns trigger as $$
declare
  v_internal boolean := coalesce(current_setting('fhip.import_bridge_internal_write', true), 'false') = 'true';
begin
  if v_internal then
    return new;
  end if;
  if new.source_type is distinct from old.source_type
     or new.last_import_application_id is distinct from old.last_import_application_id
     or new.last_imported_at is distinct from old.last_imported_at
  then
    raise exception 'retirement_accounts: source_type/last_import_application_id/last_imported_at are import-bridge provenance and may not be written directly by the authenticated role';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists trg_retirement_accounts_provenance_write on retirement_accounts;
create trigger trg_retirement_accounts_provenance_write
  before update on retirement_accounts
  for each row execute function fdh12_retirement_accounts_assert_provenance_write();

comment on column retirement_accounts.last_import_application_id is
  'FDH-12 apply provenance: the fhip_import_applications row that last wrote this account. Same-tenant-enforced and writable only by fdh12_apply_retirement_proposal() under the import-bridge GUC (migration 0114).';
comment on column retirement_accounts.last_imported_at is
  'FDH-12 apply provenance: when a retirement statement import last wrote this account. Writable only by fdh12_apply_retirement_proposal() under the import-bridge GUC (migration 0114).';

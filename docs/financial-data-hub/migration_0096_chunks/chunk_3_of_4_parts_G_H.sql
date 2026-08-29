-- PART G — extend the FDH-9 bridge's same-tenant proposal/application guards
-- with the 'liability' branch (spec sections 6, 50-58, 91). REPLACES the
-- function bodies from migration 0091 in place (`create or replace`) —
-- exactly the widening technique the income-only functions themselves
-- documented as their own future extension point ("A future domain adapter
-- adds its own narrow branch here").
-- ---------------------------------------------------------------------------
create or replace function fdh9_assert_proposal_owner() returns trigger as $$
declare
  ref_owner uuid;
begin
  if new.source_payroll_event_id is not null then
    select user_id into ref_owner from fdh_payroll_events where id = new.source_payroll_event_id;
    if ref_owner is null then
      raise exception 'fhip_import_proposals: source_payroll_event_id % does not exist', new.source_payroll_event_id;
    elsif ref_owner <> new.user_id then
      raise exception 'fhip_import_proposals: cross-tenant reference — payroll event % belongs to a different user', new.source_payroll_event_id;
    end if;
  end if;

  if new.source_liability_statement_id is not null then
    select user_id into ref_owner from fdh_liability_statements where id = new.source_liability_statement_id;
    if ref_owner is null then
      raise exception 'fhip_import_proposals: source_liability_statement_id % does not exist', new.source_liability_statement_id;
    elsif ref_owner <> new.user_id then
      raise exception 'fhip_import_proposals: cross-tenant reference — liability statement % belongs to a different user', new.source_liability_statement_id;
    end if;
  end if;

  if new.target_entity_id is not null then
    if new.target_domain = 'income' then
      select user_id into ref_owner from income_sources where id = new.target_entity_id;
      if ref_owner is null then
        raise exception 'fhip_import_proposals: target_entity_id % does not exist in income_sources', new.target_entity_id;
      elsif ref_owner <> new.user_id then
        raise exception 'fhip_import_proposals: cross-tenant reference — income entry % belongs to a different user', new.target_entity_id;
      end if;
    elsif new.target_domain = 'liability' then
      select user_id into ref_owner from liabilities where id = new.target_entity_id;
      if ref_owner is null then
        raise exception 'fhip_import_proposals: target_entity_id % does not exist in liabilities', new.target_entity_id;
      elsif ref_owner <> new.user_id then
        raise exception 'fhip_import_proposals: cross-tenant reference — liability % belongs to a different user (forged liability target — spec section 91)', new.target_entity_id;
      end if;
    else
      raise exception 'fhip_import_proposals: target_domain % has no implemented target guard', new.target_domain;
    end if;
  end if;

  if new.duplicate_of_entity_id is not null then
    if new.target_domain = 'income' then
      select user_id into ref_owner from income_sources where id = new.duplicate_of_entity_id;
      if ref_owner is null or ref_owner <> new.user_id then
        raise exception 'fhip_import_proposals: cross-tenant reference — duplicate income entry % belongs to a different user', new.duplicate_of_entity_id;
      end if;
    elsif new.target_domain = 'liability' then
      select user_id into ref_owner from liabilities where id = new.duplicate_of_entity_id;
      if ref_owner is null or ref_owner <> new.user_id then
        raise exception 'fhip_import_proposals: cross-tenant reference — duplicate liability % belongs to a different user', new.duplicate_of_entity_id;
      end if;
    end if;
  end if;

  return new;
end;
$$ language plpgsql security definer set search_path = public;
-- trigger trg_fhip_import_proposals_owner (migration 0091) already targets
-- this function by name and does not need to be recreated; it must, however,
-- also fire on the new column below.
drop trigger if exists trg_fhip_import_proposals_owner on fhip_import_proposals;
create trigger trg_fhip_import_proposals_owner
  before insert or update of user_id, source_payroll_event_id, source_liability_statement_id, target_entity_id, target_domain, duplicate_of_entity_id
  on fhip_import_proposals
  for each row execute function fdh9_assert_proposal_owner();


create or replace function fdh9_assert_application_owner() returns trigger as $$
declare
  ref_owner uuid;
begin
  select user_id into ref_owner from fhip_import_proposals where id = new.proposal_id;
  if ref_owner is null then
    raise exception 'fhip_import_applications: proposal_id % does not exist', new.proposal_id;
  elsif ref_owner <> new.user_id then
    raise exception 'fhip_import_applications: cross-tenant reference — proposal % belongs to a different user', new.proposal_id;
  end if;

  if new.source_payroll_event_id is not null then
    select user_id into ref_owner from fdh_payroll_events where id = new.source_payroll_event_id;
    if ref_owner is null or ref_owner <> new.user_id then
      raise exception 'fhip_import_applications: cross-tenant reference — payroll event % belongs to a different user', new.source_payroll_event_id;
    end if;
  end if;

  if new.source_liability_statement_id is not null then
    select user_id into ref_owner from fdh_liability_statements where id = new.source_liability_statement_id;
    if ref_owner is null or ref_owner <> new.user_id then
      raise exception 'fhip_import_applications: cross-tenant reference — liability statement % belongs to a different user', new.source_liability_statement_id;
    end if;
  end if;

  if new.target_domain = 'income' then
    select user_id into ref_owner from income_sources where id = new.target_entity_id;
    if ref_owner is null then
      raise exception 'fhip_import_applications: target_entity_id % does not exist in income_sources', new.target_entity_id;
    elsif ref_owner <> new.user_id then
      raise exception 'fhip_import_applications: cross-tenant reference — income entry % belongs to a different user', new.target_entity_id;
    end if;
  elsif new.target_domain = 'liability' then
    select user_id into ref_owner from liabilities where id = new.target_entity_id;
    if ref_owner is null then
      raise exception 'fhip_import_applications: target_entity_id % does not exist in liabilities', new.target_entity_id;
    elsif ref_owner <> new.user_id then
      raise exception 'fhip_import_applications: cross-tenant reference — liability % belongs to a different user (forged liability target — spec section 91)', new.target_entity_id;
    end if;
  else
    raise exception 'fhip_import_applications: target_domain % has no implemented target guard', new.target_domain;
  end if;

  return new;
end;
$$ language plpgsql security definer set search_path = public;
drop trigger if exists trg_fhip_import_applications_owner on fhip_import_applications;
create trigger trg_fhip_import_applications_owner
  before insert or update on fhip_import_applications
  for each row execute function fdh9_assert_application_owner();


-- ---------------------------------------------------------------------------
-- PART H — widen the authoritative-write immutable-field list from migration
-- 0091 Part D.1 to cover the new column (same "create or replace" widening
-- technique). The column itself was added in Part F.4 above.
-- ---------------------------------------------------------------------------
create or replace function fdh9_import_proposals_assert_authoritative_write() returns trigger as $$
declare
  v_internal boolean := coalesce(current_setting('fhip.import_bridge_internal_write', true), 'false') = 'true';
begin
  if v_internal then
    return new;
  end if;

  if new.user_id is distinct from old.user_id
     or new.target_domain is distinct from old.target_domain
     or new.source_kind is distinct from old.source_kind
     or new.source_payroll_event_id is distinct from old.source_payroll_event_id
     or new.source_liability_statement_id is distinct from old.source_liability_statement_id
     or new.currency_code is distinct from old.currency_code
     or new.target_entity_id is distinct from old.target_entity_id
     or new.target_entity_updated_at is distinct from old.target_entity_updated_at
     or new.recommended_apply_mode is distinct from old.recommended_apply_mode
     or new.duplicate_of_entity_id is distinct from old.duplicate_of_entity_id
     or new.generated_at is distinct from old.generated_at
     or new.applied_at is distinct from old.applied_at
  then
    raise exception 'fhip_import_proposals: this field is authoritative and may not be written directly by the authenticated role';
  end if;

  if new.status is distinct from old.status then
    if not (old.status = 'ready' and new.status in ('dismissed', 'superseded')) then
      raise exception 'fhip_import_proposals: status may only move from ready to dismissed or superseded via the authenticated role; applied is only ever set by the atomic apply function';
    end if;
  end if;

  if new.dismissed_at is distinct from old.dismissed_at and new.status <> 'dismissed' then
    raise exception 'fhip_import_proposals: dismissed_at may only be set alongside status=dismissed';
  end if;

  return new;
end;
$$ language plpgsql security definer set search_path = public;
-- trigger trg_fhip_import_proposals_authoritative_write (0091) already
-- targets this function by name; no re-creation needed since it fires on
-- every UPDATE regardless of column.


-- ---------------------------------------------------------------------------

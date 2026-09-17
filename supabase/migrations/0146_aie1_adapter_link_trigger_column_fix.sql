-- AIE-1 hotfix — corrects a real, live-reproduced defect found during AIE-1
-- live-DEV verification pass 2 (docs/aie-programme/
-- AIE_1_LIVE_DEV_VERIFICATION_REPORT.md, section 2e): `aie_ii_adapter_link`
-- (migration 0141) and `aie_insurance_adapter_link` (migration 0143) both
-- reuse the SHARED `aie_assert_child_owner()` trigger function (migration
-- 0140), but that function unconditionally references `new.intake_id`
-- (unprefixed) — correct for AIE-1.1 core's own child tables (e.g.
-- `aie_document_fingerprint`, which genuinely has an `intake_id` column),
-- but WRONG for these two adapter-link tables, whose own column is named
-- `aie_intake_id` (with the `aie_` prefix). Confirmed directly by reading
-- both migrations' own CREATE TABLE statements — this is not a hypothesis.
--
-- LIVE-REPRODUCED IMPACT (Insurance adapter, DEV): every insert into
-- `aie_insurance_adapter_link` fails with Postgres 42703 ("record \"new\"
-- has no field \"intake_id\""). Because this insert is the ONLY place the
-- Insurance adapter's canonical-write acceptance path records that a given
-- AIE run has already produced a canonical `insurance_policies` row, the
-- failure has two compounding real consequences, both observed live:
--   1. The real, correct `insurance_policies` row IS successfully written
--      (via the pre-existing, unmodified `makeRegistry().save()` path)
--      BEFORE this link insert fails — so the run is wrongly reported as
--      failed even though the canonical write already succeeded.
--   2. Because the link row (the actual idempotency record) was never
--      written, a retry of the same run does NOT detect "already written"
--      and creates a SECOND, duplicate `insurance_policies` row.
-- The same defect almost certainly affects `aie_ii_adapter_link`
-- (identical column name, identical shared-trigger reuse) — not
-- independently live-reproduced for Investment Intelligence in this pass
-- (out of that pass's scope), but fixed here on the same evidence rather
-- than leaving a known-identical bug unaddressed in a sibling table.
--
-- FIX: give both adapter-link tables their own trigger function that
-- references the correct `aie_intake_id` column, instead of continuing to
-- share `aie_assert_child_owner()` (which stays correct and untouched for
-- every AIE-1.1 core child table that genuinely uses the unprefixed
-- `intake_id` name). Additive/corrective only — no table is altered, no
-- data is rewritten, no existing row is touched. Two trigger DROP+CREATE
-- statements only.
--
-- HELD LOCALLY. Not applied to any DEV or production database by this
-- migration file's own authorship — see this session's own verification
-- evidence for exact application status.

create or replace function public.aie_adapter_link_assert_child_owner()
returns trigger as $$
declare
  true_owner uuid;
begin
  select user_id into true_owner from aie_document_intake where id = new.aie_intake_id;
  if true_owner is null then
    raise exception 'aie adapter link: intake % does not exist', new.aie_intake_id;
  end if;
  if new.user_id is distinct from true_owner then
    raise exception 'aie adapter link: cross-tenant reference — intake % belongs to a different user', new.aie_intake_id;
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists trg_aie_insurance_adapter_link_owner on aie_insurance_adapter_link;
create trigger trg_aie_insurance_adapter_link_owner
  before insert or update of aie_intake_id, user_id on aie_insurance_adapter_link
  for each row execute function public.aie_adapter_link_assert_child_owner();

drop trigger if exists trg_aie_ii_adapter_link_owner on aie_ii_adapter_link;
create trigger trg_aie_ii_adapter_link_owner
  before insert or update of aie_intake_id, user_id on aie_ii_adapter_link
  for each row execute function public.aie_adapter_link_assert_child_owner();

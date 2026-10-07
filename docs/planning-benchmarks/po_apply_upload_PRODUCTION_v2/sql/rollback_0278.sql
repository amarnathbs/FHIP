-- Rollback of migration 0278 only: puts back the 0275 version of pb_removed_band_ids.
-- This brings back the false statement that a values upload removes bands (walkthrough finding D1), so use it only if 0278 itself must be undone.
-- Safe to run twice.

create or replace function pb_removed_band_ids(p_batch uuid) returns uuid[]
language sql stable security definer set search_path = '' as $fn$
  select coalesce(array_agg(tr.id order by tr.id), '{}'::uuid[])
    from public.benchmark_target_ranges tr
   where (tr.effective_to is null or tr.effective_to > current_date)
     and exists (
       select 1 from public.benchmark_upload_rows r
        where r.batch_id = p_batch
          and (r.payload ->> 'metric_definition_id')::uuid = tr.metric_definition_id
          and nullif(r.payload ->> 'country_code', '') is not distinct from tr.country_code::text
          and nullif(r.payload ->> 'life_stage', '') is not distinct from tr.life_stage
          and nullif(r.payload ->> 'household_type', '') is not distinct from tr.household_type)
     and not exists (
       select 1 from public.benchmark_upload_rows r
        where r.batch_id = p_batch
          and (r.payload ->> 'metric_definition_id')::uuid = tr.metric_definition_id
          and nullif(r.payload ->> 'country_code', '') is not distinct from tr.country_code::text
          and nullif(r.payload ->> 'life_stage', '') is not distinct from tr.life_stage
          and nullif(r.payload ->> 'household_type', '') is not distinct from tr.household_type
          and (r.payload ->> 'band_tier')::integer = tr.band_tier);
$fn$;

revoke all on function pb_removed_band_ids(uuid) from public, anon, authenticated;

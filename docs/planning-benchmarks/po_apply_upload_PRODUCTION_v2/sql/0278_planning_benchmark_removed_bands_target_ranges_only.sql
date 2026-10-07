-- 0278 -- Planning Benchmarks: the preview of an observed values upload must not claim that bands are removed
-- (finding D1 of the DEV walkthrough of 07/10/2026).
--
-- WHAT WAS WRONG
--   pb_removed_band_ids (migration 0275) lists the live target range bands that an upload would take out of
--   service because it replaces their group as a set and does not restate them. It looked only at the staged
--   rows and never at the kind of file. An observed values row carries a metric and no band tier, so a values
--   batch matched live bands of the same metric and the preview said bands would be removed. Activation of a
--   values batch never retires a band (the activate function only acts on bands for a target ranges batch),
--   so the person approving was shown a false statement. The staged counts and the staging digest also
--   carried the false number.
--
-- WHAT THIS DOES
--   Re-emits pb_removed_band_ids, and only that function, so that it returns an empty list unless the batch is
--   a planning target ranges batch. The preview text, the staged counts, the digest and the activate function
--   all read this one function, so the preview and what activation really does now agree. The
--   readiness function of migration 0277 (pb_dataset_readiness) is not touched and neither is any other
--   function, table or grant.
--
-- EFFECT ON A BATCH THAT IS ALREADY STAGED
--   A values batch staged before this change stored the false count and a digest that contained the false
--   list. Activate recomputes the digest, finds it different and refuses with the stale message, so nothing
--   goes live on a wrong preview. Discard that batch and stage the file again. A target ranges batch gives
--   the same answer as before, so it is unaffected.
--
-- ORDER: apply after 0275 and 0277. Re-running 0275 after this file puts the old function back, so run this
-- file again if that ever happens. Safe to run twice.
-- ROLLBACK: see docs/planning-benchmarks/po_apply_upload_PRODUCTION_v2/README.md.
--
-- HAND-RUN SAFETY: ASCII only, no bare dollar quote, no percent sign, no double quote, no semicolon or quote
-- inside a comment, no statement word followed by a name inside a comment or a string.

do $do$ begin
  if to_regclass('public.benchmark_upload_batches') is null or to_regclass('public.benchmark_upload_rows') is null
     or to_regclass('public.benchmark_target_ranges') is null then
    raise exception 'the removed bands fix needs the staged upload of migration 0275';
  end if;
end $do$;

create or replace function pb_removed_band_ids(p_batch uuid) returns uuid[]
language sql stable security definer set search_path = '' as $fn$
  select coalesce(array_agg(tr.id order by tr.id), '{}'::uuid[])
    from public.benchmark_target_ranges tr
   where exists (select 1 from public.benchmark_upload_batches ub where ub.id = p_batch and ub.kind = 'target_ranges')
     and (tr.effective_to is null or tr.effective_to > current_date)
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

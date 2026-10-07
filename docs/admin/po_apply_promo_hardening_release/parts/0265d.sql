-- ---------------------------------------------------------------------------
-- PART D starts here: digest backfill and finalise (service role only)
-- ---------------------------------------------------------------------------
-- Run order for existing plain codes (the runbook has the full procedure):
--   1. The Admin button Prepare existing codes on the Promo Codes page (or the operator script
--      scripts/promo_code_digest_backfill.mjs) reads the pending rows, computes each digest with the
--      application secret, stores it, then asks the database to verify the copy. Safe to repeat.
--   2. promo_codes_finalise_hash_only(true) reports the counts. Only when every plain row is verified does
--      promo_codes_finalise_hash_only(false) blank the plain values. It is all or nothing.
-- A point in time backup before the real finalise is the reversal plan: after the blanking the plain
-- values exist nowhere, by design, and the digests keep every existing code working.

create or replace function public.promo_codes_digest_pending(p_limit int default 200)
returns table (id uuid, code text, code_digest text, code_digest_version int)
language sql stable security definer set search_path = '' as $fn$
  select p.id, p.code, p.code_digest, p.code_digest_version
    from public.promo_codes p
   where p.code is not null and p.code_digest_verified_at is null
   order by p.created_at, p.id
   limit least(greatest(coalesce(p_limit, 200), 1), 1000);
$fn$;
revoke all on function public.promo_codes_digest_pending(int) from public, anon, authenticated;
grant execute on function public.promo_codes_digest_pending(int) to service_role;

create or replace function public.promo_codes_digest_apply(p_id uuid, p_digest text, p_version int)
returns boolean
language plpgsql security definer set search_path = '' as $fn$
begin
  if p_digest is null or p_digest !~ '^[0-9a-f]{64}$' or p_version is null or p_version < 1 then
    raise exception 'PROMO_DIGEST_INVALID' using errcode = '22023';
  end if;
  update public.promo_codes
     set code_digest = p_digest, code_digest_version = p_version, code_digest_verified_at = null
   where id = p_id and code is not null and code_digest_verified_at is null;
  return found;
end;
$fn$;
revoke all on function public.promo_codes_digest_apply(uuid, text, int) from public, anon, authenticated;
grant execute on function public.promo_codes_digest_apply(uuid, text, int) to service_role;

-- The caller recomputes the digest of the plain value it just read and passes it. The row is marked verified
-- only when the stored digest equals that recomputed value.
create or replace function public.promo_codes_digest_mark_verified(p_id uuid, p_recomputed_digest text)
returns boolean
language plpgsql security definer set search_path = '' as $fn$
begin
  update public.promo_codes
     set code_digest_verified_at = now()
   where id = p_id and code is not null and code_digest is not null and code_digest = p_recomputed_digest;
  return found;
end;
$fn$;
revoke all on function public.promo_codes_digest_mark_verified(uuid, text) from public, anon, authenticated;
grant execute on function public.promo_codes_digest_mark_verified(uuid, text) to service_role;

create or replace function public.promo_codes_finalise_hash_only(p_dry_run boolean default true)
returns jsonb
language plpgsql security definer set search_path = '' as $fn$
declare
  v_plain int;
  v_unverified int;
  v_total int;
  v_blanked int := 0;
begin
  select count(*) into v_total from public.promo_codes;
  select count(*) into v_plain from public.promo_codes where code is not null;
  select count(*) into v_unverified from public.promo_codes where code is not null and code_digest_verified_at is null;
  if coalesce(p_dry_run, true) then
    return jsonb_build_object('dry_run', true, 'rows_total', v_total, 'rows_with_plain_value', v_plain, 'rows_unverified', v_unverified);
  end if;
  if v_unverified > 0 then
    raise exception 'PROMO_FINALISE_BLOCKED' using errcode = 'P0001', detail = 'rows with a plain value and no verified digest: ' || v_unverified::text;
  end if;
  update public.promo_codes set code = null where code is not null and code_digest_verified_at is not null;
  get diagnostics v_blanked = row_count;
  insert into public.admin_monitoring_events (event_type, severity, details)
  values ('promo_codes_hash_only_finalised', 'info', jsonb_build_object('rows_blanked', v_blanked, 'rows_total', v_total));
  return jsonb_build_object('dry_run', false, 'rows_total', v_total, 'rows_blanked', v_blanked, 'rows_unverified', 0);
end;
$fn$;
revoke all on function public.promo_codes_finalise_hash_only(boolean) from public, anon, authenticated;
grant execute on function public.promo_codes_finalise_hash_only(boolean) to service_role;


-- Counts only, for the Admin setup card on the Promo Codes page. Promo capability. No code, no digest.
create or replace function public.admin_promo_codes_hash_status()
returns jsonb
language plpgsql stable security definer set search_path = '' as $fn$
begin
  if auth.uid() is null then raise exception 'PROMO_UNAUTHENTICATED' using errcode = '42501'; end if;
  if not public.is_promo_code_admin() then raise exception 'PROMO_ADMIN_REQUIRED' using errcode = '42501'; end if;
  return jsonb_build_object(
    'rows_total', (select count(*) from public.promo_codes),
    'rows_with_plain_value', (select count(*) from public.promo_codes where code is not null),
    'rows_plain_without_verified_digest', (select count(*) from public.promo_codes where code is not null and code_digest_verified_at is null),
    'rows_with_digest', (select count(*) from public.promo_codes where code_digest is not null));
end;
$fn$;
revoke all on function public.admin_promo_codes_hash_status() from public, anon;
grant execute on function public.admin_promo_codes_hash_status() to authenticated;

-- One evidence row for each run of the Admin backfill button (counts only). Service role only.
create or replace function public.promo_codes_backfill_record(p_actor uuid, p_rows_seen int, p_rows_verified int)
returns void
language plpgsql security definer set search_path = '' as $fn$
begin
  insert into public.admin_monitoring_events (event_type, severity, actor_user_id, details)
  values ('promo_codes_digest_backfill', 'info', p_actor,
          jsonb_build_object('rows_seen', coalesce(p_rows_seen, 0), 'rows_verified', coalesce(p_rows_verified, 0)));
end;
$fn$;
revoke all on function public.promo_codes_backfill_record(uuid, int, int) from public, anon, authenticated;
grant execute on function public.promo_codes_backfill_record(uuid, int, int) to service_role;

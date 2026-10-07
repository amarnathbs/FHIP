-- 0265 promo and premium hardening, functions (part A of F)
-- =============================================================================
-- NEW migration on top of 0264 (apply 0264 first). The applied migrations 0231, 0237, 0238 and 0242 are
-- NOT edited. ADDITIVE: every function this file adds is a NEW overload or a NEW name, with the SAME owner
-- (the migration role), the SAME security mode (security definer), the SAME search_path (empty) and the
-- SAME grants as the function it stands beside. The old functions are NOT dropped here. They stay in place,
-- unchanged, so the release that is live today keeps working while this migration and the new application
-- release overlap in time (the deploy safety rule). A later migration, 0279, removes the old ones after the
-- PO has verified the new release.
--
-- WHAT THIS MIGRATION CHANGES
--   A  admin_create_promo_code: takes a keyed digest and a masked hint computed by the application. The
--      plain code is never seen by the database and never stored. Returns the id and the settings only.
--   B  admin_list_promo_codes_v2: a new list function with no code column (the old list stays for now).
--   C  redeem_promo_code_for_user: looks the code up by digest (current and previous key version), takes
--      the verified address hash, and ends a window of D days on the day redeemed plus D minus 1.
--   D  the digest backfill and finalise functions (service role only).
--   E  admin_manage_premium_entitlement: a new five argument form (the override flag has NO default, so a
--      four argument call can only ever reach the old function): shared window definition, lifetime ceiling, override path.
--   F  premium_reminder_claim: window length measured by the shared definition.
--
-- OLD SIGNATURES ARE KEPT. The application in this release calls only the new ones. Apply 0264 to 0268 BEFORE
-- deploying the application. The old application keeps using the old functions until the deploy completes
-- (create, list, redeem, grant and e-mail begin all still work), and the new application, if it ever ran against a
-- database without this migration, refuses with an explicit unavailable message and changes nothing.
--
-- EDITOR SAFETY. ASCII only. No comment and no string contains one of the three statement words followed
-- by a name. Hand-run parts A to F in order. Their concatenation is byte-equal to this file.
--
-- MIGRATION NUMBER 0265: highest found on every ref and every worktree was 0263 (NAV2).
-- =============================================================================

-- Named constant: how long the redemption attempt ledger is kept (the redeem function prunes with it).
create or replace function public.promo_attempts_retention_days()
returns int
language sql
immutable
set search_path = ''
as $fn$ select 30; $fn$;
comment on function public.promo_attempts_retention_days() is
  'Hardening 0265 item 7: days a redemption attempt row is kept. Used by redeem_promo_code_for_user and seeded as the retention policy value for promo_redemption_attempts.';
revoke all on function public.promo_attempts_retention_days() from public, anon;
grant execute on function public.promo_attempts_retention_days() to authenticated, service_role;

create or replace function public.admin_create_promo_code(
  p_code_digest text, p_code_hint text, p_digest_version int,
  p_duration_days int, p_max_redemptions int, p_unlimited boolean,
  p_expires_on date, p_no_expiry boolean, p_note text,
  p_bound_email_hash text default null, p_recipient_count int default 0
) returns jsonb
language plpgsql security definer set search_path = '' as $fn$
declare
  v_actor uuid := auth.uid();
  v_today date := current_date;
  v_duration int := coalesce(p_duration_days, 30);
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_id uuid;
begin
  if v_actor is null then raise exception 'PROMO_UNAUTHENTICATED' using errcode = '42501'; end if;
  if not public.is_promo_code_admin() then raise exception 'PROMO_ADMIN_REQUIRED' using errcode = '42501'; end if;

  -- The application computes the digest and the hint. Their shape is checked here, the value is not knowable here.
  if p_code_digest is null or p_code_digest !~ '^[0-9a-f]{64}$' then raise exception 'PROMO_CODE_INVALID' using errcode = '22023'; end if;
  if p_digest_version is null or p_digest_version < 1 then raise exception 'PROMO_CODE_INVALID' using errcode = '22023'; end if;
  if p_code_hint is null or p_code_hint !~ '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{2}[*]{2,20}[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{2}$' then
    raise exception 'PROMO_CODE_INVALID' using errcode = '22023';
  end if;

  if v_duration < 1 or v_duration > 365 then raise exception 'PROMO_DURATION_INVALID' using errcode = '22023'; end if;
  if coalesce(p_unlimited, false) then
    if p_max_redemptions is not null then raise exception 'PROMO_MAX_INVALID' using errcode = '22023'; end if;
  else
    if p_max_redemptions is null or p_max_redemptions < 1 or p_max_redemptions > 1000000 then raise exception 'PROMO_MAX_INVALID' using errcode = '22023'; end if;
  end if;
  if coalesce(p_no_expiry, false) then
    if p_expires_on is not null then raise exception 'PROMO_EXPIRY_INVALID' using errcode = '22023'; end if;
  else
    if p_expires_on is null or p_expires_on < v_today or p_expires_on > v_today + 3650 then raise exception 'PROMO_EXPIRY_INVALID' using errcode = '22023'; end if;
  end if;
  if v_note is not null and char_length(v_note) > 500 then raise exception 'PROMO_NOTE_INVALID' using errcode = '22023'; end if;
  if p_bound_email_hash is not null then
    if p_bound_email_hash !~ '^[0-9a-f]{64}$' then raise exception 'PROMO_BINDING_INVALID' using errcode = '22023'; end if;
    if coalesce(p_unlimited, false) or p_max_redemptions is distinct from 1 then raise exception 'PROMO_MAX_INVALID' using errcode = '22023'; end if;
  end if;
  if coalesce(p_recipient_count, 0) < 0 or coalesce(p_recipient_count, 0) > 20 then raise exception 'PROMO_RECIPIENTS_INVALID' using errcode = '22023'; end if;

  begin
    insert into public.promo_codes (code, code_digest, code_digest_version, code_digest_verified_at, code_hint, duration_days,
                                    max_redemptions, expires_on, note, created_by, bound_email_hash)
    values (null, p_code_digest, p_digest_version, now(), p_code_hint, v_duration,
            case when coalesce(p_unlimited, false) then null else p_max_redemptions end,
            case when coalesce(p_no_expiry, false) then null else p_expires_on end, v_note, v_actor, p_bound_email_hash)
    returning id into v_id;
  exception when unique_violation then
    raise exception 'PROMO_CODE_EXISTS' using errcode = 'P0001';
  end;

  insert into public.promo_code_events (event_type, actor_user_id, promo_code_id, code_hint, details)
  values ('create', v_actor, v_id, p_code_hint, jsonb_build_object(
    'duration_days', v_duration,
    'max_redemptions', case when coalesce(p_unlimited, false) then null else p_max_redemptions end,
    'unlimited', coalesce(p_unlimited, false),
    'expires_on', case when coalesce(p_no_expiry, false) then null else p_expires_on end,
    'no_expiry', coalesce(p_no_expiry, false),
    'has_note', v_note is not null,
    'recipient_count', coalesce(p_recipient_count, 0),
    'bound', p_bound_email_hash is not null,
    'digest_version', p_digest_version));

  return jsonb_build_object('id', v_id, 'code_hint', p_code_hint, 'duration_days', v_duration,
    'bound', p_bound_email_hash is not null,
    'ends_if_redeemed_today', public.access_end_date(v_today, v_duration),
    'max_redemptions', case when coalesce(p_unlimited, false) then null else p_max_redemptions end,
    'expires_on', case when coalesce(p_no_expiry, false) then null else p_expires_on end);
end;
$fn$;

revoke all on function public.admin_create_promo_code(text, text, int, int, int, boolean, date, boolean, text, text, int) from public, anon;
grant execute on function public.admin_create_promo_code(text, text, int, int, int, boolean, date, boolean, text, text, int) to authenticated;

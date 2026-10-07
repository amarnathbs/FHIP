-- 0279 promo and premium hardening, legacy cleanup (part A of B)
-- =============================================================================
-- RUN THIS ONLY AFTER the new application release has been live and verified, and after the plain codes were
-- blanked (the finalise step in the runbook). It removes the OLD function shapes that 0265 and 0266 kept so that
-- the release that was live before could keep working while the database and the application overlapped.
--
-- WHAT IT REMOVES (each was replaced by a new function that the new release uses)
--   admin_create_promo_code with 9 arguments, admin_list_promo_codes, redeem_promo_code_for_user with 4 arguments,
--   admin_manage_premium_entitlement with 4 arguments, admin_promo_email_begin with 3 arguments.
--
-- SAFETY GUARD. It refuses and changes nothing (error PROMO_CLEANUP_BLOCKED) while any promo code still holds a plain
-- value, or while any of the new functions is missing. Both mean the earlier steps are not finished.
--
-- AFTER IT RUNS the old application release can no longer create or redeem codes or grant Premium. Rolling the
-- application back past this point needs the rollback script in the hand-over folder first.
--
-- EDITOR SAFETY. ASCII only. No comment and no string contains one of the three statement words followed
-- by a name. Hand-run parts A and B in order. Their concatenation is byte-equal to this file.
--
-- MIGRATION NUMBER 0279: the highest number found on every ref and every worktree was 0278 (Planning Benchmarks).
-- =============================================================================

do $fn$
declare
  v_plain int;
begin
  select count(*) into v_plain from public.promo_codes where code is not null;
  if v_plain > 0 then
    raise exception 'PROMO_CLEANUP_BLOCKED' using errcode = 'P0001',
      detail = 'promo codes that still hold a plain value: ' || v_plain::text || '. Finish the digest backfill and the finalise step first.';
  end if;
  if to_regprocedure('public.admin_create_promo_code(text,text,integer,integer,integer,boolean,date,boolean,text,text,integer)') is null
     or to_regprocedure('public.admin_list_promo_codes_v2()') is null
     or to_regprocedure('public.redeem_promo_code_for_user(uuid,text[],text,text,text)') is null
     or to_regprocedure('public.admin_manage_premium_entitlement(text,uuid,date,text,boolean)') is null
     or to_regprocedure('public.admin_promo_email_begin(text,integer,boolean,text,text,uuid)') is null then
    raise exception 'PROMO_CLEANUP_BLOCKED' using errcode = 'P0001',
      detail = 'one of the new functions is missing. Apply 0264 to 0268 first.';
  end if;
end $fn$;

drop function if exists public.admin_create_promo_code(text, int, int, boolean, date, boolean, text, text, int);
drop function if exists public.admin_list_promo_codes();
drop function if exists public.redeem_promo_code_for_user(uuid, text, text, text);
drop function if exists public.admin_manage_premium_entitlement(text, uuid, date, text);
drop function if exists public.admin_promo_email_begin(text, int, boolean);

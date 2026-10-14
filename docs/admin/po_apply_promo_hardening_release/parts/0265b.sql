-- ---------------------------------------------------------------------------
-- PART B starts here: a new list function that returns no code value (the old list is kept for now)
-- ---------------------------------------------------------------------------

create or replace function public.admin_list_promo_codes_v2()
returns table (
  id uuid, code_hint text, duration_days int, max_redemptions int, redemption_count int,
  expires_on date, note text, status text, state text, created_at timestamptz, created_by_email text,
  bound boolean, ends_if_redeemed_today date, plain_stored boolean
)
language plpgsql stable security definer set search_path = '' as $fn$
declare v_today date := current_date;
begin
  if auth.uid() is null then raise exception 'PROMO_UNAUTHENTICATED' using errcode = '42501'; end if;
  if not public.is_promo_code_admin() then raise exception 'PROMO_ADMIN_REQUIRED' using errcode = '42501'; end if;
  return query
    select p.id, p.code_hint, p.duration_days, p.max_redemptions, p.redemption_count, p.expires_on, p.note, p.status,
           case when p.status = 'disabled' then 'disabled'
                when p.expires_on is not null and p.expires_on < v_today then 'expired'
                when p.max_redemptions is not null and p.redemption_count >= p.max_redemptions then 'exhausted'
                else 'active' end,
           p.created_at, u.email::text, (p.bound_email_hash is not null),
           public.access_end_date(v_today, p.duration_days), (p.code is not null)
      from public.promo_codes p left join auth.users u on u.id = p.created_by
     order by p.created_at desc limit 500;
end;
$fn$;

revoke all on function public.admin_list_promo_codes_v2() from public, anon;
grant execute on function public.admin_list_promo_codes_v2() to authenticated;

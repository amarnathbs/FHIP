-- ---------------------------------------------------------------------------
-- PART C starts here: per recipient status for a request, without any plain address or code
-- ---------------------------------------------------------------------------
-- The caller passes the keyed hashes it recomputes out of the addresses the admin typed. Only the admin who
-- started the request can read it. A recipient with no ledger row is reported as unknown (the response may
-- have been lost before the outcome was recorded) and is never assumed to have received anything.

create or replace function public.admin_promo_email_request_status(p_request_key text, p_recipient_hashes text[])
returns jsonb
language plpgsql stable security definer set search_path = '' as $fn$
declare
  v_actor uuid := auth.uid();
  v_req record;
  v_sends jsonb;
begin
  if v_actor is null then raise exception 'PROMO_UNAUTHENTICATED' using errcode = '42501'; end if;
  if not public.is_promo_code_admin() then raise exception 'PROMO_ADMIN_REQUIRED' using errcode = '42501'; end if;
  if p_request_key is null or char_length(p_request_key) < 8 or char_length(p_request_key) > 100 then
    raise exception 'PROMO_EMAIL_KEY_INVALID' using errcode = '22023';
  end if;
  if p_recipient_hashes is null or cardinality(p_recipient_hashes) > 20 then
    raise exception 'PROMO_RECIPIENTS_INVALID' using errcode = '22023';
  end if;

  select * into v_req from public.promo_email_requests where admin_user_id = v_actor and request_key = p_request_key;
  if not found then return jsonb_build_object('request_exists', false, 'recipients', '[]'::jsonb); end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'recipient_hash', h.hash,
           'status', coalesce(s.status, 'unknown'),
           'attempts', coalesce(s.attempts, 0),
           'promo_code_id', s.promo_code_id,
           'updated_at', s.updated_at) order by h.ord), '[]'::jsonb)
    into v_sends
    from unnest(p_recipient_hashes) with ordinality as h(hash, ord)
    left join public.promo_email_sends s
      on s.admin_user_id = v_actor and s.request_key = p_request_key and s.recipient_hash = h.hash;

  return jsonb_build_object('request_exists', true, 'kind', v_req.kind, 'purpose', v_req.purpose,
                            'recipient_count', v_req.recipient_count, 'bound', v_req.bound,
                            'created_at', v_req.created_at, 'recipients', v_sends);
end;
$fn$;
revoke all on function public.admin_promo_email_request_status(text, text[]) from public, anon;
grant execute on function public.admin_promo_email_request_status(text, text[]) to authenticated;

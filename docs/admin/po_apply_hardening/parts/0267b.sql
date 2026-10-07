-- ---------------------------------------------------------------------------
-- PART B starts here: the promo audit trail stays append-only, with ONE narrow anonymising exception
-- ---------------------------------------------------------------------------
-- Same function name, same trigger wiring, same search_path as 0237. An UPDATE is allowed only inside the
-- retention function (it sets a transaction local switch first), only to mark the row anonymised, and only
-- while the identifying columns (id, time, type, code id, masked hint) stay exactly as they were. Delete and
-- truncate stay refused for everyone.

create or replace function public.promo_code_events_immutable()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
begin
  if tg_op = 'UPDATE'
     and coalesce(current_setting('app.promo_retention_anonymise', true), '') = 'on'
     and new.id = old.id and new.created_at = old.created_at and new.event_type = old.event_type
     and new.promo_code_id = old.promo_code_id and new.code_hint = old.code_hint
     and old.anonymised_at is null and new.anonymised_at is not null then
    return new;
  end if;
  raise exception 'promo_code_events is append-only' using errcode = '42501', detail = tg_op;
end;
$fn$;

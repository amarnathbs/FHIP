-- 0281 -- Optional tax per pay period on an income record (PO decision 16-10-2026).
--
-- WHY. Net (take-home) income used to stay "unknown" when a record had no net amount. The PO decided that the
-- app must instead (a) ask for the take-home pay, (b) meanwhile treat the GROSS as take-home and say so, and
-- (c) let the user enter the TAX per pay period instead, so that net = gross - tax. This column stores (c).
--
-- WHAT THIS DOES. Adds ONE nullable column, income_sources.tax_amount, in the SAME pay period as amount (the
-- record keeps a single frequency, so gross, take-home and tax can never sit on different period bases), and one
-- CHECK: tax is never negative and never more than the gross. Existing rows get NULL; no row is changed.
--
-- DEPLOYMENT ORDER. Apply this migration BEFORE the code that sends tax_amount from the Income grid. The read
-- model retries without the column if it is missing, so reads never break, but a grid save that carries
-- tax_amount needs the column to exist.
--
-- Additive, idempotent (safe to run twice), forward-only.

alter table public.income_sources
  add column if not exists tax_amount numeric(18,2);

do $guard$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'income_sources_tax_amount_range'
       and conrelid = 'public.income_sources'::regclass
  ) then
    alter table public.income_sources
      add constraint income_sources_tax_amount_range
      check (tax_amount is null or (tax_amount >= 0 and tax_amount <= amount));
  end if;
end
$guard$;

comment on column public.income_sources.tax_amount is
  'Optional tax per pay period (same frequency as amount). When net_amount is empty, take-home = amount - tax_amount. With neither, the gross is treated as take-home and the app discloses it.';

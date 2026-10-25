-- 0295 -- SMSF fund liabilities carry the canonical liability fields and can be tied to the property they fund
-- (DOCUMENT2 (4) review, work package C, finding F21). Additive only, forward only.
--
-- WHAT THE PO FOUND. Adding a liability for an SMSF sent the user to the personal Liabilities page. Entity phase 1 (0289) gave the fund its own
-- liabilities table, but its form was thinner than the personal liability form: no rate type, no fixed-rate expiry, no masked account reference,
-- no due date, no link to the property the loan funds. This migration closes that gap on the fund side so nothing has to be entered in the
-- personal register.
--
-- WHAT IS ADDED to smsf_liabilities (all nullable or defaulted, no existing row changes):
--   interest_rate_type    fixed or variable, same values as the personal liabilities register
--   fixed_rate_expiry     date the fixed rate ends
--   masked_identifier     account reference, same masking rule as the personal register: a run of seven or more digits is refused
--   due_date              next payment due date
--   smsf_holding_id       the SMSF property asset the loan funds, a loan can only point at a PROPERTY asset of the SAME fund and the SAME owner
--   source_type           where the row came from, manual by default
--
-- COUNTING IS UNCHANGED. The fund net stays assets minus the fund liabilities (0289). A property link is descriptive, it never adds or removes
-- an amount, so linking cannot create a double count. SMSF liabilities are in the fund net and never in personal debt ratios, because they live
-- in this table and the personal formulas never read it.
--
-- ROLLBACK: drop trigger trg_smsf_liabilities_holding_link, drop function smsf_liability_holding_link_rule, drop the five added columns.
-- Safe at any time, nothing else refers to them.

begin;

alter table smsf_liabilities
  add column if not exists interest_rate_type text,
  add column if not exists fixed_rate_expiry date,
  add column if not exists masked_identifier text,
  add column if not exists due_date date,
  add column if not exists smsf_holding_id uuid references smsf_holdings(id) on delete set null,
  add column if not exists source_type text not null default 'manual';

alter table smsf_liabilities drop constraint if exists chk_smsf_liabilities_rate_type;
alter table smsf_liabilities
  add constraint chk_smsf_liabilities_rate_type
    check (interest_rate_type is null or interest_rate_type in ('fixed', 'variable'));

alter table smsf_liabilities drop constraint if exists chk_smsf_liabilities_masked_identifier;
alter table smsf_liabilities
  add constraint chk_smsf_liabilities_masked_identifier
    check (masked_identifier is null or masked_identifier !~ '[0-9]{7,}');

alter table smsf_liabilities drop constraint if exists chk_smsf_liabilities_source_type;
alter table smsf_liabilities
  add constraint chk_smsf_liabilities_source_type
    check (source_type in ('manual', 'statement_import', 'moved_from_personal'));

create index if not exists idx_smsf_liabilities_holding on smsf_liabilities(smsf_holding_id) where smsf_holding_id is not null;

comment on column smsf_liabilities.smsf_holding_id is
  'The SMSF property asset this loan funds (descriptive link only, no amount moves). Must be a property asset of the same fund and the same owner.';
comment on column smsf_liabilities.masked_identifier is
  'Account reference as shown on a statement, masked. A run of seven or more digits is refused, the same rule the personal liabilities register uses.';

-- A loan can only be tied to a PROPERTY asset of the same fund. Runs as the invoker, so row level security hides another household asset: a
-- forged asset id of another tenant finds nothing and is refused.
create or replace function smsf_liability_holding_link_rule() returns trigger as $fn$
begin
  if new.smsf_holding_id is not null
     and (tg_op = 'INSERT' or new.smsf_holding_id is distinct from old.smsf_holding_id) then
    if not exists (
      select 1 from smsf_holdings h
      where h.id = new.smsf_holding_id
        and h.smsf_fund_id = new.smsf_fund_id
        and h.user_id = new.user_id
        and h.holding_class = 'property'
    ) then
      raise exception 'ENTITY_HOLDING_LINK: a fund loan can only be tied to a property asset of the same fund'
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$fn$ language plpgsql;

drop trigger if exists trg_smsf_liabilities_holding_link on smsf_liabilities;
create trigger trg_smsf_liabilities_holding_link
  before insert or update of smsf_holding_id on smsf_liabilities
  for each row execute function smsf_liability_holding_link_rule();

commit;

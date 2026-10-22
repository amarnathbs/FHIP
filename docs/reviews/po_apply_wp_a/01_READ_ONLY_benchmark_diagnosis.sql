-- WP-A F9: why is a benchmark not shown for a held fund? READ ONLY. No insert, update, delete or DDL.
-- Run on DEV first (project vqycarelcoijzwlpkpcz), then on production (twwpnltizhtjxhamyoxt). Nothing here changes data.
-- Paste each numbered query on its own, copy the result grid back to the agent.

-- QUERY 1: which benchmark does each category use, is it in the catalogue, what kind of index is it (TRI = total return,
-- PRI = price only), how much history is loaded, and which approved entitlements exist (no row = not shown to customers)?
-- A row whose history_rows is 0 or whose first_date is later than the date you first invested in the fund is a BENCH-1 DEPENDENCY.
with wanted(category_key, benchmark_key) as (
  values
    ('large_cap', 'IN_NIFTY_100_TRI'),
    ('mid_cap', 'IN_NIFTY_MIDCAP_150_TRI'),
    ('small_cap', 'IN_BSE_250_SMALLCAP_TRI'),
    ('large_mid_cap', 'IN_NIFTY_LARGEMIDCAP_250_TRI'),
    ('flexi_cap / multi_cap / elss / focused / value / contra', 'IN_NIFTY_500_TRI'),
    ('balanced_advantage / aggressive_hybrid', 'IN_NIFTY50_HYBRID_COMP_DEBT_5050_TRI'),
    ('corporate_bond', 'IN_NIFTY_CORPORATE_BOND_A2_TRI'),
    ('infrastructure', 'IN_NIFTY_INFRASTRUCTURE_TRI'),
    ('mnc', 'IN_NIFTY_MNC_TRI')
)
select
  w.category_key,
  w.benchmark_key,
  b.id as benchmark_id,
  b.benchmark_label,
  b.return_type,
  b.catalogue_status,
  b.lifecycle_status,
  (select count(*) from ii_benchmark_series s where s.benchmark_id = b.id and s.quality_status = 'ok') as history_rows,
  (select min(series_date) from ii_benchmark_series s where s.benchmark_id = b.id and s.quality_status = 'ok') as first_date,
  (select max(series_date) from ii_benchmark_series s where s.benchmark_id = b.id and s.quality_status = 'ok') as last_date,
  b.return_variant,
  b.currency_code,
  (select string_agg(distinct format('approved %s %s, data %s to %s', e.return_variant, e.currency_code, coalesce(e.data_from::text, 'open'), coalesce(e.data_to::text, 'open')), '; ')
     from ii_benchmark_entitlements e
    where e.benchmark_id = b.id and e.status = 'approved') as approved_entitlements
from wanted w
left join ii_benchmarks b on b.benchmark_key = w.benchmark_key
order by w.category_key;

-- QUERY 2: for every fund you hold (replace the e-mail), its category as the app reads it, whether it has a declared benchmark,
-- and the date you first put money in. Match each category to a row of QUERY 1.
with me as (select id as user_id from auth.users where email = 'REPLACE_WITH_YOUR_EMAIL'),
held as (
  select distinct s.instrument_id
  from ii_holding_snapshots s
  where s.user_id = (select user_id from me)
)
select
  i.instrument_name,
  m.sub_category,
  m.category_header_raw,
  (select string_agg(bb.benchmark_key || ' (' || coalesce(bb.return_type, '?') || ')', ', ')
     from ii_instrument_benchmarks ib
     join ii_benchmarks bb on bb.id = ib.benchmark_id
    where ib.instrument_id = i.id and ib.relationship_type = 'primary' and ib.quality_status <> 'superseded') as declared_benchmark,
  (select min(t.transaction_date) from ii_transactions t where t.instrument_id = i.id and t.user_id = (select user_id from me)) as first_transaction
from held h
join ii_instruments i on i.id = h.instrument_id
left join ii_scheme_master m on m.instrument_id = i.id and m.effective_to is null
order by i.instrument_name;

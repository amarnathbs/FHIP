-- READ ONLY. How many price-history (NAV) rows each fund this user has transacted in carries.
-- The report reads every one of these rows for Performance and again for SIP, in pages of 1,000.
-- The user is found through the report id.
select held.instrument_id,
       i.instrument_name,
       count(p.id) as nav_rows,
       min(p.price_date) as first_price_date,
       max(p.price_date) as last_price_date
  from (select distinct t.instrument_id
          from ii_transactions t
         where t.user_id = (select x.user_id from reports x where x.id = '0b9a5749-64a5-4268-9f00-c55228424836')) held
  left join ii_instruments i on i.id = held.instrument_id
  left join ii_prices_nav p on p.instrument_id = held.instrument_id
 group by held.instrument_id, i.instrument_name
 order by nav_rows desc;

-- Totals for the same funds: how many funds, how many rows, how many 1,000-row pages that is.
select count(*) as funds,
       sum(q.nav_rows) as total_nav_rows,
       ceil(sum(q.nav_rows) / 1000.0) as pages_of_1000
  from (select held.instrument_id, count(p.id) as nav_rows
          from (select distinct t.instrument_id
                  from ii_transactions t
                 where t.user_id = (select x.user_id from reports x where x.id = '0b9a5749-64a5-4268-9f00-c55228424836')) held
          left join ii_prices_nav p on p.instrument_id = held.instrument_id
         group by held.instrument_id) q;

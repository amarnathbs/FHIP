-- WRITES ONE VALUE IN ONE ROW. Production. STEP 3 of 5. Run only after step 2 succeeded.
-- Before: net_amount 3,975.43 (one fortnight) on an annual record.  After: net_amount 103,361.18 (3,975.43 x 26, a full year).
-- The update only fires when the row still has EXACTLY the values you confirmed (amount 196,994.48, net 3,975.43, annually), so
-- running it twice, or after someone edited the record, changes nothing and returns no row.
-- It also sets updated_at so the Monthly Report notices the change and rebuilds. Nothing else is touched.
update public.income_sources
set net_amount = 103361.18,
    updated_at = now()
where id = '63d26f07-a799-4286-bdb6-38f324c87428'
  and amount = 196994.48
  and net_amount = 3975.43
  and frequency = 'annually'
returning id, source_name, frequency, amount as gross_per_year, net_amount as net_per_year_now, round(net_amount / 12, 2) as net_per_month_now;

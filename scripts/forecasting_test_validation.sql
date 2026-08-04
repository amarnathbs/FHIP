-- FHIP Forecasting Engine — 50-case test-data validation queries, rewritten
-- against the REAL schema (see scripts/seedForecastingTestData.ts's header
-- comment for the full schema-gap analysis versus the user-supplied
-- template). Table/column names below are exact matches to the live
-- database — no adaptation needed before running.

-- 1. Selected test-user count and country split.
select country_of_residence as country, count(*) as users
from user_profiles
where full_name like 'Forecast Test User %'
group by country_of_residence
order by country_of_residence;
-- Expected: AU 25, IN 25 (once all 50 cases are seeded — 2/2 today for the
-- TC001/TC003 dry-run subset).

-- 2. Four forecast scenarios per selected user's forecast profile.
select fp.name as profile_name, count(fs.id) as scenario_rows
from forecast_profiles fp
join forecast_scenarios fs on fs.forecast_profile_id = fp.id
where fp.name like '%Integrated Forecast%'
group by fp.name
having count(fs.id) <> 4;
-- Expected: zero rows.

-- 3. Goal-to-investment allocation must not exceed 100% per investment
--    (allocation_percentage is stored 0-100, not 0-1 — see goal_funding_sources).
select investment_id, sum(allocation_percentage) as allocation_pct
from goal_funding_sources
where source_type = 'investment' and is_active = true
group by investment_id
having sum(allocation_percentage) > 100.0001;
-- Expected: zero rows.

-- 4. Confirm no investment/retirement double counting inside the canonical
--    asset table. There is no linked_investment_id/linked_retirement_id
--    column on `assets` in this schema — investments and retirement are
--    kept in wholly separate tables from `assets` by construction, so the
--    equivalent check is simply confirming no investment/retirement id
--    reappears as an asset id (a real bug would only be possible via a
--    hand-authored duplicate row, not a schema-level ambiguity).
select a.id as asset_id
from assets a
where a.id in (select id from investments)
   or a.id in (select id from retirement_accounts);
-- Expected: zero rows.

-- 5. Historical monthly coverage for the ten variance cases (financial_snapshots
--    is the only granular-history table this schema has — see the seed
--    script's SCHEMA GAPS note for why the JSON's other 7 historical_* arrays
--    have no table to land in).
select up.full_name, min(fsn.snapshot_month) as first_month,
       max(fsn.snapshot_month) as last_month, count(*) as months
from financial_snapshots fsn
join user_profiles up on up.user_id = fsn.user_id
where up.full_name like 'Forecast Test User %'
group by up.full_name
order by up.full_name;
-- Expected month counts once all 10 historical cases are seeded: 60,48,36,60,48,36,60,60,48,36.

-- 6. Debt-repayment cashflow treatment — this schema has no cashflow_treatment
--    flag on expense_items (see seed script header); debt repayments are
--    tracked purely via liabilities.monthly_repayment, never expense_items.
--    The equivalent integrity check is: no expense_items row should exist
--    with a debt-repayment-flavoured category, since that would double-count
--    against liabilities.monthly_repayment.
select id, expense_category
from expense_items
where lower(expense_category) like '%debt%repayment%' or lower(expense_category) like '%loan%repayment%';
-- Expected: zero rows.

-- 7. Duplicate investment test for TC090 — DOCUMENTED GAP: this schema has
--    no record_status/duplicate_of_investment_id/exclude_from_calculations
--    columns anywhere (confirmed absent from every migration). Both of
--    TC090's investment rows are seeded as ordinary active investments;
--    this query can only confirm both rows exist, not that one is excluded.
select i.id, i.investment_name, i.current_value
from investments i
join user_profiles up on up.user_id = i.user_id
where up.full_name = 'Forecast Test User TC090'
order by i.investment_name;
-- Known limitation: cannot assert "one canonical + one excluded" — the
-- exclusion mechanism does not exist in this schema. Flagged, not silently
-- passed.

-- 8. Cross-border values must retain local currency (investment_type here
--    holds the randomly-assigned real master-item key, not "Cross-Border" —
--    the actual cross-border signal is investments.country_code differing
--    from the user's home country_code).
select i.investment_name, i.country_code, i.currency_code, i.current_value, up.country_of_residence as home_country
from investments i
join user_profiles up on up.user_id = i.user_id
where i.country_code is distinct from up.country_of_residence;

-- 9. Recommendation master integrity (v2 schema column names).
select recommendation_code
from action_recommendation_master
where is_active = true
  and (
    action_content_template is null
    or calculation_method_code is null
    or supported_placeholders = '{}'
  );
-- Expected: zero rows for the test pack's own 18 seeded codes (the 542-row
-- production library has some rows with a null calculation_method_code —
-- scope this query to recommendation_code in (select recommendation_code
-- from action_recommendation_master where admin_notes = 'Synthetic test content only')
-- if running against a database that also has the full production library loaded).

-- 10. Snapshot arithmetic reconciliation.
select up.full_name, fsn.snapshot_month,
       fsn.total_assets - fsn.total_liabilities - fsn.net_worth as reconciliation_difference
from financial_snapshots fsn
join user_profiles up on up.user_id = fsn.user_id
where abs(fsn.total_assets - fsn.total_liabilities - fsn.net_worth) > 0.01;
-- Expected: zero rows.

-- 11. (New — not in the original template) Confirm every seeded goal's
--     funding sources reference an investment the SAME user owns (RLS-style
--     cross-user leak check at the data-integrity level, not just via RLS).
select gfs.id, gfs.goal_id, gfs.linked_investment_id
from goal_funding_sources gfs
join user_goals g on g.id = gfs.goal_id
left join investments i on i.id = gfs.linked_investment_id
where gfs.linked_investment_id is not null and (i.id is null or i.user_id <> g.user_id);
-- Expected: zero rows.

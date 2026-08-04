-- Fixes an inconsistency in 0014's seed data: the AU investment_return row
-- for retirement/superannuation returns was keyed 'superannuation' while the
-- IN row for the equivalent concept was keyed 'retirement'. The net worth
-- calculator (lib/engines/forecast/netWorthCalculator.ts) looks up the
-- single key 'retirement' for both countries, so the AU row was silently
-- never matched. Rename to align both countries on 'retirement'.
update forecast_global_assumptions
set assumption_key = 'retirement'
where country_code = 'AU' and assumption_key = 'superannuation';

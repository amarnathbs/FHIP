-- P1 (read only). Run on DEV first, then on production, BEFORE anything else. Paste the rows back. It changes nothing.
-- Part 1: the two series and the date each is confirmed through. Expected on production as reported on 19-10-2026: both rows show 2026-10-02.
select series_id, cadence, enabled, to_char(verified_through_date, 'DD-MM-YYYY') as confirmed_through, to_char(updated_at, 'DD-MM-YYYY HH24:MI') as changed_at_utc,
       (select to_char(max(o.observation_date), 'DD-MM-YYYY') from public.ii_risk_free_observations o where o.series_id = s.series_id and o.kind = 'value') as last_rate_day,
       (select count(*) from public.ii_risk_free_observations o where o.series_id = s.series_id) as observation_rows
from public.ii_risk_free_series s
order by series_id;

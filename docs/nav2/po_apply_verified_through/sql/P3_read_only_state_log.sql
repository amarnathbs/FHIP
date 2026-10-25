-- P3 (read only). Run on production. Every change of a switch, a terms status or a confirmed-through date, newest first.
select to_char(l.created_at, 'DD-MM-YYYY HH24:MI') as at_utc, l.series_id, l.previous_enabled, l.new_enabled, l.previous_terms_status, l.new_terms_status, left(l.reason, 140) as reason_start
from public.ii_risk_free_series_state_log l
order by l.created_at desc
limit 30;

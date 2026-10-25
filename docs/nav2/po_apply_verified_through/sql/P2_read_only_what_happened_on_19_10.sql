-- P2 (read only). Run on production. It shows what the database recorded for the uploads of the two risk-free series, newest first, so the 19-10-2026 report can be explained with facts.
-- How to read it: an upload that reached the database leaves one batch row (a new file) or, for a file that was already uploaded before, a state log row that starts with Verified-through (only when the date moved).
-- If there is NO batch row and NO state log row dated 19-10-2026, the press never reached the database: the screen refused it first (for example the future date message of the morning of 19-10-2026 in India or Australia).
select to_char(b.created_at, 'DD-MM-YYYY HH24:MI') as at_utc, b.series_id, b.source_kind, b.file_name, left(b.file_sha256, 12) as file_hash_start,
       b.rows_submitted, b.rows_inserted, b.rows_identical_skipped, to_char(b.date_from, 'DD-MM-YYYY') as from_day, to_char(b.date_to, 'DD-MM-YYYY') as to_day
from public.ii_risk_free_batches b
order by b.created_at desc
limit 30;

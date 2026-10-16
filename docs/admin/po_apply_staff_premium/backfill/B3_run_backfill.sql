-- B3 the backfill. Run it only after B1 (backup) and B2 (preview) and only if the preview list is what you expect.
-- Safe to run again: a second run changes nothing. The column result says started, kept or kept_paid for each account.
-- Each start is recorded in the audit table staff_premium_events with origin backfill.

select user_id, masked_email, planned, result
from public.staff_premium_reconcile(false)
order by result, user_id;

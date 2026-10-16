-- B2 preview (read only). Needs migration 0283 applied. Writes nothing.
-- One row per staff account, e-mail masked to its first two characters and its domain. The column planned says what the backfill will do:
--   start                          a Free or lapsed row becomes Staff Premium
--   start_replacing_admin_grant    an active admin grant is replaced by Staff Premium (the grant is not restored later)
--   start_replacing_promo_code     an active promo is replaced by Staff Premium (not restored later)
--   keep_paid                      a paid subscription is Premium today and stays exactly as it is
--   keep_staff                     already done
--   end                            holds a staff entitlement but is no longer staff (the backfill returns it to Free)
-- Read the list. If it names anyone who should NOT get Premium, stop and tell me before running B3.

select user_id, masked_email, qualifies_via, current_source, current_plan_tier, current_active, planned
from public.staff_premium_reconcile(true)
order by planned, user_id;

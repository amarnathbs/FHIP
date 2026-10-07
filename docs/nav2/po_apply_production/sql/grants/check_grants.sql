-- Read only. After granting: how many administrators hold each fund analytics permission, and whether the same person holds both.
-- Expect uploaders 1, switchers 1 (or 0 until a second administrator exists), and holders_of_both 0 when two people exist.
select
  count(*) filter (where can_upload_risk_free_data) as uploaders,
  count(*) filter (where can_switch_risk_free_series) as switchers,
  count(*) filter (where can_upload_risk_free_data and can_switch_risk_free_series) as holders_of_both
from public.admin_users;

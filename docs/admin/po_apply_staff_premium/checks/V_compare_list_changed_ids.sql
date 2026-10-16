-- V_compare_list_changed_ids lists the accounts behind row 3 of V_compare_with_backup (read only). User ids only, no e-mail.
-- Send me the table. A changed plan or source here normally means a customer paid, cancelled or redeemed a code after the backup.

select e.user_id, e.entitlement_source as now_source, e.plan_tier as now_tier, b.entitlement_source as backup_source, b.plan_tier as backup_tier
from public.user_entitlements e
join private.bk_user_entitlements_before_staff_premium b on b.user_id = e.user_id
where e.entitlement_source <> 'staff_admin'
  and (e.plan_tier, e.entitlement_source, e.effective_from, e.effective_to) is distinct from (b.plan_tier, b.entitlement_source, b.effective_from, b.effective_to)
order by e.user_id;

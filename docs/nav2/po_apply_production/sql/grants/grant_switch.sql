-- Give ONE administrator the permission to switch a risk free series on or off and to change its terms status.
-- Replace the address below with the real address of the person, keep the quotes. Run once.
-- This must be a DIFFERENT person than the one who loads rates, when a second administrator exists.
update public.admin_users
set can_switch_risk_free_series = true
where user_id = (select id from auth.users where email = 'REPLACE-WITH-SWITCHER-EMAIL');

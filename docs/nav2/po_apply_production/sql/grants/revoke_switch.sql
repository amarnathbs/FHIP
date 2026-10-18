-- Take the series switch permission away again (recommended with ONE administrator, right after the switch you needed, so nobody holds it while no switch is planned).
-- Replace the address below, keep the quotes.
update public.admin_users
set can_switch_risk_free_series = false
where user_id = (select id from auth.users where email = 'REPLACE-WITH-SWITCHER-EMAIL');

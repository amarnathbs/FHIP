-- P6b (read only, for you only, do NOT paste the result back). Who the administrators are, so you can choose who gets which NAV2 permission.
select u.email, a.user_id
from public.admin_users a
join auth.users u on u.id = a.user_id
order by u.email;

-- Take the upload permission away again (recommended once the first load is checked, so nobody holds it while no load is planned).
-- Replace the address below, keep the quotes.
update public.admin_users
set can_upload_risk_free_data = false
where user_id = (select id from auth.users where email = 'REPLACE-WITH-UPLOADER-EMAIL');

-- Give ONE administrator the permission to load and correct risk free rates (upload, preview, commit, review queue, correction).
-- Replace the address below with the real address of the person, keep the quotes. Run once.
-- This is a different duty than switching a series on or off. Give the two permissions to two different people when you can.
update public.admin_users
set can_upload_risk_free_data = true
where user_id = (select id from auth.users where email = 'REPLACE-WITH-UPLOADER-EMAIL');

-- C03 WRITE. Delete ONLY the registered proof accounts, and only those whose e-mail ends with the synthetic domain typed below.
-- Run C01 and C02 first (every ok true). Deleting an account removes its uploads, drafts, transactions, statements and entitlement
-- (they cascade). The audit events and the AI cost attempts are NOT deleted: their account reference is set to empty, so the
-- spending record and the proof trail stay. The Premium grant on the proof accounts ends by itself on its end date.
-- Edit the domain below to the synthetic domain of YOUR proof accounts. Left as it is, this deletes nothing.

delete from auth.users u
 where u.id in (select user_id from private.aiproof_ids)
   and lower(split_part(u.email, '@', 2)) = lower('REPLACE-WITH-YOUR-SYNTHETIC-DOMAIN')
returning left(u.id::text, 8) as deleted_user_prefix;

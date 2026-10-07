-- P3 (read only). The one existing function that migration 0261 replaces is exactly the version 0261 was written against (the one from migration 0219).
-- Expect ONE row. body_is_0219 must be true and service_only must be true.
-- If body_is_0219 is false, STOP: another version of this function is live here, and 0261 would overwrite it. Send me the row and the output of P3b.
select
  md5(p.prosrc) as body_md5,
  md5(p.prosrc) = '__EXPECTED_0219_BODY_MD5__' as body_is_0219,
  (not has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute') and has_function_privilege('service_role', p.oid, 'execute')) as service_only
from pg_proc p
where p.oid = 'public.pc6_nav_row_is_candidate(uuid, date, date)'::regprocedure;

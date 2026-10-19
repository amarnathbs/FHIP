-- P3c (read only). The full identity of the retention function that migration 0261 replaces. Expect ONE row.
-- normalized_md5 ignores comments, white space and letter case, so a re-formatted copy of the same text still matches (the raw body_md5 of P3 does not).
-- Migration 0261 now checks this itself before it changes anything: it stops with nothing changed unless the live function is the 0219 text or the 0261 text.
-- is_0219 or is_0261 must be true. If both are false, STOP: send me this row and the output of P3b.
select
  p.proname as function_name,
  pg_get_function_identity_arguments(p.oid) as identity_arguments,
  pg_get_function_result(p.oid) as result_type,
  pg_get_userbyid(p.proowner) as owner,
  p.prosecdef as security_definer,
  p.provolatile::text as volatility,
  md5(p.prosrc) as raw_body_md5,
  md5(lower(regexp_replace(regexp_replace(p.prosrc, '--[^\n]*', '', 'g'), '\s+', '', 'g'))) as normalized_md5,
  md5(lower(regexp_replace(regexp_replace(p.prosrc, '--[^\n]*', '', 'g'), '\s+', '', 'g'))) = 'f76a895dc95c047b62bf11b7935ebd1f' as is_0219,
  md5(lower(regexp_replace(regexp_replace(p.prosrc, '--[^\n]*', '', 'g'), '\s+', '', 'g'))) = 'f5721ba038f67b2b985cd55b8aa8c97e' as is_0261,
  length(pg_get_functiondef(p.oid)) as definition_length,
  md5(pg_get_functiondef(p.oid)) as definition_md5,
  has_function_privilege('anon', p.oid, 'execute') as anon_can_execute,
  has_function_privilege('authenticated', p.oid, 'execute') as authenticated_can_execute,
  has_function_privilege('service_role', p.oid, 'execute') as service_role_can_execute
from pg_proc p
where p.oid = 'public.pc6_nav_row_is_candidate(uuid, date, date)'::regprocedure;

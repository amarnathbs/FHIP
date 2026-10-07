-- D2 definition pack: read only, safe to run on DEV and on production
-- Paste the whole file in the SQL editor and press Run. It returns the five old functions as normalised text (comments removed and white space
-- collapsed) cut in pieces, with the hash and the length of each. Use it when D1 section B says a function differs: send me the whole result.
-- The hash column must equal the expected value in D1 for the function to match the repository.

select f.function_name, g.n as part, substr(f.norm, (g.n - 1) * 900 + 1, 900) as text_part, md5(f.norm) as normalised_hash, length(f.norm) as normalised_length
from (
  select 1 as k, 'create (old, 9 arguments)' as function_name, btrim(regexp_replace(regexp_replace(p.prosrc, '-{2}[^' || chr(10) || ']*', '', 'g'), '\s+', ' ', 'g')) as norm from pg_proc p where p.oid = to_regprocedure('public.admin_create_promo_code(text,integer,integer,boolean,date,boolean,text,text,integer)')
  union all select 2, 'list (old, returns the plain code)', btrim(regexp_replace(regexp_replace(p.prosrc, '-{2}[^' || chr(10) || ']*', '', 'g'), '\s+', ' ', 'g')) from pg_proc p where p.oid = to_regprocedure('public.admin_list_promo_codes()')
  union all select 3, 'redeem (old, 4 arguments)', btrim(regexp_replace(regexp_replace(p.prosrc, '-{2}[^' || chr(10) || ']*', '', 'g'), '\s+', ' ', 'g')) from pg_proc p where p.oid = to_regprocedure('public.redeem_promo_code_for_user(uuid,text,text,text)')
  union all select 4, 'grant (old, 4 arguments)', btrim(regexp_replace(regexp_replace(p.prosrc, '-{2}[^' || chr(10) || ']*', '', 'g'), '\s+', ' ', 'g')) from pg_proc p where p.oid = to_regprocedure('public.admin_manage_premium_entitlement(text,uuid,date,text)')
  union all select 5, 'e-mail request start (old, 3 arguments)', btrim(regexp_replace(regexp_replace(p.prosrc, '-{2}[^' || chr(10) || ']*', '', 'g'), '\s+', ' ', 'g')) from pg_proc p where p.oid = to_regprocedure('public.admin_promo_email_begin(text,integer,boolean)')
) f
cross join lateral generate_series(1, greatest(ceil(length(f.norm) / 900.0)::int, 1)) g(n)
order by f.k, g.n;

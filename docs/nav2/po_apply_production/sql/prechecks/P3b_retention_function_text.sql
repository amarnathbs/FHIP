-- P3b (read only, only needed if P3 said body_is_0219 is false). Shows the live text of the retention function so it can be compared with 0219.
select pg_get_functiondef('public.pc6_nav_row_is_candidate(uuid, date, date)'::regprocedure) as live_function_text;

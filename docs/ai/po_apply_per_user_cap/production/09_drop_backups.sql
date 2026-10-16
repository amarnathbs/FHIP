-- 09 Remove the manual backup copies made by file 02. Run it only when the change is verified and stable.
drop table if exists private.bkp_aiecap_ai_cost_attempt;
drop table if exists private.bkp_aiecap_ai_cost_ledger;

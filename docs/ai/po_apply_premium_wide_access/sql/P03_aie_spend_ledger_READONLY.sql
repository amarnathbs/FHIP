-- P03  READ-ONLY  The AI document-reading spend ledger. This is the ONLY spend ceiling on the document fallback
-- and it is GLOBAL (all users together), not per person. This change does not raise it.
-- If remaining_usd is small, document reading will start refusing for everyone with a "capacity" message once it is gone.

select id,
       allowance_usd,
       reserved_usd,
       settled_usd,
       (allowance_usd - reserved_usd - settled_usd) as remaining_usd,
       total_attempts,
       total_input_tokens,
       total_output_tokens
  from aie_ai_cost_ledger
 where id = 'global';

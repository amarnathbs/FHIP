-- C05 WRITE. Remove the manual backup copies and the account register. Run it only when the proof is finished, the evidence is saved
-- and C04 is clean. The database is over its plan size, so do not keep the copies for long.

drop table if exists private.bkp_aiproof_uploads, private.bkp_aiproof_drafts, private.bkp_aiproof_transactions, private.bkp_aiproof_reconciliation,
  private.bkp_aiproof_audit, private.bkp_aiproof_cost_attempts, private.bkp_aiproof_payroll, private.bkp_aiproof_liability,
  private.bkp_aiproof_retirement, private.bkp_aiproof_investment, private.bkp_aiproof_entitlements, private.aiproof_ids;

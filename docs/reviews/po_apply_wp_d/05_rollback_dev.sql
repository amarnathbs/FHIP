-- WP-D rollback (DEV): remove the new table. Account balances are never touched by the feature. The derived contribution columns of an
-- account stay as last written; restore them by hand using the backup table if wanted.
drop table if exists public.retirement_contributions;
drop function if exists public.retirement_contributions_validate_destination();
-- To restore the contribution columns of the accounts, compare with public.bk_retirement_accounts_wp_d_20261021 (id, employer_contribution, personal_contribution, contribution_frequency) and ask for the exact update statement.

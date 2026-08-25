# FDH-8 — Account Experience

`getAccounts(userId, filters)` returns `{ household: CurrencyTotals[], perAccount: AccountActivityRow[] }`. `household` is computed by fetching approved transactions across ALL of the user's accounts (`filters.accountId` deliberately ignored for this call — the accountId parameter passed to the internal fetch is stripped) and running them through the same oracle used everywhere else; `perAccount` groups the SAME already-fetched transaction set by `financial_account_id` and re-runs the oracle per account (so household and per-account totals are guaranteed to reconcile — they are computed from the identical underlying row set, never two independent queries that could drift).

## Transfer-safety "for free" (spec 41-43)

The worked example — CBA -$1,000 / ANZ +$1,000 must not create $1,000 expense + $1,000 income in the household overview — holds structurally: both legs of a confirmed internal transfer are classified `economic_transaction_type = 'transfer'` by FDH-6, and the oracle never routes `transfer` into `income_total`/`expense_total` regardless of which account(s) the rows being summed span. Pooling multiple accounts' rows into one oracle call cannot, by construction, turn two transfer legs into income+expense — there is no account-crossing logic in the oracle at all, so there is nothing for a transfer to "trick" when accounts are combined.

## No full account numbers (spec 41)

The `/api/financial-data-hub/activity/accounts` route selects `masked_identifier` only from `fdh_financial_accounts` — never the account's raw number (which the schema itself refuses to store: `chk_fdh_accounts_masked_identifier` on `fdh_financial_accounts` rejects any masked identifier containing 7+ consecutive digits, a FDH-1-era structural guarantee FDH-8 inherits rather than re-implements).

## Account drilldown

Each account row links to `/financial-data-hub/activity/transactions?account_id=<id>`, reusing the Transaction Explorer's existing `accountId` filter rather than building a second per-account transaction list.

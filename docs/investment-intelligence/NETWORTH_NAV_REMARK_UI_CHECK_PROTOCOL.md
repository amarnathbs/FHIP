# Net Worth current-NAV re-mark: human UI check protocol

For a person with a signed-in browser and read access to the database. Nothing in this protocol has been run by the author: no signed-in browser, no DEV and no production session was available. It is the checklist that turns "code-complete and test-proven" into "DEV-verified" and then "production-verified".

**Where it is safe to run.**
- DEV (`vqycarelcoijzwlpkpcz`): every step, including the optional NAV-correction step (section 6).
- Production (`twwpnltizhtjxhamyoxt`): **read-only steps only** (sections 1 to 5 and 7). Never edit `ii_prices_nav` or any other row in production for this check.

**What changed (so you know what to expect).** A published India mutual fund position still reaches `investments` exactly once and `ii_fhip_publications.published_value` still records the certified statement value. The one register row's `current_value` is now kept equal to `units x latest eligible NAV` (the same rule as the Holdings table), re-evaluated whenever Net Worth, the Investments list, a report, or a publish/refresh/republish touches it. Each landed change appends a row to `ii_investment_value_revisions`.

**Prerequisite.** Migration `0240_networth_current_nav_remark.sql` is applied to the database you are checking (see the report, section 7). Without it the app falls back to the old frozen value and shows no NAV labels. Check:

```sql
select column_name from information_schema.columns
where table_name = 'investments' and (column_name like 'ii_valuation%' or column_name = 'ii_value_as_of');
-- expect 6 rows: ii_value_as_of, ii_valuation_basis, ii_valuation_units, ii_valuation_nav, ii_valuation_fingerprint, ii_valuation_remarked_at
select to_regclass('public.ii_investment_value_revisions');  -- expect the table name, not null
```

Replace `<USER_ID>` below with the test user's `auth.users.id`.

---

## 1. Find the published funds and their expected value (read-only SQL)

```sql
select i.id as investment_id, i.investment_name, i.owner, i.currency_code,
       i.current_value, i.ii_value_as_of, i.ii_valuation_basis,
       i.ii_valuation_units, i.ii_valuation_nav, i.ii_valuation_remarked_at,
       p.id as publication_id, p.published_value as certified_statement_value,
       s.as_of_date as certified_date, s.units as certified_units,
       p.instrument_id, p.account_id
from investments i
join ii_fhip_publications p on p.published_row_id = i.id and p.status = 'published'
join ii_holding_snapshots s on s.id = p.canonical_position_id
where i.user_id = '<USER_ID>' and i.source_type = 'investment_intelligence_published' and i.is_active
order by i.investment_name;
```

Pick one fund. Note `instrument_id`, `account_id`, `certified_units`, `certified_date`.

Latest eligible NAV for it (eligible = on or before today, quality `ok`/null, price > 0, same currency):

```sql
select price_date, price, currency_code, quality_status
from ii_prices_nav
where instrument_id = '<INSTRUMENT_ID>'
  and price_date <= current_date
  and (quality_status is null or quality_status = 'ok')
  and price > 0 and currency_code = '<FUND_CURRENCY>'
order by price_date desc limit 3;
```

Units transacted after the certified statement (for this folio):

```sql
select transaction_date, transaction_type, units, status
from ii_transactions
where user_id = '<USER_ID>' and account_id = '<ACCOUNT_ID>' and instrument_id = '<INSTRUMENT_ID>'
  and transaction_date > '<CERTIFIED_DATE>' and status not in ('reversed','review_required')
order by transaction_date;
```

**Expected value** = (`certified_units` + net units from the query above: purchases and reinvested dividends positive, redemptions negative) x (the NAV in the first row), **only if that NAV's date is later than `certified_date`**. Otherwise it is the certified statement value, and the row must say so.

Worked example (the unit-test oracle): 100 units, statement value 10,000 (NAV 100) on 2026-06-30, latest eligible NAV 112 on 2026-09-30 -> **11,200**, dated 2026-09-30. A later correction of that NAV to 111 -> **11,100**.

## 2. Investments tab agrees with the SQL

1. Open `/investments`. Above the grid there is a panel **Mutual funds in your Net Worth**.
2. The chosen fund's row shows **Value**, **Units**, **NAV**, **NAV date** and a tag. Expected: Value = the expected value from section 1 to the paisa; Units = certified units plus later net units; NAV and NAV date = the first row of the NAV query.
3. Tag: **Latest NAV** when the NAV date is within 7 days of today; **Stale NAV** when older; **Statement value** (never "NAV") when no eligible NAV is newer than the certified statement; **Redeemed** with value 0 for a 0-unit position.
4. Re-run the section 1 query: `current_value` equals the panel Value; `ii_value_as_of` equals the NAV date; `ii_valuation_basis` is `market_nav` / `statement` / `redeemed` to match the tag; `certified_statement_value` is **unchanged** (it is the immutable certified value).

## 3. Dashboard Net Worth agrees with the Holdings table to the rupee

1. Open `/dashboard`. Under the figures the **About these figures** box has a line **Mutual funds in your Net Worth: N at the latest NAV dated ... (and M at a statement value, K redeemed, J stale)**. The dates are the oldest and newest NAV dates among your published funds.
2. Net Worth contribution of the fund = the panel Value from section 2. To prove the whole figure: note Net Worth, then compute (Net Worth before) - (old frozen value) + (new value) for a fund you know changed, or compare the sum of all panel Values with the Dashboard "Investments" total minus your manual investments.
3. Open `/investment-intelligence` -> Performance -> Holdings. For the **same folio** the Market Value, NAV and NAV date must equal the Investments panel to the rupee. For a fund held in two folios, the Holdings rows are per folio and the Net Worth rows are per folio: the two folio values add up to the scheme total shown in X-Ray / Performance.
4. Open X-Ray and Overview: the portfolio total equals the sum of the panel Values of all published India funds when all of them are published (if some are only imported, Overview counts them at their NAV-valued amount and Net Worth counts only the published ones, the rest sit in **Imported, not yet in Net Worth**).

Record: Dashboard Net Worth ____, Investments panel total ____, Holdings total ____, difference ____ (expected 0.00).

## 4. Exactly once, idempotent, no phantom wealth

1. Reload `/dashboard` and `/investments` three times. Then:
   ```sql
   select count(*) from ii_investment_value_revisions where investment_id = '<INVESTMENT_ID>';
   select count(*) from investments where user_id = '<USER_ID>' and ii_canonical_instrument_id = '<INSTRUMENT_ID>' and ii_canonical_account_id = '<ACCOUNT_ID>' and is_active;
   select count(*) from ii_fhip_publications where user_id = '<USER_ID>' and instrument_id = '<INSTRUMENT_ID>' and account_id = '<ACCOUNT_ID>' and status = 'published';
   ```
   Expected: revision count identical before and after the reloads (no write when nothing changed); exactly **1** active register row; exactly **1** published publication.
2. Revision history for the fund (read-only):
   ```sql
   select created_at, reason, remark_trigger, previous_value, new_value, previous_basis, new_basis, units, nav, value_as_of, statement_as_of, statement_value
   from ii_investment_value_revisions where investment_id = '<INVESTMENT_ID>' order by created_at;
   ```
   Expected: the first row is `baseline` (previous = the value before the first evaluation, usually the certified statement value); later rows are `nav_update` / `nav_correction` / `units_changed` with the matching NAV and dates.
3. A redeemed position (a published fund whose certified snapshot has 0 units): Investments panel shows **Redeemed**, value 0, and Net Worth carries 0 for it.
4. A **manual** investment you entered yourself keeps its value and has no valuation tag. Confirm: `select current_value, ii_valuation_basis from investments where user_id='<USER_ID>' and source_type='manual';` -> `ii_valuation_basis` is null for all of them and `current_value` is what you typed.

## 5. Entity-owned and joint accounts

1. **Entity-owned (Trust / HUF / Company).** Find accounts with an entity owner:
   ```sql
   select ii_account_id, owner_business_entity_id, allocation_basis_points
   from ii_ownership_allocation where user_id = '<USER_ID>' and status = 'active' and owner_business_entity_id is not null;
   ```
   For such an account: no active `investments` row should exist for its positions (publication to personal Net Worth is blocked by the owner-edit work, once merged); if one pre-exists, the re-mark skips it (its `ii_valuation_basis` stays null and its value does not change). Personal Net Worth must not include it; the entity holding appears only in the separate owner-class breakup on the Investment Intelligence Overview and in the macro consolidated line (owner-edit branch).
2. **Joint split.** For an account with two member allocations (for example 6000 / 4000 basis points):
   ```sql
   select owner_member_id, allocation_basis_points from ii_ownership_allocation
   where user_id = '<USER_ID>' and ii_account_id = '<ACCOUNT_ID>' and status = 'active' and ii_instrument_id is null;
   ```
   Expected: **one** register row for the position (`owner = 'joint'`), whose `current_value` is the NAV-valued total (for example 1,000,000). Household Net Worth counts it once. Once the owner-edit branch is merged, the owner breakup shows 600,000 and 400,000 and they add up to the same 1,000,000, never 2,000,000.

## 6. DEV only: a NAV correction supersedes

Only on DEV, with a throw-away test position:

```sql
-- note the current NAV row
select id, price_date, price from ii_prices_nav where instrument_id = '<INSTRUMENT_ID>' order by price_date desc limit 1;
-- correct it (DEV ONLY)
update ii_prices_nav set price = <OLD_PRICE> - 1 where id = '<NAV_ROW_ID>';
```
Reload `/investments`. Expected: Value drops by units x 1; NAV shows the corrected price; one new revision with `reason = 'nav_correction'`. Then restore the price and reload; Value returns; another `nav_correction` revision is recorded. (The history keeps both.)

## 7. Failure and degradation checks (read-only observation)

- If a fund has no eligible NAV newer than its statement, the row says **Statement value** with the statement date; the Dashboard note says "at a statement value (no newer NAV on file)". It never says "Latest NAV".
- A NAV older than 7 days: the tag says **Stale NAV** with its date; the number is still units x that NAV (it is disclosed, not altered).
- Before migration 0240 is applied: the Investments panel is absent (no valuation fields), Net Worth shows the previous frozen values, and nothing errors. After applying 0240 the labels and NAV values appear on the next page load.

## 8. Pass / fail record

| Check | Expected | Observed | Pass |
|---|---|---|---|
| 2: panel Value = SQL expected value | to the paisa | | |
| 2: panel NAV date = latest eligible NAV date | equal | | |
| 3: Dashboard note names the NAV dates | yes | | |
| 3: Holdings market value = panel value (same folio) | difference 0.00 | | |
| 4: reload x3 does not change revision count | unchanged | | |
| 4: exactly one active register row and one published publication | 1 and 1 | | |
| 4: manual investments untouched | yes | | |
| 5: entity-owned excluded from personal Net Worth | yes | | |
| 5: joint position counted once | yes | | |
| 6 (DEV): correction supersedes | yes | | |

Label the result honestly: **DEV-verified** only when every row above was observed on DEV; **production-verified** only for the read-only rows observed on production.

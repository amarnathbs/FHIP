# Document2 Finding #5 — Browser verification protocol (Holdings and related screens)

**Purpose.** The unit and integration tests prove the NAV-selection rule and that every consumer applies it identically. They cannot prove what a signed-in browser actually renders on DEV or production. This protocol is what a human, or a browser-driving session with a real login, runs to close that last gap. It is read-only: nothing here writes data.

**Evidence label until this is executed:** the Finding #5 fix is **code-complete and test-proven**. It is **not DEV-verified and not production-verified** by this protocol until the steps below have been run and the results recorded.

**Requirements.** A signed-in user with at least one mutual-fund position that has units greater than 0, and read access to the database for the expected-value step (Supabase SQL editor on DEV, or the read-only production access path). Run on DEV first, then production.

---

## 1. Compute the expected values independently (read-only SQL)

Do this **before** looking at the screen, so the expectation is not influenced by what the screen shows. Replace `<USER_ID>`.

**1a. The latest certified statement per position:**

```sql
select a.folio_number,
       i.instrument_name,
       s.instrument_id,
       s.as_of_date           as statement_date,
       s.units,
       s.value                as statement_value,
       case when s.units > 0 then s.value / s.units end as statement_nav,
       s.currency_code
from ii_holding_snapshots s
join ii_accounts    a on a.id = s.account_id
join ii_instruments i on i.id = s.instrument_id
where s.user_id = '<USER_ID>'
  and s.as_of_date = (select max(s2.as_of_date) from ii_holding_snapshots s2
                      where s2.account_id = s.account_id and s2.instrument_id = s.instrument_id)
order by i.instrument_name;
```

**1b. The latest ELIGIBLE NAV for each instrument.** Eligible means all of: dated today or earlier (UTC), `quality_status = 'ok'`, `price > 0`, and in the same currency as the holding.

```sql
select instrument_id, price_date, price, currency_code, quality_status
from ii_prices_nav
where instrument_id = '<INSTRUMENT_ID>'
  and price_date <= (now() at time zone 'utc')::date
  and quality_status = 'ok'
  and price > 0
  and currency_code = '<HOLDING_CURRENCY>'
order by price_date desc
limit 3;
```

**1c. Work out the expected row** (hand calculation, not code):

| Situation | Expected NAV date | Expected NAV | Expected market value | Expected tag |
|---|---|---|---|---|
| Latest eligible NAV date is **after** the statement date | that NAV's own date | that NAV's price | units x that price | none (and, if the NAV is more than 7 days before today, **Stale**) |
| No eligible NAV newer than the statement | the statement date | statement value / units | the statement value | **Statement** (and **Stale** if more than 7 days old) |
| Units = 0 (fully redeemed) | `—` | `—` | 0 | **Redeemed** |

Note any of these in your results sheet: instrument, statement date, units, latest eligible NAV (date, price), expected market value.

---

## 2. Check the Holdings table

1. Sign in and open **Investment Intelligence > Performance**. The **Holdings** table is on that page.
2. For each position from step 1, find its row and read: **NAV date**, **NAV**, **Market value**, and any small tag beside the NAV date (hover the NAV date for the tooltip, which states where the value came from).
3. Compare with the expectation from 1c.

**Pass criteria, per row:**

- The **NAV date** equals the date you computed, and is **the NAV's own date**. It must not be the statement date when a newer eligible NAV exists.
- **Market value = Units x NAV** (allow rounding in the last displayed digit).
- **Gain/(Loss)** = Market value - Cost value, and **Return %** = Gain/(Loss) / Cost value.
- A row valued from the statement shows the **Statement** tag. A row valued from a market NAV shows **no** such tag.
- A row whose NAV is more than 7 days old shows **Stale**. A row with a fresh NAV does not.
- A fully redeemed position shows NAV date `—`, Market value 0 and the **Redeemed** tag. It must not show a non-zero value, and must not need any NAV.
- No row shows a blank or `0` market value for a position that still has units. If it does, record it as a failure.

You can also read the same values as JSON (signed in, in the browser address bar): `/api/investment-intelligence/holdings`. The fields are `navDate`, `nav`, `marketValue`, `valuationBasis` (`market_nav`, `statement`, `redeemed`, `unavailable`), `statementAsOfDate`, `statementNav`, `statementSuperseded`, `valuationStale`, `valuationNote`.

---

## 3. Check that the other screens agree (same holding, same value, same date)

| Screen | Where | What to compare |
|---|---|---|
| Overview | Investment Intelligence home | **Value of reconstructed positions** per currency = sum of the Market values in Holdings for that currency. **Valued as at** = the most recent NAV or statement date used; the "oldest position as at" line, if shown, = the oldest. |
| X-Ray | Investment Intelligence > X-Ray | "Positions as at" = the most recent valuation date used. The AMC table value for a fund = that fund's Market value in Holdings. |
| Performance | Investment Intelligence > Performance, "Scheme performance" table | "Value as of" date and value for each scheme = the Holdings row's NAV date and Market value. |

Where the same fund is held in **more than one folio**, Holdings shows one row per folio, while Performance and X-Ray work per fund and read only the most recent statement's units (a known limitation recorded in the closure report, outside Finding #5's NAV-selection scope). Do not treat a mismatch on such a fund as a NAV-selection failure; note it separately.

**Not expected to match:** a position you have **published** keeps the value certified at its statement date (the Net Worth entry is a frozen, once-only publication). If the Holdings value has moved on since the statement, the Net Worth figure will legitimately differ until the position is republished. Record this as "by design" and do not log it as a defect.

---

## 4. A point-in-time check (optional but recommended)

Open `/api/investment-intelligence/analytics?to=YYYY-MM-DD` with a date **between** two of the holding's NAV dates (and before today). The Performance scheme `currentValue` and `currentValueDate` in the JSON must use the NAV on or before that date, never a later NAV and never a later statement.

---

## 5. Record the result

For each position: instrument, expected (date, NAV, value), observed (date, NAV, value, tags), PASS / FAIL. Attach a screenshot of the Holdings table and of the JSON for any FAIL. Only when every row passes on DEV **and** on production may Finding #5's browser proof be marked complete.

---

## 6. If it is wrong: what to look for

| Symptom | Most likely cause | How to confirm |
|---|---|---|
| NAV date is the statement date, but a newer NAV exists in the database | The build running is older than this fix | Check the deployed commit includes the Finding #5 change (`currentHoldingValuation.ts` exists in the build). Reload after the deployment finishes. |
| NAV date is the statement date, tag says **Statement**, and a newer NAV row exists | That NAV row is **ineligible**: `quality_status` is not `ok`, `price` is 0 or negative, its `currency_code` differs from the holding's, or its date is in the future | Run query 1b without the eligibility filters and look at the newer rows' `quality_status`, `price` and `currency_code`. The screen is correct; the data is not. |
| NAV date is old and **Stale** is shown, and no newer NAV exists | NAV hydration has not covered this instrument or date range | Check the NAV1 held-instrument hydration and coverage status for the instrument (`ii_prices_nav` has no recent row). Not a display defect. |
| Market value is 0 for a position that has units | The latest statement snapshot says 0 units | Check `ii_holding_snapshots.units` for that position. If the statement really says 0, the position is redeemed and `Redeemed` should appear. |
| Market value shows `—` | The row failed unit reconciliation and shows a "Data quality issue" badge | Resolve it from the statement (the "Resolve on statement" link). Values are intentionally withheld, not zero. |
| Overview total differs from the sum of Holdings rows | A currency mix, a published-versus-reconstructed confusion, or the position being in more than one folio | Compare per currency, and compare reconstructed (not published) values. |
| X-Ray or Performance fund value differs from its Holdings row | Same fund held in more than one folio (those two screens read one statement per fund) | Check whether the fund has more than one folio in Holdings. Known limitation, not a NAV-selection fault. |
| Net Worth value differs from Holdings | By design: published positions are frozen at the certified statement value | Confirm the position is published and note the statement date. |

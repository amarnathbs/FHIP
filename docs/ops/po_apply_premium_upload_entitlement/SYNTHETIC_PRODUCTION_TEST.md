# Synthetic production test -- Premium Upload Entitlement

Purpose: after the release is live, prove on production that (1) a Free customer is refused every upload / import path before anything is
stored or processed, (2) a Premium customer is not broken, (3) manual entry still works on Free, (4) Admin imports are unaffected.
Synthetic accounts only. **No real customer is used and no real customer's subscription is changed.**

## Preconditions

* The release is deployed (Amplify build of the merge commit shows *Deployed*). Record: merge SHA, build number, time live.
* One synthetic **Free** customer and one synthetic **Premium** customer exist on production (country confirmed, ordinary onboarding done). The Premium one
  is granted through the existing Admin Premium grant screen (a time-limited grant is fine) -- not by editing the database. Confirm their state with the
  read-only query below (replace the placeholders; do not paste real customer ids anywhere else).
* No managed backups exist on production. This test **writes nothing** except where Step 5 says so; nothing here needs a backup. If you choose Step 5 and a
  later cleanup needs a data change, take a manual table backup of the affected tables first.

```sql
-- Read-only: confirm the two synthetic accounts' plan state.
select user_id, plan_tier, effective_from, effective_to, entitlement_source
  from public.user_entitlements
 where user_id in ('REPLACE_SYNTHETIC_FREE_USER_ID', 'REPLACE_SYNTHETIC_PREMIUM_USER_ID');
```

## Step 1 -- Free: manual entry works (browser)

Sign in as the synthetic Free user. For each of Income, Expenses, Liabilities, Investments (and Retirement, Insurance):
add one manual record, edit it, delete it. Expected: all succeed. Screenshot one.

## Step 2 -- Free: the UI shows the Premium lock (browser)

On Income, Expenses, Liabilities, Investments, Retirement, and India Investments (`/investment-intelligence/data`):
the Import control is a **link with a "Premium" pill**; opening it shows the lock notice with the wording *"Statement and document import is available on Premium.
You can continue to add and edit your financial information manually on the Free plan."* and a **View Premium plans** link to `/profile`. There is **no file picker**
anywhere. Check at 375 px (phone) and desktop widths; tab to the lock with the keyboard. Screenshot each.

## Step 3 -- Free: direct API refusal (console probe)

On any app page, open the browser console and paste `synthetic_probe.js` (this folder). Expected for Free:
`PREMIUM_REQUIRED on 28 of 28` (HTTP 403) and `import_access = premium_required`. Save the printed JSON block. The probe sends only empty/invalid bodies and random ids,
so even a missed gate cannot create data -- but a missed gate would show as a non-403 row, which is the finding.

## Step 4 -- Premium: nothing broken (console probe)

Sign in as the synthetic Premium user and paste the probe again. Expected: `PREMIUM_REQUIRED on 0 of 28`, `import_access = allowed`, statuses 400/403 (feature flag, no
code)/404/422 -- and **no unexpected 5xx**. Manual entry: repeat Step 1 quickly. Screenshot the Import control active (no lock) on Income.

## Step 5 -- (optional, with your explicit go-ahead) one real synthetic upload as Premium

Only if you want proof beyond "the gate lets Premium through": as the synthetic Premium user upload one tiny, obviously synthetic payslip PDF on Income,
review it, then **delete the document in the app** (the user's own delete; never SQL). Then run the residue query:

```sql
-- Read-only residue check for the synthetic Premium user.
select 'documents' as what, count(*) as n
  from public.fdh_statement_uploads where user_id = 'REPLACE_SYNTHETIC_PREMIUM_USER_ID'
union all
select 'upload_sessions', count(*) from public.fdh_upload_sessions where user_id = 'REPLACE_SYNTHETIC_PREMIUM_USER_ID'
union all
select 'income_source_rows', count(*) from public.income_sources where user_id = 'REPLACE_SYNTHETIC_PREMIUM_USER_ID';
```

Expected after cleanup: the counts you recorded before Step 5. Do not Apply the payslip (that would create an Income row).

## Step 6 -- Admin exemptions

Sign in as an authorised Admin who has **no Premium consumer plan** and open Admin -> Resources, Benchmarks / Market Index Data and Recommendations.
Expected: all load and their upload controls are active (no Premium lock, no 403). **Do not upload anything that changes published content**; opening the
upload screens and the template downloads is sufficient. A customer account (Free or Premium) opening an Admin URL must still be refused by the Admin guard.

## Step 7 -- Downgrade check (optional)

Revoke the synthetic Premium user's grant through the Admin screen. Re-run the probe: it must now match the Free result. Previously imported data (if Step 5 was
done and not deleted) must still be visible and editable.

## Cleanup

Revoke the synthetic Premium grant; remove the synthetic accounts only if they were created solely for this test. Record what remains.

## Verdict wording you may use

* All of Steps 1-4 and 6 green: **PRODUCTION-VERIFIED for the Free denial matrix, the Premium non-regression and the Admin exemptions** (list which steps you ran).
* A real upload (Step 5) is what separates *"gate does not break Premium"* from *"Premium import works end to end on production"*; say which one you proved.
* Anything not run is **NOT VERIFIED**, not a pass.

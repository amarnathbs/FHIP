# Production proof: safe procedure and evidence template (you run it; I cannot)

Nothing here needs a production credential in my hands. You use your own browser sessions. Use **synthetic documents**
only (generated below), **your own accounts**, and do not touch any real customer. No production data is changed by any
step except the rows your proof accounts create through the normal app screens. **Production has no managed backups**,
so there is deliberately no SQL delete anywhere in this procedure; cleanup is done with the app's own Delete.

## 0. Accounts (create or reuse your own; all addresses synthetic or yours)

| Label | Plan | Must be | How |
|---|---|---|---|
| P1 | Premium | **Outside the former two-e-mail pilot** | A fresh account you control, then Admin > Premium grant for 1 to 3 days (or a promo code) |
| P2 | Premium | Also outside the pilot, independent of P1 | Same, a second account |
| F1 | Free | Never granted | A fresh account |
| X1 | Former pilot e-mail, **no active Premium** | One of the two former pilot accounts, if it is not Premium today, or a copy of the F1 recipe using that address | Proves pilot membership no longer helps. Skip if both former pilot accounts are Premium; then use F1 only |
| E1 | Premium that ends | P2 after the grant is shortened or revoked in Admin | Proves a lapse stops new execution |

Admin status alone must not give consumer Premium: use an Admin account that has **no** Premium grant as A1 (step 9).

## 1. Make the synthetic documents

From the repository root on your machine, after the push, run:

```
npx tsx scripts/ai_premium_proof_make_fixtures.ts "%USERPROFILE%\Documents\fhip_ai_proof"
```

It writes four synthetic files (bank statement letter PDF that no layout parser can read, liability CSV, retirement
CSV, AU investment CSV). A payslip and an Investment Intelligence statement: use your own synthetic ones. Each file is
generated with a unique tag, so repeating the run creates new, distinct documents (no duplicate-upload shortcut).

## 2. Before you start: take the baseline (sql/P03 and V02 statement 6) and write the numbers in the table

## 3. The journeys (each is: do it, then fill one evidence row)

| # | Account | Action | Expected | Evidence to record |
|---|---|---|---|---|
| 1 | P1 | Expenses > import the bank letter PDF; choose Self as owner | Upload ok, scan clean, "AI-read draft" screen appears, values shown for your review. **No pilot message** | Time (dd/mm/yyyy hh:mm, Melbourne), document id (browser address bar of the review or network tab), `sql/V01` row `bank_statement_ai_fallback_draft_ready`, `V02` statement 6 row (model `gpt-4o-mini`, tokens, cost) |
| 2 | P1 | Accept the draft | Transactions written exactly once; screen says imported | `V02` statement 3 shows the original file purged; transaction count |
| 3 | P1 | Reload and open the same document | Already-imported message; no second AI call | `V02` statement 6: no new row |
| 4 | P2 | Same journey with a different tag | Own draft, own result; P1 cannot see it | Both accounts' pages: only their own data; document ids differ |
| 5 | F1 | Same bank letter PDF | Upload and deterministic read run; it ends as "could not read"; the message says AI reading is a Premium feature and offers the upgrade. **No AI draft** | `V01`: `premium_required` on `bank_statement_ai_fallback_not_usable`; `V02` statement 6: **no new provider row**; ledger numbers unchanged |
| 6 | X1 | Same | Same as 5 | Same |
| 7 | F1 | Enter the same figures by hand | Manual entry works | Screenshot |
| 8 | E1 (after revoke) | A NEW unreadable document | Refused as in 5. A draft created while Premium (if any) is still reviewable and acceptable | `V01` reason `premium_required` |
| 9 | A1 (Admin, no Premium) | Same document | Refused as in 5 | `V01` |
| 10 | F1, then upgrade F1 to Premium | Same document again | Works after the grant, with no sign-out needed (the plan is read on every request) | `V01` |
| 11 | P1 | Liability CSV, retirement CSV, AU investment CSV, payslip, one Investment Intelligence statement | Each ends in its review screen and, once accepted, its canonical result | One row each |
| 12 | Any | Set `AIE_BANK_STATEMENT_AI_FALLBACK_ENABLED=false`, build, repeat 1 | No AI call, normal rejection, manual entry intact; then set it back | Time, `V01` reason `adapter_disabled` |

Journey 5 is the important negative: success is **a refusal and a ledger that did not move**, not the absence of a message.

## 4. Spend and accounting

Record `sql/P03` before and after. Expected movement per document: a few tenths of a cent to about one cent. Open
reservations older than an hour (`V02` statement 5) must be zero afterwards. If the global ceiling is close to gone,
stop and decide on the ceiling before inviting users; the change deliberately does not raise it.

## 5. Evidence template (copy this block per journey)

```
Journey:                #__
Date and time:          __/__/____ __:__ (Melbourne)
Account label / plan:   P1 / Premium (outside pilot)
Document class + tag:   bank statement / tag ______
Document id:            ________________________
HTTP result seen:       ___ (screen text: ______________)
V01 row (event, reason, count):  ______________________
V02-6 row (model, in tokens, out tokens, outcome, reserved, settled):  ________
Ledger before / after (remaining USD):  ____ / ____
Original file purged (V02-3):  yes / no
Result accepted once (rows written):  ___
Cleanup done (app Delete / account removed):  yes / no
```

## 6. Cleanup

Use the app's own Delete on each proof document and remove the proof accounts through the normal account route.
Spend ledger entries stay (they are accounting). The Premium grants end by themselves on their end date (1 to 3 days).

## 7. What I could not do and you must not read into this

I produced no PRODUCTION-VERIFIED evidence. The words "live for all eligible Premium users" are not claimed until your
journeys 1, 2, 5 and 11 above have rows filled in with real ids and times.

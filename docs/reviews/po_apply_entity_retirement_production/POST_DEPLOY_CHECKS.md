# Post-deploy checks (production, after the code is live)

Do these in order, signed in as yourself. Nothing here needs a password to be typed anywhere but your own login.

## 1. Read only database checks (SQL editor)
1. `A_prerequisites_and_what_is_new_READ_ONLY.sql`: every NEW row true, every prerequisite true.
2. `cutover/P4_verify_READ_ONLY.sql` (your login e-mail in the file): the same values as after P3.

## 2. The numbers (Dashboard)
- Personal net worth 874,441. Family net worth 1,007,441. The Entities section lists the SMSF with its own assets 503,000, liabilities 370,000 and net economic value 133,000, counted in full.
- No "SMSF recorded twice" note, no "typed value" note on the SMSF card.

## 3. The screens
- Investment and Retirement > Retirement: the top of the page has the retirement status and declaration controls, then the contribution panel, then the accounts. SMSF card: itemised, Assets, Liabilities, a net worked out for you with no box to type it, Income and expenses, Bank statements (Premium, the upload entry only, see item 6), history.
- SMSF > Add liability stays on the SMSF card (it never opens the personal Liabilities page).
- Personal Liabilities > Add: the Owner list has no SMSF, Company or Family Trust. The catalogue has no "SMSF Property Loan / LRBA".
- Companies and Trusts: opens, shows entities with how each is recorded, assets and liabilities, income, expenses, history and Undo (if you have an entity).
- Retirement declaration: with an active account the "I don't have any retirement savings" tick is disabled with the reason.
- Monthly Report: the entity table matches the Dashboard entity section figure for figure.

## 4. What must NOT have changed
- Personal net worth and every personal ratio (debt to income, debt service) are the same as before the release.
- The Dashboard history chart for earlier months is unchanged (history is not rewritten).

## 5. Browser console and network
- No red errors on Dashboard, Retirement, Companies and Trusts, Reports. No request fails with 500.

## 6. Switches that must stay as they are
- `AIE_RETIREMENT_PDF_ROUTE_ENABLED` is not set (off). The retirement PDF import is not offered beyond what it was before.
- Production document uploads are still gated by the malware and readiness programme. The SMSF bank statement upload is the existing bank upload with the owner fixed to the fund: it is only as open as the bank upload already is (still gated). Do NOT try a real statement upload in production as a test.

## 7. If a check fails
Do not fix forward in production. Note the screen and the exact message and follow `ROLLBACK_SEQUENCE.md`.

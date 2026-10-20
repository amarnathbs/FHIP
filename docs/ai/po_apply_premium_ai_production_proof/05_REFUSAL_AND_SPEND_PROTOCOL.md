# 5. Refusals and spending controls: what is proven, and the production protocol

## 1. How the spending controls actually work (read from code and schema; PGLITE-VERIFIED)

| Control | Where it lives | Size | When it resets |
|---|---|---|---|
| **Global AI allowance** | one row, `aie_ai_cost_ledger` id `global`: stored `allowance_usd`, running `reserved_usd` and `settled_usd` | US$10.00 by default (production value **UNKNOWN**: read `sql/A02`) | **Never.** It is a lifetime ledger for the whole platform. Nothing in any migration or in the application resets, deletes or truncates it (PGLITE-VERIFIED: a test scans every migration and every application file, and shows spend dated 40 days ago still counts). A "daily" figure shown anywhere is not this |
| Effective global ceiling | the **smaller** of the stored `allowance_usd` and the setting `AIE_AI_COST_ALLOWANCE_USD` | | Raising the setting alone cannot raise the ceiling; only an update of the stored column does (`sql/ops/O01`) |
| **Per-user daily cap** | stored `aie_ai_cost_ledger.user_daily_cap_usd`; a user's day is derived from their attempt rows | US$1.00 per user per **UTC** day (production value UNKNOWN) | Every day at 00:00 UTC (10:00 or 11:00 in Melbourne; 05:30 in India). The setting `AIE_USER_DAILY_COST_CAP_USD` can only lower it |
| Per-document bounds | code | 4,000 input tokens reserved, 512 output (4,096 for line-item statements), 2 transient retries, 20 s timeout, `gpt-4o-mini` only | per call |
| Idempotency | primary key on the attempt row | a replayed key is never admitted or charged twice | |

Order of checks for one reading (UNIT-TESTED): class switch, global switch, real-scan precondition, **Premium**, masking, gateway model and
personal-data re-scan, then the single atomic database step (**per-user cap first, then global allowance**) which reserves the worst case, then the
provider, then settlement at the actual cost. A refusal anywhere before the provider sends nothing and charges nothing.

Reservation sizes (worst case, what counts while a call is in flight): scalar document US$0.00272; line-item statement US$0.0092 to US$0.0166. Actual
settled cost of the DEV readings of these very files: US$0.000444 (bank) to US$0.000668 (retirement). The cap is therefore a backstop against a script
(about 2,900 statement readings a day), not a tight per-person budget.

## 2. What is already proven without spending money

| Claim | Label | Where |
|---|---|---|
| Free user refused before provider and before any chargeable work (upload refused 403 `PREMIUM_REQUIRED`: no row, no storage, no scan, no ledger movement) | DEV-verified (19/10/2026) and UNIT-TESTED | rehearsal R1; `premiumUpload*` suites |
| Former-pilot account whose plan ended: AI step refused `premium_required` (not `cohort_denied`), no attempt row, nothing reserved or settled | DEV-verified | rehearsal R4; `premiumAiProductionConfig` (the real gate) |
| Expired window refused; upgrade honoured on the next request, same session | DEV-verified | rehearsal R5, R6 |
| Forged plan or user claim in query string and headers from a Free session ignored | DEV-verified and UNIT-TESTED | rehearsal R2; `aiePremiumAccessRoutes` |
| No session: 401 | DEV-verified | rehearsal R3 |
| Cross-tenant: another Premium account gets 404 on process and confirm; a Free account 403; the draft stays pending. Draft store functions only ever act on the owner's rows | DEV-verified and UNIT-TESTED | rehearsal J1.9; `aiProductionProofTenancy` |
| Replay: same document, same upload or same confirm makes no second provider call, no second charge, no second write | DEV-verified | rehearsal J1.7, J1.8, J1.12 to J1.14 |
| Reservation then settlement accounting, six realistic readings leave exactly the settled sum, reservation released, replays and double settlement charge nothing | PGLITE-VERIFIED | `aiProductionProofSpendPglite` section 3 |
| Per-user cap: exact arithmetic, UTC rollover, per-user independence, refusals recorded with nothing reserved | PGLITE-VERIFIED (30 tests with mutants) and DEV-verified with **22 truly parallel requests: exactly 10 admitted** (scripts/aie_user_cap_live_dev_check.ts, 12 of 12, 19/10/2026) | |
| Per-user cap through the real route: refused `daily_limit_reached` before the provider, attempt `user_daily_cap_reached`, no draft, ledger unchanged | DEV-verified (temporary cap of US$0.001, restored and re-read) | rehearsal L1 |
| Global ceiling through the real route: attempt `budget_exhausted`, no provider request id, no draft (the person is not told the reason; it stays internal) | DEV-verified (temporary ceiling of US$0.001, restored) | rehearsal L2 |
| Global ceiling is lifetime; per-user cap resets daily | PGLITE-VERIFIED | `aiProductionProofSpendPglite` section 1 |

No real provider money was spent to exhaust anything. The DEV rehearsal used six real readings (about US$0.003 in total).

## 3. Production protocol (you run it; accounts F1, X1, P1, P2 from the README)

Open `sql/E06` for the account under test **before and after** each step (replace the all-zero id). Expected "nothing happened" is: `uploads`,
`drafts`, `cost_attempts`, `ai_events` all 0 for a Free account blocked at upload.

| # | Account | Action | Expected | Evidence |
|---|---|---|---|---|
| R1 | F1 (Free) | Expenses, Import: choose the file DOC-B1 | The screen shows the Premium locked-upload notice and no file form, or an upload attempt is refused with a Premium message. **No document is created** | Screenshot; `E06` zeros; `A02` `total_attempts` and `settled_usd` unchanged |
| R2 | X1 (former pilot e-mail, no active Premium) | Same | Same as R1: pilot membership does not help | Same, plus `E10` shows `premium_today` false |
| R3 | F1 | Enter one of the sheet's transactions by hand (manual entry) | Works. Manual entry stays available to Free | Screenshot |
| R4 | any | Sign out, open an import screen | Sent to sign-in; no upload possible | Screenshot |
| R5 | A1 (an Admin account **without** a Premium grant; staff roles Super Admin, Resource Administrator and Editor are Premium by design since 16/10/2026) | Try to import | Refused as R1 | `E10` for A1 |
| R6 | E1 (P2 after you shorten its grant to yesterday in Admin) | Upload a **new** file | Refused as R1 | `E10` shows `premium_today` false; `E06` zeros for the new attempt |
| R7 | F1, then grant Premium in Admin | Reload the same signed-in session and import | Works with **no sign-out** (the plan is read on every request) | Time of grant, time of success |
| R8 | X1 or F1, **lapsed after upload** (optional, not rehearsed in a browser) | In the browser developer tools, Network, block the address pattern ending in `/process`. As a Premium account upload DOC-B2 (the upload completes; the reading does not start). In Admin end the Premium grant. Remove the block and reopen the import panel so the waiting document is processed | The reading is **refused** with the Premium message and the upgrade offer; `E02` shows `..._ai_fallback_not_usable` with reason **premium_required**; `E04` and `E06` show **no cost attempt**; `A02` unchanged. A draft created while Premium (if any) can still be reviewed and accepted | `E02`, `E04`, `E06`. If the panel does not resume the waiting document, record **NOT PERFORMED** with the exact point it stopped |
| R9 | P2 | Open P1's document by its address | Not found. P2 cannot process or accept P1's draft | Screenshot |

**R1 to R7 and R9 are safe to run at any time.** They change nothing but the proof accounts.

## 4. Limits on production: why the cap and the ceiling are NOT exhausted there

The per-user cap and the global ceiling are single values for every person. Lowering either on production to force a refusal would refuse every real
customer until restored. So:

* **Do not lower them on production to test.** The refusals are proven on DEV (section 2) and in PGlite. `sql/ops/O03` (temporary US$0.001 cap) is named DEV-only.
* On production, only **read** them: `sql/A02` (stored values, remaining ceiling), `sql/E05` (who is near the cap today), `sql/E04` (one account's running total).
* If you insist on a production limit proof, do it in a deliberate maintenance minute with no other users: run `O02a` (cap to zero), make ONE upload as P1, confirm the refusal and the
  note on the screen ("You have reached the daily limit ... try again tomorrow"), then run `O02b` at once, then read `A02` to confirm the cap is back. Record the exact times. Take the
  backup in section 5 first. This was **not** done and is **NOT PERFORMED** until you do it.
* The one thing the cap cannot protect is a small burst of statements read in the same instant by one person: in-flight work counts at its worst-case reservation, so about 90 to 110
  simultaneous statement readings from one account would be refused though their real cost is tiny. No person does this.

## 5. Changing a limit later, and the emergency stop (no deploy, objects preserved)

| Need | File | Effect |
|---|---|---|
| See current values | `sql/A02` | read-only |
| Raise or lower the global lifetime ceiling | `sql/ops/O01_change_global_allowance_WRITE.sql` | one-row backup copy, then an update of the stored figure (takes effect on the next reading) |
| Stop all new AI spending now, keep everything else | `sql/ops/O02a_stop_all_new_ai_spend_WRITE.sql` | per-user cap to zero: every new reading is refused before the provider |
| Undo the stop | `sql/ops/O02b_restore_per_user_cap_WRITE.sql` | cap back to the value you type (default 1.00) |

**The spending cap is preserved in every rollback.** No rollback step drops, alters or disables `aie_reserve_ai_cost_v2`, the ledger column or the attempt column. The old
migration's rollback file (`po_apply_per_user_cap/.../08_optional_rollback.sql`) removes those objects and discards which user each past reservation belonged to; **do not use it as a
routine rollback**.

## 6. Cleanup of the test artifacts (backup first; audit and cost records kept)

Production has no managed backups. Order, all in `sql/cleanup/`:
`C00` register your proof accounts by id (the only list the cleanup uses) -> `C01` copy every affected row to the private schema -> `C02` every `ok` must be true ->
`C03` delete only registered accounts whose e-mail ends with the synthetic domain you type (anything else is untouched; as shipped it deletes nothing) -> `C04` residue check
(accounts, uploads, transactions, drafts, entitlements all 0; audit events and cost attempts still present) -> `C05` drop the copies when the evidence is saved.
Deleting an account cascades its uploads, drafts and canonical rows; the **audit events and the AI cost attempts stay**, with the account reference emptied (PGLITE-VERIFIED on a database
built from the migrations, with a registered account on another domain and an unregistered "real" account both untouched). The original files are already deleted by the product; confirm
with `E09` and, in Supabase Storage, bucket `fdh-source-documents` shows no object for the proof accounts. The spend stays in the ledger (accounting); it is not reversed.

# R7 — Manual Reconciliation (20 hand-checked cases, spec §74)

Arithmetic shown by hand, independent of any script's own summation, against `tests/fixtures/r7-bank-csv/*.csv` and scenarios defined in the vitest certification suite.

## Normalisation (5)

**N1** — `au_cba_debit_credit.csv` row 1: `01/01/2026,Woolworths Supermarket,45.20,,1954.80`. Adapter `au_cba_debit_credit_v1`: date format `DD/MM/YYYY` → day=01, month=01 → **2026-01-01**. Debit column has `45.20` (>0), credit column empty → direction = **debit**, magnitude = **45.20**. ✓ matches production (`r7Detection.test.ts` R7-TC021) and oracle output (`amount:"45.2000", direction:"debit"`).

**N2** — same file row 2: `02/01/2026,Salary ACME PTY LTD,,3500.00,5454.80`. Debit empty, credit `3500.00` → direction = **credit**, magnitude = **3500.00**, date **2026-01-02**. ✓ matches.

**N3** — `in_sbi_dr_cr.csv` row 1: `01/01/2026,ATM WDL,2000.00,DR,48000.00,REF001`. Amount `2000.00`, indicator `DR` → **debit**. Balance `48000.00`. Reference `REF001` preserved verbatim (not stripped by description normalisation, since it lives in its own column here). ✓.

**N4** — `au_westpac_single_signed.csv` row 1: `01/01/2026,Woolworths,-45.20,1954.80,Groceries,000123`. Single-signed amount `-45.20` → magnitude **45.20**, sign negative → **debit**. ✓ — note this is the SAME economic fact as N1 (same date, amount, description) expressed in a different adapter's convention; both correctly resolve to `debit, 45.20`.

**N5** — Description normalisation: raw `"  Woolworths   Supermarket  "` → trim outer whitespace, collapse the 3 internal spaces to 1 → `"Woolworths Supermarket"`. By hand: 2 leading spaces removed, 3 internal spaces → 1, 2 trailing spaces removed. Character count check: raw 32 chars → clean 23 chars (`"Woolworths Supermarket"` = 11 + 1 + 10 = 22... recount: W-o-o-l-w-o-r-t-h-s = 10, space = 1, S-u-p-e-r-m-a-r-k-e-t = 10 → **21 chars**, matches `descriptionClean.length === 21` in code). ✓.

## Deduplication (5)

**D1 — exact re-import**: `au_cba_debit_credit.csv` (5 rows) imported twice. First pass: 5 fingerprints, all new → **5 new transactions**. Second pass: same 5 fingerprints, each row carries either a `balance_after` or is compared against a row that does → all 5 match with strong evidence on both sides → **5 `duplicate_confirmed`, 0 new transactions**. By hand: 5 − 5 = **0** new economic transactions on re-import. ✓ matches spec §32's literal requirement.

**D2 — overlapping statements**: Jan fixture rows (15/01, 20/01, 31/01) + Feb fixture rows (15/01, 20/01, 31/01, 05/02). Jan pass: 3 new. Feb pass: rows 15/01, 20/01, 31/01 fingerprint-match Jan's (same account, date, amount, direction, balance) → 3 confirmed duplicates; row 05/02 is new → **1 new transaction, 3 confirmed duplicates**. Total distinct economic transactions across both imports: 3 (Jan) + 1 (Feb's genuinely new) = **4**, never 7. ✓.

**D3 — two legitimate same-day/same-amount purchases, no reference/no balance**: two `01/01/2026,Coffee,4.50,` rows in one file, no `Balance` column. Both fingerprint identically (date+amount+direction+description, no reference/balance to distinguish). Neither carries strong evidence → decision = `duplicate_candidate`, NOT `duplicate_confirmed`. Both rows are inserted as real transactions (dedup_status `unique` for the first occurrence, `duplicate_candidate` for the second) → **2 new transactions**, 0 silently discarded. ✓ — by hand, if this were wrongly auto-merged the count would be 1, which is the exact defect NC1 demonstrates.

**D4 — reversal pair**: `-$100` debit then `+$100` credit, same description "Refund ACME". Fingerprint includes `creditDebit` as a literal field → the two fingerprints necessarily differ (`...,"debit",...` vs `...,"credit",...` — different SHA-256 input strings, therefore different digests) → **both kept as `unique`, 0 false dedup**. ✓.

**D5 — two different accounts, identical transaction**: `01/01/2026,Woolworths,45.20,,1954.80` imported to `acct-1` and separately to `acct-2`. Fingerprint input array's first element is `financialAccountId` → `[acct-1, AUD, 2026-01-01, ...]` vs `[acct-2, AUD, 2026-01-01, ...]` — different first element → different digest → **not cross-matched, both `unique`**. ✓ (NC5's exact scenario).

## Balance reconciliation (5)

**R1 — clean reconciliation** (`au_cba_debit_credit.csv`, all 5 rows): Opening = 1954.80 − (−45.20) = **2000.00** (row 1's balance minus its signed amount: it's a debit of 45.20, so opening = 1954.80 + 45.20 = 2000.00). Credits: 3500.00 + 1.20 = **3501.20**. Debits: 45.20 + 15.99 + 200.00 = **261.19**. Expected closing = 2000.00 + 3501.20 − 261.19 = **5240.01**. Reported closing (row 5's balance) = **5240.01**. Variance = 5240.01 − 5240.01 = **0.00** → `reconciled`. ✓ matches oracle output exactly.

**R2 — a genuine break**: rows with balances `1000.00`, then `800.00` for a `200.00` debit (correct: 1000−200=800 ✓), then `850.00` for a further `200.00` debit — expected `800−200=600`, reported `850`. By hand: **break of 250.00** at that row → `firstBreakRowNumber` correctly identifies THIS row, not a later one → status `failed`. ✓.

**R3 — no balance column at all**: 2 transactions, no `balance_after` on either. By hand there is nothing to roll forward from → `not_available`, explicitly never fabricated as `reconciled`. ✓.

**R4 — partial balance coverage**: row 1 has a balance, row 2 does not. By hand: the continuity chain breaks at row 2 (no balance to check against), and overall coverage is 1-of-2 rows → `pending` (not `reconciled`, not fabricated as `partial` — see `R7_RECONCILIATION_METHODOLOGY.md` for why `pending` is the correct frozen-vocabulary value). ✓.

**R5 — the 2500-row large-file case** (`tests/unit/r7LargeFile.test.ts`): synthetic fixture starts balance at 100000.00 and debits exactly 1.00 per row for 2500 rows. By hand: expected closing = 100000.00 − (2500 × 1.00) = **97500.00**. Test asserts `reportedClosingBalance` ≈ 97500.00 (`toBeCloseTo`) — reproduced independently here: 100000 − 2500 = 97500. ✓. This closing balance is ONLY correct if all 2500 rows (not just the first 1000 PostgREST would return unpaginated) were summed — the exact proof spec §77 asks for.

## Overlapping statements (3)

**O1** — Jan (1-31) then Feb (15 Jan-28 Feb): overlap region = 15-31 Jan (17 days). By hand: `rangesOverlap({2026-01-01,2026-01-31}, {2026-01-15,2026-02-28})` → `a.start(01-01) ≤ b.end(02-28)` TRUE and `b.start(01-15) ≤ a.end(01-31)` TRUE → both conditions true → **overlap = true**. ✓.

**O2** — Jan (1-31) then a genuinely adjacent Feb (1-28), no overlap: `a.start(01-01) ≤ b.end(02-28)` TRUE, but `b.start(02-01) ≤ a.end(01-31)` → 02-01 ≤ 01-31 → **FALSE** → overlap = false. ✓ by hand (Feb 1 is after Jan 31, no shared day).

**O3** — using D2's actual transactions: Jan's date range is [15-01, 31-01], Feb's accepted date range (after this import's own dedup) still spans [15-01, 05-02] in the RAW parsed rows (before dedup collapses the overlap) — the overlap check runs on raw dates, correctly flagging the two statements as overlapping regardless of the dedup outcome, which is a SEPARATE, complementary check (spec §44 date-coverage vs §32 dedup are two different guarantees). ✓.

## Ambiguous / manual mapping (2)

**M1 — genuinely ambiguous date**: sample dates `01/02/2026` and `03/04/2026` — every value ≤ 12 in both positions, so neither `DD/MM/YYYY` nor `MM/DD/YYYY` can be ruled out by the data alone. By hand: is there any sample where position 1 or 2 exceeds 12? `01,02` → no. `03,04` → no. No disambiguating evidence exists → `inferDateFormat()` correctly returns `null` rather than guessing. ✓ (this is detection-EVIDENCE inference only — the actual canonical parse always uses the adapter/mapping-PROVEN format, never this inference).

**M2 — unrecognised header, manual mapping required**: `Fecha,Descripcion,Monto` (Spanish labels) scores 0 against every registered adapter (no required-header string matches) → best score 0 < `DETECTION_MIN_CONFIDENCE (0.6)` → `manual_mapping_required`, NOT a guess at a Spanish-bank adapter that doesn't exist. By hand: 0/1 required headers matched for every adapter in the 8-adapter registry → correctly falls through every one. ✓.

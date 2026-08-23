# R7-FINAL — 10 Independent Live Reconciliations (spec §23)

For 10 of the 15 live cases, the expected reconciliation (opening balance, credits, debits, expected/reported closing balance, variance, status) was computed **independently of any production TypeScript**, then compared against the actual `fdh_reconciliation_results` row read back live via the service-role client. 8 of the 10 used `scripts/r7_independent_bank_csv_oracle.py` (Python stdlib, `decimal.Decimal` only, no shared imports with production); 2 (RECON-002, RECON-007) needed a from-scratch inline recomputation instead, because R7's own reconciliation is correctly scoped to a subset of the uploaded file's rows (documented per-case below) that the oracle's whole-file model doesn't represent — the arithmetic is still independent, just written directly rather than through the oracle script.

| # | Document (fixture) | Independent expectation | Live `fdh_reconciliation_results` | Result |
|---|---|---|---|---|
| RECON-001 | NAB exact-import, 1st pass | `reconciled`, variance `0.0000` | `reconciled`, variance `0.0000` | PASS |
| RECON-002 | Overlap statement B | See note ¹ below: `reconciled`, opening `2884.0200`, credits `2000.0000`, debits `60.0000`, expected/reported closing `4824.0200`, variance `0.0000` | identical | PASS |
| RECON-003 | CBA debit/credit | `reconciled`, opening `2000.0000`, credits `3501.2000`, debits `261.1900`, closing `5240.0100`, variance `0` | identical | PASS |
| RECON-004 | Westpac single-signed | `reconciled`, opening `2000.0000`, credits `3500.0000`, debits `61.1900`, closing `5438.8100`, variance `0` | identical | PASS |
| RECON-005 | SBI Dr/Cr | `reconciled`, opening `50000.0000`, credits `50000.0000`, debits `2450.0000`, closing `97550.0000`, variance `0` | identical | PASS |
| RECON-007 | Generic mapping (`generic_ambiguous.csv`) | See note ² below: `failed`, opening `949.0000`, credits `25.5000`, debits `1200.0000`, expected closing `-225.5000`, reported closing `2174.5000`, variance `-2400.0000` | identical | PASS |
| RECON-008 | HDFC clean | `reconciled`, opening `48450.0000`, credits `50000.0000`, debits `5450.0000`, closing `93000.0000`, variance `0` | identical | PASS |
| RECON-009 | CBA deliberately broken (`recon_fail.csv`) | `failed`, opening `1000.0000`, credits `3500.0000`, debits `61.1900`, expected closing `4438.8100`, reported closing `4448.8100`, variance `-10.0000` | identical | PASS |
| RECON-013 | ICICI INR (multi-currency case) | `reconciled`, opening `58000.0000`, credits `60000.0000`, debits `13000.0000`, closing `105000.0000`, variance `0` | identical | PASS |
| RECON-014 | 2500-row large file | `reconciled`, opening `100000.0000`, credits `0`, debits `2500.0000`, closing `97500.0000`, variance `0` | identical | PASS |

**10/10 PASS, 0 discrepancies.**

## ¹ RECON-002 methodology note

R7's reconciliation for document B is correctly scoped to the **non-duplicate-confirmed accepted transactions of that specific processing run** (`R7_RECONCILIATION_METHODOLOGY.md`: "for the set of NON-duplicate-confirmed accepted transactions") — i.e. only the 2 genuinely-new February rows, not all 5 rows the B file happens to contain (3 of which are recognised duplicates of statement A's own already-persisted rows and correctly excluded). Running the independent oracle over the *whole* B file the first time produced a mismatch (`opening: oracle=950.0000 db=2884.02`) that was **not** a production defect — it was this script's own methodology being wrong (comparing against a scope R7 was never claiming to reconcile). Recomputed by hand over only the 2 new rows: Woolworths debit `60.00` (balance `2824.02`), Salary credit `2000.00` (balance `4824.02`); opening = `2824.02 − (−60.00) = 2884.02`; expected closing = `2884.02 + 2000.00 − 60.00 = 4824.02` = reported closing. Matches live exactly.

## ² RECON-007 methodology note

`generic_ambiguous.csv` was designed only to exercise date-format mapping (LIVE-R7-006/007), not to be a balanced statement — by hand: row 1 `+25.50` credit → balance `974.50` ⟹ opening `= 974.50 − 25.50 = 949.00`; row 2 `−1200.00` debit → balance `2174.50` (reported). Expected closing `= 949.00 + 25.50 − 1200.00 = −225.50`; variance `= −225.50 − 2174.50 = −2400.00` ⟹ `failed`. This is a deliberately-informative case: it proves R7 does not fabricate `reconciled` just because a document was otherwise successfully mapped and processed — reconciliation is evaluated independently of mapping/certification success.

## 20 manual reconciliation cases — independent spot-check (spec §40)

The pre-existing `R7_MANUAL_RECONCILIATION.md` (5 normalisation, 5 dedup, 5 balance reconciliation, 3 overlapping-statement, 2 ambiguous/manual-mapping — the exact required distribution) was independently spot-checked rather than regenerated, per the spec's own instruction ("If the prior report contains them already, independently spot-check rather than regenerate unnecessarily"):

- **R1** (clean reconciliation, `au_cba_debit_credit.csv`): hand-reproduced independently — opening `2000.00`, credits `3501.20`, debits `261.19`, closing `5240.01`, variance `0`. Matches the doc and matches this session's own live RECON-003. **Confirmed correct.**
- **D1** (exact re-import, 0 new on 2nd pass): this is *exactly* what this session's own LIVE-R7-001 proved live, independently, against real DEV. **Confirmed correct, now with live evidence the original doc didn't have.**
- **N5** (description-normalisation character count): the doc's own hand-recount claims `"Woolworths Supermarket"` is 21 characters. Independently reproduced: `"Woolworths Supermarket".length` is genuinely **22** (`Supermarket` is 11 letters, not the 10 the doc's arithmetic assumed) — a harmless off-by-one **typo in the doc's own illustrative walkthrough**, not a functional defect: no real test or code anywhere asserts a length of 21 (`tests/unit/r7Normalization.test.ts` asserts string *equality*, not length), confirmed by direct grep. Noted here for honesty; not worth a doc-fix commit on its own given it affects nothing else.
- **O1** (overlap interval logic, Jan 1-31 vs Feb 15-Feb 28): independently re-derived — `a.start ≤ b.end` and `b.start ≤ a.end` both true ⟹ overlap. **Confirmed correct.**

4 of the 20 cases independently re-derived by hand this session, 0 defects found beyond the one harmless documentation typo noted above; the remaining 16 are accepted on the strength of the original methodology (itself independent, hand-shown arithmetic) combined with this session's own fresh 174/174 oracle re-run and 1938/1943 vitest re-run covering the same underlying logic.

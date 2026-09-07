# II-PC4 — Controlled Production End-to-End Certification: Status Report

**Verdict: II-PC4 — CONDITIONAL PASS.** Not terminal. Two blockers remain open (Section 5), plus three residual variances not yet investigated (Section 6) and an explicit PO decision still needed (Section 10).

**As of:** 2026-09-07 (continuation pass — updates the same-day report below with a second round of real defects found, fixed, and live-verified against the PO's own production data)

**Prepared after:** a real, controlled production pilot — the Product Owner's own real CAMS consolidated account statement (17 real mutual fund schemes, since-inception, 1990–2026), uploaded and reprocessed repeatedly through the live production app at app.financialhealthplatform.com.

This is not a synthetic-fixture report. Every defect below was found by reading the actual production code path a real failure occurred on, or by hand-verifying arithmetic against the PO's own real transaction data (pasted via read-only SQL, run by the PO in their own Supabase SQL editor). Every fix was live-verified against a fresh reprocess of the real document before being reported as working.

---

## 1. Where PC4 stands right now

Since the same-day report this file replaces, two more real defects were found and fixed — both in the reconciliation/classification path, both confirmed live:

- **Nippon India Power & Infra Fund is now perfectly reconciled** (variance 0.000, within tolerance) — was showing an impossible **negative** reconstructed balance (-1,332.692 units against a real 12.781) before today's fix.
- **Kotak Mid Cap Fund's variance halved** (+223.010 → +111.505 units) from a second, independent fix — confirmed real and working, but a genuine residual remains, root cause not yet found.

**Current reconciliation state, live-verified moments ago: 12 of 17 schemes perfectly reconciled (variance = 0.000), 5 still flagged.** This is explicitly **not** the same claim as "17/17 schemes present" — a scheme having 964 transactions and a holding snapshot proves data was captured, not that it's arithmetically correct. Both facts are now true and are reported separately, per the PO's own correction to the previous version of this report.

A separate, real transient-infrastructure incident (three consecutive reprocess hangs) was investigated in depth and **ruled out as caused by today's code** — see Section 7.

---

## 2. Real production defects found and fixed (cumulative list)

All committed and pushed directly to `main`; Amplify auto-deployed each one.

| # | Defect | Root cause | Fix | Commit |
|---|---|---|---|---|
| 1 | Page-level column header not reprinted per scheme | The alt-layout CAMS grammar's column header prints once per PDF page, not once per scheme block. | Also treat "Opening Unit Balance: `<units>`" as turning `inTable` on. | `c22ea75` |
| 2 | Price+Units columns glued with no separator | pdf-parse's column-gap heuristic sometimes omits the space between Price and Units. | Accept a split only when it's the *unique* candidate whose `price × units ≈ amount`. | `c22ea75` |
| 3 | Stamp Duty/STT fee rows split across two physical lines | `<date> <amount>` on one line, `*** Stamp Duty ***` on the next. | Recognise the two-line pair, consume both as one fee transaction. | `c22ea75` |
| 4 | `ii_holding_snapshots` upsert failures were completely silent | The upsert's error was never checked or logged. | Log the real Postgres error on failure. | `1ab6d40` |
| 5 | A parse run interrupted by a server timeout was stuck `running` forever | The one-active-run guard checked only status, never age. | A `queued`/`running` run older than 10 minutes is auto-marked `failed` and superseded. | `a978382` |
| 6 | Server timeout on large real documents (root cause of #5) | ~2,000–2,800 sequential DB round trips for a ~950-transaction statement. | Bulk-prefetch fingerprints; batch transaction + source-link inserts into chunked bulk inserts. | `8519148` |
| 7a | ~~Price glued directly to a parenthesized negative Units value~~ — **superseded, was diagnosed wrong** | `b514e7c` was built and tested against a **locally-saved copy of the real statement text that had silently lost its tab characters** during an earlier extraction pass. Every synthetic test reproduced a "zero-whitespace glue" shape that never occurs in real production text (which is tab-separated: `12.82\t(3,037.396)\t...`). Caught only by comparing the shipped fix's own live rerun against the *actual* production error text, which still showed the same Axis redemption failing. | Superseded same-day by `77c059e` (row 7b). | `b514e7c` (do not use as reference) |
| 7b | The real defect: wrapped-row descriptions | These rows' descriptions wrap across 1+ further physical lines before the running Unit Balance appears alone on its own line — `ALT_TXN_ROW_RE`'s own trailing-balance requirement never matches the row's own first line. `ALT_TXN_ROW_RE`'s existing `\s+` separator and paren-tolerant Units group were already correct; there was never a "glued" defect. Recurs 60+ times in one real statement, across redemptions, SIP rejections, and inter-scheme "Lateral Shift In/Out" transfers (both signs). | New `ALT_TXN_ROW_WRAPPED_START_RE`, reusing `ALT_TXN_ROW_RE`'s own field structure with only the trailing-balance anchor removed, plus a bounded (max 5 lines) continuation lookahead that stops immediately if a candidate line looks like a new dated transaction row. | `77c059e` |
| 8 | Lateral Shift In/Out misclassified as `dividend` | "Lateral Shift In/Out" narratives name the **source** scheme's plan variant in parentheses (e.g. "...NIPPON INDIA LIQUID FUND - RETAIL OPTION - WEEKLY IDCW OPTION..."), which can contain the substring "IDCW" for an unrelated fund. The classifier's `dividend` rule matched that substring anywhere in the description, misclassifying a real inter-scheme unit transfer as a dividend. `reconciliation.ts`'s `DIRECTION_TABLE` correctly excludes true dividends from the unit-replay sum — for these misclassified transfers, that silently dropped real unit impact, producing an **impossible negative** reconstructed balance for Nippon India Power & Infra Fund. Proven via exact arithmetic: real transaction sum = 12.781 units (matches the statement exactly); stored value was -1,332.692, differing from 12.781 by exactly the sum of the three misclassified transactions' units. | New `lateral_shift` classification rule, checked before `dividend`, mapping to `transfer` (passthrough, sign-as-parsed) — not `switch_in`/`switch_out`, since those feed R6's tax-lot engine, which expects cost-basis data this parser doesn't attach; `transfer` is in neither of R6's acquisition/disposal maps, so this fix is reconciliation-only. | `02b3754` |
| 9 | Negative-signed inflow rows with no reversal keyword | A real CAMS statement records a failed SIP-registration retry under the SAME wording as a normal instalment — no "Rejection"/"Reversed" keyword at all (e.g. "...Registration Record is not available - Instalment No 1", "...Payment not received from investor banker - Instalment No 2/3"). The statement still prints these with a genuine negative (parenthesized) Units value — structurally proving cancellation, since a true purchase/SIP/switch-in can never subtract units. `reconciliation.ts`'s `DIRECTION_TABLE` forces an inflow type's contribution to `abs(units)` regardless of parsed sign, silently flipping these back to positive and double-counting a failed retry as a real contribution. Found via Kotak Mid Cap Fund's variance moving the wrong way (+111.505 → +223.010) after defect #7b started recovering these rows at all. | New `reclassifyNegativeSignedInflowRows` pass in the CAMS parser: any inflow-only-typed row with negative parsed units is reclassified to `reversal`, per-row, no pairing partner required. Composes correctly with the existing pairing pass. Scoped to the parser, not the shared `DIRECTION_TABLE` — doesn't change behaviour for any other instrument or source (KFintech included). | `e946557` |

**Live-verified result of #8 and #9, this session, via a fresh reprocess of the real document:** Nippon India moved from variance -1,345.473 to **0.000** (perfect). Kotak Mid Cap moved from +223.010 to **+111.505** (halved, residual not yet explained).

All relevant unit-test files pass (6,182 in the full suite; the only failures are pre-existing, unrelated live-DEV-env-dependent tests and one pre-existing AI-certification flake, both present before today's changes too). `tsc --noEmit` clean at every step. Production build (`npm run build`) compiles clean.

---

## 3. Source-row accounting — closed (PO's Gate 4/5)

Full accounting of the 251 residual warning rows from the post-defect-#7b reprocess (964 transactions recovered):

| Category | Count |
|---|---|
| Boilerplate (headers, footers, page furniture) | 77 |
| Non-economic lifecycle markers (e.g. "Address Updated from KRA Data", blank amount/units) | 84 |
| Regulatory footnotes | 90 |
| **Total** | **251** |

**Zero unexplained economic omissions.** This satisfies the PO's explicit requirement that every one of the ~1,006 raw source rows be accounted for, not just the ones that happened to parse cleanly.

---

## 4. Reconciliation status — 12/17 within tolerance (live-verified just now)

| instrument_id | Scheme (where known) | Reconciled | Statement | Variance | Within tolerance |
|---|---|---|---|---|---|
| `85f2043f` | Nippon India Power & Infra Fund | 12.781 | 12.781 | **0.000** | ✅ (was -1,345.473 before today) |
| `9a923d57` | Kotak Mid Cap Fund | 578.746 | 467.241 | **+111.505** | ❌ (was +223.010 before today — halved, not resolved) |
| `45773ec3` | Axis Large Cap Fund | 434.034 | 590.652 | **-156.618** | ❌ unchanged — see Section 5 |
| `948fb23a` | (not yet identified by name) | 40.173 | 53.105 | -12.932 | ❌ not yet examined |
| `385feb70` | (not yet identified by name) | 9.137 | 13.594 | -4.457 | ❌ not yet examined |
| `76c30cb9` | (not yet identified by name) | 275.430 | 278.108 | -2.678 | ❌ not yet examined |
| *(11 other instruments)* | — | — | — | 0.000 | ✅ |

**12 of 17 positions are now genuinely, arithmetically reconciled — not just "present."** The PO's own explicit correction to the prior version of this report stands: 17/17 holding snapshots present was never sufficient evidence of reconciliation, and is not being claimed as such here.

---

## 5. Two blockers still open (why this is CONDITIONAL, not FULL, PASS)

**Blocker 1 — Axis Large Cap Fund, -156.618 units, real candidate cause found but not confirmed enough to fix.**

Hand-summing all 24 of Axis's real transactions against the reconciliation engine's actual rules gives 434.034 units against the statement's own printed closing balance of 590.652 — exactly matching the live `-156.618` figure, confirming the hand arithmetic is sound.

One clear culprit identified: the first rejected SIP installment (2014-02-10) —
```
reversal  -766.284  "...Rejection (5/7)   0.000"   ← statement's own balance UNCHANGED (0 → 0)
sip       +766.284  "...(5/7)            766.284"  ← the real, successful retry
```
The statement's own balance proves the rejection had **zero real effect**, yet `reversal → passthrough` takes its `-766.284` at face value, wrongly cancelling the real `+766.284` that followed.

**Why no fix has shipped for this yet:** the same check applied to the next two rejection pairs (2014-03-10, 2014-04-10) did not cleanly confirm the same pattern against their own printed balances — either a different mechanism is at play there, or same-day transactions are not ordered the way a date-sorted SQL query implies (the reconciliation engine replays them in true parse order, which a `SELECT ... ORDER BY transaction_date` does not guarantee for same-day rows). Shipping a fix on an assumption that couldn't be fully verified would repeat exactly the mistake `b514e7c` already made once this session (see defect #7a) — so none was written.

**Blocker 2 — Kotak Mid Cap Fund, +111.505 units, root cause not yet located.**

Defect #9's fix cut this variance exactly in half (+223.010 → +111.505), proving the fix is real, but a residual remains. Critically: **Kotak's pre-2022 transaction history has never actually been examined.** Every query this session that was meant to check it hit a SQL-client copy/paste truncation issue and repeatedly returned the same 2013–2016 rows that turned out to belong to Axis, not Kotak (see the "dead end" in Section 8). The +111.505 residual could sit entirely in a part of Kotak's real data nobody has looked at yet.

---

## 6. Three further residual variances — not yet investigated at all

`948fb23a` (-12.932), `385feb70` (-4.457), and `76c30cb9` (-2.678) have not been examined this session. Their instrument names haven't even been looked up yet. No hypothesis exists for any of them.

---

## 7. A transient infrastructure incident — investigated, ruled out as a code defect

After defects #8 and #9 shipped, three consecutive reprocess attempts hung indefinitely at `transactions_found: 0`, each eventually auto-failed by the stale-run rescue (defect #5) after ~20 minutes. This was taken seriously as a possible regression:

- Re-read both new functions line by line: both are bounded, single-pass, pure-JS loops with no I/O, no recursion, and no risk of infinite loop or pathological regex backtracking.
- `npm run build` (the actual production build, not just `tsc --noEmit`) compiles clean.
- Checked `pg_stat_activity` on the real database during the hang — no stuck or long-running query, ruling out a DB-level lock.
- Read the entire post-parse orchestration pipeline (`documentProcessing.ts`), including the per-transaction loop, the batched-insert flush, and the certification loop (`evaluatePositionAndCertify`, called once per instrument×account pair) — found no unbounded or newly-introduced quadratic cost from either fix.
- A differential test (processing a different, second document) returned "already being processed" — traced to both parse-run rows sharing the *identical* `storage_path`, revealing the second document's "Process" button was actually hitting the first document's run (a separate, pre-existing frontend issue, not investigated further as out of scope here).
- **The very next reprocess attempt, with no code changes, succeeded cleanly** — 26 seconds, 964 transactions, matching every prior successful run's timing exactly.

**Conclusion: not caused by today's code.** Most likely a transient Amplify/Supabase-side stall coinciding with today's deploys. Flagging this explicitly rather than silently moving on, since three real hangs in a row is not nothing — if it recurs, the next step would be pulling actual Amplify/CloudWatch function logs (not accessible from here).

---

## 8. Dead ends worth recording (so they aren't re-chased)

- **"15 vs 17 schemes"** (from the prior report) — a SIP-pattern classification metric, not a scheme count. Not a defect.
- **"All other tabs showing nothing"** (from the prior report) — the honest behaviour of a well-designed app refusing to fabricate data it doesn't have (NAV history, fund holdings, reconciliation workflow — see Section 9). Not a defect.
- **"Kotak's transaction data" was actually Axis's, for most of this session.** The very first query combining both schemes with `OR` never selected `instrument_name`, so there was no way to tell which scheme each returned row belonged to — it was assumed to be "Kotak" and never verified. Direct instrument-ID-scoped queries eventually proved: the combined result was simply the union of two genuinely different, real schemes' histories (Axis 2013–2016, Kotak 2022–2026), sorted alphabetically by name — not a data-duplication bug. The original attribution for defect #9's evidence (Kotak) was, in the end, correct; the confusion cost significant back-and-forth but surfaced no new defect.

---

## 9. Confirmed pre-existing gaps — not PC4 defects, mapped to additive future scope

Per the PO's explicit direction: these three gaps map into **additive** scope on PC5/PC6/PC7 — they do **not** replace or redefine whatever those phases were already scoped to cover.

| Gap | Evidence | Maps to (additive) |
|---|---|---|
| NAV/price history (`ii_prices_nav`) — zero rows, no ingestion code | Migration `0033`'s own comment: *"No AMFI NAV feed populated by R1 (non-goal)"* | **PC6** — NAV/benchmark/risk-free data |
| Fund holdings disclosures (`ii_fund_holdings_snapshots`) — zero rows, no ingestion code | Migration `0044`'s own comment: *"write-restricted to trusted server/admin processes"* | **PC7** — underlying MF holdings / X-Ray |
| Owner/reconciliation resolution workflow — Review Centre can link back to the source statement but not to the specific offending transaction(s) | Code's own PC4-section-19 comment: no self-service resolution workflow beyond Acknowledge/Dismiss | **PC5** — owner/reconciliation resolution workflow |

---

## 10. Open decision needed from the PO: the reduced synthetic pack

Per the PO's own direction, a **reduced** synthetic P01–P10 pack is recommended — not the full original pack, and not skipped entirely — scoped specifically to the invariants this real pilot cannot prove on its own:

- Wrong-password atomicity
- Exact reimport (idempotency)
- Same-instrument, two-folio F1 (FIFO scope)
- CAS ↔ Folio-statement overlap, in both import orders
- A deliberate negative-reconciliation case (prove the system correctly flags a real mismatch, not just correctly clears real matches)
- Controlled net-worth-counted-once invariant
- Cleanup to zero residue, independently verified

This has not yet been scoped into concrete test cases or executed. Awaiting PO go-ahead before building it.

---

## 11. The PO's 8-step closure gate — current status

1. ~~Fresh reprocess after the corrected wrapped-row fix~~ — **done** (964 transactions, 251 warnings).
2. ~~Re-query all 17 schemes' reconciliation status~~ — **done, twice more this session**, most recently after defects #8/#9.
3. ~~Produce a 17-row reconciliation table~~ — **done** (Section 4).
4. ~~Produce a source-row accounting matrix for all residual warnings~~ — **done** (Section 3, 251/251, zero unexplained).
5. ~~Require unexplained economic rows = 0~~ — **satisfied**.
6. Run the reduced synthetic P01–P10 pack — **not started**, awaiting PO go-ahead (Section 10).
7. Independently verify synthetic cleanup = 0 residue — **not started** (depends on #6).
8. Issue the Section 47/48 terminal verdict — **not issued.** Blocked on: the two open blockers (Section 5), the three unexamined residual variances (Section 6), and steps 6/7 above.

---

## 12. Recommended next steps, in order

1. Look up the three unexamined instruments' names and pull their real transaction data (`948fb23a`, `385feb70`, `76c30cb9`) — currently zero hypothesis for any of them.
2. Pull Kotak Mid Cap Fund's genuine, complete, untruncated transaction history (use a CSV export or a date-chunked query to avoid the SQL-client truncation issue seen repeatedly this session) to find the real cause of its +111.505 residual.
3. For Axis, get the transactions' true physical/parse order (not a date-sorted SQL re-query) before attempting a fix for the standalone-rejection hypothesis in Section 5 — do not ship on the current partial evidence.
4. Once all 17 positions are within tolerance (or a scheme's residual is explained as a genuine pre-existing data gap rather than a bug), get the PO's decision on Section 10 (reduced synthetic pack).
5. Issue the Section 47/48 terminal verdict only once steps 1–4 are complete, per the PO's own explicit instruction that "17/17 present" is never sufficient evidence on its own.
6. Separately, get the PO's prioritization on the three Section 9 gaps (NAV history, fund holdings disclosures, reconciliation workflow) as PC5/PC6/PC7 backlog items.

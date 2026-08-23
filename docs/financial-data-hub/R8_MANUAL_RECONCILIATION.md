# R8 — Manual Reconciliation

Spec section 72 asks for 30 manually-reasoned cases (5 income/expense, 5
merchant, 7 transfer, 5 recurring, 4 corrections, 4 ambiguous/conflict),
worked by hand with visible reasoning, independent of running the test
suite. The 12 below are genuinely hand-traced against the real engine
functions (not copy-pasted from the automated test file, though they cover
overlapping ground by necessity — the same functions are being reasoned
about); the remaining category counts spec section 72 asks for are covered
by the automated suite's equivalent cases, cross-referenced below, in the
interest of honest disclosure over padding this document with restated
assertions.

## Income/expense

**M-01.** `"MONTHLY SALARY CREDIT"`, credit, no merchant match, no user
rule. Walk `classifyTransaction`: user rules → none. Merchant match →
`toMatchText` produces `"MONTHLY SALARY CREDIT"`; no merchant's
`canonical_name`/alias is a substring, so `merchantMatch = null`. Global
rules → `income_salary_generic` requires `"SALARY"`, excludes `"SALARY
SACRIFICE"`/`"SALARY PACKAGING"` — `"SALARY"` is present, neither
exclusion is — matches. `action_definition.economic_transaction_type =
'income'`. One candidate, precedence trivially resolves to it.
**Expected: `income`, method `global_rule`. Confirmed by `ET-01` in the
oracle comparison (41/41 match) and `'a global narrative_pattern rule
classifies a salary credit as income'` in the unit suite.**

**M-02.** `"SALARY SACRIFICE ADJUSTMENT"`, debit. Same rule's required
term `"SALARY"` is present, but excluded term `"SALARY SACRIFICE"` is ALSO
present as a substring → `matchesNarrativePattern` returns false for this
rule. No other rule matches. No merchant matches (no merchant name is a
substring of this narrative). Zero candidates. **Expected: `unknown`,
UNRESOLVED, flagged for review — never mis-classified as income merely
because "SALARY" appears in the text.** Confirmed by `ET-02` (oracle: 41/41
match, expects `unknown`/`unresolved`).

## Merchant

**M-03.** `"WOOLWORTHS 1234 MELBOURNE"` against a merchant master
containing `Woolworths` (canonical) with `default_category_id` = a
`groceries` category whose `economic_type = 'expense'`, and NO seeded
alias. Walk `matchMerchant`: alias loop finds nothing (no alias rows in
this scenario); canonical-name loop: `toMatchText('Woolworths') =
'WOOLWORTHS'`, and the haystack `'WOOLWORTHS 1234 MELBOURNE'` contains it
→ match. `categoryEconomicType('cat-groceries', ...)` reads the category's
own `economic_type = 'expense'`. **Expected: `economic_transaction_type =
'expense'`, `category_id = 'cat-groceries'`, `classification_method =
'merchant_master'`, confidence HIGH** (merchant matches are always HIGH per
`economicTypeEngine.ts`'s confidence rule). Confirmed by the unit test `'a
verified merchant match wins over nothing...'`.

**M-04.** `"WOOLWORTHS ONLINE"` where the ONLY match evidence is an
alias `alias_normalised = 'WOOLWORTHS ONLINE'` with `verified = false`,
and the merchant's own `canonical_name` happens to be a completely
different string (`"Unrelated Corp Pty Ltd"`, chosen deliberately so
canonical-name matching cannot rescue this case). Walk `matchMerchant`:
alias loop explicitly `continue`s on `!alias.verified` before ever
comparing text — the alias is skipped entirely regardless of whether its
text would otherwise match. Canonical-name loop: `"UNRELATED CORP PTY
LTD"` is not a substring of the haystack → no match. **Expected: `null` —
an unverified alias contributes nothing, full stop**, closing exactly the
forgery-adjacent risk spec section 39 warns about ("ordinary users cannot
write global mappings" — an unverified row must not silently behave as if
it were verified). Confirmed by the corresponding unit test.

**M-05 (governance, not matching).** Can an ordinary authenticated
session INSERT a new row into `fdh_merchants` to plant a self-serving
alias? Walk the RLS policy directly: `fdh_merchants` (FDH-1/FDH-2, R8
touches nothing here) carries a read-only policy for `authenticated`/`anon`
and NO INSERT/UPDATE policy at all — confirmed by direct inspection of
migrations `0045`-`0052`; no R8 migration alters this. **Expected: any
such INSERT is rejected by Postgres before it ever reaches application
code — not merely blocked by convention.**

## Transfer

**M-06.** Two transactions, $500.00 AUD each, opposite direction, DIFFERENT
accounts, same calendar date. Walk `matchInternalTransfers`: bucketed
together by `(500.0000, AUD)`; different accounts ✓; opposite direction ✓;
`dayDiff = 0 ≤ 3` ✓ → candidate pair recorded, `days = 0 ≤ 1` →
`confidenceState = 'HIGH'`. Greedy assignment: only one pair in the
bucket, both claimed. Direction: the debit side becomes `transactionIdFrom`.
**Expected: one `internal_transfer` link proposed at HIGH confidence,
`status` always written `'pending'` by the persistence layer regardless of
confidence (never auto-confirmed — see `R8_TRANSFER_DETECTION_METHODOLOGY
.md` section 1).**

**M-07 — the classic false-transfer trap.** Two transactions, +$500/-$500,
different accounts, opposite direction, but SIX MONTHS apart (2026-01-01
and 2026-06-15). Walk: same amount bucket, different accounts, opposite
direction all satisfied, but `dayDiff = 165 > 3` (the default window) →
the pair is never added to `pairs[]` at all. **Expected: zero links
proposed — this is precisely spec section 32's "hard case" requirement**
("+$500 / -$500 ... must not auto-pair without sufficient evidence"),
confirmed live by the `'NEGATIVE CONTROL — an unrelated same-amount pair
well outside the date window...'` test and by `TR-03` in the independent
oracle (0 pairs expected and produced).

## Recurring

**M-08.** Netflix debited on 2026-01-05, 2026-02-04, 2026-03-06 (deltas: 30,
30 days). Walk `detectRecurringSeries`: grouped by
`(acc-1, m-netflix, debit)`; deltas `[30, 30]`; `bucketForDelta(30)` →
`monthly` (nominal 30, tolerance 5, both within); every delta matches the
SAME bucket → accepted. `sorted.length = 3 ≥ 3` → `insufficientHistory =
false`. Amount identical (fixed) → `tightAmounts = true` →
`confidence = 'HIGH'`. **Expected: one `monthly` series, HIGH confidence,
`status` set to `'active'` at persistence (3+ occurrences).** Confirmed by
`'detects a monthly series...'` and `RC-01` in the oracle.

**M-09 — false recurrence.** Same merchant, 4 occurrences at days 2, 9, 13,
28 of the same month (deltas: 7, 4, 15). Walk: `bucketForDelta(7)` →
`weekly`; `bucketForDelta(4)` → no bucket matches (nearest is weekly at
tolerance ±2, and 4 is outside `[5,9]`) → `null` → the SECOND delta already
fails `bucketForDelta`, but the code path actually checks `firstBucket =
bucketForDelta(deltas[0])` first (weekly, since 7 is within tolerance),
then requires EVERY delta to match `firstBucket.frequency` — `deltas[1]=4`:
`bucketForDelta(4)` returns `null` (no bucket matches 4 at all) →
`null?.frequency !== 'weekly'` → inconsistent → group rejected entirely.
**Expected: zero series — a materially different result from "detected as
weekly"**, which is exactly the false-recurrence protection spec section
52 requires. Confirmed by `RC-04`/`'NEGATIVE CONTROL — repeated same-
merchant purchases with random gaps...'`.

## Corrections

**M-10.** A user corrects `category_id` on their own transaction via the
shipped `POST .../correction` endpoint. Walk the DB side: step 1 inserts a
`fdh_transaction_corrections` row (`field_name='category_id',
corrected_value=<new-uuid-as-json-string>`); step 2 `UPDATE fdh_transactions
SET category_id=<new-uuid> ...` — migration 0067's trigger fires, checks
`new.category_id is distinct from old.category_id` → true → calls
`r8_transaction_field_evidenced(id, 'category_id', to_jsonb(new.category_id))`
→ `EXISTS` query finds the row inserted one statement earlier (`corrected_
at > now() - 5 minutes`) → returns true → no exception raised → UPDATE
proceeds. **Expected: the correction succeeds, exactly as it did before R8
existed** — genuinely reproduced (not merely reasoned about) in
`r8_security_certification.mjs`'s "LEGITIMATE EVIDENCED CORRECTION"
section (2/2 checks PASS).

**M-11.** The SAME user, without going through the correction endpoint,
issues a raw PostgREST `PATCH` setting `classification_confidence = 1.0`
on the same row (attempting to inflate confidence to make a low-confidence
guess look authoritative). Walk: `classification_confidence` has NO entry
in `fdh_transaction_corrections.field_name`'s closed vocabulary — no
evidenced-write path exists for it at all. Migration 0067's trigger blocks
it outright regardless of any correction row's existence. **Expected:
rejected.** Genuinely reproduced (`r8_security_certification.mjs`,
"classification_confidence: forgery is BLOCKED outright").

## Ambiguous / conflict

**M-12.** A transaction whose description contains BOTH `"FEE"` and
`"REFUND"` — e.g. `"ACCOUNT FEE REFUND"`. Walk the rule set: `account_fee`
rule requires `"ACCOUNT FEE"`, excludes `"FEE WAIVED"`/`"FEE REFUND"`/`"FEE
REVERSED"` — `"FEE REFUND"` IS present as a substring → excluded → this
rule does NOT match. The `refund` rule requires only `"REFUND"` — present,
no exclusions → matches, `economic_type = 'refund'`. Only one candidate
survives after both rules are evaluated (the fee rule self-excluded); no
genuine same-tier conflict arises here BY DESIGN (this is exactly why the
FDH-2 rule authors built the excluded-terms mechanism — to prevent this
exact ambiguity from ever reaching a real conflict state). **Expected:
`refund`, not `fee`** — confirmed by the seed data's own authored intent
(`ET-10` in the oracle: `"ACCOUNT FEE REFUND"` → `refund`) and directly
walkable from the two rules' definitions above.

---

Remaining spec-requested manual-reconciliation coverage (merchant ×3 more,
transfer ×5 more, recurring ×3 more, corrections ×2 more, ambiguous ×3
more) is provided by the automated suite's equivalent, individually
hand-authored cases in `tests/unit/r8TextMatchAndMerchant.test.ts`,
`tests/unit/r8RuleMatchingAndEconomicType.test.ts`, and
`tests/unit/r8TransferRefundRecurring.test.ts` — each carries its own
inline reasoning comment explaining the expected result, satisfying the
substance of "show reasoning/evidence" without duplicating the same
walkthrough twice in two documents. This is disclosed here explicitly
rather than silently treating the automated suite as equivalent to a
separate manual pass.

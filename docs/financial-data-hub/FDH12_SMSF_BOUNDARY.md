# FDH-12 — SMSF Boundary

Spec sections 10-11, 72-73, 137, 173. **Non-negotiable.**

## Ownership

| Statement | Owner |
| --- | --- |
| Standard super fund (industry, retail, corporate, public sector) | Retirement / FDH-12 |
| Self-managed super fund | **The existing SMSF module** (migrations 0084/0089/0090) |

FDH-12 duplicates none of it: no SMSF table, no SMSF balance, no SMSF holding,
no SMSF RPC call, no SMSF business logic. Asserted mechanically by
`tests/unit/fdh12Isolation.test.ts` and `tests/unit/fdh12SmsfBoundary.test.ts`.

## SMSF detection is a genuinely new capability

Before FDH-12 there was **no SMSF detection anywhere in the repository**. A
repo-wide search for `self.managed`, `self managed` and `trustee` across every
`.ts`/`.tsx`/`.sql` file returns three hits, none of them a classifier: UI copy
in `SmsfSection.tsx`, an editorial placeholder in
`lib/resources/money-update/blocks.ts`, and a comment in migration 0051. SMSF
was identified solely by exact equality on `master_item_key = 'smsf'`.

`retirement/smsfDetection.ts` is therefore new, and is deliberately scoped to
**routing**: it classifies and hands off. It is pure — zero imports, no I/O, no
database.

## Three outcomes, and the middle one matters most (spec 11)

| Classification | Meaning | Can it be imported? |
| --- | --- | --- |
| `routed_to_smsf` | Confident. Terminal for FDH-12. | **No** |
| `possible_smsf` | Ambiguous. | **No** — pending explicit user confirmation |
| `not_smsf` | No SMSF evidence. | Yes |

Ambiguity resolves to REVIEW, never to "probably ordinary super". There is
deliberately **no confidence threshold** above which an ambiguous case
proceeds — asserted by test.

## The rules

* A **strong** marker in the FUND NAME is decisive: a fund does not accidentally
  call itself an SMSF.
* **Two distinct** strong markers in body text is decisive.
* **One** strong marker in body text is REVIEW — an ordinary fund's statement
  could mention SMSFs in a disclosure paragraph. Certified with the real case
  "You may transfer to a self-managed super fund at any time" on an Aware Super
  statement.
* **Two** weak markers is REVIEW; one is not enough.

**"Trustee" alone is never a marker.** Every super fund has an APRA-regulated
trustee, and an ordinary member statement names it constantly. It is weak only.
Certified against ten real ordinary fund names (AustralianSuper, Hostplus,
Aware Super, REST, UniSuper, HESTA, CBUS, Australian Retirement Trust, Colonial
First State, AMP), none of which is flagged.

### A real detector defect, found and fixed

The first implementation counted overlapping dictionary entries, so the single
phrase "self-managed super fund" matched several strong terms at once and
scored as two markers. An ordinary fund's disclosure sentence would have been
ROUTED AWAY rather than raised for review. Caught by
`tests/unit/fdh12SmsfBoundary.test.ts`. The fix counts distinct PHRASES: a
matched term that is merely a substring of another matched term is discarded.
Repeating one phrase is now correctly one piece of evidence, not two.

## Defence in depth — four independent refusals

1. **Detection** routes before a proposal can exist.
2. **`fdh12_approve_retirement_statement()`** refuses `routed_to_smsf`
   (`ROUTED_TO_SMSF`) and `possible_smsf` (`SMSF_REVIEW_REQUIRED`). An
   unapproved statement can never be applied, so routing is terminal.
3. **`fdh12_apply_retirement_proposal()`** refuses an SMSF target
   (`SMSF_ACCOUNT_NOT_IMPORTABLE`), testing BOTH `master_item_key = 'smsf'` AND
   the existence of an `smsf_funds` row. The check runs BEFORE the staleness
   comparison so the user gets a routing message rather than a confusing STALE
   result.
4. **Migration 0090's guard** raises `42501` on any `current_balance` write to
   an SMSF row outside a `fhip.smsf_balance_write='certified'` window. FDH-12
   never sets that GUC — asserted by test that the string appears nowhere in
   migration 0111.

Additionally, `matchRetirementAccount` and the bridge adapter both exclude SMSF
rows from the candidate pool outright, so an SMSF account can never even be
OFFERED as a target.

## Duplicate SMSF accounts: structurally 0 (spec 72-73)

ADD NEW forces `master_item_key = NULL`, and SMSF is identified solely by
`master_item_key = 'smsf'`. An import therefore cannot create an SMSF row at
all — not "does not", but cannot.

Certified live in `scripts/fdh12_certification.mjs`: an SMSF-targeted apply is
refused and the SMSF balance is confirmed unchanged.

## SMSF gap register (spec 173)

**No SMSF-owned defects were found during FDH-12.** The SMSF module behaved
correctly at every point it was exercised, including its AU jurisdiction gate,
which correctly refused to create an SMSF fixture for a user with no AU home
jurisdiction during harness development — live evidence the gate works.

Nothing inside the SMSF module was patched to make an FDH-12 test pass.
EOF

# II-PC1-F1 — FIFO Scope Decision Document

**Dispatch:** II-PC1-F1 — R6 FIFO Account-Scope Review & Remediation
**Base:** `origin/main` @ `b7b28cada1000d5078fec2597e0d611d80a5b603`
**Date:** 2026-09-02
**Status:** DECIDED

---

## Question

For the same user holding the **same instrument / same scheme / same ISIN** across
**two different folios / canonical accounts**, when a redemption is placed against one
specific folio, should R6's FIFO lot matching consume:

- **A. ACCOUNT_SCOPED_FIFO** — acquisition lots from that same folio/account only; or
- **B. USER_INSTRUMENT_SCOPED_FIFO** — acquisition lots for that instrument across all
  of the user's folios?

---

## Current R6 implementation

Established by source read of `origin/main` @ `b7b28ca` (not inferred):

| Stage | File | Function | Grouping key | account_id available? |
|---|---|---|---|---|
| Canonical read | `lib/services/investment-intelligence/taxRepository.ts` | `loadTaxDataset` | `instrument_id` alone (`acquisitionsByInstrument` / `disposalsByInstrument`) | **YES** — `account_id` is selected on every row and retained in the `accountIdByTransactionId` side map |
| Lot build | `lib/engines/investment-intelligence/tax/taxLotEngine.ts` | `buildTaxLots` | one lot per acquisition event; lot carries `instrumentKey` only | NO (type has no account field) |
| **FIFO candidacy** | `lib/engines/investment-intelligence/tax/taxLotEngine.ts` | `consumeLotsFifo` | `l.instrumentKey === disposal.instrumentKey` | **NO — this is the defect site** |
| Orchestration | `lib/engines/investment-intelligence/tax/taxOrchestrator.ts` | `runTaxSimulation` | receives **flattened** arrays (`[...map.values()].flat()`), so any repository-level partitioning is destroyed before the engine sees it | NO |
| Persist lots | `taxRepository.ts` | `persistTaxLots` | writes `ii_tax_lots.account_id` from the side map | YES |
| Persist consumptions | `taxRepository.ts` | `persistTaxLotConsumptions` | `(disposal_transaction_id, lot_id)` | implicit via lot |

**Exact current behavior:** FIFO candidate lots are selected by instrument alone. Because
every caller flattens the per-instrument maps into a single array before calling
`runTaxSimulation`, a disposal booked against Folio B is free to consume an acquisition lot
that was opened in Folio A whenever Folio A's lot is chronologically older.

This was disclosed — but explicitly **not fixed** — during II-PC1's closure, at
`tests/live-dev/iiPc1ClosureVerification.test.ts` (the "Documented architectural finding"
block), because PC1's fixtures used two different instruments and therefore could not
distinguish the two models.

---

## FHIP canonical-account semantics

1. `ii_accounts` is FHIP's canonical representation of a **folio / demat account**. Account
   identity is (institution/AMC + folio number), repaired and certified by II-PC1's
   CAMS/KFintech folio-identity fix. Two folios of the same AMC are two `ii_accounts` rows.
2. `ii_transactions.account_id` is **NOT NULL**. Every acquisition and every disposal is
   already attributable to exactly one canonical account, with no migration required.
3. `ii_tax_lots.account_id` is **NOT NULL** and already persisted per lot.
4. **R5 already does this correctly.** `lib/engines/investment-intelligence/sip/
   sipOrchestrator.ts:131` selects the transactions fed to its own FIFO reconstruction as
   `dataset.transactions.filter((t) => t.accountId === series.accountId && t.instrumentId
   === series.instrumentId)`, and `sipAttribution.ts`'s contract documents its input as
   "ALL certified transactions for the same **(account, instrument)**". **R6 is the sole
   FIFO surface in the codebase that is not account-partitioned.**
5. **R3 publication already assumes account-scoped lots.**
   `lib/services/investment-intelligence/investmentPublicationService.ts:242` computes a
   published position's **cost basis** as the sum over
   `ii_tax_lots WHERE account_id = <position account> AND instrument_id = <position
   instrument> AND status <> 'closed'`. Under instrument-wide FIFO, a Folio B redemption
   decrements a **Folio A** lot's `units_remaining`, which then *understates Folio A's
   published cost basis and overstates Folio B's*. The current model therefore does not
   merely mis-state tax — it corrupts a published, net-worth-adjacent figure.

---

## India tax treatment

**Statutory hook.** Section 45(2A) of the Income-tax Act, 1961 provides for computation of
capital gains on securities held in dematerialised form and mandates FIFO for determining
the date of transfer and period of holding.

**Direct authority on the multi-account question.** CBDT **Circular No. 768, dated
24-6-1998**, issued to interpret s.45(2A), states:

> "In the depository system, the investor can open and hold multiple accounts. In such a
> case, where an investor has more than one security account, FIFO method will be applied
> accountwise."

and gives the reason:

> "…securities lying in his other account cannot be construed to have been sold as they
> continue to remain in that account."

This is squarely on point and resolves the question in favour of **account-wise** FIFO.

**Extension to non-demat mutual-fund folios.** Circular 768 speaks literally of depository
accounts. For units held in Statement-of-Account (folio) mode with the AMC/RTA, the same
result follows *a fortiori* and does not depend on the circular at all: s.45 charges gains
on **the transfer of a capital asset**. A redemption instruction names a specific folio and
extinguishes units standing to the credit of **that folio only**; units in the other folio
are not transferred at all, so no charge can attach to them. FIFO is a presumption for
identifying which of otherwise-fungible units were transferred — it can only operate over
units that were actually capable of being transferred by that instruction. The circular's
own stated rationale ("cannot be construed to have been sold as they continue to remain in
that account") is precisely this reasoning.

**Market practice (corroborating, not authority).** CAMS/KFintech realised-capital-gains
statements — the documents Indian taxpayers actually file from — apply FIFO **within a
folio**, and gains are computed on a PAN + scheme + folio basis. A product whose FIFO
crossed folios would disagree with the taxpayer's own RTA statement.

### TAX LAW RULE vs FHIP ACCOUNTING / PROVENANCE RULE — kept separate

- **Tax-law rule:** FIFO is applied **account-wise** (Circular 768; and by direct operation
  of s.45 for folio-mode units).
- **FHIP accounting/provenance rule:** FHIP must in addition retain folio-specific
  provenance for every lot and every consumption, because R3's published cost basis is
  computed per `(account_id, instrument_id)`.

Here the two rules **coincide and reinforce each other** — this is *not* a case where tax
law permits aggregation while FHIP must nevertheless keep provenance. Aggregation is
prohibited by both. Tax grouping is therefore **not** being silently equated with
portfolio-account grouping; they were evaluated independently and both land on the account
boundary.

---

## CAMS folio transaction semantics

A CAMS/KFintech Consolidated Account Statement is organised **folio by folio**, under an
AMC, with the scheme and its ISIN nested inside. Every transaction row — purchase, SIP
instalment, redemption, switch — appears **within** a folio block and carries that folio's
running unit balance. A redemption row is therefore self-identifying as to its source
folio: the folio is structural in the document, not inferred.

FHIP preserves this: the CAMS parser resolves each folio block to an `ii_accounts` row
(II-PC1's certified folio/AMC identity fix) and stamps `ii_transactions.account_id`
accordingly. The disposing account is already canonical truth in FHIP, derived from the
statement, never from user input.

---

## Decision

**ACCOUNT_SCOPED_FIFO**

FIFO lot candidacy must be restricted to lots opened in the **same canonical account** as
the disposing transaction. The lot-grouping identity is **(user, account, instrument)**.

---

## Reason

1. **Direct authority.** CBDT Circular No. 768 (24-6-1998), interpreting s.45(2A), states in
   terms that where an investor has more than one security account, "FIFO method will be
   applied accountwise."
2. **First principles for folio-mode units.** Units in the non-disposing folio were never
   transferred, so s.45 cannot reach them; FIFO cannot select an asset that was not the
   subject of the transfer.
3. **Agreement with the taxpayer's own source document.** CAMS/KFintech compute realised
   gains folio-wise; FHIP disagreeing with the RTA statement would produce numbers the user
   cannot reconcile or file.
4. **Internal consistency.** R5's SIP attribution already partitions FIFO by
   `(accountId, instrumentId)`. R6 is the only unpartitioned FIFO surface in the codebase.
5. **Downstream correctness.** R3's published cost basis reads `ii_tax_lots` filtered by
   `(account_id, instrument_id)`; instrument-wide consumption corrupts that figure across
   folios.
6. **No schema barrier.** `ii_transactions.account_id` and `ii_tax_lots.account_id` are both
   already NOT NULL and populated. The correct rule is implementable with **no migration**.

Under the dispatch's §1, this is **OUTCOME B — ACCOUNT-SCOPE DEFECT CONFIRMED**.

---

## Scope boundary for the repair (per dispatch §16-§18)

- The grouping key becomes `(user, account, instrument)` using **canonical `ii_accounts.id`**
  — never institution name, folio-number text, AMC name, source document, or display label.
- **No second FIFO engine.** The existing deterministic `consumeLotsFifo` is retained; only
  its candidacy predicate is corrected, and the account identity is threaded onto the event
  types so the partition survives the callers' `.flat()`.
- **No change** to equity/debt classification, effective-dating, grandfathering, indexation,
  disposal recognition, holding-period thresholds, or capital-gain formulas.
- **No migration.** See §21 — `account_id` already exists and is NOT NULL on both
  `ii_transactions` and `ii_tax_lots`.

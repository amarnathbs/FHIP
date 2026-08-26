# R12 — Corporate Action Scope (spec sections 28-29)

R12 does **not** build a corporate-action processing engine. Exact support classification for direct
listed equity / equity-oriented ETF:

| Corporate action | Status | Mechanism |
|---|---|---|
| Stock split | **MANUAL_CORRECTION_REQUIRED** | User records the resulting unit-count change as a `reprice`/subsequent `buy`-equivalent adjustment reflecting the new unit count and post-split price; `split` transaction type already exists in the DB (migration 0059) but R12 does not automate detection or generation of it |
| Bonus issue | **MANUAL_CORRECTION_REQUIRED** | Same as split — `bonus` transaction type already exists; user enters it as a manual event if/when the manual-entry UI is extended to expose bonus/split actions (not built this cycle — the `iiManualDirectPositionSchema` action set is `buy`/`sale`/`dividend`/`reprice` only) |
| Rights issue | **DEFERRED** | No transaction type exists for a rights subscription's distinct partial-cost-basis semantics; not needed for R12's frozen scope's certification |
| Merger | **DEFERRED** | `merger` transaction type exists (R1-era) but no resolution logic for the resulting instrument-identity change was built or tested in R12 |
| Demerger | **DEFERRED** | No support |
| Symbol change | **SUPPORTED structurally** | The instrument's canonical identity is the ISIN, not the exchange symbol — a symbol change does not require touching `ii_instruments.id` at all, only adding/superseding an `ii_instrument_identifiers` row (already the existing, tested identifier-alias architecture) |
| ISIN change | **DEFERRED** | A genuine ISIN change (rare, e.g. post-merger) has no automated remapping; would currently read as a new instrument |

**Why this is safe to defer**: R12's frozen scope is a from-scratch manual-entry pathway for equity/ETF
— no existing user has data that would be silently corrupted by an unhandled corporate action, because
no R12 data exists yet. A user who experiences a real corporate action after adopting R12 must record
a correcting manual transaction; this is disclosed, not silent (spec section 29 — "do not silently
produce incorrect holdings"). Nothing in R12's holdings engine auto-derives a wrong post-action position
without the user's own input driving it.

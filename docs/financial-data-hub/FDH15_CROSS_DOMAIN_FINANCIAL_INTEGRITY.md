# FDH-15 — Cross-Domain Financial Integrity

## Reused evidence vs. fresh this round (rule 7 distinction, made explicit)

FDH-14 built `scripts/fdh14_golden_household_e2e_oracle.mjs`, which proves the canonical DATA MODEL
correctly avoids double-counting (salary+bank, card purchase+repayment, loan drawdown/repayment
decomposition, bank→broker transfer, etc.) — 23/23 PASS, reused here as evidence that the
**aggregation/classification layer** (FDH-1/6/7/8's own certified territory) is dedup-correct
*given* canonical rows in the right shape.

**Important scoping distinction this round makes explicit**: that script commits its canonical rows
directly via the service-role REST key, simulating the shape the real Apply RPCs would produce — it
does **not** invoke `fdh9_apply_income_proposal`/`fdh10_apply_liability_proposal`/
`fdh12_apply_retirement_proposal`/`applyAuStatementActivity` themselves. Per this project's own
standing rule (§215, born from the FDH-12 incident), that is valid evidence for the canonical
economic-event semantics, but is **not** decisive evidence that the bridge's own Apply RPCs
produce that shape — that is FDH-15's job, and is why this round built a **second**, independent
live-DEV script that calls the real RPCs with a real authenticated JWT
(`scripts/fdh15_bridge_governance_live_dev_certification.mjs`).

## What FDH-15 freshly proved via real RPCs this round

- Income Apply, called via the real RPC, correctly stamps exactly one canonical `income_sources`
  row with the applied amount and provenance (INC-1/1b/1c) — i.e. the REAL bridge path, not a
  simulation, produces the economically-correct single canonical effect.
- Liability Apply, called via the real RPC, correctly updates the single canonical `liabilities`
  balance with provenance (LIA-1/1b).
- Retirement Apply, called via the real RPC, correctly updates the single canonical
  `retirement_accounts` balance with provenance (RET-1/1b).
- Double-applying the same proposal produces **zero** additional economic effect (INC-2/2b) — the
  "one proposal applied twice ≠ two financial effects" invariant, proven live via the real RPC.

## Salary / card-repayment / loan / dividend / employer-super / rollover / investment dedup (spec §66–74)

Not re-derived fresh this round as a single combined golden-household scenario across all named
economic events (time-boxed; FDH-14's already-cited 23/23 covers this exact list at the
data-model level, and is not contradicted by anything found this round). What IS new this round is
narrower and more decisive for the bridge specifically: proof that the Apply RPCs, when actually
invoked, write the single correct canonical row for Income/Liability/Retirement (above) — closing
the gap FDH-14's own service-role-only method left open for those three domains. AU Investment's
buy/sell-not-expense/not-income semantics and the fingerprint-based dedup backstop were reused from
FDH-11's own prior live certification (`FDH11_SECURITY_CERTIFICATION.md`, `FDH11_COMPLETION_REPORT.md`)
— unchanged source this round (no edits to `applyAuStatementActivity.ts`/`applyAuStatementPosition.ts`).

## Net-worth duplication / Forecasting pre-Apply mutation / Goals regression (spec §75–77)

Not independently re-tested fresh this round. Architecturally: canonical Net Worth/Forecasting/Goals
read from the SAME canonical tables (`income_sources`, `liabilities`, `retirement_accounts`,
`ii_*`) the bridge writes to — there is no second FDH-owned copy of any of these values anywhere in
the schema (confirmed structurally via the isolation tests cited in
`FDH15_BRIDGE_ARCHITECTURE_INVENTORY.md`), so a correct single canonical write (proven above)
implies no second asset/liability/income copy for downstream consumers. Before Apply, proposal/
evidence tables are never read by any Forecasting/Net-Worth/Goals code path — confirmed by grep
(no `fhip_import_proposals`/`fdh_*_statements` reference in `lib/forecasting/`, `lib/net-worth/`,
or Goals code). Disclosed as architecturally-covered-but-not-freshly-live-tested this round (P3).

## Governing invariants (spec §225) — status

| Invariant | Status this round |
|---|---|
| Evidence ≠ canonical truth | PROVEN (live, this round) |
| Proposal ≠ permission to mutate | PROVEN (live, this round) |
| High confidence ≠ automatic Apply | PROVEN (by source inspection — no RPC reads confidence as an authorization gate) |
| Exact reconciliation ≠ automatic Apply | PROVEN (by source inspection, same basis) |
| Compare ≠ Apply | PROVEN (live, this round) |
| Manual data ≠ disposable data | PROVEN (live — stale-proposal test preserves the manual edit, INC-4) |
| Old proposal ≠ authority to overwrite newer canonical state | PROVEN (live — STALE_PROPOSAL, INC-4) |
| Owning a row ≠ authority to forge provenance | PROVEN (live — INC-3/LIA-2/RET-3) |
| Owning a proposal ≠ authority to target another tenant's record | PROVEN (live — XT-1..5) |
| One proposal applied twice ≠ two financial effects | PROVEN (live — INC-2/2b) |
| Two documents describing one economic event ≠ two economic events | REUSED evidence (FDH-14, data-model level) — not re-derived via real RPCs this round |
| FDH proposal tables ≠ another canonical financial engine | PROVEN (by source inspection — 0 second-engine tables found) |
| FDH-15 bridge governance ≠ FDH-13 Admin governance | Stated explicitly; FDH-13 not touched |
| **Same-tenant member/owner target is NOT interchangeable** (this round's own addition) | Found violated pre-fix (FDH15-DEF-001/002), FIXED this round, PGlite-proven, DEV activation pending PO |

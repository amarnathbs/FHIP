# FDH-16 — Golden Household Oracle

## REUSED PRIOR CERTIFIED EVIDENCE

FDH-14's golden household (`scripts/fdh14_golden_household_e2e_oracle.mjs`, 23/23 PASS, live DEV, 2026-08-31)
remains the most complete single-household oracle in the repository: one AU household with Self, salary +
payslip, bank salary credit, employer super contribution + super statement, credit card purchase + repayment,
personal loan repayment (principal/interest/fee decomposition), AU brokerage transfer/purchase/sale/dividend,
and a real negative control (a genuine `23505` unique-index rejection on a duplicate-statement attempt). All 9
named economic events were proven with real committed rows. This round did not rebuild that fixture (no
demonstrated defect required it, per rule 8/§6's no-speculative-refactoring discipline) — its evidence is cited,
not re-derived.

**Caveat carried forward from FDH-15, not resolved by this round**: FDH-14's golden household writes evidence
and canonical rows directly via the service-role key, in the shape the real Apply functions would produce — it
does not call the real Apply RPCs themselves. FDH-15's own residual register (#2) explicitly names this gap:
"no single combined golden bridge household spanning Income+Liability+AU-Investment+Retirement via real
RPCs/API in one user context."

## FRESH FDH-16 contribution this round

This round's own two live scripts partially close that gap for three of the four named domains, using real
authenticated-JWT RPC calls throughout (never service-role for the decisive step):

- `scripts/fdh16_manual_vs_import_equivalence_certification.mjs` — Income, Liability, Retirement, each via its
  real owner-Apply RPC (`add_new` decision), 33/33 PASS.
- `scripts/fdh16_dashboard_engine_live_proof.mjs` — Income, Expense, Asset, Liability, Investment (legacy table),
  Retirement, all via direct authenticated manual-entry-shaped inserts, reconciled through the real
  `computeDashboard()` engine, 8/8 PASS.

**AU Investment remains the one domain neither this round nor FDH-15 exercised via a real externally-callable
Apply RPC** — `applyAuStatementActivity.ts`/`applyAuStatementPosition.ts` are typed functions invoked from within
the Next.js API route layer, not RPCs reachable via a bare PostgREST call the way Income/Liability/Retirement's
bridges are. Reaching it decisively would require either running the actual Next.js server (blocked this round
— see `FDH16_SCOPE_AND_CERTIFICATION_PLAN.md`'s browser-tooling note) or FDH-11's own prior live certification
(REUSED, not re-run fresh).

## Combined oracle picture (fresh + reused, honestly composed)

| Domain | Golden-household evidence | Real-RPC evidence |
|---|---|---|
| Income | FDH-14 (23/23, incl. payslip+bank dedup) | FDH-16 fresh (`I-1`..`I-1c`) + FDH-15 fresh (`INC-1`..`INC-6`, DEV-confirmed) |
| Liability | FDH-14 (23/23, incl. card+loan decomposition) | FDH-16 fresh (`I-2`..`I-3c`) + FDH-15 fresh (`LIA-1`..`LIA-3`) |
| Retirement | FDH-14 (23/23, incl. rollover neutrality) | FDH-16 fresh (`I-4`..`I-5d`) + FDH-15 fresh (`RET-0`..`RET-4`, DEV-confirmed) |
| AU Investment | FDH-14 (23/23, incl. transfer/purchase/sale/dividend) | REUSED ONLY (FDH-11's own live certification) — disclosed residual |

## Verdict

Golden-household oracle coverage is **PASS with a disclosed, unchanged residual** (AU Investment real-RPC path)
carried forward from FDH-15, not newly discovered and not blocking per the severity-gate rules (it is a coverage
gap, not a demonstrated defect).

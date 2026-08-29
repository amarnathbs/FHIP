# FDH-10 — Liability Import Bridge (FDH10-J)

## Extends FDH-9's bridge; no second framework

`lib/import-bridge/adapters/liabilityAdapter.ts` implements the same `ImportDomainAdapter<TEvidence, TExisting>` contract `incomeAdapter.ts` implements. `lib/import-bridge/supabaseStore.ts`'s `DOMAIN_TABLES`/`PROVENANCE_BY_DOMAIN` maps gained one entry each (`liability: 'liabilities'`) — the store, `proposalEngine.ts` (serialisation/staleness/patch-building), and `applyService.ts` (the TypeScript-level guard) needed **zero** code changes; they were already fully domain-agnostic.

## What the adapter proposes

| Field | When proposed | Why |
|---|---|---|
| `liability_name`, `debt_type`, `currency_code`, `country_code` | Only on `add_new` | Never renames/re-types a Liability the user already classified |
| `lender`, `masked_identifier` | Always, when the statement discloses them | Metadata |
| `balance` | Always | Card closing balance or loan closing principal |
| `interest_rate` | **Loan facilities only** | Never overwrites a canonical rate with a card purchase APR (spec 77) |
| `monthly_repayment` | Card minimum payment (`requiresConfirmation: true`) or loan contractual repayment | Preserves the semantic distinction (spec 78) — the UI must not silently treat a card minimum as the user's habitual repayment |
| `credit_limit`, `minimum_payment`, `due_date` | Card facilities | Additive metadata columns (migration 0096) |

`available_credit` is deliberately **not** in `LIABILITY_APPLICABLE_FIELDS` — it is informational evidence only, never written to the canonical Liability, so it structurally cannot be summed into net worth (spec 85).

## The typed atomic apply RPC (spec sections 53-58)

`fdh10_apply_liability_proposal(p_proposal_id, p_decision, p_selected_fields)` — a **separate, narrow, typed** function per spec section 53's explicit instruction, not a generalisation of the income RPC into a dynamic-table dispatcher. Same guarantees as `fdh9_apply_income_proposal()`: row lock, atomic compare-and-swap, staleness gate (value-level, not timestamp), allow-listed columns only, single transaction (all-or-nothing).

## Full matrix certified (spec section 58)

| Scenario | Certified in |
|---|---|
| No existing liability -> add new | `fdh10LiabilityBridge.test.ts` + `fdh10_security_certification.mjs` |
| Same facility -> update existing | both |
| Ambiguous facility -> review required (no auto-update) | `facilityMatching`/`liabilityAdapter` logic + `fdh10BankMatching.test.ts` |
| Keep existing (no write of any kind) | `fdh10LiabilityBridge.test.ts` |
| Apply selected fields only | `fdh10LiabilityBridge.test.ts` |
| No apply (upload/parse/review changes nothing) | `fdh10LiabilityBridge.test.ts` |
| Stale proposal (edited after generation) | both |
| Duplicate apply (idempotency) | both |
| Concurrent apply (exactly one mutation) | `fdh10LiabilityBridge.test.ts` (`Promise.all`) + RPC's row-level lock (real Postgres) |
| Cross-tenant target | both |
| Forbidden field | `fdh10LiabilityBridge.test.ts` |

## FDH-9 regression (spec section 142)

The full pre-existing FDH-9 suite (`fdh9IncomeBridge.test.ts`, `fdh9DoubleCountCertification.test.ts`, `fdh9SchemaContract.test.ts`, `fdh9PayslipExtraction.test.ts`, `fdh9IncomeTabUx.test.ts` — 330 tests) was re-run **unchanged** after adding the liability branch: 330/330 passing, proving `target_domain='income'` behaviour is byte-for-byte unaffected by the `target_domain='liability'` addition.

## Residual

No API route exists yet that calls `applyLiabilityProposalAtomic()` — the production apply function is written and its underlying RPC is live-certified against real Postgres, but nothing in `app/api/` invokes it (see `FDH10_LIABILITIES_TAB_UX.md`).

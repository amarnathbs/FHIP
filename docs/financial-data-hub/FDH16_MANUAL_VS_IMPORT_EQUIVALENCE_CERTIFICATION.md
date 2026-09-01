# FDH-16 — Manual vs Import Equivalence Certification

**FRESH FDH-16.** This is the centrepiece artefact spec §214 asks for. Script:
`scripts/fdh16_manual_vs_import_equivalence_certification.mjs`. Run live against hosted DEV
(`vqycarelcoijzwlpkpcz`) this round. Result: **33/33 PASS.**

## Method

Two synthetic AU households, identical economic facts (salary $6,000/mo, personal loan balance $15,000, super
balance $150,000):

- **Household M (Manual)** — every canonical row created via a direct RLS-scoped `POST` using the household's
  own real authenticated JWT (`role: authenticated`), matching exactly the write shape
  `lib/services/registry.ts`'s `save()`/`create()` executes for the real manual-entry API routes
  (`app/api/income/route.ts`, etc.) — no service-role key used for any Household M write.
- **Household I (Import)** — real evidence rows (payslip / loan statement / retirement statement), approved via
  the real `fdh10_approve_liability_statement`/`fdh12_approve_retirement_statement` RPCs, then proposed
  (`fhip_import_proposals` + `fhip_import_proposal_fields`, `recommended_apply_mode='add_new'`) and Applied via
  the real `fdh9_apply_income_proposal`/`fdh10_apply_liability_proposal`/`fdh12_apply_retirement_proposal` RPCs —
  every decisive call made with a real authenticated JWT, per standing rule #10 (never service-role for the
  decisive Apply step).

## Required comparison table (spec §215)

| Metric | Manual (Household M) | Imported (Household I) | Variance |
|---|---|---|---|
| Income (salary) | $6,000.00 | $6,000.00 | **$0.00** |
| Liability (personal loan balance) | $15,000.00 | $15,000.00 | **$0.00** |
| Retirement (super balance) | $150,000.00 | $150,000.00 | **$0.00** |
| Net Worth (partial oracle: retirement − liability, no other assets in this fixture) | $135,000.00 | $135,000.00 | **$0.00** |
| Assets | Not exercised in this fixture (exercised separately in the Dashboard live proof, see `FDH16_NET_WORTH_INTEGRATION_CERTIFICATION.md`) | — | — |
| Investments | Not exercised in this fixture — AU Investment has no real bridge RPC reachable outside the running Next.js app server (disclosed residual, same as FDH-15's own) | — | — |
| Expenses | Not exercised in this fixture (exercised in the Dashboard live proof instead) | — | — |
| Cashflow | Not exercised in this fixture | — | — |

Expenses/Assets/Cashflow variance-of-$0 is instead proven by the separate Dashboard engine live proof
(`fdh16_dashboard_engine_live_proof.mjs`, `FDH16_NET_WORTH_INTEGRATION_CERTIFICATION.md`), which reconciles a
single household's manually-entered figures against the real `computeDashboard()` output exactly (8/8 PASS) —
that script does not itself run a paired import household, so it certifies "canonical rows produce correct
downstream totals," not "manual vs import produce the same downstream totals." The two scripts together cover
the full required metric set except AU Investment (disclosed residual).

## Legitimate (allowed) differences — proven, not merely asserted (anti-vacuity, CMP-5/5b/5c)

| Field | Manual | Imported |
|---|---|---|
| `income_sources.source_type` | `manual` | `payslip_import` |
| `liabilities.source_type` | `null` (manual rows don't stamp this column) | `liability_statement_import` |
| `retirement_accounts.source_type` | `manual` | `retirement_statement_import` |
| `last_import_application_id` / `last_imported_at` | `null` | set, pointing at the real `fhip_import_applications` audit row |

All three provenance fields differ as expected — this proves the two households genuinely took different code
paths (not a vacuous "both empty" pass) while the financial figures matched exactly.

## FDH evidence non-duplication (CMP-6/6b)

Household I has exactly 1 `fdh_payroll_events` evidence row and exactly 1 canonical `income_sources` row — the
evidence is not separately summed into a second total anywhere (re-confirmed by direct re-query, not inferred).

## Fresh cross-tenant sweep against this exact fixture (XT16-1..3b)

- Household M cannot read Household I's applied proposal via PostgREST (RLS empty result).
- Household M cannot read Household I's canonical income row via PostgREST (RLS empty result).
- Household M's attempt to forge a NEW proposal naming Household I's liability row as `target_entity_id` is
  **BLOCKED at INSERT** with a real Postgres trigger error (`P0001`, "cross-tenant reference ... forged liability
  target — spec section 91"), and Household I's liability balance is confirmed unchanged afterward.

## Cleanup

Both synthetic households' rows and both auth users were deleted at the end of the run; the script's own
final `CLEANUP:` checks re-queried by id and confirmed 0 residual rows and both auth users returning 404. See
`FDH16_LIVE_DEV_CERTIFICATION.md` for the full DEV cleanup ledger.

## Verdict

**Manual vs Import Equivalence: PASS** for Income/Liability/Retirement/partial-Net-Worth (the three domains with
a real, externally-callable Apply RPC). AU Investment equivalence remains a disclosed residual (no real bridge
RPC reachable from outside the running app), consistent with FDH-15's own carried-forward gap — not newly
introduced by this round.

# II-PC3 Phase 4 — Live DEV Campaign Status

Status: **NOT EXECUTED — blocked on missing credentials**

## What was checked

Before starting any work, this pack confirmed there is no `.env.local` (or any `.env*` file besides the committed `.env.example`) anywhere in this worktree:

```
$ ls -la .env* 
.env.example   (committed template only — no real values)
```

Every existing `tests/live-dev/*.ts` suite in this repository (`iiPc1LiveDev.test.ts`, `iiPc1F1FifoAccountScopeLiveDev.test.ts`, `iiPc1F2EngineVersionConsumersLiveDev.test.ts`, `iiPc2WorkspaceLiveDev.test.ts`, `iiPc2F1ReadSideMutationLiveDev.test.ts`, `iiPc1ClosureVerification.test.ts`) reads real Supabase URL/anon-key/service-role-key values out of `.env.local` and hard-guards that the target project ref is exactly `vqycarelcoijzwlpkpcz` (the DEV project) before doing anything else. With no `.env.local` present, none of these suites — and no new PC3 suite written the same way — can run in this environment.

This is a genuine, environmental blocker, not a design gap in the qualification pack: `tests/live-dev/iiPc3RealCamsQualificationLiveDev.test.ts` is written, ready, and follows the identical methodology every prior live-DEV suite in this codebase uses. It self-skips with an explicit, visible `it.skip(...)` (never a silent 0-assertion pass) when `.env.local` is absent, and documents exactly how to run it for real once credentials are supplied.

## What Phase 4 would have covered, and where it is captured right now instead

| Phase 4 requirement | Where it lives today, DB-free | What is still missing without live DEV |
|---|---|---|
| Real PDF upload -> real `processSourceDocument()` -> certified accounts/transactions/holdings | `tests/live-dev/iiPc3RealCamsQualificationLiveDev.test.ts` (written, self-skipping) | Real Supabase Storage + Postgres round-trip |
| Q02 wrong/no/correct password against real DEV | same file | same |
| Q05/Q04 exact-reimport & monthly-delta dedup, LIVE | same file; DB-free proxy exists in `tests/unit/iiPc3QualificationPack.test.ts` (fingerprint-equality proof) | The actual `transaction_fingerprint` unique-index enforcement in real Postgres |
| Q03 F1 cross-account FIFO, LIVE | same file; DB-free proxy exists in `iiPc3QualificationPack.test.ts` (`planFolioAccountResolution` resolves 2 distinct keys) | The real `ii_accounts`/tax-lot-engine round trip |
| R4/R5/R6/F2/PC2-F1 `closed_at` proofs for a rich user | not attempted — these are live-DEV-only by construction in this codebase (no unit-level equivalents exist for `closed_at` idempotency) | Everything — this row has zero DB-free proxy |
| Full UI journey (Overview -> ... -> Reports) | `it.skip(...)` placeholder only | Everything — requires a running app + real auth session |
| Cross-user RLS (persisted truth + response body) | `it.skip(...)` placeholder only | Everything — requires two real authenticated sessions against real RLS policies |
| Independent E2E financial oracle for a rich user | not attempted | Everything |

## What this means for the verdict

Per the task's own stated decision rule, this is named here as the second explicit blocker (alongside "no real CAMS structural reference") capping the overall PC3 verdict at **CONDITIONAL PASS**, not a verdict of FAIL — the DB-free two-thirds of the pipeline (extraction, detection, parsing, dedup-fingerprinting, account-resolution planning, reconciliation, certification) was genuinely, rigorously proven against real PDF bytes and real production code in this environment; the live-hosted-DEV two-fifths of Phase 4 (real Storage/Postgres/RLS/UI) was not, for a reason entirely outside this pack's control.

## To actually run Phase 4

1. Supply a `.env.local` with `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` for the DEV project (ref `vqycarelcoijzwlpkpcz`).
2. `npx vitest run tests/live-dev/iiPc3RealCamsQualificationLiveDev.test.ts`.
3. Fill in the two `it.skip` placeholders (cross-user RLS probe, full UI journey) — both need live iteration against the real hosted project/running app, the same way R1's and R4's own security suites were originally built (see `[[investment_intelligence_r1]]`/`[[investment_intelligence_r4]]` in project memory).
4. Re-run Phase 5's cleanup verification against the real project afterward (the suite's own `afterAll` already does a first pass of this).

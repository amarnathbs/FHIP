# FDH-14 — Failure-Mode Certification

## 1. Error vs financial zero (spec §42) — REUSED, source-inspection re-confirmed this pass

The whole-FDH invariant — parser error ≠ $0, DB error ≠ $0, unsupported layout ≠ $0, loading ≠ $0, insufficient
evidence ≠ $0 — is enforced structurally by the shared document-status/extraction-status vocabulary
(`FDH_ALL_ERROR_CODES` in `lib/financial-data-hub/constants/enums.ts`, confirmed present this pass) rather than
by convention alone: a failed/errored document is left in a `failed`/`review_required`/`manual_mapping_required`
state, never advanced to a state that would cause a $0 to be read as a real reconciled balance. FDH-5's OCR
boundary (`OCR_REQUIRED`) and FDH-10's `insufficient_evidence` decomposition outcome are both concrete instances
of this same pattern, not one-off special cases.

## 2. Parser failure / partial parse failure (spec §75-76) — REUSED

A malformed or unsupported statement produces a controlled parse failure and never a canonical financial
mutation — this is structural, since canonical mutation only ever happens through the typed Apply RPCs (see
`FDH14_CANONICAL_OWNERSHIP_MATRIX.md`), which require an approved proposal that in turn requires successfully
extracted, reconciled evidence to exist first. A file that is only partially valid follows each domain's own
disclosed policy (e.g. FDH-10's `component_mismatch`/`insufficient_evidence` outcomes rather than a silent
partial import claiming exact reconciliation) — re-confirmed by reading `repaymentDecomposition.ts`'s three
possible outcomes this pass (`decomposed` / `component_mismatch` / `insufficient_evidence` — never a silent
default to "decomposed").

## 3. Reconciliation failure (spec §77) — REUSED

FDH-1's domain tests explicitly proved "reconciliation can never be recorded successful outside tolerance."
Every later domain's reconciliation module (bank, liability, investment, retirement) uses the same
tolerance-gated pattern; a variance is recorded as `variance`/`failed`, never silently promoted to `reconciled`.

## 4. Apply failure atomicity / repeated Apply / concurrent Apply (spec §78-80) — REUSED

Every domain Apply is a single Postgres RPC call (`fdh9_apply_income_proposal`, `fdh10_apply_liability_
proposal`, the FDH-11 investment bridge functions, the FDH-12 retirement Apply RPC) executed inside one
database transaction — atomicity is a property of using a single `SECURITY DEFINER` function per Apply, not of
any application-level orchestration that could partially fail. Idempotency against a second Apply is enforced
by each RPC's own "already applied" / unique-constraint check (FDH-9's proposal-status transition guard;
FDH-12's live proof that "an APPLIED proposal cannot be reset to ready and re-applied"). No new locking
architecture was built in this pass, consistent with spec §80's explicit instruction not to build one where
existing idempotency already handles it. A live, deliberately-forced mid-transaction Apply failure (e.g. by
killing the connection mid-RPC) was not freshly reproduced in this pass — this remains REUSED architectural
reasoning plus each module's own idempotency proof, not a new fault-injection experiment (disclosed as
residual R-14-3).

## 5. Fail-closed DB behaviour (spec §74) — REUSED + reasoning

FDH-6's own certification found and fixed a real defect in the opposite direction (a pagination cap silently
truncating results, not fabricating zeros) — the closest real fault this codebase has produced — and the fix
(`fetchAllRows()`, spec-referenced pagination helper) is now the standard pattern reused by FDH-8's and
FDH-10's own later pagination fixes (both found and fixed the identical class of defect independently,
suggesting the underlying PostgREST 1,000-row cap is a recurring hazard this project has now hardened against
in at least three call sites). No FDH service was observed, by source inspection, to catch a DB error and
substitute a fabricated `0`/empty-success result — every service function found propagates the Supabase error
object up rather than swallowing it (spot-checked in `payslipProcessingService.ts`, `economicTypeEngine.ts`,
`approvedSummary.ts` this pass). A live, deliberately-injected DB outage against hosted DEV was not performed
in this pass (would require damaging shared DEV, prohibited by spec §74's own instruction) — this remains a
source-inspection-level proof, disclosed as such rather than claimed as a live fault-injection result.

## 6. Verdict

Parser failure: **PASS**. Partial parse failure: **PASS**. Reconciliation failure: **PASS**. Apply atomicity:
**PASS** (architectural + idempotency proof; live fault-injection not attempted — residual R-14-3). Repeated
Apply: **PASS**. Concurrent Apply: **PASS** (reused per-module idempotency proofs; no dedicated concurrent-race
harness run fresh this pass). Fail-closed DB behaviour: **PASS** by source inspection; live DB-outage
simulation not performed (residual, disclosed, not claimed).

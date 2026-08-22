# R6-SECURITY-FINAL — Closure Report

Investment Intelligence, India Tax & Cost Intelligence (R6). Final,
narrowly-bounded closure pass before the module is frozen. Branch:
`feature/investment-intelligence-r6-security-final`, forked from
`feature/investment-intelligence-r6-debt-fund-fix` at `7b81c4d`. Date:
2026-08-22.

## Scope

Two, and only two, closure items — no tax logic, DDL, or arithmetic was
reopened outside what these two items required (neither required any):

1. **Authoritative INSERT-forgery closure.** The prior report disclosed
   INSERT-based forgery as "only incidentally blocked by FK integrity, not
   deliberately prevented by RLS/security design." Determine whether this
   is still true, and if it is, fix it with least-privilege RLS.
2. **Grandfathering legal-source closure.** The 31-Jan-2018 FMV
   grandfathering rule's continuity into the Income-tax Act, 2025 was
   disclosed as "reasonably certain by inference, not independently
   section-cited." Find direct current-law authority, or gate the
   uncertified case.

## 1. Repository state at start

Confirmed via `git status`/`git branch --show-current`/`git log`/
`git remote -v`: `HEAD` was `7b81c4d`
(`7b81c4df839db7662ddc655deba24f39ae7a20b6`) on
`feature/investment-intelligence-r6-debt-fund-fix`, matching
`origin/feature/investment-intelligence-r6-debt-fund-fix` exactly, clean
working tree. This closure's own work was done on a new branch,
`feature/investment-intelligence-r6-security-final`, forked from that tip.

## 2. Primary closure — INSERT forgery: found already resolved, live-reproven with rigor the prior report lacked

Live re-attack against DEV (`vqycarelcoijzwlpkpcz`) found **migration
`0061` is now applied** — this session has no DDL/RPC capability and did
not apply it; a human applied it between the R6-FINAL report's original
writing and this pass. That migration replaces the single `for all`
policy on `ii_capital_gains_computations`, `ii_tax_lot_consumptions`, and
`ii_tax_lots` with a SELECT-only policy, i.e. it removes the INSERT/UPDATE/
DELETE grant entirely rather than relying on any downstream constraint.

The prior report's own INSERT tests, however, used payloads that were
either referentially invalid (`crypto.randomUUID()` for a required
`disposal_transaction_id`/`opening_transaction_id` FK) or collided with a
unique index (an instrument that already had a classification/exit-load
row) — meaning a 403/409 there could not, by itself, distinguish "RLS
rejected this" from "the database rejected malformed data." This closure
built `scripts/ii_r6_security_final.mjs`, which re-runs every INSERT attack
with **fully valid, non-colliding, real foreign keys** — real transactions,
real lots, real accounts, real instruments owned by the attacking user (or,
for the two world-readable reference tables, a real instrument that
genuinely carries no existing classification/exit-load row) — removing the
ambiguity entirely.

**Result: 12/12 PASS**, live against DEV, today
(`scripts/ii-r6-security-final/results.json`):

| Table | Attack | Result |
|---|---|---|
| `ii_capital_gains_computations` | valid-FK INSERT, owning user | 403 `42501` RLS — **PASS** |
| `ii_tax_lot_consumptions` | valid-FK INSERT, owning user | 403 `42501` RLS — **PASS** |
| `ii_tax_lots` | valid-FK INSERT, owning user | 403 `42501` RLS — **PASS** |
| `ii_scheme_tax_classification` | valid-FK INSERT, unclassified real instrument | 403 `42501` RLS — **PASS** |
| `ii_exit_load_schedules` | valid-FK INSERT, unscheduled real instrument | 403 `42501` RLS — **PASS** |
| `ii_tax_rule_versions` | valid-FK INSERT, real `country_code`, novel version | 403 `42501` RLS — **PASS** |
| `ii_capital_gains_computations` | PATCH own existing row | 0 rows changed — **PASS** |
| `ii_capital_gains_computations` | DELETE own existing row | 0 rows deleted — **PASS** |
| `ii_capital_gains_computations` | cross-user SELECT (B reads A) | 0 rows returned — **PASS** |
| `ii_capital_gains_computations` | cross-user INSERT (B writes as A) | 403 RLS — **PASS** |
| `ii_capital_gains_computations` | cross-user PATCH (B tampers A's row) | 0 rows changed — **PASS** |
| `ii_capital_gains_computations` | cross-user DELETE (B deletes A's row) | 0 rows deleted — **PASS** |

**No new migration was required.** `0061`, once applied, was already the
correct and sufficient fix (least-privilege: SELECT-only for the owning
user on all three application-populated authoritative tables; the three
reference tables already had zero INSERT/UPDATE/DELETE grant since their
original migration `0058`/`0031`, world-readable via `using (true)` for
SELECT only). This pass's job was to prove that with attacks that cannot be
second-guessed as FK/constraint artifacts, live, and it now has.

**Trusted server write regression**: a real authenticated call to
`/api/investment-intelligence/tax/summary` (real cookie-based session, dev
server on port 3199, `.next` cache cleared to rule out a stale route
manifest after a first false-404 run) returned HTTP 200 with 12
`disposalResults`, and the corresponding `ii_capital_gains_computations`
rows for that real user were confirmed persisted via a direct service-role
read — the RLS lockdown does not disturb the legitimate write path, because
`taxRepository.ts`'s `persistTaxLots`/`persistTaxLotConsumptions`/
`persistCapitalGainsComputations` have always used `createAdminClient()`
(service-role, RLS-bypassing), never the request-scoped client. Confirmed
end-to-end in the browser too: navigating to `/investment-intelligence/tax`
as the same authenticated test user renders the real realised-gains table,
tax-lot table, and disclaimers — not a stub or an error state.

Full evidence and the negative-control rationale (why this DEV-shared
environment could not safely have `0061` reverted to reproduce the pre-fix
state fresh) are in `R6_FINAL_SECURITY_VERIFICATION.md`'s addendum.

## 3. Second closure — grandfathering legal source: DIRECTLY SOURCED AND CERTIFIED

Official-source web research found direct current-law authority: **Section
90(7)-(9) of the Income-tax Act, 2025** [30 of 2025] — a cost-of-acquisition
provision applying "for the purposes of sections 72 and 73" (the Act's
general capital-gains computation sections) — restates, for "a long-term
capital asset, being an equity share in a company or a unit of an equity
oriented fund or a unit of a business trust referred to in section 198,
acquired before the 1st February, 2018", the identical formula this engine
already implements: cost of acquisition is the higher of (a) the actual
cost, or (b) the lower of the fair market value as on 31 January 2018 and
the sale consideration — i.e. `max(actualCost, min(fmv, saleConsideration))`,
byte-for-byte the same three-way comparison `grandfathering.ts` has always
computed.

Direct fetches of `incometaxindia.gov.in` and `indiankanoon.org` returned
HTTP 403 (the same disclosed pattern the R6-FINAL pass hit for Sections
196/198). Two independent secondary-source fetches — `eztax.in` and
`aubsp.com` — quote matching verbatim statutory text for Section 90(7)-(9),
which is the same corroboration standard already used and accepted
elsewhere in this register for the Section 196/198 rate figures.

**No arithmetic change was made.** `grandfathering.ts`'s formula already
applies unconditionally by acquisition date, independent of which Act
governs the disposal — that behaviour is now confirmed correct by direct
statutory authority rather than "reasonably certain by inference." The
module header, `ruleVersions.ts`'s header and the `RULE_2025_ACT_POST_20260401`
doc comment, and `R6_TAX_LEGAL_SOURCE_REGISTER.md` (Section 5, and Open
Item 2, now struck through and marked CLOSED) were all updated to carry the
citation.

A new, additive-only test file,
`tests/unit/iiR6SecurityFinalClosure.test.ts` (5 tests, all passing),
proves this at the engine-behaviour level, not just in documentation:

- The same eligible pre-1-Feb-2018 acquisition, disposed once under the
  1961 Act (31-Mar-2026) and once under the 2025 Act (1-Apr-2026), produces
  numerically identical grandfathering treatment (`costBasisUsed` and
  `taxableGain` equal to 6 decimal places; only `ruleVersion` differs).
- The REAL production `RULE_2025_ACT_POST_20260401` constant is confirmed
  `placeholder: false` — today's real disposals are not silently running
  through an unflagged inference.
- A **negative control** (spec Section 27): a LOCALLY CLONED rule-version
  array (never the real exported constant or DB seed) with the governing
  version's `placeholder` flipped to `true`, passed through
  `computeDisposalTax`'s own `ruleVersions` override parameter, causes
  `ruleVersionPlaceholder: true` and the orchestrator's
  `PLACEHOLDER_RULE_DISCLAIMER` to attach — proving the engine's existing
  safety mechanism genuinely surfaces an uncertified rule rather than
  silently computing through it, if one were ever encountered again. The
  unmodified real rule set, run through the identical case, does not carry
  the note.

No `RULE_NOT_CERTIFIED`/`REVIEW_REQUIRED` hard-gate needed to be built:
since direct legal authority was found, the existing unconditional
behaviour is correct as-is, and the spec's harder fail-safe requirement
(Section 22) only applies to the case where authority CANNOT be verified,
which did not occur here.

## 4. Regression

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npx vitest run --no-file-parallelism` | 1260 passed / 5 skipped (was 1255/5; +5 from the new closure test file, 0 regressions) |
| `npx eslint .` | 6 errors / 7 warnings — unchanged from disclosed baseline |
| `npm run build` | exit 0, clean |
| R4 50-case cert (`iiR4Certification50Case.test.ts`) | 50/50 PASS, max variance 2.66e-8 (tolerance 1e-6) |
| R5 89-case cert (`iiR5Certification.test.ts`) | 89 cases / 698 comparisons / 698 PASS / 0 FAIL |
| R6 142-case cert (`iiR6P1Certification.test.ts`) | 142 cases / 644 comparisons / 644 PASS / 0 FAIL |
| New R6-SECURITY-FINAL closure tests (`iiR6SecurityFinalClosure.test.ts`) | 5/5 PASS |
| Live security harness (`ii_r6_security_final.mjs`) | 12/12 PASS |

All comparison reports were freshly regenerated by this dispatch's own
`vitest run` (not copied from a prior run) — `scripts/ii-r4-certification/`,
`scripts/ii-r5-certification/`, `scripts/ii-r6p1-certification/`.

## 5. Files touched

- `lib/engines/investment-intelligence/tax/grandfathering.ts` — header
  comment only (citation added), formula unchanged.
- `lib/engines/investment-intelligence/tax/ruleVersions.ts` — header/doc
  comments only (citation added, open item marked resolved), rule data
  unchanged.
- `tests/unit/iiR6SecurityFinalClosure.test.ts` — new, additive.
- `scripts/ii_r6_security_final.mjs` — new, additive live-security harness.
- `docs/investment-intelligence/R6_TAX_LEGAL_SOURCE_REGISTER.md` — Section
  5 and Open Items updated.
- `docs/investment-intelligence/R6_FINAL_SECURITY_VERIFICATION.md` —
  addendum appended.
- `docs/investment-intelligence/R6_ACCEPTANCE_REPORT.md` — superseded-by
  note appended (original content retained verbatim).
- `docs/investment-intelligence/R6_SECURITY_FINAL_CLOSURE_REPORT.md` — this
  file.

No migration was added (none was needed). No previously-applied migration
was edited. No certified tax calculation, FIFO logic, debt-fund boundary,
23-Jul-2024 disposal boundary, taxpayer-level aggregation, exit-load logic,
or TER logic was touched.

## 6. Verdict

**R6 FROZEN — UNCONDITIONAL FULL PASS.** Both closure items resolved on
their merits (the security gap was found to have already been closed by an
already-applied migration, re-verified with genuinely rigorous valid-FK
attacks; the legal-research gap was closed with a direct statutory
citation). Zero forged rows persisted anywhere in DEV at any point in this
pass — every INSERT attack was rejected before persistence; the two
UPDATE/DELETE attempts that returned a non-error HTTP status affected zero
rows, confirmed by immediate re-read. R7 is authorised to begin.

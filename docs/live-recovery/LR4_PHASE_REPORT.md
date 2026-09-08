# LR-4 — Income / Liability / Investment / Retirement Import Recovery: Phase Report

**As of:** 2026-09-08

## 1. Terminal Verdict

**CONDITIONAL PASS — two real, precisely-scoped defects found and fixed; no code change was needed for Income or Liability import, which are already genuinely complete.**

## 2. Discovery Truth Map (WP-01 — capability truth audit)

Traced all four import surfaces UI→API→parser→staging→Apply, end to end, with exact file citations (not doc claims):

| Surface | Verdict |
|---|---|
| Income (Payslip) | **Live and connected** — full Upload→Process→Review→Approve→Apply chain verified, writes to canonical `income_sources` via an atomic RPC. No change needed. |
| Liability | **Live and connected** — same pattern, writes to canonical `liabilities`. Supports both credit-card and loan statement types. No change needed. |
| Investment (AU broker statements) | **Partially wired** — real, unbroken chain, but "Apply" lands in the Investment Intelligence (`ii_*`) schema, not the `investments` table this tab's own grid, Net Worth and Dashboard read. Reaching `investments` requires a separate, unlinked manual "publish" step in a different top-level module. Two generic CSV adapters exist (transaction + portfolio); no named-broker adapters, no PDF support. |
| Investment (CAMS/India) | **By design, not a defect** — a separate, pre-existing module (`/investment-intelligence`), reusing its own certified parsers, sharing the identical "publish to `investments`" gap as the AU path above. Taxonomy preservation is structurally intact (CAMS parsing untouched). |
| Retirement | **Functionally complete but missing the production upload gate** every sibling surface has. Writes to canonical `retirement_accounts` via an atomic RPC once uploaded — a genuine, concrete, unintentional gap, not a design choice. |
| Direct equity/ETF broker import | Not a separate absent capability — already inside the AU investment adapter's scope (equity/ETF/managed_fund are all parsed instrument classes). Inherits the same publish-detachment gap as the AU path. |

## 3. Root Causes and Defects Fixed

1. **Retirement statement upload had no production-enablement gate.** Every sibling surface (Income, Liability, AU Investment) calls `isFdhDocumentUploadEnabled()` — the same hard gate that refuses real uploads outside the one certified DEV Supabase project regardless of any environment variable — before doing anything mutating. `app/api/financial-data-hub/retirement-statement/upload/route.ts` never called it. No comment anywhere claimed this was intentional; it was a real, unintentional gap that would have let retirement-statement uploads through in production while every other statement type stayed correctly gated. **Severity: P1** (a genuine, if narrow, production-safety gap — this route already requires authentication and country confirmation, so it is not an open/anonymous hole, but it bypasses the one explicit "not certified for production yet" control every sibling route enforces).
2. **The AU Investment import panel's success state left the user with no path forward.** "Apply" genuinely succeeds and the panel's own copy is honest that it lands in "Investment Intelligence," but nothing told the user that a *further*, separate action (reviewing and publishing the position) was needed before it would show up in the Investments tab, Net Worth, or Dashboard — the panel's `onApplied()` callback even refreshes a grid that will show no new rows. **Severity: P2** (confusing, not incorrect — no data was lost or duplicated, but a user could reasonably believe the import failed silently).

## 4. Implementation

- `app/api/financial-data-hub/retirement-statement/upload/route.ts`: added the identical `isFdhDocumentUploadEnabled()` gate, in the identical place, that every sibling upload route already uses.
- `components/investments/AuInvestmentStatementImportPanel.tsx`: the "applied" success state now explicitly says this is evidence, not yet a current holding value, and links directly to `/investment-intelligence/data` to complete the review-and-publish step. Investment Intelligence itself was not touched — this is a messaging/navigation fix in the AU import panel only.

## 5. What was explicitly NOT done, and why

- **Building a "publish" step directly into the AU import panel** was considered and rejected as out of scope for this phase: it would mean reaching into Investment Intelligence's own certified publish workflow (`investmentPublicationService.ts`, itself the product of a prior, terminal, unconditional-full-pass certification arc) from a different module, which is exactly the kind of cross-module coupling this codebase's isolation discipline exists to prevent. The honest-link fix addresses the real user-facing problem (a dead end with no explanation) without touching a module this phase has no mandate to modify.
- **CAMS/India import** was not changed — it correctly and deliberately reuses the same evidence-then-publish architecture as the AU path, and the LR-4 spec's own lock ("CAMS/India investment recovery must preserve current Investment taxonomy") is already satisfied structurally; the shared publish-detachment gap is the same one item 4's fix already addresses at its one common surfacing point.
- **No named-broker CSV adapters or PDF support were added** for AU investment statements — the spec's own lock says "Do not claim PDF/broker support unless a parser/adaptor is genuinely implemented and certified," and building new adapters was not this phase's mandate (WP-01's own instruction: prove what's already correct, don't add scope to appear productive).

## 6. Financial/Data Contract

Neither fix touches a financial calculation, a canonical write path's data shape, or any RLS policy. The gate fix is a pure availability control (blocks vs. allows a mutating call); the messaging fix is presentation-only.

## 7. Regression / Typecheck / Lint / Build

- `tsc --noEmit`: clean.
- ESLint: clean on both touched files.
- Targeted regression: `fdh12FinancialIntegrity.test.ts`, `fdh12Isolation.test.ts`, `fdh12PayslipReconciliation.test.ts`, `fdh1Isolation.test.ts` (124 tests, all referencing the touched route or module) — all pass.
- Full suite: 6,182/6,206 passing. One failing test (`aiResidualClosureFailClosed.test.ts`), confirmed pre-existing/unrelated across every test run this entire session.
- Production build: succeeds.

## 8. Live DEV / Production

Not independently live-verified this phase — both fixes are narrow, mechanically verified (the gate fix matches an already-live, already-certified sibling pattern byte-for-byte; the messaging fix is a static copy/link change with no new logic). No migration was required, so no DEV/production sequencing risk applies; safe to push directly once tests/build are green.

## 9. Deferred Findings

| Finding | Owner/Phase | Why not blocking |
|---|---|---|
| AU Investment / CAMS "Apply" landing in `ii_*` rather than `investments` directly | A future, explicitly-scoped cross-module phase (not LR-4) | Structural, not a regression — this is Investment Intelligence's own certified, deliberate architecture (evidence-then-publish). LR-4's mandate was to fix what its own import surfaces get wrong, not redesign a different, already-terminal module. |
| No named-broker AU CSV adapters, no PDF support | Future phase, if the Product Owner prioritises it | Explicitly out of scope per this phase's own locks |
| Zero-residue cleanup of synthetic test data | Immediate, before the shared LRTest DEV account is reused | Same disclosed, non-blocking gap as LR-2/LR-3 |

## 10. Next-Phase Readiness

**Yes, LR-5 may proceed.** No migration, no shared calculation engine, and no cross-phase dependency was introduced.

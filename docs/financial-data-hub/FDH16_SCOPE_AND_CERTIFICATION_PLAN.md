# FDH-16 — Scope and Certification Plan

## Mission

FDH-16 is the terminal Financial Data Hub integration certification. It does not add features. It proves the
complete chain — manual input / FDH ingestion → normalisation → classification → reconciliation → user review →
proposal → compare → explicit Apply → canonical FHIP financial model → calculations → Dashboard → Scores/DNA/
Resilience/Twin → Forecasting → Reports — is economically consistent, secure, jurisdiction-correct, and free of
duplicate canonical engines.

## Prior certified foundations (treated as established, not re-derived from scratch)

FDH-0 through FDH-12 (Financial Data Hub build-out), FDH-14 (Standalone FDH Certification, TERMINAL FULL PASS,
`99fe118`), FDH-15 (Bridge/Governance Certification, TERMINAL UNCONDITIONAL FULL PASS, `481d2ed`), Admin A0.2
Wave 2 (FULL PASS), Wave 0, Analyst Analytics Wave 1, Module 11.1/11.2, and Mandatory Country Confirmation — all
merged to `main` as of this branch's fork point (`6fdcf7e`).

## Rule 7 discipline: fresh vs reused, exactly labelled throughout

Every FDH16_*.md document and the final report distinguishes:
- **FRESH FDH-16**: newly executed this round, against current source, with a runnable script or command whose
  output is quoted or summarised with an honest pass count.
- **REUSED PRIOR CERTIFIED EVIDENCE**: a prior FDH-14/FDH-15/domain-module finding, spot-checked against current
  source where practical, cited by document/script name rather than re-derived.
- **NOT PERFORMED THIS ROUND**: explicitly disclosed as a residual, never silently omitted.

## What this round executed fresh (§247's own required-fresh list, honestly reconciled against what was
actually achievable in this pass)

| §247 item | Status this round |
|---|---|
| Full migration replay | **FRESH** — `node scripts/db-rebuild-check/replay.mjs`, 115/115, from empty, today's chain |
| Manual-vs-import equivalence | **FRESH** — new script, real authenticated-JWT RPCs, 33/33 PASS live DEV |
| Golden integrated household | **PARTIAL** — reuses FDH-14's 23/23 multi-domain oracle (service-role-seeded evidence, real Apply-function-shaped writes) + this round's own real-RPC Income/Liability/Retirement household; a single household spanning ALL domains via real RPCs in one continuous run (incl. AU Investment, which has no real bridge RPC reachable outside the running Next.js app) was NOT rebuilt fresh — same disclosed gap FDH-15 already carried forward |
| Cross-member security | **REUSED, DEV-confirmed** — FDH-15's `INC-6`/`RET-2` fixes (migrations `0119`/`0120`) independently re-verified live by FDH-15 itself the same week; this round's own scripts implicitly re-exercise the same RPCs cleanly (no member-mismatch triggered where none was intended) |
| Cross-tenant authoritative target | **FRESH** — this round's own 3-check sweep against its own new fixture (`XT16-1..3b`), plus reused FDH-15's 5-check sweep |
| Provenance control | **FRESH** (via this round's own script's provenance-difference assertions) + REUSED FDH-15 forgery-block proofs |
| Net Worth integration | **FRESH** — real `computeDashboard()` fed real live-DEV rows, 8/8 PASS |
| Cashflow integration | **FRESH** (income/expense reconciliation, same script) + REUSED FDH-14 transfer/funding/drawdown economic-type classification proofs |
| Dashboard integration | **FRESH at the calculation-engine level** (real function, real data) — **NOT fresh at the rendered-browser-pixel level**: this environment's browser-preview tool is bound to the Product Owner's own `D:/FHIP` working tree (confirmed via `preview_list`'s `cwd`), and this certification is barred from starting a dev server there. Disclosed as a residual, not silently substituted. |
| Representative downstream calculation | **FRESH** (Dashboard engine) + **source-verified FRESH** (grep-confirmed zero `fdh_*` references anywhere in `lib/engines/**` — Scores/DNA/Resilience/Twin/Goals/Forecast — and in `lib/services/reportSnapshotResolver.ts`) |
| 1000/1001 | **REUSED** — FDH-11/FDH-14 prior scale certifications; not re-run fresh this round (time-boxed; disclosed residual) |
| Hosted UI smoke | **REUSED** — FDH-14's Playwright-based 5-surface smoke; not re-run fresh this round for the same browser-tooling reason above |
| TypeScript | **FRESH** — `npx tsc --noEmit`, 0 errors |
| Build | **FRESH** — `npm run build`, PASS, full route manifest inspected |
| Main reconciliation | **FRESH** — `git fetch origin main` re-run twice this round; origin/main's tip (`6fdcf7e`) equals this branch's own fork point both times — no divergence, no reconciliation needed |
| DEV cleanup | **FRESH** — every synthetic script independently re-verifies 0 residue by re-query |

## Time-boxing decision (honestly disclosed up front, not discovered by the reader in section 22)

Given the enormous nominal scope of the source spec (255 sections) against one certification pass, this round
prioritised, per the dispatch's own instruction, "items marked must be fresh over ceremony-only re-runs of
unchanged evidence" (§246). Full hosted-browser walkthroughs of Reports/Forecasting/Scores/DNA/Resilience/Twin,
a fresh 5,000/10,000-row scale run, and live fault-injected concurrent-Apply/DB-failure tests were **not**
performed fresh this round. Each is carried forward explicitly in `FDH16_RESIDUAL_RISK_REGISTER.md`, not asserted
as passed.

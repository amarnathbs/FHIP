# FDH-16 — Report Integration Certification

## FRESH FDH-16 (source-level)

`lib/services/reportSnapshotResolver.ts` was read in full this round. Its data-gathering queries target only
canonical tables: `user_profiles`, `households`, `future_financial_commitments`, `goal_snapshots`, `investments`,
`insurance_policies`, `assets`, `liabilities`, `income_sources`, `expense_items`. **Zero `fdh_*` references** —
fresh, source-verified confirmation that current reports cannot read FDH staging evidence directly (satisfies
§106's "identify current reports that consume canonical financial data" and the substance of §111-113).

## Which reports currently exist (per current `main`, not assumed from historical redesign plans)

The build's route manifest (`npm run build`, this round) lists `/reports`, `/reports/[id]`, and
`/reports/[id]/print` as live, server-rendered routes. Per repository memory (Report Formatting Phase 2, Report
v3 Phase 3a), a Free-tier report and a Premium-tier report both exist on current `main`; the separately-planned
advisor-style Premium redesign is **not** implemented and was correctly not built during this round (§108
explicitly forbids doing so).

## Fix applied this round (same defect class as FDH16-DEF-001)

While reading `lib/services/reportSnapshotResolver.ts` in full for this certification, its Premium report data
loader was found to have the identical unpaginated-query pattern discovered in `dashboardData.ts`
(FDH16-DEF-001) on 6 queries (investments, insurance_policies, assets, liabilities, income_sources,
expense_items). Fixed in the same pass by reusing the same `fetchAllRows()` pagination helper (now exported from
`dashboardData.ts`) rather than writing a second bespoke implementation, per spec §244. See
`FDH16_RESIDUAL_RISK_REGISTER.md` for the full record, including the honest caveat that this specific fix was
not independently live-re-proven at the 1,001-row boundary the way the original Dashboard defect was (it was
fixed by pattern-matching once the first instance was found, not by reproducing a second live failure).

## Not performed fresh this round

- No live report was generated for either of this round's synthetic households and numerically diffed against
  the canonical oracle (§111 "report variance: $0"). This is a genuine gap — report generation was not exercised
  end-to-end this round (would require the same blocked dev-server/browser path noted in
  `FDH16_DASHBOARD_CERTIFICATION.md`, or a direct call into report-generation code with a synthetic user, which
  was not attempted this round given the time-box).
- CSV/PDF export numeric parity (§114) and currency-label correctness (§115) were not freshly re-checked.

## REUSED PRIOR CERTIFIED EVIDENCE

Report Formatting Phase 2 (page numbers/PDF export, justification, decimal removal) and Report v3 Phase 3a
(pillar-triggered recommendation content) both previously certified; no FDH-16 activity touched report
generation code.

## Verdict

**Report integration: PASS by architectural source-inspection only** (reports structurally cannot read FDH
staging evidence). **Live numeric report-vs-canonical reconciliation: NOT performed this round** — disclosed
residual.

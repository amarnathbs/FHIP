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

## CLOSED this targeted final-closure round (2026-09-01)

### Item 1 — direct 1,001-row boundary proof for the resolver itself

`scripts/fdh16_report_resolver_scale_certification.mjs`, live hosted DEV, **13/13 PASS**. This closes the gap the
original round's fix left open: `reportSnapshotResolver.ts`'s pagination fix had only been accepted by
source-inspection pattern-matching, never independently reproduced at the live 1,001-row boundary the way the
Dashboard fix was.

**Certification-hygiene correction (hygiene-closure round, 2026-09-01)**: the prior "12/13 PASS (transient
auth-admin-API eventual-consistency artifact, independently confirmed resolved)" framing above was itself
inaccurate — independent reproduction this round found the script's cleanup routine had a real, deterministic
defect (not a transient artefact): `main()` created the synthetic auth user, then ran later setup steps and the
`@/lib`-aliased dynamic import of `reportSnapshotResolver.ts` *before* entering its own `try/finally`, so any
failure there (most reliably the script's own documented `Run: node ...` invocation, which plain Node cannot
execute at all — `ERR_MODULE_NOT_FOUND` on that import) skipped cleanup entirely, leaving the synthetic auth user
genuinely orphaned. This was confined to the certification script, never `reportSnapshotResolver.ts` or any other
FDH-16 product code. The cleanup path was corrected (id captured before `try`, every delete step independently
guarded and status-checked, belt-and-braces `user_profiles`/`user_entitlements` deletes added), the full
certification rerun returned **13/13 PASS** on a clean, uncontended run, reproduced again after this round's
`origin/main` reconciliation merge, and independent post-run queries (outside the script itself) confirmed zero
synthetic residue. Full defect record: `FDH16_RESIDUAL_RISK_REGISTER.md`, "Certification-script hygiene defect".

- Created a synthetic premium-tier AU user with 1,000 then 1,001 `expense_items` rows via a real authenticated
  JWT.
- **Negative control (permanent platform-cap proof, reproduced again)**: a raw, unpaginated PostgREST request
  against this exact DEV project is silently capped at 1,000 of 1,001 rows (`content-range: 0-999/1001`).
- **Decisive proof**: the REAL, unmodified `resolveReportSourceData()` (imported and invoked directly — never a
  reimplementation, never a mock) was called with a service-role-backed client for this user at both 1,000 and
  1,001 rows. `premium.expenseItems.length` and the economic total (sum of `amount`) both correctly read `1000`
  then `1001` — no silent truncation.
- **Secondary register** (spec: "verify at least one other paginated register if easy"): the same boundary was
  also reproduced for `investments` -> `premium.investments` in the same run — 1,000 then 1,001, both correct.
- Cleanup: all synthetic rows and the auth user independently re-verified at 0 residual.

### Item 4 — live report numbers vs canonical DB, direct diff

`scripts/fdh16_downstream_parity_and_report_certification.mjs`'s report-parity section (`RPT-0` through `RPT-7`,
all PASS): generated a real Premium report for a synthetic AU household (via `resolveReportSourceData()`, the
same resolver fixed above) and diffed its numbers directly against independent ground-truth DB queries for
Income, Expenses, Liabilities, Retirement, and Net Worth. **Unexplained variance: $0** across every section
checked — both the report's raw premium row totals (`premium.incomeSources`/`expenseItems`/`liabilities`) and
its canonical dashboard-derived totals (`dashboard.grossMonthlyIncome`/`totalLiabilities`/`totalRetirement`/
`netWorth`) matched ground truth exactly. This closes both the "live report generated and numerically diffed"
requirement and confidence in the newly-paginated resolver at once, as intended.

A real end-to-end UI pass was also performed this round (see `FDH16_DASHBOARD_CERTIFICATION.md`'s "Hosted
browser UI smoke" section): a Premium report was generated via the actual `/reports` page's "Generate report"
button against this candidate's own dedicated dev server, and its returned figures (net worth $545,000, health
score 54, monthly surplus $3,200, etc.) matched the same synthetic household's Dashboard and DB state exactly.
One minor UX finding (not blocking, not a data-integrity issue): the Reports list page did not auto-refresh
after a successful generation — the new report was visible only after a manual page reload/navigation. Disclosed
in `FDH16_RESIDUAL_RISK_REGISTER.md` as a new P3 UX polish item.

## Not performed fresh this round

- CSV/PDF export numeric parity (§114) and currency-label correctness (§115) were not freshly re-checked.

## REUSED PRIOR CERTIFIED EVIDENCE

Report Formatting Phase 2 (page numbers/PDF export, justification, decimal removal) and Report v3 Phase 3a
(pillar-triggered recommendation content) both previously certified; no FDH-16 activity touched that code.

## Verdict

**Report integration: PASS.** Architectural source-inspection (reports structurally cannot read FDH staging
evidence) **plus** live numeric report-vs-canonical reconciliation (this closure round, $0 unexplained variance)
**plus** a direct 1,001-row boundary proof on the real, fixed resolver code path (this closure round, not
source-inspection). The only disclosed gap remaining is export-format (CSV/PDF) numeric parity, unchanged from
the original round.

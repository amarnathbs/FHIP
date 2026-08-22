# Phase 0B — Complete UX, Data-Confidence & Journey Audit

**Status:** Audit only. No application behaviour, calculation logic, database schema, or copy was changed as part of this document. Two prior-session copy fixes (removing internal "Module 10" build-phase language) are noted in §0 for context but are separate from this audit and were already reported/approved earlier.

**Scope covered in this pass:** deep code-level tracing of the Financial Health Score and Financial Resilience engines (exact, reproducible); a live, granular re-test of the score's data-completeness behaviour on a fresh account; a full route and component inventory; the missing-value/data-confidence/recommendation-eligibility audit; and a UX issue register with severity and founder-decision flags.

**Scope NOT completed in this pass** (see §9 Exit Gate for the honest breakdown): full live builds of the Family / Pre-Retirement / India / Cross-Border personas; a systematic 6-breakpoint responsive sweep; a formal WCAG 2.2 AA pass. These are real, bounded follow-up work, not skipped by oversight — each is scoped explicitly in §9 so a founder can decide whether Phase 1 needs to wait on them.

---

## §0. Executive Summary

**A. Is the application ready for UX redesign?**
**Conditional.** The visual/interaction layer (spacing, cards, nav, copy) is redesign-ready. But one mechanism — how the Financial Health Score and Financial Resilience score handle missing data — needs a founder decision before a redesign locks in a new presentation for it, because the current presentation (a plain 0-100 number + severity label, always shown, never suppressed) actively misrepresents "we don't know yet" as "this is bad." A redesign that just reskins the current gauge will carry the problem forward with better typography.

**B. Calculation/data-confidence issues that must be resolved first?**
None of the underlying *math* is wrong — every score calculation traced in this audit is internally consistent and, where re-derived by hand, matched the live output exactly (see §1). The issue is presentation, not arithmetic: there is no gate between "not enough data to score" and "scored and it's bad," and three different parts of the app compute three different confidence numbers with three different thresholds from overlapping inputs (§1.6, §3).

**C. Is the 89/100 result valid based on the available data?**
**Yes, in the narrow sense that the formula was applied correctly** — every input traced back to a real number the user entered. But "valid" undersells the real finding: 89/100 is a weighted average of only 6 of the model's 10 components (65% of total weight); the other 4 (Emergency Fund 12%, Investment 8%, Retirement 10%, Behaviour 5% — 35% of the model) were entirely absent from the calculation, not counted as zero, not counted as anything. The score doesn't say "89/100 based on 65% of your financial picture" — it says "89/100 — Excellent," full stop, at 6xl font size, in green. See §1 for the complete reproduction and reconciliation.

**D. Five biggest UX issues** (full detail and evidence in §7 UX Issue Register):
1. UX-001 — A brand-new account with zero data shows "0/100 — Critical" in red, indistinguishable in presentation from a genuinely troubled household.
2. UX-002 — The Financial Health Score gauge (dashboard and score page) has no state for "not enough data to score" — it is mathematically incapable of showing anything other than a number 0-100 and a severity band.
3. UX-003 — With zero expenses entered, the app computes Savings Behaviour as literally 100% (perfect score) because "no expenses recorded" silently becomes "$0 in expenses" inside the savings-rate formula, not "unknown expenses."
4. UX-004 — Three different, inconsistent confidence/completeness calculations exist across the app (Health Score's `dataConfidence`, Resilience's own `confidence`, and the Dashboard's `DataQualityPanel` tier), using different formulas and different thresholds on data that overlaps.
5. UX-005 — Onboarding/signup has no visual continuity with the marketing site or the authenticated app's own navy/teal identity (carried over from the earlier walkthrough, still open).

**E. Five strongest existing patterns to protect:**
1. Every score/DNA/resilience page explains *why* a number is what it is, component by component, in the reader's language, before showing a benchmark — this is the "explainable, not a black box" instinct the whole platform is built on, and it's genuinely well executed on the pages that have it (Score, DNA, the Free Report).
2. The Component Breakdown grid on `/score` already does the right thing for missing data — "Data missing — this component isn't counted yet" — component by component. The problem is scoped to the *headline number*, not this grid.
3. `report_content_library` / pillar-triggered recommendations give the reports genuine narrative variation instead of templated filler.
4. The `<70%` "provisional score" caveat on `/score` is a real, working mitigation — it's just not present on the Dashboard, where the same number is shown first and more prominently.
5. Cash-flow, savings, and net-worth scoring are grounded in real arithmetic on real user data with no hidden defaults — the trust problem is scoped to the *minority* of components (debt, insurance) that substitute an inferred default when data is absent, and to the *presentation* of the aggregate, not to the majority of the math.

**F. Five highest-priority actions before redesign** (see §8 Founder Decision Register for the actual decisions to make):
1. Decide FD-01/FD-02: does a score need a minimum data threshold before it's shown as a number at all, and should a "Not Yet Scored" state exist?
2. Decide FD-03: consolidate the three confidence calculations into one canonical definition, or explicitly justify why Health Score, Resilience, and the Dashboard's Data Quality panel need different ones.
3. Decide FD-04: should "no data entered" and "confirmed zero" require an explicit user action (a checkbox, a "I have no debts" confirmation) rather than being inferred from `hasEngaged` heuristics?
4. Decide whether the `<70%` provisional-score caveat should be promoted onto the Dashboard's score card, not just `/score`.
5. Complete the deferred persona/responsive/accessibility passes (§9) before finalizing new component designs for Score, Resilience, DNA, and the data-entry grids, since those are exactly the surfaces this audit found the open questions in.

---

## §1. P0 — Financial Health Score Eligibility & 89/100 Investigation

### 1.1 Reproduction

A fresh account (`phase0b.progression.test@example.com`, AU/AUD, single, 0 dependants, full-time employed, DOB 1990-05-15) was created and the Financial Health Score recorded on `/score` after each individual data-entry step, with no other data added at each step (per the instruction to isolate variables). All figures below are the actual live application output, not estimates.

| Step | Data available | Score | Rating | Data confidence |
|---|---|---:|---|---:|
| Registration (onboarding complete) | Profile/household only | **0** | Critical | **0%** |
| + Income (Employment Salary, $95,000 gross / $72,000 net p.a.) | Income only | **82** | Good | **20%** |
| + Expense (Rent, $2,200/mo, not marked "essential") | Income + expense | **90** | Excellent | **30%** |
| + Asset (Savings account, $25,000) — *from the earlier full walkthrough session, same account shape* | Income + expense + asset | **89** | Excellent | **60%** |

Two things are worth stating plainly:
- **The score is not monotonic with "more data."** It went 0 → 82 → 90 → 89. Adding the asset (real, positive information — $25,000 in savings, zero debt) *lowered* the number by one point, because the Net Worth component's raw score (85, penalised 15 points for 100% cash concentration) pulled the weighted average down slightly even as data confidence properly rose from 30% to 60%. A user watching this number over time has no way to know that a *drop* here reflects "more of your real financial picture became visible," not "your finances got worse."
- **Data confidence climbs correctly and communicates something true** — it is doing its job. The failure is that the headline score doesn't carry that context with it anywhere the user is likely to see first (§1.5).

### 1.2 Calculation trace: UI → API → engine → component → weighting → final score

```
/score, /dashboard (React Server Components)
  → loadHealthScore(userId)                          lib/services/healthScoreData.ts
      → loadDashboard(userId)                         lib/services/dashboardData.ts
          → 7 category tables (income, expenses, assets, liabilities,
            investments, retirement, insurance) + financial_snapshots
      → loadResilience(userId)                         lib/services/resilienceData.ts
          → computeResilience()                        lib/engines/resilience.ts
      → computeHealthScore()                           lib/engines/healthScore.ts
          → 10 × score<Component>() functions, each either:
              - returns a `missingComponent()` (treatment: 'missing_data'), or
              - returns a `notApplicableComponent()` (treatment: 'not_applicable',
                only reachable via the 3 user-set "not applicable to me" toggles
                added in migration 0029 — investments/retirement/insurance only), or
              - computes a real 0-100 rawScore from dashboard/resilience fields
          → reweight: overallScore = Σ(rawScore × weight) / Σ(weight of SCORED
            components only) — missing/not-applicable components are excluded
            from both numerator and denominator, not treated as 0
          → dataConfidence = (scored components) / (all components except
            'not_applicable') × 100
          → riskOverride: if persistent deficit + <N months emergency fund,
            score is capped regardless of the above
      → bandFor(roundedScore, scoreBands)               lib/engines/scoring.ts
          → 5 fixed bands: excellent≥85, good≥70, fair≥55, needs_attention≥40,
            critical≥0 — a literal 0 falls into the *same band* ("critical")
            as a household in genuine crisis; there is no separate band or
            code path for "insufficient data"
  → <HealthScoreGauge score statusLabel statusBand />   components/score/HealthScoreGauge.tsx
      → pure presentational: renders Math.round(score) at 6xl font size,
        colored by statusBand, with a progress bar to `score`%. Has zero
        knowledge of dataConfidence, sample size, or component count. There is
        no branch in this component (or anywhere else in the codebase) that
        renders anything other than a number 0-100 + a severity label.
```

### 1.3 Component dependency matrix (Financial Health Score, `lib/engines/healthScore.ts`)

Base weights are from the seed config in `supabase/migrations/0006_module4_health_score.sql`; every household's actual weighting is re-normalised at scoring time to only the components that have data (§1.2).

| Component | Base weight | Required data | Missing-data behaviour | Confirmed-zero behaviour | Reweighted if missing? |
|---|---:|---|---|---|---|
| Cash Flow Health | 15% | Income **and** expenses | `missing_data` — excluded | n/a | Yes |
| Savings Behaviour | 12% | Income | `missing_data` — excluded | n/a (see UX-003: zero expenses ≠ missing, it silently becomes a 100% savings rate) | Yes |
| Emergency Fund & Liquidity | 12% | Expenses, **and** at least one expense marked "essential" | `missing_data` — excluded (explicitly guards the essential=0 case so it isn't misread as a confirmed-zero) | n/a | Yes |
| Debt Health | 15% | — | If no liabilities **and** user has engaged with income+expenses+(assets\|liabilities\|investments): scored **100** ("no debt-servicing burden") — an *inferred* confirmed-zero, never explicitly confirmed by the user. If not engaged: `missing_data`. | Inferred, not explicit | Yes |
| Net Worth & Asset Position | 10% | Assets **or** liabilities | `missing_data` — excluded | n/a | Yes |
| Investment Health | 8% | Investments (unless user has ticked "not applicable to me") | `missing_data` — excluded, with the explanation itself acknowledging the ambiguity: *"...or this may genuinely be zero if you invest only through super."* | Requires explicit user opt-out via `notApplicable.investments` | Yes |
| Retirement Readiness | 10% | Retirement accounts (unless opted out) | `missing_data` — excluded | Requires explicit opt-out | Yes |
| Insurance & Protection | 8% | — (unless opted out) | If no insurance **and** engaged **and** 0 dependants: scored **60**, fixed, regardless of income, assets, or actual risk exposure. Otherwise `missing_data`. | Inferred fixed default, not explicit | Yes |
| Financial Resilience | 5% | Resilience sub-engine must have ≥1 scored component | Uses Resilience's *own* independently-reweighted overall score (see §1.4) | n/a | Yes |
| Financial Management Behaviour | 5% | At least one check-in field touched (`health_check_ins` table) | `missing_data` — excluded | n/a | Yes |

**Two components can materially inflate the score with an inferred default rather than a real measurement**: Debt Health (100, inferred) and Insurance & Protection (60, fixed). In the 89/100 reproduction, Debt Health's inferred 100 alone contributed roughly 23 of the 89 points (15/65 reweighted share × 100). Neither is *wrong* as a heuristic — most people with no liabilities on file genuinely have none — but neither is confirmed, and the score presents them with the same visual weight as a genuinely calculated result.

### 1.4 The Financial Resilience sub-score uses the identical mechanism

`lib/engines/resilience.ts`'s `computeResilience()` is architecturally a smaller copy of `computeHealthScore()`: 6 weighted components (Emergency Fund Adequacy 25%, Liquidity 15%, Income Resilience 15%, Insurance & Protection 20%, Debt & Commitment Pressure 15%, Concentration & Exposure Risk 10%), the same reweight-on-missing logic, and the same two "confirmed zero without explicit confirmation" patterns (Debt Pressure → 100 if no liabilities and engaged; Insurance & Protection → 55 fixed if no insurance, 0 dependants, and engaged). This score feeds into Health Score's 9th component *and* is displayed independently on `/resilience` and the Dashboard's "Risks & Protection" section — so the same missing-data ambiguity is visible to the user in two more places under two more numbers.

### 1.5 Where the score is — and isn't — communicated as provisional

This is the crux of the finding, and it's precise:

- **On `/score`:** `payload.dataConfidence < 70` renders a genuine caveat box: *"This score is provisional because important financial information is missing. Complete more of your data... for a more reliable result."* Verified live at 0%, 20%, and 30% confidence — the caveat appeared every time. This is a real, working piece of UX.
- **On `/dashboard`:** The identical `<HealthScoreGauge>` component is rendered at the very top of the page (`app/(app)/dashboard/page.tsx:80`) with **no `dataConfidence` prop passed and no caveat rendered anywhere near it.** The only related information — `<DataQualityPanel>` — is placed as the *second-to-last section on the page* (line 136 of 140), after Trends, Plans, and Risks & Protection. A user has to scroll past the entire dashboard to reach any indication that the number they saw first is low-confidence.
- This means: **the single most alarming presentation of this score (0/100, red, first thing on the page, no caveat) is also the one place in the app where the mitigating context is absent.** A user who only ever looks at the Dashboard — plausibly the majority of users, most of the time — never sees the "provisional" language at all.

### 1.6 Three different, inconsistent "confidence" calculations

| Where | Field | Formula | Thresholds used |
|---|---|---|---|
| `/score` | `healthScore.dataConfidence` | (scored components) / (all components except opted-out) × 100 | `<70%` → shows "provisional" caveat |
| `/resilience`, Dashboard resilience gauge | `resilience.confidence` | Weighted blend of 7 factors (income/expense/liquid-asset/liability/insurance completeness, **data recency**, **verification history** — the last two have no equivalent in Health Score's formula at all) | No caveat rendered from this value in any file found in this audit |
| Dashboard, `DataQualityPanel` (bottom of page) | `confidenceTier` | Same input as Health Score's `dataConfidence`, but re-bucketed: `≥80` high / `≥50` medium / `<50` low | Displayed as a plain label + per-category Complete/Stale/Missing chips |

A household sitting at exactly 75% confidence would, in the same session: see **no caveat** on `/score` (75 ≥ 70), but be labelled **"medium" confidence** (not "high") at the bottom of the Dashboard. Three genuinely different pieces of logic, doing conceptually the same job, disagreeing with each other on the same underlying number. This isn't a bug in the sense of producing a wrong output — each formula is internally consistent — but it's a real product-coherence gap: there is no single canonical answer to "how much do we actually know about this household's finances," and a redesign that tries to show one confidence indicator per page will need to pick (or unify) one of these three.

### 1.7 Root cause, impact, severity, recommendation

- **Root cause:** The scoring architecture (both engines) was deliberately built to *never* let missing data drag the score down (a defensible design goal — punishing users for incomplete data would be worse) by excluding missing components from the weighted average entirely. But this was implemented with no corresponding gate on *whether to display a number at all*, and no unified signal threaded through to every place the number appears.
- **Impact:** A first-time user's very first substantive interaction with the product's core value proposition (a financial health verdict) can be either a false-alarm "Critical" or an overconfident "Excellent" built on 6 of 10 components, depending on the order they happen to enter data — and the app cannot currently distinguish these from a genuinely-computed, well-supported score in its primary presentation.
- **Severity: P0.** This directly matches the P0 definition in the audit brief ("user could make a materially wrong financial conclusion" / "incorrect interpretation of missing data") for the Dashboard case, and P1 for the fact that three inconsistent confidence definitions coexist.
- **Recommended resolution (not implemented — requires founder sign-off, see FD-01/FD-02/FD-03):** Introduce an explicit score-eligibility gate (e.g., require `dataConfidence` above some threshold, or require specific "reviewed" sections, before rendering a numeric score at all — see §8 FD-01), add a "Not Yet Scored" / "Preliminary Score" intermediate state (FD-02), and thread one canonical confidence value through Dashboard, Score, and Resilience with consistent thresholds and messaging (FD-03). None of this requires changing the underlying `computeHealthScore`/`computeResilience` math — only what wraps around calling it and how the result is presented.

---

## §2. Missing-Value Semantics — Zero vs. Unknown, by Category

Traced directly from `lib/engines/dashboard.ts`, `healthScore.ts`, and `resilience.ts` (not inferred).

| Category | "No rows entered" is read as | Evidence |
|---|---|---|
| **Liabilities** | *Ambiguous by design, resolved via `hasEngaged()` heuristic*: if the user has entered income + expenses + (assets\|liabilities\|investments), zero liability rows is read as **confirmed zero debt** (scored 100/100 for both Health Score's Debt Health and Resilience's Debt Pressure). If not yet "engaged," it's read as **unknown** (`missing_data`). | `healthScore.ts:314-333`, `resilience.ts:362-384` |
| **Insurance** | Same heuristic, narrower condition: confirmed-zero-equivalent (fixed score, not derived from any real cover data) only if engaged **and** 0 dependants. Otherwise unknown. | `healthScore.ts:511-528`, `resilience.ts:299-321` |
| **Expenses (as a category)** | Unknown (`missing_data`) for every component that directly needs expenses (Cash Flow, Emergency Fund, Liquidity). | `healthScore.ts:148,268` |
| **Expenses (indirectly, inside Savings Behaviour)** | **Silently treated as $0**, not unknown. `cashSavingsRate = max(monthlySurplus, 0) / income` — with zero expense rows, `monthlySurplus` equals the full income, producing a 100% savings rate and a perfect Savings Behaviour score. Live-verified: Checkpoint 2 above (income only, zero expenses) scored Savings Behaviour = 100. | `healthScore.ts:199-209`; live reproduction §1.1 |
| **Investments** | Unknown, *unless* the user explicitly ticks "not applicable to me" (migration 0029) — the only category in Health Score with a genuine explicit-confirmation mechanism rather than an inferred one. | `healthScore.ts:410-414` |
| **Retirement** | Same as Investments — explicit opt-out available and is the only way to reach `not_applicable`. | `healthScore.ts:445-449` |
| **Assets (as a category)** | Unknown for Net Worth and Concentration Risk; the essential-expense flag (see below) also depends on assets being liquid, so an unmarked asset can leave Emergency Fund unknown even with assets on file. | `healthScore.ts:373`, `resilience.ts:447` |
| **"Essential" expense flag** | A distinct, separate unknown: even with real expense rows entered, Emergency Fund & Liquidity stays `missing_data` until **at least one expense is explicitly marked essential** — the code comment is explicit about *why*: "essentialMonthlyExpenses is 0 — nothing has been marked essential yet... that's missing data, not a confirmed zero." This is the *correct* pattern (explicit user action distinguishes zero from unknown) and should be the template for Debt/Insurance's inferred defaults above. | `healthScore.ts:271-280` |
| **Goal data** | Not part of Health Score or Resilience at all — goals only affect the Recommendations engine's `goal` category-variance signal, and only once a forecast baseline exists (§3). | `recommendationsData.ts:35-59` |

**Summary distinction the codebase actually makes, in its own terms:** `treatment: 'scored' | 'not_applicable' | 'missing_data'` — three states, cleanly modelled at the type level. The gap is that `'missing_data'` covers two things a user experiences very differently (*"I haven't gotten to this yet"* vs. *"the app decided this is close enough to zero that I don't need to be asked"*), and for Debt/Insurance specifically, the app has already silently resolved that ambiguity in the user's favour without telling them it did so.

---

## §3. Score & Recommendation Eligibility — Does a Minimum-Data Gate Exist?

**No.** There is no code path in `computeHealthScore()`, `computeResilience()`, `/score`, or `/dashboard` that withholds a numeric score based on how little data exists. The `overallScore` calculation is defined for `scoredWeightTotal = 0` (all 10 components missing) as a guarded no-op — the loop simply never adds to `overallScore`, leaving it at its initial value of `0` — which is exactly what renders as "0/100 — Critical" (§1.1, Checkpoint 1). This is not a special "no data" code path; it is the *general* formula falling through to its identity element.

**Priority Actions / Recommendations eligibility** (`lib/services/recommendationsData.ts`) is a genuinely separate, narrower system:
- Category-level recommendations (net worth, retirement, goal, debt, cross-border, investment) require a **forecast baseline with an elapsed comparison period** to exist (`toLibraryStatus()` returns `null`, and the signal is skipped entirely, for both `insufficient_data` and `baseline_established` statuses — i.e., a brand-new forecast run produces *zero* recommendation signals in this category, indistinguishable in the UI from "we checked and everything's fine").
- Pillar-level recommendations (tied to each Health Score component's band) only fire for components with `treatment === 'scored'` — so a household with 4 of 10 components missing automatically has 4 fewer possible sources of a priority action, again with no signal to the user that the absence is about data, not performance.
- The Dashboard's literal empty-state copy — *"No priority actions right now — check back after your next data update"* — is accurate in the narrowest sense (no matches exist in the `recommendation_matches` table) but conflates at least three distinct real states the audit brief calls out explicitly: genuinely-evaluated-and-fine, no-forecast-baseline-yet, and pillar-not-scored-yet. A returning user with a mature forecast history and a first-time user with none see the identical sentence.

**Recommended framework (not implemented, needs FD-01/FD-02 sign-off):** gate the *numeric* score behind a minimum-review threshold — the audit brief's suggested framing ("has the user reviewed the section and confirmed the information relevant to them" rather than "are all fields populated") maps cleanly onto states the codebase already half-models: a section is either genuinely reviewed (real data, or an explicit not-applicable/no-debts confirmation) or not. The infrastructure for the explicit-confirmation half already exists for Investments/Retirement/Insurance (`notApplicable` flags, migration 0029) — extending the same explicit-confirmation pattern to Liabilities and Insurance's currently-inferred zero-states would close most of §2's ambiguity without touching any scoring math.

---

## §4. Route Inventory

43 user-facing routes under the Next.js App Router. Rather than repeat the full per-route dependency/state table the brief specifies (data dependency, empty/partial/loading/error state, etc. — that level of detail for 43 routes would roughly double this document's length for marginal signal), routes are grouped by area with the specific gaps found during this audit called out. Every route below was confirmed to exist by direct filesystem enumeration, not assumed.

| Area | Routes | Notes |
|---|---|---|
| Marketing (public) | `/`, `/contact`, `/privacy`, `/terms` | No phone/address/email shown on Contact per prior instruction (verified in the earlier walkthrough) |
| Auth | `/login`, `/signup`, `/forgot-password`, `/reset-password` | Google/LinkedIn OAuth + email/password on both login and signup |
| Onboarding | `/onboarding` (5-step wizard: Profile → Household → Countries & Currency → Goals → Review) | No branding continuity with marketing site (open finding, prior walkthrough) |
| Core data entry | `/income`, `/expenses`, `/assets`, `/liabilities`, `/investments`, `/insurance`, `/retirement` | All share the `FinancialDataGrid` component (§5); `/retirement` is a deliberate second tab alongside `/investments` inside `InvestmentsSubNav.tsx`, not a duplicate — confirmed by direct inspection, not left ambiguous |
| Dashboard & scoring | `/dashboard`, `/score`, `/dna`, `/resilience` | Subject of §1-§3 |
| Twin/Benchmark | `/financial-twin`, `/financial-twin/[id]`, `/financial-twin/history` | Not deeply re-audited this pass — flagged for the deferred persona work (§9) |
| Goals | `/goals`, `/goals/new`, `/goals/[id]` | Not deeply re-audited this pass |
| Forecasting | `/forecast`, `/forecast/{assumptions,cross-border,debt,goals,history,investments,net-worth,report,resilience,retirement,scenarios,variance}` — **12 routes** | Largest single area by route count; not deeply re-audited this pass beyond confirming existence — recommend this be the focus of a dedicated follow-up given its size |
| Reports | `/reports`, `/reports/[id]`, print variants `/forecast/report/print`, `/reports/[id]/print` | Report generation live-verified working in the prior walkthrough (89/100-scoring account, real PDF-quality cover page) |
| Recommendations | `/recommendations` | — |
| Admin (gated) | `/admin/benchmarks`, `/admin/recommendations` | Not customer-facing; not audited here |

**Sign-out** is reachable from the sidebar nav (confirmed in the prior walkthrough) with a confirmation dialog (`ConfirmDialog.tsx`, per the P0-6 fix already shipped) — easy to find, not an issue.

---

## §5. Component Inventory

67 component files. Grouped by function, with the specific duplication/standardisation candidates the brief asks for called out explicitly (not asserted generically).

**Genuinely shared/reusable** (used across many pages by design): `SectionCard`, `MetricCard`, `AppShell`, `ConfirmDialog`, `SelectWithOther`, `FinancialDataGrid` (all 7 data-entry categories run through this one grid component — a real, working DRY pattern), `LockedFeatureCard` (every "coming soon" placeholder across Dashboard/Score/Resilience/DNA/Goals).

**Structurally parallel but separately implemented** — the brief's "similar components implemented differently" category, found by direct comparison, not assumption:
- `score/HealthScoreGauge.tsx` and `resilience/ResilienceGauge.tsx` — two gauges rendering the identical visual pattern (big number, band-colored, progress bar) for two conceptually parallel scores, as two separate files rather than one parametrised component. Any redesign of "how a score gauge looks" has to be made twice today.
- `score/ComponentGrid.tsx` and `resilience/ComponentGrid.tsx` — same name, same job (render a weighted-component breakdown list), two implementations. This is the single clearest standardisation candidate found in this audit: both engines already emit the same shape (`code, label, rawScore, weight, treatment, explanation, dataCompleteness`), so one generic `<ScoreComponentGrid components={...} />` could plausibly serve both today without a data-model change.
- `dashboard/sections.tsx`, `dna/sections.tsx` — both named `sections.tsx`, both export multiple section components per file (a file-organisation pattern worth standardising, not a functional duplication).

**Per-domain, not obviously reusable elsewhere:** the 12 `forecast/*` components, 11 `goals/*` components, 8 `resilience/*` components (beyond the gauge/grid above), and the 3 `reports/*` report-rendering components are each domain-specific enough that consolidation isn't an obvious win — flagged only for completeness, not as findings.

---

## §6. Copy & Terminology — Internal Language Leaking to Users

This was substantially covered by the fixes already shipped in the immediately-preceding session (four instances of literal "Module 10 (AI Coach)" / "Module 11 (Settings)" text, and three instances of the internal engineering note "Kept as a placeholder for a fast-follow so it isn't forgotten," all found and corrected). A repeat sweep in this audit for the same pattern class found **no further instances** — `grep` for `Module \d+ \(` across `app/` and `components/` returns zero matches post-fix.

**Financial jargon** is, on the pages inspected in this and the prior audit (Score, DNA, Resilience, Free Report), consistently paired with a plain-language explanation before or alongside the technical term — e.g. Resilience's "Debt & Commitment Pressure" component explanation reads in plain English ("Debt repayments are X% of net income") with the underlying ratio named only in the benchmark metadata, not the headline copy. This matches the brief's recommended pattern (plain label, technical term in the explanation) and appears to already be the house style rather than something needing to be retrofitted.

---

## §7. UX Issue Register

| ID | Area | Finding | Evidence | Category | Severity | User Impact | Recommended Direction | Founder Decision? |
|---|---|---|---|---|---|---|---|---|
| UX-001 | Dashboard, Score | Zero-data account shows "0/100 — Critical" in red, first thing on the page, indistinguishable from genuine financial distress | Live-reproduced §1.1; `bandFor()` has no "insufficient data" band, `scoring.ts` | Calculation / UX | **P0** | New user's first impression is an alarming, inaccurate verdict | Add a distinct "Not Yet Scored" presentation gated on data-completeness | **Yes — FD-01, FD-02** |
| UX-002 | Dashboard | The score's `<70%` "provisional" caveat exists on `/score` but is never passed to or rendered on the Dashboard's identical gauge | `dashboard/page.tsx:80` vs `score/page.tsx:64-70` | UX | P0 | Most users' primary view of the score carries none of its own caveat | Pass `dataConfidence` into the Dashboard gauge, or link the caveat there too | No — mechanical fix |
| UX-003 | Savings Behaviour scoring | Zero expenses entered is silently treated as \$0 expenses (not "unknown"), producing an inflated 100/100 Savings Behaviour score | Live-reproduced §1.1 Checkpoint 2; `healthScore.ts:199` | Calculation / Data Quality | P1 | Score component can read as excellent purely because a whole category hasn't been touched yet | Guard on `hasExpenses` the same way Cash Flow already does | **Yes — relates to FD-04** |
| UX-004 | Health Score, Resilience, Dashboard | Three separate confidence/completeness calculations (different formulas, different thresholds: 70% / 80-50% / resilience's own 7-factor blend) exist for what a user experiences as one concept | §1.6, code citations therein | Architecture / Data Quality | P1 | A household can be "confident enough" on one page and "medium confidence" on another simultaneously | Consolidate to one canonical confidence definition, or explicitly scope why each differs | **Yes — FD-03** |
| UX-005 | Debt Health, Debt Pressure | Zero liabilities + "engaged" is scored as a confirmed 100/100 debt score without the user ever explicitly confirming they have no debts | `healthScore.ts:314-333`, `resilience.ts:362-384` | Calculation / Data Quality | P1 | A real inferred assumption is presented with the same confidence as a directly-entered fact | Extend the existing explicit "not applicable to me" pattern (already built for Investments/Retirement/Insurance) to Liabilities | **Yes — FD-04** |
| UX-006 | Insurance & Protection (both engines) | Zero insurance + 0 dependants + "engaged" scores a fixed 60 (Health Score) or 55 (Resilience) regardless of income, assets, or actual need | `healthScore.ts:511-528`, `resilience.ts:299-321` | Calculation / Data Quality | P2 | A fabricated-feeling number where "unknown" would be more honest | Same explicit-confirmation extension as UX-005 | Yes — FD-04 |
| UX-007 | Priority Actions panel | "No priority actions right now" is shown identically whether the engine found nothing wrong, has no forecast baseline yet, or has unscored pillars | `recommendationsData.ts:65-72,166`; live-observed copy | Recommendation Logic / Copy | P2 | User can't tell "you're fine" from "we can't tell yet" | Differentiate the three states in copy | No — copy-only |
| UX-008 | `/score`, `/resilience` component grids | Two structurally-identical `ComponentGrid` components exist as separate files | §5 | Architecture | P3 | No user-facing impact; developer/maintenance cost only | Consolidate to one generic component | No |
| UX-009 | Onboarding | No visual brand continuity with marketing site or authenticated app (carried forward from the prior walkthrough, still unresolved) | Prior session finding, re-confirmed not yet fixed | UX / Commercial trust | P1 | First-minutes "did I land on the right site?" moment | Design-system pass across onboarding screens | No — already flagged, scoped as design work |

---

## §8. Founder Decision Register

| ID | Question | Why it matters | Options | Claude's recommendation | Founder Decision |
|---|---|---|---|---|---|
| FD-01 | Should there be a minimum data-completeness threshold before the Financial Health Score is shown as a number at all? | Directly resolves UX-001/UX-002 — the single biggest first-impression risk found in this audit | (a) No gate, keep current behaviour; (b) Gate below a `dataConfidence` threshold (e.g. <30%) with a "Not Yet Scored" state instead of a number; (c) Gate on specific sections being reviewed (income+expenses minimum) rather than a raw percentage | (b) or (c) — the raw-percentage gate (b) is simpler to implement against the existing `dataConfidence` field; the section-based gate (c) matches the audit brief's own preferred framing ("reviewed," not "populated") more closely but requires defining "reviewed" per section first (see FD-04) | _____ |
| FD-02 | If a gate exists, should there be an intermediate "Preliminary Score" state between "Not Yet Scored" and a full score? | Affects how much of the current always-show-a-number behaviour is preserved vs. replaced | (a) Binary: Not Yet Scored / Full Score; (b) Three states: Not Yet Scored / Preliminary / Full, with Preliminary showing the number but visually distinct from Full (e.g. dashed gauge, different color treatment) | (b) — the current numbers (82, 90, 89 in the reproduction) aren't *wrong*, they're just unqualified; a visually-distinct "preliminary" treatment preserves the motivating-feedback-loop value of an early number without presenting it as final | _____ |
| FD-03 | Should Health Score's `dataConfidence`, Resilience's `confidence`, and the Dashboard's `DataQualityPanel` tier be unified into one canonical confidence calculation? | Directly resolves UX-004 | (a) Unify to one formula, used everywhere; (b) Keep three, but align their thresholds so the same household never reads as "confident" on one page and "not confident" on another; (c) Keep three, explicitly documented as measuring genuinely different things (e.g. resilience's recency/verification-history factors may be intentionally distinct) | (a) if the three formulas' extra factors (resilience's recency/verification-history) aren't load-bearing for a founder's actual product intent; (b) as a lower-effort interim step otherwise | _____ |
| FD-04 | Should "confirmed zero" (no debts, no insurance) require an explicit user confirmation, the way Investments/Retirement/Insurance's opt-out already does, rather than being inferred from the `hasEngaged()` heuristic? | Directly resolves UX-003, UX-005, UX-006 — the clearest, most mechanical fix available, since the explicit-confirmation pattern already exists and works for 3 of 10 components | (a) Extend explicit opt-out to Liabilities (and keep Insurance's existing partial heuristic); (b) Extend to Liabilities and Insurance both; (c) No change, keep inferring | (b) — the pattern is proven, low-risk, and directly converts an inferred assumption into a confirmed fact the score can trust at full weight | _____ |
| FD-05 | Should the Dashboard's score-card treatment (currently `dataConfidence`-blind) be updated to carry the same `<70%` caveat `/score` already has? | Smallest, lowest-risk fix in this register — could ship independent of FD-01-04 | (a) Pass the caveat through now, independent of the bigger gating decision; (b) Wait and bundle with whatever FD-01/02 decide | (a) — this requires no new state, no new design, just wiring an existing prop through; worth doing regardless of the bigger decisions | _____ |

---

## §9. Phase 0B Exit Gate

| Condition | Status | Notes |
|---|---|---|
| Score eligibility understood | **PASS** | §1, §3 — fully traced end-to-end, live-reproduced, exact numeric reconciliation on 3 of 4 checkpoints |
| Missing-value treatment understood | **PASS** | §2 — every category's behaviour traced to specific code, not inferred |
| Recommendation eligibility understood | **PASS** | §3 — traced to `recommendationsData.ts`; the category-vs-pillar split and the forecast-baseline dependency are both documented |
| Route inventory complete | **PASS** | §4 — all 43 routes enumerated by direct filesystem listing |
| Component inventory complete | **PASS** | §5 — all 67 components enumerated; genuine duplication (not assumed) identified |
| First-time journey mapped | **PASS** | Landing → Signup → Onboarding → Dashboard fully walked in the prior session; this session added the granular per-field score progression on top of it |
| Returning-user journey mapped | **NOT DONE** | Requires a second login session with elapsed time/changed data to observe "what changed since last visit" — not attempted this pass |
| AU persona reviewed | **PASS (Young Single only)** | Both this session's and the prior session's test accounts are AU/AUD/single/no-dependants — matches Persona 1 exactly. Personas 2 (Family) and 3 (Pre-Retirement) were **not** built |
| India persona reviewed | **NOT DONE** | Confirmed India exists as a selectable country/currency option in onboarding (`AU`/`IN`, `AUD`/`INR`) and that FX/cross-border infrastructure exists in the codebase (`fx.ts`, currency-aware dashboard aggregation, per-country benchmark library — established in prior work, not re-verified live this session), but no live India household was built or walked through this audit |
| Cross-border persona reviewed | **NOT DONE** | Same as above — infrastructure confirmed to exist, not live-tested this pass |
| Mobile reviewed | **PARTIAL** | All live testing this session and the prior session was done at a ~476-480px mobile-card viewport (the grid components' mobile card layout, confirmed in the prior walkthrough); no systematic 375/390/430px comparison was run |
| Tablet reviewed | **NOT DONE** | |
| Desktop reviewed | **PARTIAL** | A 1280×800 desktop check was run in the prior session; one apparent layout issue was investigated and found to be a rendering artifact of the testing tool, not a real bug (documented, not a false claim) |
| Accessibility baseline reviewed | **NOT DONE** | No formal keyboard-navigation, screen-reader, or contrast pass was run this audit cycle |
| Forecasting reviewed | **NOT DONE** | 12 routes confirmed to exist (§4); no UX walkthrough of any of them was performed this pass — flagged as the largest single area of unaudited surface |
| Reports reviewed | **PASS (Free tier)** | Free Report generation and cover page live-verified in the prior session on a real scored account; Premium Report was previously audited in an earlier session (per project memory) but not re-verified this pass |
| Premium journey reviewed | **NOT DONE** | Free/Premium feature-gating and upsell messaging were not specifically re-audited this pass |
| P0 issues identified | **PASS** | UX-001, UX-002 (§7) |
| P1 issues identified | **PASS** | UX-003, UX-004, UX-005, UX-009 (§7) |
| Founder decisions documented | **PASS** | §8, 6 decisions, all currently blank pending founder input |

**Overall: NEEDS FOUNDER DECISION, not a clean PASS.** The core mechanism this audit was commissioned to investigate (score eligibility, missing-value semantics, the 89/100 question) is now fully understood and documented with reproducible evidence — that work is genuinely done. What remains before a *complete* Phase 0B sign-off is the persona/device/accessibility/forecasting breadth the brief also asked for, none of which is blocked by anything found in the P0 investigation. Recommend: (1) resolve FD-01 through FD-06 now, since none require the deferred work to answer; (2) schedule a follow-up pass specifically for Forecasting (12 unaudited routes), the 3 remaining personas, and the responsive/accessibility sweep before Phase 1 locks in new designs for the Score/Resilience/DNA surfaces specifically, since those are exactly where this audit found open questions.

---

*Do not proceed to Phase 1 until this document has been reviewed and §8's decisions recorded.*

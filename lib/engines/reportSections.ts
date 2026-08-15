import type { ReportSourceData } from '@/lib/services/reportSnapshotResolver';
import { computeSectionEligibility, type SectionCode, type FreeSectionCode, type SectionStatus, type EligibilityInput } from './reportEligibility';
import { computeMetricMovement, scoreMovementNarrative, overallocationNarrative, firstReportMessage } from './reportNarrative';
import { generateGoalInsights } from './goalInsights';
import { computeKeyInsights } from './reportInsights';
import { formatMoneyWhole } from './money';
import { buildPremiumSections } from './reportSectionsPremium';
import type { FinancialSection } from './financialSectionStatus';

export interface BuiltSection {
  sectionCode: SectionCode;
  sectionTitle: string;
  displayOrder: number;
  sectionStatus: SectionStatus;
  sectionData: Record<string, unknown>;
  narrativeText: string | null;
  chartData: Record<string, unknown> | null;
  sourceReferences: Record<string, unknown>;
  confidenceLevel: string | null;
  limitationText: string | null;
}

const SECTION_TITLES: Record<FreeSectionCode, string> = {
  executive_summary: 'Executive Financial Summary',
  cash_flow: 'Household Financial Position',
  net_worth: 'Net Worth and Balance Sheet',
  health_score: 'Financial Health Score™',
  financial_dna: 'Financial DNA™',
  resilience: 'Financial Resilience and Risks',
  goals: 'Goals',
  commitments_timeline: 'Upcoming Commitments (Next 90 Days)',
  forecast: 'Goal Forecast Summary',
  financial_twin: 'Financial Twin Comparison',
  cross_border: 'Cross-Border Wealth',
  actions: 'Recommended Areas to Review',
  data_quality: 'Data Quality and Completeness',
  methodology: 'Assumptions, Methodology and Disclaimer',
};

// Fixed, generic "what it measures" definitions for the Financial Health
// Score pillars (Page 5, spec section "For every pillar, display... What it
// measures") — the same wording for every household, distinct from the
// household-specific "meaning" sentence the score engine already computes.
const PILLAR_WHAT_IT_MEASURES: Record<string, string> = {
  cash_flow: 'This pillar assesses whether current income is sufficient to meet recorded expenses and commitments while leaving a sustainable surplus.',
  savings: 'This pillar assesses how much of your income is being retained through cash savings, investment contributions and retirement contributions combined.',
  emergency_fund: 'This pillar assesses whether readily available cash could cover essential household expenses for a reasonable period if income stopped.',
  debt: 'This pillar assesses how much of your net income is required to meet scheduled debt repayments.',
  net_worth: 'This pillar assesses your net worth relative to your total assets, and how concentrated your wealth is in a single holding.',
  investment: 'This pillar assesses the diversification and contribution activity of your recorded investment holdings.',
  retirement: 'This pillar assesses whether your recorded retirement balance is broadly aligned with a reference multiple of income for your age.',
  insurance: 'This pillar assesses whether recorded insurance cover appears broadly adequate given your household circumstances.',
  resilience: 'This pillar reflects your overall Financial Resilience score, covering your capacity to withstand unexpected financial pressure.',
  behaviour: 'This pillar assesses recent financial management activity, such as reviewing goals, debts, insurance and budgets.',
};

// A pillar's "area to review" should only appear when the pillar itself is
// actually a concern — not merely because a recommendation record exists for
// it (the score/resilience engines can generate a recommendation for a
// component that's already scoring well, e.g. suggesting periodic review).
// Mirrors ReportV2Charts.tsx's statusFromBand groupings, kept as a small
// local copy rather than importing from a 'use client' component file into
// this server-side engine module.
function isConcernBand(band: string): boolean {
  return ['fair', 'needs_attention', 'critical', 'moderately_vulnerable', 'vulnerable', 'fragile'].includes(band);
}

function previousSnapshotRow(source: ReportSourceData) {
  const snaps = source.dashboard.snapshots;
  return snaps.length >= 2 ? snaps[snaps.length - 2] : null;
}

function buildExecutiveSummary(source: ReportSourceData, isFirstReport: boolean): BuiltSection {
  const d = source.dashboard;
  const prev = previousSnapshotRow(source);
  const currency = source.currency;

  const scoreMovement = computeMetricMovement({
    label: 'Financial Health Score',
    current: source.healthScore?.overallScore ?? null,
    previous: source.healthScore?.previousScore ?? null,
    format: 'count',
    goodDirection: 'up',
  });
  const netWorthMovement = computeMetricMovement({
    label: 'Net worth',
    current: d.netWorth,
    previous: prev?.net_worth ?? null,
    format: 'currency',
    goodDirection: 'up',
    currency,
  });
  const surplusMovement = computeMetricMovement({
    label: 'Monthly surplus',
    current: d.monthlySurplus,
    previous: prev?.monthly_surplus ?? null,
    format: 'currency',
    goodDirection: 'up',
    currency,
  });
  const savingsRateMovement = computeMetricMovement({
    label: 'Savings rate',
    current: d.savingsRate !== null ? d.savingsRate * 100 : null,
    previous: prev?.savings_rate !== null && prev?.savings_rate !== undefined ? prev.savings_rate * 100 : null,
    format: 'percentage_point',
    goodDirection: 'up',
  });
  const prevDebtToIncome = prev && prev.monthly_income > 0 ? prev.total_liabilities / (prev.monthly_income * 12) : null;
  const debtToIncomeMovement = computeMetricMovement({
    label: 'Debt-to-income',
    current: d.debtToIncome,
    previous: prevDebtToIncome,
    format: 'ratio',
    goodDirection: 'down',
  });
  const emergencyFundMovement = computeMetricMovement({
    label: 'Emergency-fund coverage',
    current: d.emergencyFundMonths,
    previous: null, // not yet tracked historically at a granular level — disclosed limitation
    format: 'months',
    goodDirection: 'up',
  });
  const goalsOnTrackMovement = computeMetricMovement({
    label: 'Active goals on track',
    // Gated on `prev` (same "does a prior period exist" check every other
    // metric here uses), not just `source.previousGoalsOnTrackCount` being
    // non-null: Supabase returns `[]` (truthy) rather than null when a query
    // matches zero rows, so on a genuine first report the resolver's own
    // `prevGoalSnapshots ? ... : null` check was passing the empty-array
    // branch and reporting a real "0" instead of "not available".
    current: source.goals.summary.onTrackCount,
    previous: prev ? source.previousGoalsOnTrackCount : null,
    format: 'count',
    goodDirection: 'up',
  });

  const metrics = [scoreMovement, netWorthMovement, surplusMovement, savingsRateMovement, debtToIncomeMovement, emergencyFundMovement, goalsOnTrackMovement];

  // Report v2 visuals: a cash-flow waterfall (Page 2/3) and an
  // emergency-fund target-zone bar (Page 2/5). 3-6 months mirrors the
  // healthScore.ts emergency_fund component's own scoring brackets (4-6
  // months scores well), not a new planning assumption.
  const fmt = (n: number) => formatMoneyWhole(n, currency);
  // totalMonthlyExpenses deliberately excludes debt repayments (tracked
  // separately in dashboard.ts) — the waterfall and narrative must always
  // show debt as its own bucket so the visible numbers actually sum to net
  // income, rather than silently describing totalMonthlyExpenses alone as
  // "total expenses and commitments".
  const totalMonthlyOutflow = d.totalMonthlyExpenses + d.debtMonthlyRepayments;
  const cashFlowChart = {
    grossMonthlyIncome: d.grossMonthlyIncome,
    netMonthlyIncome: d.netMonthlyIncome,
    totalMonthlyExpenses: d.totalMonthlyExpenses,
    debtMonthlyRepayments: d.debtMonthlyRepayments,
    totalMonthlyOutflow,
    monthlySurplus: d.monthlySurplus,
    summary:
      d.monthlySurplus >= 0
        ? `Your household received net income of ${fmt(d.netMonthlyIncome)} during the month. After ${fmt(d.totalMonthlyExpenses)} in living and other expenses and ${fmt(d.debtMonthlyRepayments)} in debt repayments (${fmt(totalMonthlyOutflow)} total outflows), the household retained a monthly surplus of ${fmt(d.monthlySurplus)}.`
        : `Your recorded expenses, commitments and debt repayments (${fmt(totalMonthlyOutflow)} in total) exceeded net monthly income by ${fmt(Math.abs(d.monthlySurplus))}. This may require the household to use savings, additional borrowing or other available funds to meet the difference.`,
  };
  const emergencyFundChart = {
    months: d.emergencyFundMonths,
    targetMin: 3,
    targetMax: 6,
    summary:
      d.emergencyFundMonths !== null
        ? `Your available emergency funds could cover approximately ${d.emergencyFundMonths.toFixed(1)} months of recorded essential expenses, compared with the current reference target of 4 months.`
        : null,
  };

  // Level-based (works on a first report, unlike the movement-only lines
  // above which need a prior snapshot to say anything at all).
  const { strengths, attentionAreas } = computeKeyInsights(d, currency, fmt, source.goals.summary);

  const narrative = isFirstReport
    ? firstReportMessage()
    : scoreMovementNarrative(
        source.healthScore?.overallScore ?? 0,
        source.healthScore?.previousScore ?? null,
        source.healthScore?.positiveContributors.slice(0, 1) ?? []
      );

  // Page 2 item 5: a two-sentence overall assessment built from the same
  // reconciled strengths/attention-area findings above, not generic praise
  // or warnings unrelated to the calculated data.
  const firstSentence =
    strengths.length > 0
      ? `Your household currently has ${strengths.map((s) => s.title.toLowerCase()).join(' and ')}, providing a reasonable financial foundation.`
      : isFirstReport
        ? 'This report establishes your household’s current financial baseline.'
        : 'Your household’s current financial position is mixed based on the information available.';
  const secondSentence =
    attentionAreas.length > 0
      ? `However, ${attentionAreas.map((a) => a.title.toLowerCase()).join(' and ')} may reduce your ability to respond to unexpected expenses or changes in income.`
      : strengths.length > 0
        ? 'No material areas of concern were identified from the information currently available.'
        : '';
  const twoSentenceAssessment = `${firstSentence} ${secondSentence}`.trim();

  return {
    sectionCode: 'executive_summary',
    sectionTitle: SECTION_TITLES.executive_summary,
    displayOrder: 1,
    sectionStatus: 'included',
    sectionData: {
      metrics,
      strengths,
      attentionAreas,
      isFirstReport,
      twoSentenceAssessment,
      householdName: source.profile.householdName ?? source.profile.fullName,
    },
    narrativeText: narrative,
    chartData: { cashFlow: cashFlowChart, emergencyFund: emergencyFundChart },
    sourceReferences: { healthScoreId: source.healthScore ? 'current' : null },
    confidenceLevel: source.healthScore ? source.healthScore.dataConfidence.toFixed(0) : null,
    limitationText: null,
  };
}

function buildCashFlow(source: ReportSourceData, status: SectionStatus, reason: string | null): BuiltSection {
  const d = source.dashboard;
  return {
    sectionCode: 'cash_flow',
    sectionTitle: SECTION_TITLES.cash_flow,
    displayOrder: 2,
    sectionStatus: status,
    sectionData:
      status === 'included'
        ? {
            grossMonthlyIncome: d.grossMonthlyIncome,
            netMonthlyIncome: d.netMonthlyIncome,
            passiveMonthlyIncome: d.passiveMonthlyIncome,
            activeMonthlyIncome: d.activeMonthlyIncome,
            incomeSourceCount: d.incomeSourceCount,
            largestIncomeSharePct: d.largestIncomeSharePct,
            essentialMonthlyExpenses: d.essentialMonthlyExpenses,
            lifestyleMonthlyExpenses: d.lifestyleMonthlyExpenses,
            debtMonthlyRepayments: d.debtMonthlyRepayments,
            totalMonthlyExpenses: d.totalMonthlyExpenses,
            monthlySurplus: d.monthlySurplus,
            savingsRate: d.savingsRate,
            cashFlowRatio: d.cashFlowRatio,
            debtServiceRatio: d.debtServiceRatio,
            topExpenses: d.topExpenses,
            topIncome: d.topIncome,
          }
        : {},
    narrativeText:
      status === 'included'
        ? `Your household retains ${d.savingsRate !== null ? (d.savingsRate * 100).toFixed(0) : '—'}% of net income after expenses this month.`
        : null,
    chartData:
      status === 'included'
        ? {
            topExpenses: d.topExpenses,
            topIncome: d.topIncome,
            largestExpenseSummary:
              d.topExpenses.length > 0 && d.totalMonthlyExpenses > 0
                ? `The largest recorded expense category is ${d.topExpenses[0].name}, representing approximately ${((d.topExpenses[0].monthlyAmount / d.totalMonthlyExpenses) * 100).toFixed(0)}% of total monthly expenses.`
                : null,
            largestIncomeSummary:
              d.topIncome.length > 0 && d.grossMonthlyIncome > 0
                ? `Your largest recorded income source is ${d.topIncome[0].name}, representing approximately ${((d.topIncome[0].monthlyAmount / d.grossMonthlyIncome) * 100).toFixed(0)}% of total gross household income.`
                : null,
          }
        : null,
    sourceReferences: {},
    confidenceLevel: null,
    limitationText: reason,
  };
}

function buildNetWorth(source: ReportSourceData, status: SectionStatus, reason: string | null): BuiltSection {
  const d = source.dashboard;
  const prev = previousSnapshotRow(source);
  const netWorthMovement = computeMetricMovement({
    label: 'Net worth',
    current: d.netWorth,
    previous: prev?.net_worth ?? null,
    format: 'currency',
    goodDirection: 'up',
    currency: source.currency,
  });
  return {
    sectionCode: 'net_worth',
    sectionTitle: SECTION_TITLES.net_worth,
    displayOrder: 3,
    sectionStatus: status,
    sectionData:
      status === 'included'
        ? {
            // The reconciling figure — always equals totalInvestments +
            // totalRetirement + coreAssets, so "Total assets − Total
            // liabilities = Net worth" holds exactly wherever this is shown.
            totalAssets: d.totalAssetsCombined,
            coreAssets: d.totalAssets, // property/cash/other only, the breakdown line beneath totalAssets
            totalInvestments: d.totalInvestments,
            totalRetirement: d.totalRetirement,
            totalLiabilities: d.totalLiabilities,
            netWorth: d.netWorth,
            movement: netWorthMovement,
            netWorthAllocation: d.netWorthAllocation,
            liabilityByType: d.liabilityByType,
            liquidAssetRatio: d.liquidAssetRatio,
            propertyConcentration: d.propertyConcentration,
          }
        : {},
    narrativeText:
      status === 'included' && netWorthMovement.comparable
        ? `Net worth ${netWorthMovement.direction === 'positive' ? 'rose' : netWorthMovement.direction === 'negative' ? 'fell' : 'remained stable'} from ${netWorthMovement.previousText} to ${netWorthMovement.currentText}${netWorthMovement.changePercent !== null ? ` (${netWorthMovement.changePercent >= 0 ? '+' : ''}${netWorthMovement.changePercent.toFixed(1)}%)` : ''}.`
        : null,
    chartData:
      status === 'included'
        ? {
            allocation: d.netWorthAllocation,
            summary: `Your recorded assets total ${formatMoneyWhole(d.totalAssetsCombined, source.currency)} and your recorded liabilities total ${formatMoneyWhole(d.totalLiabilities, source.currency)}, resulting in an estimated net worth of ${formatMoneyWhole(d.netWorth, source.currency)}.`,
          }
        : null,
    sourceReferences: { financialSnapshotMonth: source.reportMonth },
    confidenceLevel: null,
    limitationText: reason,
  };
}

function buildHealthScore(source: ReportSourceData, status: SectionStatus, reason: string | null): BuiltSection {
  const hs = source.healthScore;
  // Phase 0C (§24): a report must never present a Preliminary or
  // Not-Yet-Scored result with Full-score authority. Reuses the same
  // eligibility object Dashboard/Score already compute — never re-derives
  // it — so a report can't disagree with what the live pages show.
  const notYetScored = status === 'included' && hs?.eligibility.state === 'not_yet_scored';
  const isPreliminary = status === 'included' && hs?.eligibility.state === 'preliminary';
  return {
    sectionCode: 'health_score',
    sectionTitle: SECTION_TITLES.health_score,
    displayOrder: 4,
    sectionStatus: status,
    sectionData:
      status === 'included' && hs
        ? {
            overallScore: hs.overallScore,
            roundedScore: hs.roundedScore,
            statusBand: hs.statusBand,
            statusLabel: hs.statusLabel,
            previousScore: hs.previousScore,
            scoreChange: hs.scoreChange,
            dataConfidence: hs.dataConfidence,
            modelVersion: hs.modelVersion,
            riskOverrideApplied: hs.riskOverrideApplied,
            riskOverrideReason: hs.riskOverrideReason,
            components: hs.components,
            recommendations: hs.recommendations,
            // Phase 0C: the full eligibility object (not just a couple of
            // derived fields) so the report can render the exact same
            // Not-Yet-Scored / Preliminary / Full presentation Dashboard and
            // /score use, via the same <HealthScoreStateCard>.
            eligibility: hs.eligibility,
          }
        : {},
    narrativeText:
      status !== 'included' || !hs
        ? null
        : notYetScored
          ? "A Financial Health Score has not yet been calculated because some core financial information has not been reviewed."
          : isPreliminary
            ? `Preliminary Financial Health Score: ${hs.roundedScore}/100. Based on ${hs.eligibility.confidencePercent}% of the currently required financial picture.`
            : scoreMovementNarrative(hs.overallScore, hs.previousScore, hs.positiveContributors.slice(0, 2)),
    chartData:
      status === 'included' && hs
        ? {
            history: hs.history,
            // Surfaces each pillar's own explanation (e.g. "Complete the
            // check-in checklist to calculate this" for a missing_data
            // component) instead of the report showing an unexplained
            // blank/dash for an unscored pillar. `whatItMeasures` is a fixed,
            // generic definition (same for every household); `explanation`
            // is the engine's own household-specific "meaning" sentence.
            // `areaToReview` used to read hs.recommendations[].explanation,
            // but that field is always a verbatim copy of c.explanation
            // (healthScore.ts's recommendation builder), so it rendered the
            // exact same sentence twice under two different labels. It now
            // pulls the pillar-triggered content-library match (Report v3
            // Phase 3a, same library backing the Priority Actions section)
            // instead, which is genuinely distinct, actionable text — and
            // is simply omitted when the library has no matching row for
            // this pillar/band rather than falling back to a duplicate.
            pillars: hs.components.map((c) => ({
              code: c.code,
              label: c.label,
              score: c.rawScore,
              statusBand: c.statusBand,
              explanation: c.explanation,
              treatment: c.treatment,
              whatItMeasures: PILLAR_WHAT_IT_MEASURES[c.code] ?? null,
              areaToReview: isConcernBand(c.statusBand)
                ? (source.actionRecommendations.find((r) => r.pillarCode === c.code)?.content ?? null)
                : null,
            })),
          }
        : null,
    sourceReferences: { modelVersion: hs?.modelVersion ?? null },
    confidenceLevel: hs ? hs.dataConfidence.toFixed(0) : null,
    limitationText: reason,
  };
}

function buildFinancialDna(source: ReportSourceData, status: SectionStatus, reason: string | null): BuiltSection {
  const dna = source.dna;
  return {
    sectionCode: 'financial_dna',
    sectionTitle: SECTION_TITLES.financial_dna,
    displayOrder: 5,
    sectionStatus: status,
    sectionData:
      status === 'included' && dna
        ? {
            primaryProfileCode: dna.primaryProfileCode,
            primaryProfileLabel: (dna.primaryProfileCode ? dna.archetypes[dna.primaryProfileCode]?.profile_name : null) ?? dna.primaryProfileCode,
            primaryScore: dna.primaryScore,
            secondaryProfileCode: dna.secondaryProfileCode,
            confidence: dna.confidence,
            confidenceLabel: dna.confidenceLabel,
            profileChanged: dna.profileChanged,
            traits: dna.traits,
            strengths: dna.strengths,
            risks: dna.risks,
            actions: dna.actions,
          }
        : {},
    narrativeText:
      status === 'included' && dna && dna.primaryProfileCode
        ? `Your current financial pattern most closely resembles a ${dna.archetypes[dna.primaryProfileCode]?.profile_name ?? dna.primaryProfileCode} profile. This describes your current pattern, not a permanent label.`
        : null,
    chartData: null,
    sourceReferences: { modelVersion: dna?.modelVersion ?? null },
    confidenceLevel: dna ? dna.confidence.toFixed(0) : null,
    limitationText: reason,
  };
}

function buildResilience(source: ReportSourceData, status: SectionStatus, reason: string | null): BuiltSection {
  const r = source.resilience;
  return {
    sectionCode: 'resilience',
    sectionTitle: SECTION_TITLES.resilience,
    displayOrder: 6,
    sectionStatus: status,
    sectionData:
      status === 'included' && r
        ? {
            overallScore: r.overallScore,
            roundedScore: r.roundedScore,
            statusBand: r.statusBand,
            statusLabel: r.statusLabel,
            confidence: r.confidence,
            components: r.components,
            risks: r.risks,
            actions: r.actions,
          }
        : {},
    narrativeText: status === 'included' && r ? `Your Financial Resilience score is ${r.roundedScore}/100 (${r.statusLabel}).` : null,
    chartData:
      status === 'included' && r
        ? {
            components: r.components.map((c) => ({
              code: c.code,
              label: c.label,
              score: c.rawScore,
              statusBand: c.statusBand,
              explanation: c.explanation,
              treatment: c.treatment,
            })),
          }
        : null,
    sourceReferences: { modelVersion: r?.modelVersion ?? null },
    confidenceLevel: r ? r.confidence.toFixed(0) : null,
    limitationText: reason,
  };
}

function buildGoals(source: ReportSourceData): BuiltSection {
  const g = source.goals;
  const hasGoals = g.summary.activeGoalsCount > 0;
  const goalRows = g.goals
    .filter((goal) => goal.status === 'active')
    .map((goal) => ({
      goalName: goal.goalName,
      progressPct: goal.forecasts.base.progressPct,
      plannedContribution: goal.plannedContributionAmount,
      requiredContribution: goal.forecasts.base.requiredMonthlyContribution,
      trackStatus: goal.forecasts.base.trackStatus,
      targetDate: goal.targetDate,
    }));
  return {
    sectionCode: 'goals',
    sectionTitle: SECTION_TITLES.goals,
    displayOrder: 7,
    sectionStatus: 'included',
    sectionData: {
      summary: g.summary,
      affordability: g.affordability,
      goals: goalRows,
    },
    narrativeText: hasGoals
      ? `${g.summary.onTrackCount} of ${g.summary.activeGoalsCount} active goals are on track.${
          g.affordability.status === 'overallocated' ? ` ${overallocationNarrative((g.affordability.usageRatio ?? 1) * 100)}` : ''
        }`
      : 'No active goals were recorded for this period.',
    chartData: hasGoals ? { goals: goalRows } : null,
    sourceReferences: {},
    confidenceLevel: null,
    limitationText: hasGoals ? null : null,
  };
}

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

function buildCommitmentsTimeline(source: ReportSourceData): BuiltSection {
  const now = new Date(source.asOfDate);
  const cutoff = new Date(now.getTime() + NINETY_DAYS_MS);
  const upcoming = source.commitments
    .filter((c) => {
      const due = new Date(c.due_date);
      return due >= now && due <= cutoff;
    })
    .sort((a, b) => a.due_date.localeCompare(b.due_date));
  const hasUpcoming = upcoming.length > 0;
  const total = upcoming.reduce((s, c) => s + c.amount, 0);

  return {
    sectionCode: 'commitments_timeline',
    sectionTitle: SECTION_TITLES.commitments_timeline,
    displayOrder: 8,
    sectionStatus: 'included',
    sectionData: { commitments: upcoming, total },
    narrativeText: hasUpcoming
      ? `${upcoming.length} recorded upcoming ${upcoming.length === 1 ? 'commitment totals' : 'commitments total'} ${formatMoneyWhole(total, source.currency)} over the next 90 days.`
      : 'No material upcoming commitments were recorded for the next 90 days.',
    chartData: hasUpcoming ? { commitments: upcoming } : null,
    sourceReferences: {},
    confidenceLevel: null,
    limitationText: null,
  };
}

function buildForecast(source: ReportSourceData, status: SectionStatus, reason: string | null): BuiltSection {
  const activeGoals = source.goals.goals.filter((g) => g.status === 'active');
  return {
    sectionCode: 'forecast',
    sectionTitle: SECTION_TITLES.forecast,
    displayOrder: 9,
    sectionStatus: status,
    sectionData:
      status === 'included'
        ? {
            // goalForecast.ts's standardForecast() leaves completionDate null
            // by design whenever the goal already has a fixed targetDate (the
            // common case) — the number to show is requiredMonthlyContribution
            // / forecastFundingPct instead. Previously this table always read
            // completionDate and showed "—" for every goal with a target date.
            goalForecasts: activeGoals.map((g) => ({
              goalName: g.goalName,
              conservative: g.forecasts.conservative,
              base: g.forecasts.base,
              optimistic: g.forecasts.optimistic,
              hasTargetDate: g.targetDate !== null,
            })),
          }
        : {},
    narrativeText: null,
    chartData: null,
    sourceReferences: {},
    confidenceLevel: null,
    limitationText:
      status === 'included'
        ? 'This forecast summarises individual goal-level projections only. Full household net-worth, retirement-income and Monte Carlo forecasting are not part of this platform yet.'
        : reason,
  };
}

// References (not recalculates) the user's most recent Financial Twin run
// from Module 8 — same Rule 15 pattern as every other section here.
function buildFinancialTwin(source: ReportSourceData, status: SectionStatus, reason: string | null): BuiltSection {
  const twin = source.financialTwin;
  if (status !== 'included' || !twin) {
    return {
      sectionCode: 'financial_twin',
      sectionTitle: SECTION_TITLES.financial_twin,
      displayOrder: 10,
      sectionStatus: 'unavailable',
      sectionData: {},
      narrativeText: null,
      chartData: null,
      sourceReferences: {},
      confidenceLevel: null,
      limitationText: reason,
    };
  }
  return {
    sectionCode: 'financial_twin',
    sectionTitle: SECTION_TITLES.financial_twin,
    displayOrder: 10,
    sectionStatus: 'included',
    sectionData: {
      cohortTier: twin.cohortTier,
      cohortDescription: twin.cohortDescription,
      metricsCompared: twin.metricsCompared,
      aheadCount: twin.aheadCount,
      alignedCount: twin.alignedCount,
      behindCount: twin.behindCount,
      overallConfidence: twin.overallConfidence,
      insights: twin.insights,
    },
    narrativeText: `Your Financial Twin compared ${twin.metricsCompared} metrics against a synthetic peer profile and FHIP planning ranges: ${twin.aheadCount} ahead, ${twin.alignedCount} broadly aligned, ${twin.behindCount} below benchmark.`,
    chartData: null,
    sourceReferences: { financialTwinRunId: twin.id },
    confidenceLevel: twin.overallConfidence !== null ? twin.overallConfidence.toFixed(0) : null,
    limitationText: 'Financial Twin comparisons are indicative synthetic peer profiles, not actual households, and reflect the most recently generated Twin, not necessarily this report period.',
  };
}

function buildCrossBorder(source: ReportSourceData, status: SectionStatus, reason: string | null): BuiltSection {
  const d = source.dashboard;
  return {
    sectionCode: 'cross_border',
    sectionTitle: SECTION_TITLES.cross_border,
    displayOrder: 11,
    sectionStatus: status,
    sectionData:
      status === 'included'
        ? {
            countries: d.countriesInUse,
            assetsByCountry: d.assetsByCountry,
            liabilitiesByCountry: d.liabilitiesByCountry,
            investmentsByCountry: d.investmentByCountry,
            retirementByCountry: d.retirementByCountry,
            reportingCurrency: source.currency,
          }
        : {},
    narrativeText: null,
    chartData: null,
    sourceReferences: {},
    confidenceLevel: null,
    limitationText:
      status === 'included'
        ? 'Local-country totals are shown as recorded. A fully converted reporting-currency consolidated view across all modules is not yet implemented — only Module 7 goal-level cross-border forecasts apply an explicit FX assumption today.'
        : reason,
  };
}

// Severity (action_recommendation_master's 4-value vocabulary) collapses to
// this section's 3-value priority the same way reportSectionsPremium.ts's
// buildPersonalActionPlan does — critical and high both read as "high" here,
// there's no separate "review immediately" tier in this section's UI.
function severityToPriority(severity: 'low' | 'medium' | 'high' | 'critical'): string {
  return severity === 'critical' || severity === 'high' ? 'high' : severity === 'medium' ? 'medium' : 'low';
}

function buildActions(source: ReportSourceData, status: SectionStatus, reason: string | null): BuiltSection {
  const items: { priority: string; title: string; reason: string; relatedModule: string }[] = [];
  // Real recommendation-engine matches (action_recommendation_master, Report
  // v3 Phase 3a) — pillar-triggered for every tier, plus forecast-triggered
  // too on Premium. Replaces the old direct sourcing from
  // healthScore.recommendations, which bypassed the admin-editable library
  // entirely.
  for (const rec of source.actionRecommendations) {
    items.push({ priority: severityToPriority(rec.severity), title: rec.title, reason: rec.content, relatedModule: rec.pillarCode ?? rec.forecastCategory ?? 'recommendations' });
  }
  for (const act of source.resilience?.actions ?? []) {
    items.push({ priority: act.priority, title: act.title, reason: act.explanation, relatedModule: act.relatedModule });
  }
  const goalInsights = generateGoalInsights(source.goals.goals, source.goals.summary, source.goals.affordability, source.currency);
  for (const insight of goalInsights) {
    items.push({ priority: 'medium', title: 'Review goal plan', reason: insight, relatedModule: 'goals' });
  }
  const priorityRank: Record<string, number> = { high: 0, medium: 1, low: 2 };
  const top = items.sort((a, b) => (priorityRank[a.priority] ?? 3) - (priorityRank[b.priority] ?? 3)).slice(0, 5);

  return {
    sectionCode: 'actions',
    sectionTitle: SECTION_TITLES.actions,
    displayOrder: 12,
    sectionStatus: status,
    sectionData: { actions: top },
    narrativeText: null,
    chartData: null,
    sourceReferences: {},
    confidenceLevel: null,
    limitationText: reason,
  };
}

const FRESHNESS_LABELS: Record<string, string> = {
  income: 'Income',
  expenses: 'Expenses',
  assets: 'Assets',
  liabilities: 'Liabilities',
  investments: 'Investments',
  retirement: 'Retirement',
  insurance: 'Insurance',
};

// Phase 0C follow-up: distinct from 'complete'/'stale' (real balances present)
// and from a plain 'missing' (never reviewed at all) — 'confirmed_zero' and
// 'not_applicable' mean the user has actually reviewed the section, they
// just have nothing to report there. Keeping these as their own states
// stops a confirmed-zero Liabilities section from reading as "Missing" on
// the same screen where the score already counts it as reviewed.
export type DataQualityStatus = 'complete' | 'stale' | 'confirmed_zero' | 'not_applicable' | 'missing';

export const DATA_QUALITY_STATUS_LABELS: Record<DataQualityStatus, string> = {
  complete: 'Complete',
  stale: 'Stale',
  confirmed_zero: 'Confirmed zero',
  not_applicable: 'Not applicable',
  missing: 'Missing',
};

export function buildDataQuality(
  source: Pick<ReportSourceData, 'dashboard' | 'dataFreshness' | 'healthScore'>
): BuiltSection {
  const d = source.dashboard;
  const hasFlags: Record<string, boolean> = {
    income: d.hasIncome,
    expenses: d.hasExpenses,
    assets: d.hasAssets,
    liabilities: d.hasLiabilities,
    investments: d.hasInvestments,
    retirement: d.hasRetirement,
    insurance: d.hasInsurance,
  };
  const sectionStatus = source.healthScore?.sectionStatus;
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

  const rows = Object.keys(FRESHNESS_LABELS).map((category) => {
    const lastUpdated = source.dataFreshness[category] ?? null;
    const present = hasFlags[category];
    const stale = lastUpdated !== null && new Date(lastUpdated) < sixMonthsAgo;
    const explicit = sectionStatus?.[category as FinancialSection];

    let status: DataQualityStatus;
    let reportTreatment: string;
    if (present) {
      status = stale ? 'stale' : 'complete';
      reportTreatment = stale ? 'Included, limited confidence (stale)' : 'Included';
    } else if (explicit === 'reviewed_zero') {
      status = 'confirmed_zero';
      reportTreatment = 'Included as confirmed zero — reviewed by the user';
    } else if (explicit === 'not_applicable') {
      status = 'not_applicable';
      reportTreatment = 'Excluded — marked not applicable by the user';
    } else {
      status = 'missing';
      reportTreatment = 'Not included — not treated as zero';
    }

    return { area: FRESHNESS_LABELS[category], status, lastUpdated, reportTreatment };
  });

  // Confirmed-zero and not-applicable sections have been reviewed — they
  // count toward completeness the same way a populated section does. Only
  // 'stale' and 'missing' represent something still outstanding.
  const completeCount = rows.filter((r) => r.status === 'complete' || r.status === 'confirmed_zero' || r.status === 'not_applicable').length;
  const dataCompletenessPct = (completeCount / rows.length) * 100;
  const outstanding = rows.some((r) => r.status === 'stale' || r.status === 'missing');

  return {
    sectionCode: 'data_quality',
    sectionTitle: SECTION_TITLES.data_quality,
    displayOrder: 13,
    sectionStatus: 'included',
    sectionData: { rows, dataCompletenessPct },
    narrativeText: outstanding
      ? 'Some sections are based on partial or stale information — see the table below for details.'
      : 'All core financial data areas are complete, current, or explicitly confirmed by the user.',
    chartData: { completeness: { pct: dataCompletenessPct, rows } },
    sourceReferences: {},
    confidenceLevel: null,
    limitationText: null,
  };
}

function buildMethodology(source: ReportSourceData): BuiltSection {
  return {
    sectionCode: 'methodology',
    sectionTitle: SECTION_TITLES.methodology,
    displayOrder: 14,
    sectionStatus: 'included',
    sectionData: {
      reportPeriod: source.reportMonth,
      asOfDate: source.asOfDate,
      reportingCurrency: source.currency,
      healthScoreModelVersion: source.healthScore?.modelVersion ?? null,
      dnaModelVersion: source.dna?.modelVersion ?? null,
      resilienceModelVersion: source.resilience?.modelVersion ?? null,
      templateVersion: 'report-1.0.0',
      disclaimerVersion: 'disclaimer-1.0.0',
    },
    narrativeText:
      'This report is based on financial information recorded in the Financial Health Intelligence Platform and the assumptions shown. It is intended for general information, education and financial-wellness tracking. It does not constitute personal financial advice, credit advice, tax advice, legal advice or a recommendation to acquire, dispose of or change a financial product. Forecasts and benchmark comparisons are indicative and actual outcomes may differ.',
    chartData: null,
    sourceReferences: {},
    confidenceLevel: null,
    limitationText: null,
  };
}

export function buildReportSections(source: ReportSourceData, eligibilityInput: EligibilityInput, isFirstReport: boolean): BuiltSection[] {
  const eligibility = computeSectionEligibility(eligibilityInput);
  const statusOf = (code: SectionCode) => eligibility.find((e) => e.code === code)!;

  const freeSections: BuiltSection[] = [
    buildExecutiveSummary(source, isFirstReport),
    buildCashFlow(source, statusOf('cash_flow').status, statusOf('cash_flow').reason),
    buildNetWorth(source, statusOf('net_worth').status, statusOf('net_worth').reason),
    buildHealthScore(source, statusOf('health_score').status, statusOf('health_score').reason),
    buildFinancialDna(source, statusOf('financial_dna').status, statusOf('financial_dna').reason),
    buildResilience(source, statusOf('resilience').status, statusOf('resilience').reason),
    buildGoals(source),
    buildCommitmentsTimeline(source),
    buildForecast(source, statusOf('forecast').status, statusOf('forecast').reason),
    buildFinancialTwin(source, statusOf('financial_twin').status, statusOf('financial_twin').reason),
    buildCrossBorder(source, statusOf('cross_border').status, statusOf('cross_border').reason),
    buildActions(source, statusOf('actions').status, statusOf('actions').reason),
    buildDataQuality(source),
    buildMethodology(source),
  ];

  // Premium sections are only ever built when the resolver actually loaded
  // Premium-only data (source.premium !== null, i.e. planTier === 'premium')
  // — a downgraded user's next report simply won't contain them, and the
  // preview UI needs no separate tier check since it only renders a section
  // when a matching row exists.
  return source.planTier === 'premium' ? [...freeSections, ...buildPremiumSections(source, isFirstReport)] : freeSections;
}

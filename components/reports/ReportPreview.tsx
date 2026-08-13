import { formatMoneyWhole } from '@/lib/engines/money';
import { formatDateShort } from '@/lib/engines/date';
import type { ReportRow } from '@/lib/services/reportsData';
import { SectionCard, Stat } from '@/components/dashboard/SectionCard';
import { HealthScoreGauge } from '@/components/score/HealthScoreGauge';
import { ResilienceGauge } from '@/components/resilience/ResilienceGauge';
import {
  ReportAllocationChart,
  ReportDebtBarChart,
  CashFlowWaterfallChart,
  TargetZoneBar,
  PillarBars,
  RiskSeverityMatrix,
  ScoreTrendChart,
  BulletChart,
  type PillarRow,
  type BulletRow,
} from '@/components/reports/ReportV2Charts';
import { TrendLineChart } from '@/components/dashboard/charts';
import { ReportTrendChart, ReportScenarioBarChart } from '@/components/forecast/ForecastReportCharts';
import type { ReportContent } from '@/lib/services/reportContentData';

interface BuiltSectionLike {
  sectionCode: string;
  sectionTitle: string;
  sectionStatus: 'included' | 'unavailable' | 'omitted';
  sectionData: Record<string, unknown>;
  chartData: Record<string, unknown> | null;
  narrativeText: string | null;
  confidenceLevel: string | null;
  limitationText: string | null;
}

interface Insight {
  code: string;
  title: string;
  explanation: string;
}

const STATUS_TEXT_COLOR: Record<'good' | 'caution' | 'risk' | 'neutral', string> = {
  good: 'text-progress',
  caution: 'text-amber-600',
  risk: 'text-risk',
  neutral: 'text-gray-500',
};

// Financial Twin metric values (BulletChart) carry a unit from
// lib/engines/twin/metricCatalogue.ts — format each accordingly rather than
// showing every value as a bare grouped number regardless of what it means.
function formatByMetricUnit(value: number, unit: 'currency' | 'percentage' | 'months' | 'ratio' | 'count' | 'days', currency: 'AUD' | 'INR'): string {
  switch (unit) {
    case 'currency':
      return formatMoneyWhole(value, currency);
    case 'percentage':
      return `${value.toFixed(1)}%`;
    case 'months':
      return `${value.toFixed(1)} months`;
    case 'days':
      return `${value.toFixed(0)} days`;
    case 'ratio':
      return `${value.toFixed(1)}×`;
    case 'count':
      return value.toFixed(0);
  }
}

// Every metric shows what it is (fixed definition), the household's actual
// value, and — where relevant — what to review next, rather than a bare
// number. This is the report-wide "3-layer" plain-English rule.
function MetricExplainer({ label, value, meaning, review }: { label: string; value: string; meaning?: string; review?: string }) {
  return (
    <div>
      <p className="text-xs text-gray-500">{label}</p>
      <p className="text-lg font-semibold text-gray-900">{value}</p>
      {meaning && <p className="mt-1 text-xs text-gray-600">{meaning}</p>}
      {review && <p className="text-xs text-gray-400">{review}</p>}
    </div>
  );
}

function Unavailable({ text }: { text: string | null }) {
  return <p className="text-justify text-sm text-gray-500">Not available{text ? ` — ${text}` : ''}.</p>;
}

interface GoalForecastCell {
  completionDate: string | null;
  requiredMonthlyContribution: number | null;
  forecastFundingPct: number | null;
  projectedTargetDateValue: number | null;
}

// goalForecast.ts's standardForecast() leaves completionDate null by design
// whenever the goal already has a fixed target date (the common case) — the
// number that's actually populated then is requiredMonthlyContribution or
// forecastFundingPct instead. Previously this table always read
// completionDate and showed "—" for every goal that has a target date.
function formatGoalForecastCell(cell: GoalForecastCell | null, hasTargetDate: boolean, fmt: (n: unknown) => string): string {
  if (!cell) return '—';
  if (!hasTargetDate) return cell.completionDate ?? '—';
  if (cell.requiredMonthlyContribution !== null) return `${fmt(cell.requiredMonthlyContribution)}/mo required`;
  if (cell.forecastFundingPct !== null) return `${cell.forecastFundingPct.toFixed(0)}% funded by target date`;
  return '—';
}

function formatReportMonth(monthStr: string): string {
  return new Date(monthStr).toLocaleDateString('en-AU', { month: 'long', year: 'numeric' });
}
function formatSnapshotDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });
}

export function ReportPreview({
  report,
  sections,
  currency,
  content,
}: {
  report: ReportRow;
  sections: BuiltSectionLike[];
  currency: 'AUD' | 'INR';
  content: ReportContent;
}) {
  const byCode = (code: string) => sections.find((s) => s.sectionCode === code);
  const fmt = (n: unknown) => formatMoneyWhole(Number(n ?? 0), currency);

  const execSummary = byCode('executive_summary');
  const cashFlow = byCode('cash_flow');
  const netWorth = byCode('net_worth');
  const healthScore = byCode('health_score');
  const financialDna = byCode('financial_dna');
  const resilience = byCode('resilience');
  const goals = byCode('goals');
  const commitmentsTimeline = byCode('commitments_timeline');
  const forecast = byCode('forecast');
  const financialTwin = byCode('financial_twin');
  const crossBorder = byCode('cross_border');
  const actions = byCode('actions');
  const dataQuality = byCode('data_quality');
  const methodology = byCode('methodology');

  // Premium-only sections — simply absent (byCode returns undefined) on a
  // free-tier report, so no separate tier check is needed anywhere below.
  const twelveMonthTrends = byCode('twelve_month_trends');
  const scoreDiagnosticFull = byCode('score_diagnostic_full');
  const financialDnaFull = byCode('financial_dna_full');
  const investmentAnalysis = byCode('investment_analysis');
  const retirementReadiness = byCode('retirement_readiness');
  const insuranceAnalysis = byCode('insurance_analysis');
  const goalForecastDetail = byCode('goal_forecast_detail');
  const scenarioForecasting = byCode('scenario_forecasting');
  const financialTwinFull = byCode('financial_twin_full');
  const crossBorderFull = byCode('cross_border_full');
  const stressTesting = byCode('stress_testing');
  const personalActionPlan = byCode('personal_action_plan');
  const appendices = byCode('appendices');
  const isPremiumReport = Boolean(
    twelveMonthTrends || scoreDiagnosticFull || financialDnaFull || investmentAnalysis || appendices
  );

  const isFirstReport = Boolean(execSummary?.sectionData.isFirstReport);
  const householdName = (execSummary?.sectionData.householdName as string | null) ?? null;
  const twoSentenceAssessment = (execSummary?.sectionData.twoSentenceAssessment as string | null) ?? null;
  const strengths = (execSummary?.sectionData.strengths as Insight[] | undefined) ?? [];
  const attentionAreas = (execSummary?.sectionData.attentionAreas as Insight[] | undefined) ?? [];
  const cashFlowChart = execSummary?.chartData?.cashFlow as
    | {
        grossMonthlyIncome: number;
        netMonthlyIncome: number;
        totalMonthlyExpenses: number;
        debtMonthlyRepayments: number;
        totalMonthlyOutflow: number;
        monthlySurplus: number;
        summary: string;
      }
    | undefined;
  const emergencyFundChart = execSummary?.chartData?.emergencyFund as
    | { months: number | null; targetMin: number; targetMax: number; summary: string | null }
    | undefined;

  const overallConfidencePct = healthScore?.confidenceLevel ? Number(healthScore.confidenceLevel) : null;
  const confidenceTier: 'high' | 'medium' | 'low' = overallConfidencePct === null ? 'medium' : overallConfidencePct >= 80 ? 'high' : overallConfidencePct >= 50 ? 'medium' : 'low';
  const dataQualityRows = (dataQuality?.sectionData.rows as { area: string; status: string }[] | undefined) ?? [];
  const limitingArea = dataQualityRows.find((r) => r.status !== 'complete')?.area ?? null;

  const reportTitle = isFirstReport ? 'Household Financial Health Report — Current Baseline' : 'Household Financial Health Report — Monthly Review';

  return (
    <div className="report-print-root space-y-6">
      {/* Page 1 — Purpose and how to read this report */}
      <div className="report-section rounded-card border bg-white p-8 text-center">
        <img src="/images/fhip-logo-lockup.png" alt="FHIP" className="mx-auto h-10 w-auto" />
        <p className="mt-3 text-xs uppercase tracking-wide text-gray-400">Financial Health Intelligence Platform™</p>
        <h1 className="mt-2 text-2xl font-bold text-trust">{reportTitle}</h1>
        {householdName && <p className="mt-2 text-sm font-medium text-gray-700">Prepared for: {householdName}</p>}
        <div className="mt-3 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-sm text-gray-500">
          <span>Reporting month: {formatReportMonth(report.report_month)}</span>
          <span>Financial position snapshot: {formatSnapshotDate(report.as_of_date)}</span>
        </div>
        <p className="mt-1 text-sm text-gray-500">
          Reporting currency: {content.currencyName(currency)} — {currency}
        </p>
        <p className="mt-2 text-xs font-medium text-gray-400">Confidential — prepared for personal use</p>
      </div>
      <div className="report-section rounded-card border bg-white p-6">
        <h2 className="text-lg font-semibold text-gray-900">About this report</h2>
        <p className="mt-2 text-justify text-sm text-gray-600">{content.reportWhatItIs}</p>
        <h2 className="mt-4 text-lg font-semibold text-gray-900">Why this report exists</h2>
        <p className="mt-2 text-justify text-sm text-gray-600">{content.reportWhyItExists}</p>
        <h2 className="mt-4 text-lg font-semibold text-gray-900">Reading this report</h2>
        <p className="mt-2 text-justify text-sm text-gray-600">{content.reportHowToRead}</p>
        {healthScore && (
          <p className="mt-4 text-justify text-sm font-medium text-gray-800">
            {content.confidenceExplanation(confidenceTier, limitingArea)}
          </p>
        )}
        <p className="mt-4 text-justify text-xs text-gray-400">{content.page1Disclaimer}</p>
      </div>

      {/* Your financial health in one page. Free-tier section groups below
          (through "Priority actions...") no longer force their own physical
          page via report-page-break — with 8 groups of varying length, a
          hard break at every boundary regardless of how full the page
          already was is exactly what produced the "many pages show empty
          space" complaint (e.g. a 2-card group starting a fresh page when
          the previous page still had two-thirds of its height free). Letting
          content flow naturally and only break where it doesn't fit removes
          that structural whitespace; report-section's break-inside:avoid on
          every card still prevents an individual card/chart from splitting
          mid-content. */}
      <div className="space-y-6">
        {isFirstReport && (
          <p className="report-section text-center text-xs font-semibold uppercase tracking-wide text-trust">Current baseline</p>
        )}
        {healthScore?.sectionStatus === 'included' && (
          <div className="report-section grid gap-6 sm:grid-cols-2">
            <HealthScoreGauge
              score={healthScore.sectionData.roundedScore as number}
              statusLabel={healthScore.sectionData.statusLabel as string}
              statusBand={healthScore.sectionData.statusBand as string}
              compact
            />
            <div className="rounded-card border bg-white p-6">
              <p className="text-sm text-gray-600">{content.scoreGaugeExplanation}</p>
              {healthScore.confidenceLevel && <p className="mt-3 text-xs text-gray-400">Data confidence: {healthScore.confidenceLevel}%</p>}
            </div>
          </div>
        )}

        {twoSentenceAssessment && (
          <SectionCard title="Overall position" className="report-section">
            <p className="text-sm text-gray-700">{twoSentenceAssessment}</p>
          </SectionCard>
        )}

        {/* "Where your monthly income goes" and "How much you own compared
            with what you owe" side by side — both are compact charts that
            previously each consumed a full-width section for no reason. */}
        <div className="report-section grid gap-6 sm:grid-cols-2">
          {cashFlowChart && (
            <SectionCard title="Where your monthly income goes">
              <CashFlowWaterfallChart
                grossMonthlyIncome={cashFlowChart.grossMonthlyIncome}
                netMonthlyIncome={cashFlowChart.netMonthlyIncome}
                totalMonthlyExpenses={cashFlowChart.totalMonthlyExpenses}
                debtMonthlyRepayments={cashFlowChart.debtMonthlyRepayments}
                monthlySurplus={cashFlowChart.monthlySurplus}
                currency={currency}
              />
              <p className="mt-2 text-justify text-sm text-gray-600">{cashFlowChart.summary}</p>
            </SectionCard>
          )}
          {netWorth?.sectionStatus === 'included' && (
            <SectionCard title="How much you own compared with what you owe">
              <ReportDebtBarChart
                // netWorth.sectionData.totalAssets is already the all-inclusive
                // figure (property/cash/other + investments + retirement) — do
                // not add investments/retirement again here, that would
                // triple-count them.
                rows={[
                  { debtType: 'Total assets', balance: Number(netWorth.sectionData.totalAssets ?? 0) },
                  { debtType: 'Total liabilities', balance: Number(netWorth.sectionData.totalLiabilities ?? 0) },
                ]}
                currency={currency}
              />
              <p className="mt-2 text-sm text-gray-600">{netWorth.chartData?.summary as string}</p>
            </SectionCard>
          )}
        </div>
      </div>

      {/* Money coming in and going out */}
      <div className="space-y-6">
        <p className="report-section text-sm text-gray-600">
          This section explains how money moves through your household each month. It separates income, living costs, financial
          commitments and one-off expenses so you can see which categories have the greatest effect on your available surplus.
        </p>
        {cashFlow?.sectionStatus === 'included' && (
          <>
            <div className="report-section grid gap-6 sm:grid-cols-2">
              {((cashFlow.sectionData.topIncome as { name: string; monthlyAmount: number }[]) ?? []).length > 0 && (
                <SectionCard title="Income by source">
                  <ReportAllocationChart
                    slices={(cashFlow.sectionData.topIncome as { name: string; monthlyAmount: number }[]).map((e) => ({ label: e.name, value: e.monthlyAmount }))}
                    currency={currency}
                  />
                  {cashFlow.chartData?.largestIncomeSummary != null && (
                    <p className="mt-2 text-sm text-gray-600">{cashFlow.chartData.largestIncomeSummary as string}</p>
                  )}
                </SectionCard>
              )}
              <SectionCard title="Expense categories">
                <ReportAllocationChart
                  slices={((cashFlow.sectionData.topExpenses as { name: string; monthlyAmount: number }[]) ?? []).map((e) => ({ label: e.name, value: e.monthlyAmount }))}
                  currency={currency}
                />
                {cashFlow.chartData?.largestExpenseSummary != null && (
                  <p className="mt-2 text-sm text-gray-600">{cashFlow.chartData.largestExpenseSummary as string}</p>
                )}
              </SectionCard>
            </div>
            <SectionCard title="How income and expenses are classified" className="report-section">
              <div className="space-y-3 text-sm text-gray-600">
                <p>{content.cashflowDefinition('grossVsNet')}</p>
                <p>{content.cashflowDefinition('essentialVsDiscretionary')}</p>
                <p>{content.cashflowDefinition('fixedCommitments')}</p>
                <p>{content.cashflowDefinition('debtRepayments')}</p>
                {Number(cashFlow.sectionData.monthlySurplus ?? 0) >= 0 ? (
                  <p>{content.cashflowDefinition('monthlySurplus')}</p>
                ) : (
                  <p>{content.cashflowDefinition('monthlyDeficit')}</p>
                )}
              </div>
              <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3">
                <Stat label="Gross income" value={fmt(cashFlow.sectionData.grossMonthlyIncome)} />
                <Stat label="Net income" value={fmt(cashFlow.sectionData.netMonthlyIncome)} />
                <Stat label="Essential expenses" value={fmt(cashFlow.sectionData.essentialMonthlyExpenses)} />
                <Stat label="Discretionary expenses" value={fmt(cashFlow.sectionData.lifestyleMonthlyExpenses)} />
                <Stat label="Debt repayments" value={fmt(cashFlow.sectionData.debtMonthlyRepayments)} />
                <Stat label={Number(cashFlow.sectionData.monthlySurplus ?? 0) >= 0 ? 'Surplus' : 'Deficit'} value={fmt(cashFlow.sectionData.monthlySurplus)} />
              </div>
            </SectionCard>
          </>
        )}
        {cashFlow?.sectionStatus !== 'included' && cashFlow && (
          <SectionCard title={cashFlow.sectionTitle} className="report-section">
            <Unavailable text={cashFlow.limitationText} />
          </SectionCard>
        )}
      </div>

      {/* What you own and owe */}
      <div className="space-y-6">
        <p className="report-section text-sm text-gray-600">
          This section brings together the assets you own and the debts you owe. It helps you understand your estimated net worth,
          how accessible your wealth is and whether a large proportion of your financial position depends on one asset, investment
          or property market.
        </p>
        {netWorth?.sectionStatus === 'included' && (
          <>
            <div className="report-section grid gap-6 sm:grid-cols-2">
              <SectionCard title="Where your wealth is held">
                <ReportAllocationChart
                  slices={((netWorth.sectionData.netWorthAllocation as { bucket: string; value: number }[]) ?? []).map((a) => ({ label: content.categoryLabel(a.bucket), value: a.value }))}
                  currency={currency}
                />
              </SectionCard>
              {((netWorth.sectionData.liabilityByType as { debtType: string; balance: number }[]) ?? []).length > 0 && (
                <SectionCard title="Debt by type">
                  <ReportDebtBarChart
                    rows={(netWorth.sectionData.liabilityByType as { debtType: string; balance: number }[]).map((r) => ({ debtType: content.categoryLabel(r.debtType), balance: r.balance }))}
                    currency={currency}
                  />
                </SectionCard>
              )}
            </div>
            <SectionCard title="Net worth" className="report-section">
              <p className="text-sm text-gray-600">{content.netWorthDefinition('netWorth')}</p>
              <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3">
                <Stat label="Total assets" value={fmt(netWorth.sectionData.totalAssets)} />
                <Stat label="— Property, cash & other" value={fmt(netWorth.sectionData.coreAssets)} />
                <Stat label="— Investments" value={fmt(netWorth.sectionData.totalInvestments)} />
                <Stat label="— Retirement" value={fmt(netWorth.sectionData.totalRetirement)} />
                <Stat label="Total liabilities" value={fmt(netWorth.sectionData.totalLiabilities)} />
                <Stat label="Net worth" value={fmt(netWorth.sectionData.netWorth)} />
              </div>
              <p className="mt-2 text-xs text-gray-400">Total assets = property, cash & other + investments + retirement.</p>
              {/* Same assets-vs-liabilities comparison as the Page 2 chart,
                  reused here as the "visual representation" companion to
                  this section's own numeric Stat grid — anchored to the Net
                  Worth deep-dive rather than only appearing on Page 2. */}
              <div className="mt-4">
                <ReportDebtBarChart
                  rows={[
                    { debtType: 'Total assets', balance: Number(netWorth.sectionData.totalAssets ?? 0) },
                    { debtType: 'Total liabilities', balance: Number(netWorth.sectionData.totalLiabilities ?? 0) },
                  ]}
                  currency={currency}
                />
              </div>
            </SectionCard>
            {/* Specific asset/debt notes — previously their own forced
                report-page-break group (old Page 5), which was frequently a
                near-empty physical page on its own (only 1-3 short cards).
                Folded into this page's flow instead; report-section's
                break-inside:avoid still keeps each card intact if it does
                spill onto the next physical page. */}
            <p className="report-section text-sm text-gray-600">
              The following notes highlight specific aspects of your assets and debts most likely to affect financial
              resilience — how much of your wealth is readily accessible, how concentrated it is, and how your debt is
              secured.
            </p>
            <SectionCard title="Liquid versus illiquid assets" className="report-section">
              <p className="text-sm text-gray-600">{content.netWorthDefinition('liquidVsIlliquid')}</p>
              {netWorth.sectionData.liquidAssetRatio != null && (
                <p className="mt-2 text-sm text-gray-600">
                  Although your household&apos;s total assets are {fmt(netWorth.sectionData.totalAssets)}, approximately{' '}
                  {(Number(netWorth.sectionData.liquidAssetRatio) * 100).toFixed(0)}% is currently classified as readily
                  accessible or liquid.
                </p>
              )}
            </SectionCard>
            {netWorth.sectionData.propertyConcentration != null && Number(netWorth.sectionData.propertyConcentration) > 0 && (
              <SectionCard title="Property concentration" className="report-section">
                <p className="text-sm text-gray-600">{content.netWorthDefinition('propertyConcentration')}</p>
                <p className="mt-2 text-sm text-gray-600">
                  Property represents approximately {(Number(netWorth.sectionData.propertyConcentration) * 100).toFixed(0)}%
                  of your recorded total assets.
                </p>
              </SectionCard>
            )}
            {Number(netWorth.sectionData.totalRetirement ?? 0) > 0 && (
              <SectionCard title="Retirement assets" className="report-section">
                <p className="text-sm text-gray-600">{content.netWorthDefinition('retirementAssets')}</p>
              </SectionCard>
            )}
            {((netWorth.sectionData.liabilityByType as unknown[]) ?? []).length > 0 && (
              <SectionCard title="Secured and unsecured debt" className="report-section">
                <p className="text-sm text-gray-600">{content.netWorthDefinition('securedDebt')}</p>
                <p className="mt-2 text-sm text-gray-600">{content.netWorthDefinition('unsecuredDebt')}</p>
              </SectionCard>
            )}
          </>
        )}
        {netWorth?.sectionStatus !== 'included' && netWorth && (
          <SectionCard title={netWorth.sectionTitle} className="report-section">
            <Unavailable text={netWorth.limitationText} />
          </SectionCard>
        )}
        {(strengths.length > 0 || attentionAreas.length > 0) && (
          <SectionCard title="Strengths and areas to review" className="report-section">
            {strengths.length > 0 && (
              <div className="mb-4">
                <p className="text-xs font-medium uppercase text-gray-400">Strengths</p>
                <div className="mt-2 space-y-3">
                  {strengths.map((s) => (
                    <div key={s.code}>
                      <p className="text-sm font-medium text-progress">{s.title}</p>
                      <p className="text-xs text-gray-600">{s.explanation}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {attentionAreas.length > 0 && (
              <div>
                <p className="text-xs font-medium uppercase text-gray-400">Areas requiring attention</p>
                <div className="mt-2 space-y-3">
                  {attentionAreas.map((a) => (
                    <div key={a.code}>
                      <p className="text-sm font-medium text-risk">{a.title}</p>
                      <p className="text-xs text-gray-600">{a.explanation}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </SectionCard>
        )}
      </div>

      {/* Emergency fund and core figures */}
      <div className="space-y-6">
        {emergencyFundChart && (
          <SectionCard title="Emergency-fund target" className="report-section">
            <TargetZoneBar
              value={emergencyFundChart.months}
              targetMin={emergencyFundChart.targetMin}
              targetMax={emergencyFundChart.targetMax}
              displayMax={12}
              unit="months"
            />
            {emergencyFundChart.summary && <p className="mt-2 text-justify text-sm text-gray-600">{emergencyFundChart.summary}</p>}
          </SectionCard>
        )}

        {execSummary && (
          <SectionCard title="Core figures" className="report-section">
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <MetricExplainer label="Net monthly income" value={fmt(cashFlowChart?.netMonthlyIncome)} meaning={content.coreFigureDefinition('netIncome')} />
              <MetricExplainer label="Monthly expenses" value={fmt(cashFlowChart?.totalMonthlyOutflow)} meaning={content.coreFigureDefinition('expenses')} />
              <MetricExplainer
                label={isFirstReport ? 'Monthly surplus (baseline)' : 'Monthly surplus or deficit'}
                value={fmt(cashFlowChart?.monthlySurplus)}
                meaning={content.coreFigureDefinition('surplus')}
              />
              <MetricExplainer
                label="Savings rate"
                value={cashFlow?.sectionData.savingsRate != null ? `${(Number(cashFlow.sectionData.savingsRate) * 100).toFixed(1)}%` : 'Not available'}
                meaning={content.coreFigureDefinition('savingsRate')}
              />
              <MetricExplainer label="Assets" value={netWorth ? fmt(netWorth.sectionData.totalAssets) : '—'} meaning={content.coreFigureDefinition('assets')} />
              <MetricExplainer label="Liabilities" value={netWorth ? fmt(netWorth.sectionData.totalLiabilities) : '—'} meaning={content.coreFigureDefinition('liabilities')} />
              <MetricExplainer label="Net worth" value={netWorth ? fmt(netWorth.sectionData.netWorth) : '—'} meaning={content.coreFigureDefinition('netWorth')} />
              <MetricExplainer
                label="Emergency-fund months"
                value={emergencyFundChart?.months !== null && emergencyFundChart?.months !== undefined ? `${emergencyFundChart.months.toFixed(1)} months` : 'Not available'}
                meaning={content.coreFigureDefinition('emergencyFundMonths')}
              />
              <MetricExplainer
                label="Debt-service ratio"
                // Single source of truth: dashboard.ts's debtServiceRatio
                // (net-income-based, matching this definition's own wording)
                // — previously recomputed ad hoc here against net income
                // while the Score Diagnostic page showed a different,
                // gross-income-based figure for the same label.
                value={cashFlow?.sectionData.debtServiceRatio != null ? `${(Number(cashFlow.sectionData.debtServiceRatio) * 100).toFixed(1)}%` : 'Not available'}
                meaning={content.coreFigureDefinition('debtServiceRatio')}
              />
              <MetricExplainer
                // The full sentence used to be crammed into `value`, which
                // MetricExplainer renders as a large bold heading — fine for
                // "$3,602", not for a sentence that then wraps across 4
                // lines at that size and duplicates what "X of Y" already
                // says. Every sibling metric on this page keeps `meaning`
                // as the fixed generic definition; this one now matches.
                label="Goals on track"
                value={
                  goals
                    ? `${(goals.sectionData.summary as { onTrackCount: number }).onTrackCount} of ${(goals.sectionData.summary as { activeGoalsCount: number }).activeGoalsCount}`
                    : '—'
                }
                meaning={content.coreFigureDefinition('goalsOnTrack')}
              />
            </div>
          </SectionCard>
        )}
      </div>

      {/* Score pillars */}
      <div className="space-y-6">
        <p className="report-section text-sm text-gray-600">
          Your overall score is formed from several financial-health pillars. Each pillar measures a different part of your
          household&apos;s position. Reviewing the pillars separately helps explain why the total score is strong, moderate or weak.
          The score is an information and prioritisation tool. It is not a credit score, financial-product rating or prediction of
          future wealth.
        </p>
        {healthScore?.sectionStatus === 'included' && (
          <SectionCard title="Score pillars" className="report-section">
            <PillarBars pillars={(healthScore.chartData?.pillars as PillarRow[]) ?? []} />
          </SectionCard>
        )}
      </div>

      {/* Resilience, Financial DNA and Goals */}
      <div className="space-y-6">
        {resilience?.sectionStatus === 'included' && (
          <div className="report-section grid gap-6 sm:grid-cols-2">
            <ResilienceGauge
              score={resilience.sectionData.roundedScore as number}
              statusLabel={resilience.sectionData.statusLabel as string}
              statusBand={resilience.sectionData.statusBand as string}
              compact
            />
            <div className="rounded-card border bg-white p-6">
              <h2 className="text-lg font-semibold text-gray-900">Key risks</h2>
              <div className="mt-3">
                <RiskSeverityMatrix
                  risks={((resilience.sectionData.risks as { title: string; severity: string; explanation?: string }[]) ?? []).map((r) => ({
                    title: r.title,
                    severity: r.severity,
                    explanation: r.explanation ?? '',
                  }))}
                />
              </div>
            </div>
          </div>
        )}
        {financialDna?.sectionStatus === 'included' && (
          <SectionCard title="Your Financial DNA" className="report-section">
            <p className="text-sm text-gray-700">
              Primary profile: <span className="font-medium">{financialDna.sectionData.primaryProfileLabel as string}</span> · Confidence:{' '}
              {financialDna.sectionData.confidenceLabel as string}
            </p>
            <p className="mt-1 text-justify text-xs text-gray-500">{financialDna.narrativeText}</p>
          </SectionCard>
        )}
        {goals && (
          <SectionCard title={goals.sectionTitle} className="report-section">
            {((goals.sectionData.goals as { goalName: string; progressPct: number; targetDate: string | null }[]) ?? []).length > 0 ? (
              <>
                <p className="mb-3 text-xs text-gray-500">
                  A goal is considered on track when the recorded balance and expected future contributions are sufficient to meet
                  the target under the approved forecast assumptions.
                </p>
                <div className="space-y-3">
                  {(goals.sectionData.goals as { goalName: string; progressPct: number; targetDate: string | null; trackStatus: string }[]).map(
                    (g, i) => {
                      // A goal with no valid forecast (unable_to_assess) must
                      // not be silently folded into "on track" or "at risk" —
                      // show a neutral, explicit "forecast unavailable" state
                      // instead of a colored status the underlying numbers
                      // don't actually support.
                      if (g.trackStatus === 'unable_to_assess') {
                        return (
                          <div key={i}>
                            <div className="flex items-center justify-between text-sm">
                              <span className="font-medium text-gray-900">{g.goalName}</span>
                              <span className={STATUS_TEXT_COLOR.neutral}>Forecast unavailable</span>
                            </div>
                            <p className="mt-1 text-xs text-gray-400">
                              Additional goal assumptions (contribution amount, expected return or target date) are required to calculate a forecast.
                            </p>
                          </div>
                        );
                      }
                      const status: 'good' | 'caution' | 'risk' | 'neutral' =
                        g.trackStatus === 'ahead_of_track' || g.trackStatus === 'on_track' || g.trackStatus === 'fully_funded'
                          ? 'good'
                          : g.trackStatus === 'at_risk'
                            ? 'risk'
                            : g.trackStatus === 'off_track'
                              ? 'caution'
                              : 'neutral';
                      return (
                        <div key={i}>
                          <div className="flex items-center justify-between text-sm">
                            <span className="font-medium text-gray-900">{g.goalName}</span>
                            <span className={STATUS_TEXT_COLOR[status]}>{Math.min(100, g.progressPct).toFixed(0)}%</span>
                          </div>
                          <div className="mt-1 h-2 w-full rounded-full bg-gray-100">
                            <div className="h-2 rounded-full bg-progress" style={{ width: `${Math.max(0, Math.min(100, g.progressPct))}%` }} />
                          </div>
                          {g.targetDate && <p className="mt-1 text-xs text-gray-400">Target date: {g.targetDate}</p>}
                        </div>
                      );
                    }
                  )}
                </div>
              </>
            ) : (
              <p className="text-sm text-gray-500">No active goals were recorded for this period.</p>
            )}
          </SectionCard>
        )}
      </div>

      {/* Priority actions, goal forecasts and near-term commitments */}
      <div className="space-y-6">
        <p className="report-section text-sm text-gray-600">
          The following shows where the greatest opportunity lies to improve your financial position, the outlook for your recorded
          goals, and commitments due in the next 90 days.
        </p>
        {actions && (actions.sectionData.actions as unknown[])?.length > 0 && (
          <SectionCard title="Your priority actions" className="report-section">
            <div className="space-y-3">
              {(actions.sectionData.actions as { priority: string; title: string; reason: string }[]).slice(0, 3).map((a, i) => (
                <div key={i} className="rounded border p-3">
                  <div className="flex items-center justify-between">
                    <p className="font-medium text-gray-900">{a.title}</p>
                    <span className="text-xs uppercase text-gray-400">{a.priority} priority</span>
                  </div>
                  <p className="mt-1 text-sm text-gray-600">{a.reason}</p>
                </div>
              ))}
            </div>
          </SectionCard>
        )}

        {forecast?.sectionStatus === 'included' && ((forecast.sectionData.goalForecasts as unknown[]) ?? []).length > 0 && (
          <SectionCard title={forecast.sectionTitle} className="report-section">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase text-gray-500">
                <tr>
                  <th className="py-1">Goal</th>
                  <th className="py-1">Conservative</th>
                  <th className="py-1">Base</th>
                  <th className="py-1">Optimistic</th>
                </tr>
              </thead>
              <tbody>
                {(
                  forecast.sectionData.goalForecasts as {
                    goalName: string;
                    hasTargetDate: boolean;
                    conservative: GoalForecastCell | null;
                    base: GoalForecastCell | null;
                    optimistic: GoalForecastCell | null;
                  }[]
                ).map((g, i) => (
                  <tr key={i} className="border-t">
                    <td className="py-1">{g.goalName}</td>
                    <td className="py-1">{formatGoalForecastCell(g.conservative, g.hasTargetDate, fmt)}</td>
                    <td className="py-1">{formatGoalForecastCell(g.base, g.hasTargetDate, fmt)}</td>
                    <td className="py-1">{formatGoalForecastCell(g.optimistic, g.hasTargetDate, fmt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-3 text-justify text-xs text-gray-400">{forecast.limitationText}</p>
          </SectionCard>
        )}

        {commitmentsTimeline && (
          <SectionCard title={commitmentsTimeline.sectionTitle} className="report-section">
            {((commitmentsTimeline.sectionData.commitments as { amount: number; due_date: string; is_mandatory: boolean }[]) ?? []).length > 0 ? (
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase text-gray-500">
                  <tr>
                    <th className="py-1">Due date</th>
                    <th className="py-1">Amount</th>
                    <th className="py-1">Type</th>
                  </tr>
                </thead>
                <tbody>
                  {(commitmentsTimeline.sectionData.commitments as { amount: number; due_date: string; is_mandatory: boolean }[]).map((c, i) => (
                    <tr key={i} className="border-t">
                      <td className="py-1">{new Date(c.due_date).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })}</td>
                      <td className="py-1">{fmt(c.amount)}</td>
                      <td className="py-1">{c.is_mandatory ? 'Mandatory' : 'Discretionary'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="text-justify text-sm text-gray-500">{commitmentsTimeline.narrativeText}</p>
            )}
          </SectionCard>
        )}

        {financialTwin?.sectionStatus === 'included' && (
          <SectionCard title={financialTwin.sectionTitle} className="report-section">
            <p className="text-sm text-gray-700">
              Cohort: <span className="font-medium">{financialTwin.sectionData.cohortDescription as string}</span> ·{' '}
              {financialTwin.sectionData.aheadCount as number} ahead, {financialTwin.sectionData.alignedCount as number} aligned,{' '}
              {financialTwin.sectionData.behindCount as number} below benchmark
            </p>
            <p className="mt-1 text-justify text-xs text-gray-400">{financialTwin.limitationText}</p>
          </SectionCard>
        )}

        {crossBorder?.sectionStatus === 'included' && (
          <SectionCard title={crossBorder.sectionTitle} className="report-section">
            <p className="text-sm text-gray-600">Countries recorded: {(crossBorder.sectionData.countries as string[]).join(', ')}</p>
            <p className="mt-1 text-justify text-xs text-gray-400">{crossBorder.limitationText}</p>
          </SectionCard>
        )}
      </div>

      {isPremiumReport && (
        <>
          {/* Page 8 — 12-month trends. Only forces its own page break when
              there's an actual chart to show — an unavailable-trends notice
              alone shouldn't consume a full page. */}
          <div className={twelveMonthTrends?.sectionStatus === 'included' ? 'report-page-break space-y-6' : 'space-y-6'}>
            {twelveMonthTrends?.sectionStatus === 'included' && (
              <SectionCard title={twelveMonthTrends.sectionTitle} className="report-section">
                <p className="mb-4 text-justify text-sm text-gray-600">{twelveMonthTrends.narrativeText}</p>
                {((twelveMonthTrends.sectionData.netWorthHistory as { month: string; netWorth: number }[]) ?? []).length >= 2 && (
                  <div className="mb-6">
                    <p className="mb-1 text-xs font-medium uppercase text-gray-400">Net worth</p>
                    <TrendLineChart
                      data={(twelveMonthTrends.sectionData.netWorthHistory as { month: string; netWorth: number }[]).map((r) => ({
                        month: r.month,
                        value: r.netWorth,
                      }))}
                      currency={currency}
                      roundToWhole
                    />
                  </div>
                )}
                {((twelveMonthTrends.sectionData.healthScoreHistory as { score_month: string; rounded_score: number }[]) ?? []).length >= 2 && (
                  <div className="mb-6">
                    <p className="mb-1 text-xs font-medium uppercase text-gray-400">Financial Health Score</p>
                    <ScoreTrendChart
                      data={(twelveMonthTrends.sectionData.healthScoreHistory as { score_month: string; rounded_score: number }[]).map((r) => ({
                        month: r.score_month,
                        value: r.rounded_score,
                      }))}
                    />
                  </div>
                )}
                {((twelveMonthTrends.sectionData.resilienceHistory as { score_month: string; rounded_score: number }[]) ?? []).length >= 2 && (
                  <div>
                    <p className="mb-1 text-xs font-medium uppercase text-gray-400">Financial Resilience Score</p>
                    <ScoreTrendChart
                      data={(twelveMonthTrends.sectionData.resilienceHistory as { score_month: string; rounded_score: number }[]).map((r) => ({
                        month: r.score_month,
                        value: r.rounded_score,
                      }))}
                    />
                  </div>
                )}
              </SectionCard>
            )}
            {twelveMonthTrends && twelveMonthTrends.sectionStatus !== 'included' && (
              <SectionCard title={twelveMonthTrends.sectionTitle} className="report-section">
                <Unavailable text={twelveMonthTrends.limitationText} />
              </SectionCard>
            )}
          </div>

          {/* Page 9 — Full score diagnostic */}
          {scoreDiagnosticFull?.sectionStatus === 'included' && (
            <div className="report-page-break space-y-6">
              <SectionCard title={scoreDiagnosticFull.sectionTitle} className="report-section">
                <p className="mb-4 text-justify text-sm text-gray-600">{scoreDiagnosticFull.narrativeText}</p>
                <table className="w-full text-sm">
                  <thead className="text-left text-xs uppercase text-gray-500">
                    <tr>
                      <th className="py-1">Pillar</th>
                      <th className="py-1">Score</th>
                      <th className="py-1">Weight</th>
                      <th className="py-1">Weighted contribution</th>
                      <th className="py-1">Data completeness</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(
                      scoreDiagnosticFull.sectionData.components as {
                        code: string;
                        label: string;
                        rawScore: number | null;
                        weight: number;
                        effectiveWeight: number;
                        weightAdjusted: boolean;
                        weightedContribution: number;
                        dataCompleteness: number;
                        explanation: string;
                      }[]
                    ).map((c) => (
                      <tr key={c.code} className="border-t align-top">
                        <td className="py-2 pr-2">
                          <p className="font-medium text-gray-900">{c.label}</p>
                          <p className="text-xs text-gray-500">{c.explanation}</p>
                        </td>
                        <td className="py-2">{c.rawScore !== null ? `${Math.round(c.rawScore)}/100` : '—'}</td>
                        <td className="py-2">
                          {(c.effectiveWeight * 100).toFixed(1)}%
                          {c.weightAdjusted && <span className="ml-1 text-xs text-gray-400">(base {(c.weight * 100).toFixed(0)}%)</span>}
                        </td>
                        <td className="py-2">{c.weightedContribution.toFixed(1)}</td>
                        <td className="py-2">{c.dataCompleteness}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </SectionCard>
            </div>
          )}

          {/* Page 10 — Full Financial DNA */}
          {financialDnaFull?.sectionStatus === 'included' && (
            <div className="report-page-break space-y-6">
              <SectionCard title={financialDnaFull.sectionTitle} className="report-section">
                <p className="text-sm text-gray-700">
                  Primary profile: <span className="font-medium">{financialDnaFull.sectionData.primaryProfileLabel as string}</span>
                  {(financialDnaFull.sectionData.secondaryProfileLabel as string | null) && (
                    <> · Secondary profile: <span className="font-medium">{financialDnaFull.sectionData.secondaryProfileLabel as string}</span></>
                  )}
                  {' '}· Confidence: {financialDnaFull.sectionData.confidenceLabel as string}
                </p>
                {financialDnaFull.narrativeText && <p className="mt-2 text-justify text-sm text-gray-600">{financialDnaFull.narrativeText}</p>}
              </SectionCard>
              {((financialDnaFull.sectionData.traits as { code: string; label: string; level: string; explanation: string }[]) ?? []).length > 0 && (
                <SectionCard title="Traits" className="report-section">
                  <div className="space-y-3">
                    {(financialDnaFull.sectionData.traits as { code: string; label: string; level: string; explanation: string }[]).map((t) => (
                      <div key={t.code}>
                        <p className="text-sm font-medium text-gray-900">
                          {t.label} <span className="font-normal capitalize text-gray-500">({t.level})</span>
                        </p>
                        <p className="text-xs text-gray-600">{t.explanation}</p>
                      </div>
                    ))}
                  </div>
                </SectionCard>
              )}
              {((financialDnaFull.sectionData.strengths as { explanation: string }[]) ?? []).length > 0 && (
                <SectionCard title="Strengths" className="report-section">
                  <ul className="list-disc space-y-1 pl-5 text-sm text-gray-700">
                    {(financialDnaFull.sectionData.strengths as { explanation: string }[]).map((s, i) => (
                      <li key={i}>{s.explanation}</li>
                    ))}
                  </ul>
                </SectionCard>
              )}
              {((financialDnaFull.sectionData.risks as { explanation: string }[]) ?? []).length > 0 && (
                <SectionCard title="Risks" className="report-section">
                  <ul className="list-disc space-y-1 pl-5 text-sm text-gray-700">
                    {(financialDnaFull.sectionData.risks as { explanation: string }[]).map((r, i) => (
                      <li key={i}>{r.explanation}</li>
                    ))}
                  </ul>
                </SectionCard>
              )}
              {((financialDnaFull.sectionData.actions as { title: string; explanation: string; priority: string }[]) ?? []).length > 0 && (
                <SectionCard title="Suggested actions" className="report-section">
                  <div className="space-y-3">
                    {(financialDnaFull.sectionData.actions as { title: string; explanation: string; priority: string }[]).map((a, i) => (
                      <div key={i}>
                        <p className="text-sm font-medium text-gray-900">{a.title}</p>
                        <p className="text-xs text-gray-600">{a.explanation}</p>
                      </div>
                    ))}
                  </div>
                </SectionCard>
              )}
            </div>
          )}

          {/* Page 11 — Investment analysis */}
          {investmentAnalysis?.sectionStatus === 'included' && (
            <div className="report-page-break space-y-6">
              <SectionCard title={investmentAnalysis.sectionTitle} className="report-section">
                <p className="text-justify text-sm text-gray-600">{investmentAnalysis.narrativeText}</p>
                <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3">
                  <Stat label="Current value" value={fmt(investmentAnalysis.sectionData.totalCurrentValue)} />
                  <Stat label="Cost base" value={fmt(investmentAnalysis.sectionData.totalCostBase)} />
                  <Stat label="Unrealised gain/loss" value={fmt(investmentAnalysis.sectionData.unrealisedGain)} />
                </div>
              </SectionCard>
              <SectionCard title="By investment type" className="report-section">
                <ReportAllocationChart
                  slices={((investmentAnalysis.sectionData.byType as { label: string; value: number }[]) ?? []).map((t) => ({ label: t.label, value: t.value }))}
                  currency={currency}
                />
              </SectionCard>
              {((investmentAnalysis.sectionData.byCountry as { country: string; value: number }[]) ?? []).length > 1 && (
                <SectionCard title="By country" className="report-section">
                  <ReportAllocationChart
                    slices={(investmentAnalysis.sectionData.byCountry as { country: string; value: number }[]).map((c) => ({ label: c.country, value: c.value }))}
                    currency={currency}
                  />
                </SectionCard>
              )}
            </div>
          )}

          {/* Page 12 — Retirement readiness */}
          {retirementReadiness?.sectionStatus === 'included' && (
            <div className="report-page-break space-y-6">
              <SectionCard title={retirementReadiness.sectionTitle} className="report-section">
                <p className="text-justify text-sm text-gray-600">{retirementReadiness.narrativeText}</p>
                <div className="mt-4">
                  <ReportTrendChart
                    results={retirementReadiness.sectionData.results as never[]}
                    currency={currency}
                    summed
                  />
                </div>
                {((retirementReadiness.sectionData.explanations as { title: string; explanationText: string }[]) ?? []).length > 0 && (
                  <div className="mt-4 space-y-2">
                    {(retirementReadiness.sectionData.explanations as { title: string; explanationText: string }[]).slice(0, 4).map((e, i) => (
                      <div key={i}>
                        <p className="text-sm font-medium text-gray-900">{e.title}</p>
                        <p className="text-justify text-xs text-gray-600">{e.explanationText}</p>
                      </div>
                    ))}
                  </div>
                )}
                <p className="mt-3 text-justify text-xs text-gray-400">{retirementReadiness.limitationText}</p>
              </SectionCard>
            </div>
          )}

          {/* Page 13 — Insurance analysis */}
          {insuranceAnalysis?.sectionStatus === 'included' && (
            <div className="report-page-break space-y-6">
              <SectionCard title={insuranceAnalysis.sectionTitle} className="report-section">
                <p className="text-justify text-sm text-gray-600">{insuranceAnalysis.narrativeText}</p>
                <Stat label="Total monthly premium (all policies)" value={fmt(insuranceAnalysis.sectionData.totalMonthlyPremium)} />
              </SectionCard>
              <SectionCard title="Cover by type" className="report-section">
                {/* Lump-sum, monthly-benefit and no-lump-sum cover types are
                    not economically comparable — shown as separate rows,
                    never summed into one figure. */}
                <table className="w-full text-sm">
                  <thead className="text-left text-xs uppercase text-gray-500">
                    <tr>
                      <th className="py-1">Cover type</th>
                      <th className="py-1">Cover amount</th>
                      <th className="py-1">Monthly premium</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(
                      insuranceAnalysis.sectionData.byType as {
                        label: string;
                        unit: 'lump_sum' | 'monthly_benefit' | 'no_lump_sum';
                        coverAmount: number;
                        monthlyPremium: number;
                      }[]
                    ).map((t, i) => (
                      <tr key={i} className="border-t">
                        <td className="py-1">{t.label}</td>
                        <td className="py-1">
                          {t.unit === 'no_lump_sum'
                            ? 'Policy recorded — no single lump-sum cover amount applies'
                            : t.unit === 'monthly_benefit'
                              ? `${fmt(t.coverAmount)}/month benefit`
                              : `${fmt(t.coverAmount)} lump sum`}
                        </td>
                        <td className="py-1">{fmt(t.monthlyPremium)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </SectionCard>
            </div>
          )}

          {/* Page 14 — Detailed goal forecasting */}
          {goalForecastDetail?.sectionStatus === 'included' && (
            <div className="report-page-break space-y-6">
              <SectionCard title={goalForecastDetail.sectionTitle} className="report-section">
                <p className="mb-4 text-justify text-sm text-gray-600">{goalForecastDetail.narrativeText}</p>
                <div className="space-y-4">
                  {(
                    goalForecastDetail.sectionData.goals as {
                      goalName: string;
                      targetDate: string | null;
                      conservative: GoalForecastCell | null;
                      base: GoalForecastCell | null;
                      optimistic: GoalForecastCell | null;
                      milestones: { milestone_name: string; target_amount: number; status: string }[];
                    }[]
                  ).map((g, i) => (
                    <div key={i} className="border-t pt-4 first:border-0 first:pt-0">
                      <p className="font-medium text-gray-900">{g.goalName}</p>
                      <table className="mt-2 w-full text-sm">
                        <thead className="text-left text-xs uppercase text-gray-500">
                          <tr>
                            <th className="py-1">Conservative</th>
                            <th className="py-1">Base</th>
                            <th className="py-1">Optimistic</th>
                          </tr>
                        </thead>
                        <tbody>
                          <tr>
                            <td className="py-1">{formatGoalForecastCell(g.conservative, g.targetDate !== null, fmt)}</td>
                            <td className="py-1">{formatGoalForecastCell(g.base, g.targetDate !== null, fmt)}</td>
                            <td className="py-1">{formatGoalForecastCell(g.optimistic, g.targetDate !== null, fmt)}</td>
                          </tr>
                        </tbody>
                      </table>
                      {g.milestones.length > 0 && (
                        <ul className="mt-2 list-disc pl-5 text-xs text-gray-600">
                          {g.milestones.map((m, mi) => (
                            <li key={mi}>
                              {m.milestone_name} — {fmt(m.target_amount)} ({m.status})
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ))}
                </div>
              </SectionCard>
            </div>
          )}

          {/* Page 15 — Scenario forecasting */}
          {scenarioForecasting?.sectionStatus === 'included' && (
            <div className="report-page-break space-y-6">
              <SectionCard title={scenarioForecasting.sectionTitle} className="report-section">
                <p className="text-justify text-sm text-gray-600">{scenarioForecasting.narrativeText}</p>
                {((scenarioForecasting.sectionData.scenarioComparison as unknown[]) ?? []).length > 0 && (
                  <div className="mt-4">
                    <ReportScenarioBarChart
                      scenarios={
                        scenarioForecasting.sectionData.scenarioComparison as {
                          scenarioName: string;
                          oneYear: number | null;
                          fiveYear: number | null;
                          tenYear: number | null;
                        }[]
                      }
                      currency={currency}
                    />
                  </div>
                )}
                {((scenarioForecasting.sectionData.netWorthRun as unknown[]) ?? []).length > 0 && (
                  <div className="mt-6">
                    <p className="mb-1 text-xs font-medium uppercase text-gray-400">Net worth projection — active scenario</p>
                    <ReportTrendChart results={scenarioForecasting.sectionData.netWorthRun as never[]} currency={currency} summed />
                  </div>
                )}
                <p className="mt-3 text-justify text-xs text-gray-400">{scenarioForecasting.limitationText}</p>
              </SectionCard>
            </div>
          )}

          {/* Page 16 — Full Financial Twin */}
          {financialTwinFull?.sectionStatus === 'included' && (
            <div className="report-page-break space-y-6">
              <SectionCard title={financialTwinFull.sectionTitle} className="report-section">
                <p className="text-justify text-sm text-gray-600">{financialTwinFull.narrativeText}</p>
                <div className="mt-4">
                  <BulletChart
                    rows={(
                      financialTwinFull.sectionData.metrics as {
                        metricCode: string;
                        label: string;
                        unit: 'currency' | 'percentage' | 'months' | 'ratio' | 'count' | 'days';
                        userValue: number | null;
                        peerValue: number | null;
                        healthyMin: number | null;
                        healthyMax: number | null;
                        comparisonStatus: string | null;
                      }[]
                    ).map(
                      (m): BulletRow => ({
                        label: m.label,
                        userValue: m.userValue,
                        peerValue: m.peerValue,
                        healthyMin: m.healthyMin,
                        healthyMax: m.healthyMax,
                        comparisonStatus: m.comparisonStatus,
                        displayValue: m.userValue === null ? undefined : formatByMetricUnit(m.userValue, m.unit, currency),
                      })
                    )}
                  />
                </div>
                <p className="mt-3 text-justify text-xs text-gray-400">{financialTwinFull.limitationText}</p>
              </SectionCard>
            </div>
          )}

          {/* Page 17 — Full cross-border wealth */}
          {crossBorderFull?.sectionStatus === 'included' && (
            <div className="report-page-break space-y-6">
              <SectionCard title={crossBorderFull.sectionTitle} className="report-section">
                <p className="text-justify text-sm text-gray-600">{crossBorderFull.narrativeText}</p>
              </SectionCard>
              <SectionCard title="Assets by country" className="report-section">
                <ReportAllocationChart
                  slices={((crossBorderFull.sectionData.assetsByCountry as { countryCode: string; value: number }[]) ?? []).map((c) => ({ label: c.countryCode, value: c.value }))}
                  currency={currency}
                />
              </SectionCard>
              <SectionCard title="Investments by country" className="report-section">
                <ReportAllocationChart
                  slices={((crossBorderFull.sectionData.investmentsByCountry as { countryCode: string; value: number }[]) ?? []).map((c) => ({ label: c.countryCode, value: c.value }))}
                  currency={currency}
                />
              </SectionCard>
              <p className="text-justify text-xs text-gray-400">{crossBorderFull.limitationText}</p>
            </div>
          )}

          {/* Page 18 — Stress testing */}
          {stressTesting?.sectionStatus === 'included' && (
            <div className="report-page-break space-y-6">
              <SectionCard title={stressTesting.sectionTitle} className="report-section">
                <p className="mb-4 text-justify text-sm text-gray-600">{stressTesting.narrativeText}</p>
                <table className="w-full text-sm">
                  <thead className="text-left text-xs uppercase text-gray-500">
                    <tr>
                      <th className="py-1">Scenario</th>
                      <th className="py-1">Monthly shortfall</th>
                      <th className="py-1">Estimated survival</th>
                      <th className="py-1">Net worth impact</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(
                      stressTesting.sectionData.scenarios as {
                        label: string;
                        monthlyShortfall: number;
                        survivalMonths: number | null;
                        netWorthImpact: number;
                        applicabilityNote: string | null;
                      }[]
                    ).map((s, i) => (
                      <tr key={i} className="border-t">
                        <td className="py-2">{s.label}</td>
                        {s.applicabilityNote ? (
                          <td className="py-2 text-gray-400" colSpan={3}>
                            {s.applicabilityNote}
                          </td>
                        ) : (
                          <>
                            <td className="py-2">{s.monthlyShortfall > 0 ? fmt(s.monthlyShortfall) : 'No shortfall'}</td>
                            <td className="py-2">{s.survivalMonths === null ? 'Indefinite' : `${s.survivalMonths.toFixed(1)} months`}</td>
                            <td className="py-2">{s.netWorthImpact < 0 ? `-${fmt(Math.abs(s.netWorthImpact))}` : s.netWorthImpact > 0 ? `+${fmt(s.netWorthImpact)}` : 'No change'}</td>
                          </>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="mt-3 text-justify text-xs text-gray-400">{stressTesting.limitationText}</p>
              </SectionCard>
            </div>
          )}

          {/* Page 19 — Personal action plan */}
          {personalActionPlan?.sectionStatus === 'included' && (
            <div className="report-page-break space-y-6">
              <SectionCard title={personalActionPlan.sectionTitle} className="report-section">
                <p className="mb-4 text-justify text-sm text-gray-600">{personalActionPlan.narrativeText}</p>
                <div className="space-y-4">
                  {(
                    personalActionPlan.sectionData.actions as {
                      priority: string;
                      title: string;
                      gapDescription: string;
                      reviewStep: string;
                    }[]
                  ).map((a, i) => (
                    <div key={i} className="rounded border p-3">
                      <div className="flex items-center justify-between">
                        <p className="font-medium text-gray-900">{a.title}</p>
                        <span className="text-xs uppercase text-gray-400">{a.priority} priority</span>
                      </div>
                      <p className="mt-1 text-sm text-gray-600">{a.gapDescription}</p>
                      <p className="mt-1 text-xs text-gray-500">
                        <span className="font-medium text-gray-600">Next step: </span>
                        {a.reviewStep}
                      </p>
                    </div>
                  ))}
                </div>
                <p className="mt-3 text-justify text-xs text-gray-400">{personalActionPlan.limitationText}</p>
              </SectionCard>
            </div>
          )}

          {/* Page 20 — Appendices */}
          {appendices && (
            <div className="report-page-break space-y-6">
              <SectionCard title={appendices.sectionTitle} className="report-section">
                <p className="text-justify text-sm text-gray-600">{appendices.narrativeText}</p>
              </SectionCard>
              {(
                [
                  ['Investments', 'investments', 'investment_name', 'current_value'],
                  ['Insurance policies', 'insurancePolicies', 'policy_name', 'cover_amount'],
                  ['Assets', 'assets', 'asset_name', 'current_value'],
                  ['Liabilities', 'liabilities', 'liability_name', 'balance'],
                  ['Income sources', 'incomeSources', 'source_name', 'amount'],
                  ['Expenses', 'expenseItems', 'expense_name', 'amount'],
                ] as [string, string, string, string][]
              ).map(([title, key, nameField, valueField]) => {
                const rows = (appendices.sectionData[key] as Record<string, unknown>[] | undefined) ?? [];
                if (rows.length === 0) return null;
                return (
                  <SectionCard key={key} title={title} className="report-section">
                    <table className="w-full text-sm">
                      <tbody>
                        {rows.map((row, i) => (
                          <tr key={i} className="border-t">
                            <td className="py-1">{(row[nameField] as string) ?? (row.employer_name as string) ?? '—'}</td>
                            <td className="py-1 text-right">{fmt(row[valueField])}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </SectionCard>
                );
              })}
              <p className="text-justify text-xs text-gray-400">{appendices.limitationText}</p>
            </div>
          )}
        </>
      )}

      {/* Data quality, near the end — after any Premium continuation pages
          and immediately before Methodology/Disclaimer, on both report
          tiers, rather than sitting at the free/Premium boundary
          (previously the case for Premium reports only; Free reports
          already rendered this correctly since they have no Premium
          pages to fall in front of). */}
      <div className="report-page-break space-y-6">
        <p className="report-section text-justify text-sm text-gray-600">
          The accuracy of this report depends on the completeness, quality and timing of the information available to FHIP. This
          page identifies information that may affect the calculations or interpretation of the report.
        </p>
        {dataQuality && (
          <SectionCard title={dataQuality.sectionTitle} className="report-section">
            <p className="text-justify text-sm text-gray-600">{content.dataQualityDefinition('completion')}</p>
            <p className="mt-2 text-sm font-medium text-gray-900">{(dataQuality.sectionData.dataCompletenessPct as number).toFixed(0)}% complete</p>
            <table className="mt-4 w-full text-sm">
              <thead className="text-left text-xs uppercase text-gray-500">
                <tr>
                  <th className="py-1">Area</th>
                  <th className="py-1">Status</th>
                  <th className="py-1">Last Updated</th>
                  <th className="py-1">Report Treatment</th>
                </tr>
              </thead>
              <tbody>
                {(dataQuality.sectionData.rows as { area: string; status: string; lastUpdated: string | null; reportTreatment: string }[]).map((row, i) => (
                  <tr key={i} className="border-t">
                    <td className="py-1">{row.area}</td>
                    <td className="py-1 capitalize">{row.status}</td>
                    <td className="py-1">{row.lastUpdated ? formatDateShort(row.lastUpdated, currency) : 'Not provided'}</td>
                    <td className="py-1">{row.reportTreatment}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {dataQualityRows.some((r) => r.status === 'stale') && <p className="mt-3 text-justify text-xs text-gray-500">{content.dataQualityDefinition('stale')}</p>}
          </SectionCard>
        )}

        {/* Methodology and disclaimer — combined onto the same physical page
            as Data Quality rather than its own separate report-page-break
            group (both are short enough to fit on one page together; forcing
            a hard break between them just to fit compact content used to
            cost a whole extra page for no reason). Always the last page of
            the report, after any Premium continuation pages, rather than
            sitting between the free and Premium content. */}
        {methodology && (
          <SectionCard title={methodology.sectionTitle} className="report-section">
            <p className="text-xs text-gray-500">{content.dataQualityDefinition('versions')}</p>
            <p className="mt-2 text-xs text-gray-500">
              Health Score: {(methodology.sectionData.healthScoreModelVersion as string) ?? '—'} · DNA:{' '}
              {(methodology.sectionData.dnaModelVersion as string) ?? '—'} · Resilience:{' '}
              {(methodology.sectionData.resilienceModelVersion as string) ?? '—'} · Template:{' '}
              {methodology.sectionData.templateVersion as string}
            </p>
            <p className="mt-4 text-justify text-xs text-gray-500">{content.fullDisclaimer}</p>
          </SectionCard>
        )}
      </div>
    </div>
  );
}

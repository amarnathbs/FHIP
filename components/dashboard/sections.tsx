'use client';

import { MetricCard } from '@/components/ui/MetricCard';
import { SectionCard, Stat } from './SectionCard';
import { TrendLineChart, AllocationPieChart } from './charts';
import { formatMoney } from '@/lib/engines/money';
import { formatDateShort } from '@/lib/engines/date';
import { percentChange, type DashboardSummary, type AllocationBucket } from '@/lib/engines/dashboard';

function titleCase(s: string): string {
  return s
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

const BUCKET_LABELS: Record<AllocationBucket, string> = {
  cash: 'Cash',
  property: 'Property',
  shares: 'Shares',
  super: 'Super',
  business: 'Business',
  fixed_income: 'Fixed Income',
  crypto: 'Crypto',
  gold: 'Gold',
  other: 'Other',
};

const RECOMMENDED_ALLOCATION: Record<AllocationBucket, number> = {
  cash: 0.1,
  property: 0.3,
  shares: 0.3,
  super: 0.15,
  fixed_income: 0.1,
  business: 0.02,
  crypto: 0.01,
  gold: 0.02,
  other: 0,
};

function fmtPercent(v: number | null): string {
  return v === null ? '—' : `${(v * 100).toFixed(1)}%`;
}
function fmtMonths(v: number | null): string {
  return v === null ? '—' : `${v.toFixed(1)} mo`;
}
function statusColor(status: 'good' | 'caution' | 'risk' | 'neutral'): 'good' | 'caution' | 'risk' | 'neutral' {
  return status;
}

function snapshotSeries(summary: DashboardSummary, field: 'net_worth' | 'monthly_surplus' | 'total_liabilities') {
  return summary.snapshots.map((s) => ({
    month: new Date(s.snapshot_month).toLocaleDateString('en-AU', { month: 'short', year: '2-digit' }),
    value: Number(s[field]),
  }));
}

export function ExecutiveSummary({ summary }: { summary: DashboardSummary }) {
  const netWorthSeries = snapshotSeries(summary, 'net_worth');
  const prevSnapshot = summary.snapshots.length > 1 ? summary.snapshots[summary.snapshots.length - 2] : null;
  const netWorthChange = prevSnapshot ? percentChange(summary.netWorth, prevSnapshot.net_worth) : null;

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <MetricCard
        label="Net Worth"
        value={formatMoney(summary.netWorth, summary.currency)}
        trend={netWorthChange !== null ? `${netWorthChange >= 0 ? '+' : ''}${(netWorthChange * 100).toFixed(1)}% vs last month` : 'Building history...'}
        status={summary.netWorth >= 0 ? 'good' : 'risk'}
      />
      <MetricCard
        label="Monthly Income"
        value={formatMoney(summary.netMonthlyIncome, summary.currency)}
        trend={`Gross ${formatMoney(summary.grossMonthlyIncome, summary.currency)} · Passive ${formatMoney(summary.passiveMonthlyIncome, summary.currency)}`}
      />
      <MetricCard
        label="Monthly Expenses"
        value={formatMoney(summary.totalMonthlyExpenses + summary.debtMonthlyRepayments, summary.currency)}
        trend={`Essential ${formatMoney(summary.essentialMonthlyExpenses, summary.currency)} · Debt ${formatMoney(summary.debtMonthlyRepayments, summary.currency)}`}
      />
      <MetricCard
        label={summary.monthlySurplus >= 0 ? 'Monthly Surplus' : 'Monthly Deficit'}
        value={formatMoney(Math.abs(summary.monthlySurplus), summary.currency)}
        trend={`Projected annual: ${formatMoney(summary.monthlySurplus * 12, summary.currency)}`}
        status={summary.monthlySurplus >= 0 ? 'good' : 'risk'}
      />
      <MetricCard
        label="Monthly Savings"
        value={formatMoney(Math.max(summary.monthlySurplus, 0), summary.currency)}
        trend={`Savings rate ${fmtPercent(summary.savingsRate)}`}
      />
      <MetricCard
        label="Debt Outstanding"
        value={formatMoney(summary.totalLiabilities, summary.currency)}
        trend={
          summary.averageInterestRate !== null
            ? `Avg rate ${summary.averageInterestRate.toFixed(2)}%`
            : summary.totalLiabilities > 0
              ? 'No interest rate recorded'
              : 'No liabilities recorded'
        }
        status={summary.totalLiabilities > 0 ? 'caution' : 'good'}
      />
      <MetricCard
        label="Investment Portfolio"
        value={formatMoney(summary.totalInvestments, summary.currency)}
        trend={`Unrealised gain ${formatMoney(summary.investmentUnrealisedGain, summary.currency)}`}
        status={summary.investmentUnrealisedGain >= 0 ? 'good' : 'risk'}
      />
      <MetricCard
        label="Retirement Balance"
        value={formatMoney(summary.totalRetirement, summary.currency)}
        trend="Target & funding gap: create a retirement goal on the Financial Goals page"
      />
      <div className="sm:col-span-2 lg:col-span-4">
        <SectionCard title="Net Worth Trend">
          <TrendLineChart data={netWorthSeries} currency={summary.currency} />
        </SectionCard>
      </div>
    </div>
  );
}

export function CashFlowSection({ summary }: { summary: DashboardSummary }) {
  const surplusSeries = snapshotSeries(summary, 'monthly_surplus');
  return (
    <SectionCard
      title="Cash Flow Analysis"
      description="How money moves in and out each month, and where it's going."
    >
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Monthly Inflow" value={formatMoney(summary.netMonthlyIncome, summary.currency)} />
        <Stat
          label="Monthly Outflow"
          value={formatMoney(summary.totalMonthlyExpenses + summary.debtMonthlyRepayments, summary.currency)}
        />
        <Stat label="Cash Flow Ratio" value={summary.cashFlowRatio !== null ? `${summary.cashFlowRatio.toFixed(2)}x` : '—'} />
        <Stat label="Operating Cash Flow" value={formatMoney(summary.operatingCashFlow, summary.currency)} />
        <Stat label="Disposable Income" value={formatMoney(summary.disposableIncome, summary.currency)} />
      </div>
      <div className="mt-6">
        <p className="mb-2 text-sm font-medium text-gray-700">Surplus Trend (last 12 months)</p>
        <TrendLineChart data={surplusSeries} currency={summary.currency} />
      </div>
      <div className="mt-6">
        <p className="mb-2 text-sm font-medium text-gray-700">Largest Expenses</p>
        {summary.topExpenses.length === 0 ? (
          <p className="text-sm text-gray-500">No expenses recorded yet.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {summary.topExpenses.map((e) => (
              <li key={e.name} className="flex justify-between border-b py-1 last:border-0">
                <span className="text-gray-700">{e.name}</span>
                <span className="font-medium text-gray-900">{formatMoney(e.monthlyAmount, summary.currency)}/mo</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="mt-4 text-xs text-gray-400">
        Seasonality, income stability, and AI-generated cash flow insights arrive with Module 10 (AI Coach).
      </p>
    </SectionCard>
  );
}

export function NetWorthSection({ summary }: { summary: DashboardSummary }) {
  const netWorthSeries = snapshotSeries(summary, 'net_worth');
  const allocationSlices = summary.netWorthAllocation.map((s) => ({ label: BUCKET_LABELS[s.bucket], value: s.value }));
  const debtSlices = summary.liabilityByType.map((l) => ({ label: titleCase(l.debtType), value: l.balance }));
  return (
    <SectionCard title="Net Worth Dashboard">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <Stat label="Total Assets" value={formatMoney(summary.totalAssets + summary.totalInvestments + summary.totalRetirement, summary.currency)} />
        <Stat label="Total Liabilities" value={formatMoney(summary.totalLiabilities, summary.currency)} />
        <Stat label="Net Worth" value={formatMoney(summary.netWorth, summary.currency)} />
      </div>
      <div className="mt-6 grid grid-cols-1 gap-6 md:grid-cols-3">
        <div>
          <p className="mb-2 text-sm font-medium text-gray-700">Net Worth Trend</p>
          <TrendLineChart data={netWorthSeries} currency={summary.currency} />
        </div>
        <div>
          <p className="mb-2 text-sm font-medium text-gray-700">Asset Allocation</p>
          <AllocationPieChart slices={allocationSlices} currency={summary.currency} />
        </div>
        <div>
          <p className="mb-2 text-sm font-medium text-gray-700">Debt Composition</p>
          <AllocationPieChart slices={debtSlices} currency={summary.currency} />
        </div>
      </div>
    </SectionCard>
  );
}

export function SavingsAnalyticsSection({ summary }: { summary: DashboardSummary }) {
  const recommendedBuffer = summary.essentialMonthlyExpenses * 6;
  const fiRatio = summary.ratios.find((r) => r.key === 'financial_independence_ratio');
  return (
    <SectionCard title="Savings Analytics">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Monthly Savings" value={formatMoney(Math.max(summary.monthlySurplus, 0), summary.currency)} />
        <Stat label="Annual Savings" value={formatMoney(Math.max(summary.monthlySurplus, 0) * 12, summary.currency)} />
        <Stat label="Savings Rate" value={fmtPercent(summary.savingsRate)} />
        <Stat label="Emergency Fund" value={formatMoney(summary.liquidAssets, summary.currency)} sub={fmtMonths(summary.emergencyFundMonths)} />
        <Stat label="Recommended Buffer" value={formatMoney(recommendedBuffer, summary.currency)} sub="6 months of essentials" />
        <Stat
          label="Financial Independence Progress"
          value={fiRatio ? fmtPercent(fiRatio.value) : '—'}
          sub="Passive income vs expenses"
        />
      </div>
    </SectionCard>
  );
}

export function DebtAnalyticsSection({ summary }: { summary: DashboardSummary }) {
  return (
    <SectionCard title="Debt Analytics">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Total Debt" value={formatMoney(summary.totalLiabilities, summary.currency)} />
        <Stat label="Good Debt" value={formatMoney(summary.goodDebt, summary.currency)} />
        <Stat label="Bad Debt" value={formatMoney(summary.badDebt, summary.currency)} />
        <Stat label="Average Interest Rate" value={summary.averageInterestRate !== null ? `${summary.averageInterestRate.toFixed(2)}%` : '—'} />
        <Stat label="Debt-to-Income" value={summary.debtToIncome !== null ? `${summary.debtToIncome.toFixed(2)}x` : '—'} />
        <Stat label="Debt Service Ratio" value={fmtPercent(summary.debtServiceRatio)} />
      </div>
      {summary.liabilitiesWithPayoff.length > 0 && (
        <div className="mt-6">
          <p className="mb-2 text-sm font-medium text-gray-700">Repayment Progress</p>
          <ul className="space-y-1 text-sm">
            {summary.liabilitiesWithPayoff.map((l, i) => (
              <li key={i} className="flex justify-between border-b py-1 last:border-0">
                <span className="text-gray-700">{titleCase(l.debtType)}</span>
                <span className="font-medium text-gray-900">
                  {formatMoney(l.balance, summary.currency)} ·{' '}
                  {l.monthsToPayoff === null
                    ? 'repayment does not cover interest'
                    : `${Math.floor(l.monthsToPayoff / 12)}y ${l.monthsToPayoff % 12}m to payoff`}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="mt-4 text-xs text-gray-400">
        Create a debt-payoff goal on the Financial Goals page for a debt-free date forecast.
      </p>
    </SectionCard>
  );
}

export function AssetAllocationSection({ summary }: { summary: DashboardSummary }) {
  const total = summary.netWorthAllocation.reduce((s, a) => s + a.value, 0);
  const largest = summary.netWorthAllocation.slice().sort((a, b) => b.value - a.value)[0];
  const concentrationRisk = total > 0 && largest ? largest.value / total : null;
  return (
    <SectionCard
      title="Asset Allocation"
      description="Current mix vs a general rule-of-thumb guideline — see your Financial Twin for a peer-benchmarked comparison."
    >
      <AllocationPieChart
        slices={summary.netWorthAllocation.map((s) => ({ label: BUCKET_LABELS[s.bucket], value: s.value }))}
        currency={summary.currency}
      />
      <table className="mt-4 w-full text-sm">
        <thead className="text-left text-xs uppercase text-gray-500">
          <tr>
            <th className="py-1">Bucket</th>
            <th className="py-1">Current %</th>
            <th className="py-1">Guideline %</th>
          </tr>
        </thead>
        <tbody>
          {summary.netWorthAllocation.map((s) => (
            <tr key={s.bucket} className="border-t">
              <td className="py-1">{BUCKET_LABELS[s.bucket]}</td>
              <td className="py-1">{total > 0 ? fmtPercent(s.value / total) : '—'}</td>
              <td className="py-1">{fmtPercent(RECOMMENDED_ALLOCATION[s.bucket])}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-4 grid grid-cols-2 gap-4">
        <Stat label="Diversification Score" value={summary.investmentDiversificationScore !== null ? `${summary.investmentDiversificationScore}/100` : '—'} />
        <Stat
          label="Concentration Risk"
          value={concentrationRisk !== null ? fmtPercent(concentrationRisk) : '—'}
          sub={concentrationRisk !== null && concentrationRisk > 0.5 ? 'Heavily concentrated' : 'Reasonably spread'}
        />
      </div>
    </SectionCard>
  );
}

export function InvestmentSection({ summary }: { summary: DashboardSummary }) {
  return (
    <SectionCard title="Investment Dashboard">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Portfolio Value" value={formatMoney(summary.totalInvestments, summary.currency)} />
        <Stat label="Cost Base" value={formatMoney(summary.investmentCostBase, summary.currency)} />
        <Stat label="Unrealised Gain" value={formatMoney(summary.investmentUnrealisedGain, summary.currency)} />
        <Stat label="Dividend Income" value={formatMoney(summary.dividendMonthlyIncome * 12, summary.currency)} sub="per year" />
        <Stat label="Dividend Yield" value={fmtPercent(summary.dividendYield)} />
        <Stat label="Diversification Score" value={summary.investmentDiversificationScore !== null ? `${summary.investmentDiversificationScore}/100` : '—'} />
      </div>
      {summary.investmentByCountry.length > 0 && (
        <div className="mt-6">
          <p className="mb-2 text-sm font-medium text-gray-700">Country Allocation</p>
          <AllocationPieChart
            slices={summary.investmentByCountry.map((c) => ({ label: c.countryCode, value: c.value }))}
            currency={summary.currency}
          />
        </div>
      )}
      <p className="mt-4 text-xs text-gray-400">
        Sector allocation, annual return, and risk/volatility metrics arrive with a future benchmarking update.
      </p>
    </SectionCard>
  );
}

export function RetirementSection({ summary }: { summary: DashboardSummary }) {
  return (
    <SectionCard title="Retirement Dashboard">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Current Balance" value={formatMoney(summary.totalRetirement, summary.currency)} />
        <Stat label="Employer Contributions" value={formatMoney(summary.retirementEmployerMonthlyContribution * 12, summary.currency)} sub="per year" />
        <Stat label="Personal Contributions" value={formatMoney(summary.retirementPersonalMonthlyContribution * 12, summary.currency)} sub="per year" />
        <Stat label="Projected Balance" value="—" sub="Create a retirement goal for a projection" />
      </div>
      <p className="mt-4 text-xs text-gray-400">
        Required balance, funding gap, and forecast completion date are available once you create a retirement goal on
        the Financial Goals page. Full retirement-income modelling arrives with a future forecasting update.
      </p>
    </SectionCard>
  );
}

export function InsuranceSection({ summary }: { summary: DashboardSummary }) {
  return (
    <SectionCard title="Insurance Dashboard">
      {summary.insuranceByType.length === 0 ? (
        <p className="text-sm text-gray-500">No insurance policies recorded yet.</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {summary.insuranceByType.map((i) => (
            <li key={i.coverType} className="flex justify-between border-b py-1 last:border-0">
              <span className="text-gray-700">{titleCase(i.coverType)}</span>
              <span className="font-medium text-gray-900">
                Cover {formatMoney(i.coverAmount, summary.currency)} · {formatMoney(i.annualPremium, summary.currency)}/yr
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-4">
        <Stat label="Total Annual Premium" value={formatMoney(summary.totalAnnualPremium, summary.currency)} />
      </div>
      <p className="mt-4 text-xs text-gray-400">
        Gap analysis (recommended cover, under/over-insured, cover adequacy %) arrives with a future update.
      </p>
    </SectionCard>
  );
}

export function FinancialRatiosSection({ summary }: { summary: DashboardSummary }) {
  return (
    <SectionCard title="Financial Ratios">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {summary.ratios.map((r) => (
          <MetricCard
            key={r.key}
            label={r.label}
            value={
              r.value === null
                ? '—'
                : r.format === 'percent'
                  ? fmtPercent(r.value)
                  : r.format === 'months'
                    ? fmtMonths(r.value)
                    : `${r.value.toFixed(2)}x`
            }
            trend={`Benchmark: ${r.benchmarkLabel}`}
            status={statusColor(r.status)}
          />
        ))}
      </div>
    </SectionCard>
  );
}

export function FinancialTimelineSection({ summary }: { summary: DashboardSummary }) {
  return (
    <SectionCard
      title="Financial Timeline"
      description="Upcoming insurance renewals from your data. Loan expiry, tax payments, and investment maturity dates arrive with future modules."
    >
      {summary.upcomingRenewals.length === 0 ? (
        <p className="text-sm text-gray-500">No upcoming renewals recorded.</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {summary.upcomingRenewals.map((r, i) => (
            <li key={i} className="flex justify-between border-b py-1 last:border-0">
              <span className="text-gray-700">{r.policyName}</span>
              <span className="font-medium text-gray-900">{formatDateShort(r.renewalDate, summary.currency)}</span>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

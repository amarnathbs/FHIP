// Level-based (not period-over-period) strength/attention-area detection
// for Report v2 Page 2, per the spec's "Two strengths"/"Two areas requiring
// attention" sections — these must work on a household's very first report
// (no prior snapshot to compare against), unlike the existing movement-based
// commentary in computeMetricMovement, which is comparison-only and
// produces nothing at all until a second snapshot exists.
import type { DashboardSummary } from './dashboard';

export interface Insight {
  code: string;
  title: string;
  explanation: string;
  direction: 'good' | 'bad';
  severity: number; // relative materiality, higher = more important to surface first
}

const EMERGENCY_FUND_TARGET_MONTHS = 4;
const DEBT_SERVICE_RATIO_CONCERN = 0.35;

export function computeKeyInsights(
  d: DashboardSummary,
  currency: 'AUD' | 'INR',
  fmt: (n: number) => string,
  goalsSummary: { activeGoalsCount: number; onTrackCount: number }
): { strengths: Insight[]; attentionAreas: Insight[] } {
  const insights: Insight[] = [];

  if (d.hasIncome || d.hasExpenses) {
    if (d.monthlySurplus > 0) {
      insights.push({
        code: 'surplus',
        title: 'Positive monthly surplus',
        explanation: `Your household retains approximately ${fmt(d.monthlySurplus)} after recorded monthly expenses and commitments. A continuing surplus may support savings, debt reduction and future goals.`,
        direction: 'good',
        severity: Math.min(d.monthlySurplus, 5000),
      });
    } else if (d.hasIncome && d.hasExpenses) {
      insights.push({
        code: 'surplus',
        title: 'Monthly deficit',
        explanation: `Recorded expenses and commitments exceed net monthly income by approximately ${fmt(Math.abs(d.monthlySurplus))}. This may require the household to use savings, additional borrowing or other available funds to meet the difference.`,
        direction: 'bad',
        severity: Math.min(Math.abs(d.monthlySurplus), 5000) + 1000,
      });
    }
  }

  if (d.emergencyFundMonths !== null) {
    if (d.emergencyFundMonths >= EMERGENCY_FUND_TARGET_MONTHS) {
      insights.push({
        code: 'emergency_fund',
        title: 'Emergency savings on track',
        explanation: `Your available emergency funds could cover approximately ${d.emergencyFundMonths.toFixed(1)} months of recorded essential expenses, meeting the ${EMERGENCY_FUND_TARGET_MONTHS}-month reference target. This provides a buffer against unexpected income interruptions or major costs.`,
        direction: 'good',
        severity: d.emergencyFundMonths,
      });
    } else {
      const gapMonths = EMERGENCY_FUND_TARGET_MONTHS - d.emergencyFundMonths;
      insights.push({
        code: 'emergency_fund',
        title: 'Emergency savings below target',
        explanation: `Available liquid funds currently cover approximately ${d.emergencyFundMonths.toFixed(1)} months of essential expenses compared with the ${EMERGENCY_FUND_TARGET_MONTHS}-month target. A lower buffer may make the household more dependent on credit or asset sales during an unexpected event.`,
        direction: 'bad',
        severity: gapMonths * 800,
      });
    }
  }

  if (d.debtServiceRatio !== null && d.debtServiceRatio > 0) {
    if (d.debtServiceRatio <= DEBT_SERVICE_RATIO_CONCERN) {
      insights.push({
        code: 'debt_service',
        title: 'Manageable debt repayments',
        explanation: `Scheduled debt repayments require approximately ${(d.debtServiceRatio * 100).toFixed(0)}% of net monthly income. This leaves capacity for savings and other financial priorities.`,
        direction: 'good',
        severity: (DEBT_SERVICE_RATIO_CONCERN - d.debtServiceRatio) * 3000,
      });
    } else {
      insights.push({
        code: 'debt_service',
        title: 'High debt-repayment pressure',
        explanation: `Scheduled debt repayments require approximately ${(d.debtServiceRatio * 100).toFixed(0)}% of net monthly income, above the ${(DEBT_SERVICE_RATIO_CONCERN * 100).toFixed(0)}% reference level. This may reduce flexibility to absorb an interest-rate rise or income disruption.`,
        direction: 'bad',
        severity: (d.debtServiceRatio - DEBT_SERVICE_RATIO_CONCERN) * 4000,
      });
    }
  }

  if (d.hasAssets || d.hasLiabilities) {
    if (d.netWorth > 0) {
      insights.push({
        code: 'net_worth',
        title: 'Positive net worth',
        explanation: `Recorded assets exceed recorded liabilities by approximately ${fmt(d.netWorth)}. This reflects the household's accumulated financial position at the snapshot date.`,
        direction: 'good',
        severity: Math.min(d.netWorth / 10, 3000),
      });
    } else {
      insights.push({
        code: 'net_worth',
        title: 'Negative net worth',
        explanation: `Recorded liabilities exceed recorded assets by approximately ${fmt(Math.abs(d.netWorth))}. This means the household currently owes more than the value of recorded assets.`,
        direction: 'bad',
        severity: Math.min(Math.abs(d.netWorth) / 10, 3000) + 1500,
      });
    }
  }

  if (goalsSummary.activeGoalsCount > 0) {
    if (goalsSummary.onTrackCount === goalsSummary.activeGoalsCount) {
      insights.push({
        code: 'goals',
        title: 'All active goals being on track',
        explanation: `All ${goalsSummary.activeGoalsCount} of your active goals are currently on track under their approved forecast assumptions.`,
        direction: 'good',
        severity: goalsSummary.activeGoalsCount * 200,
      });
    } else if (goalsSummary.onTrackCount < goalsSummary.activeGoalsCount) {
      const offTrack = goalsSummary.activeGoalsCount - goalsSummary.onTrackCount;
      insights.push({
        code: 'goals',
        title: 'Some goals requiring review',
        explanation:
          offTrack === 1
            ? `1 of your ${goalsSummary.activeGoalsCount} active goals is not currently meeting its required contribution or timing pathway.`
            : `${offTrack} of your ${goalsSummary.activeGoalsCount} active goals are not currently meeting their required contribution or timing pathway.`,
        direction: 'bad',
        severity: offTrack * 500,
      });
    }
  }

  const strengths = insights
    .filter((i) => i.direction === 'good')
    .sort((a, b) => b.severity - a.severity)
    .slice(0, 2);
  const attentionAreas = insights
    .filter((i) => i.direction === 'bad')
    .sort((a, b) => b.severity - a.severity)
    .slice(0, 2);

  return { strengths, attentionAreas };
}

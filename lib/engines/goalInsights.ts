import type { GoalPayload, GoalSummary } from '@/lib/services/goalsData';
import type { AffordabilityResult } from './goalAffordability';

// Deterministic, data-supported observations — never AI-generated. AI may
// later rephrase these, but the underlying facts always come from here.
export function generateGoalInsights(
  goals: GoalPayload[],
  summary: GoalSummary,
  affordability: AffordabilityResult,
  currency: 'AUD' | 'INR'
): string[] {
  const insights: string[] = [];
  const active = goals.filter((g) => g.status === 'active');
  const fmt = (n: number) => new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-AU', { style: 'currency', currency }).format(n);

  for (const g of active) {
    const req = g.forecasts.base.requiredMonthlyContribution;
    if (req !== null && req > g.plannedContributionAmount + 1) {
      const shortfall = req - g.plannedContributionAmount;
      insights.push(`Your ${g.goalName} goal requires an additional ${fmt(shortfall)} per month to remain on track.`);
    }
  }

  for (const g of active) {
    if (g.forecasts.base.trackStatus === 'ahead_of_track' && g.targetDate && g.forecasts.base.projectedCompletionDate) {
      const monthsEarly = Math.round(
        (new Date(g.targetDate).getTime() - new Date(g.forecasts.base.projectedCompletionDate).getTime()) / (1000 * 60 * 60 * 24 * 30)
      );
      if (monthsEarly > 0) {
        insights.push(`Your ${g.goalName} goal is expected to finish ${monthsEarly} month${monthsEarly === 1 ? '' : 's'} early.`);
      }
    }
  }

  const datesWithin18Months = active.filter((g) => {
    if (!g.targetDate) return false;
    const months = (new Date(g.targetDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24 * 30);
    return months > 0 && months <= 18;
  });
  if (datesWithin18Months.length >= 3) {
    insights.push(`${datesWithin18Months.length} goals are scheduled within the same 18-month period.`);
  }

  if (affordability.monthlySurplus !== null && affordability.monthlySurplus > 0 && affordability.usageRatio !== null) {
    const pct = Math.round(affordability.usageRatio * 100);
    if (pct >= 80) {
      insights.push(`Your total goal contribution plan uses ${pct}% of your estimated monthly surplus.`);
    }
  }

  const crossBorderGoals = active.filter((g) => g.forecastLogicKey === 'cross_border');
  for (const g of crossBorderGoals) {
    insights.push(`Your ${g.goalName} goal is exposed to ${g.currencyCode}/reporting-currency movements.`);
  }

  return insights.slice(0, 5);
}

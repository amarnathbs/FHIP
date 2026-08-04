export type AffordabilityStatus = 'comfortable' | 'manageable' | 'tight' | 'overallocated' | 'deficit' | 'insufficient_data';

export interface AffordabilityThresholds {
  comfortableMax: number;
  manageableMax: number;
  tightMax: number;
}

export interface AffordabilityInput {
  monthlySurplus: number | null; // null = cash-flow data incomplete (from the shared dashboard service, never recalculated here)
  totalPlannedGoalContributions: number;
  thresholds: AffordabilityThresholds;
  emergencyFundAtRisk: boolean; // Module 6 resilience signal — informational only, never blocking
}

export interface AffordabilityResult {
  status: AffordabilityStatus;
  monthlySurplus: number | null;
  totalPlannedGoalContributions: number;
  unallocatedAmount: number | null;
  overallocatedAmount: number | null;
  usageRatio: number | null;
  warning: string | null;
}

// Compares planned goal contributions against the household's monthly
// surplus (already computed by the shared dashboard service — never
// recalculated here) and classifies affordability. Never blocks an
// ambitious plan; only explains the shortfall.
export function computeGoalAffordability(input: AffordabilityInput): AffordabilityResult {
  const { monthlySurplus, totalPlannedGoalContributions: totalPlanned, thresholds } = input;

  if (monthlySurplus === null) {
    return {
      status: 'insufficient_data',
      monthlySurplus,
      totalPlannedGoalContributions: totalPlanned,
      unallocatedAmount: null,
      overallocatedAmount: null,
      usageRatio: null,
      warning: 'The goal forecast can be calculated, but affordability cannot be assessed until income and expense information is complete.',
    };
  }

  if (monthlySurplus <= 0) {
    return {
      status: 'deficit',
      monthlySurplus,
      totalPlannedGoalContributions: totalPlanned,
      unallocatedAmount: null,
      overallocatedAmount: totalPlanned,
      usageRatio: null,
      warning: 'Your current data does not show an available monthly surplus. You can still create and explore a goal scenario.',
    };
  }

  const usageRatio = totalPlanned / monthlySurplus;
  if (usageRatio > 1) {
    const over = totalPlanned - monthlySurplus;
    return {
      status: 'overallocated',
      monthlySurplus,
      totalPlannedGoalContributions: totalPlanned,
      unallocatedAmount: 0,
      overallocatedAmount: over,
      usageRatio,
      warning: `Your planned goal contributions exceed your estimated monthly surplus by $${over.toFixed(0)}.`,
    };
  }

  const unallocated = monthlySurplus - totalPlanned;
  const status: AffordabilityStatus =
    usageRatio <= thresholds.comfortableMax ? 'comfortable' : usageRatio <= thresholds.manageableMax ? 'manageable' : 'tight';

  let warning: string | null = null;
  if (status === 'tight') warning = 'Your goal contribution plan uses most of your estimated monthly surplus, leaving little flexibility.';
  if (input.emergencyFundAtRisk && totalPlanned > 0) {
    warning = warning
      ? `${warning} Your current goal plan may also leave limited monthly flexibility under an income-reduction scenario, given your emergency fund position.`
      : 'Your current goal plan may leave limited monthly flexibility under an income-reduction scenario, given your emergency fund position.';
  }

  return {
    status,
    monthlySurplus,
    totalPlannedGoalContributions: totalPlanned,
    unallocatedAmount: unallocated,
    overallocatedAmount: null,
    usageRatio,
    warning,
  };
}

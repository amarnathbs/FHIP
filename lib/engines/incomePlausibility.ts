/**
 * Plausibility of a wage's take-home pay against its gross (PO production audit, 16-10-2026).
 *
 * An income record stores gross and net with ONE frequency. If the two were typed or imported on different period
 * bases (the PO's record: an ANNUAL gross of 196,994.48 beside the net of ONE fortnightly payslip, 3,975.43), the
 * monthly net is silently wrong and every figure built on it (net income, surplus or deficit, savings rate,
 * debt-service ratio, the Cash Flow and Debt scores) is wrong with it. This module only DETECTS the symptom so the
 * Dashboard and the report can say so; it never changes a figure.
 *
 * THRESHOLD, with its rationale: take-home below 30% of gross.
 *   - Australia: the top marginal rate is 45% plus 2% Medicare levy = 47%, so a resident's wage keeps about 53% or
 *     more even at the highest income before any offsets.
 *   - India: the highest slab is 30% plus 4% cess and up to 25-37% surcharge (about 39% effective), plus employee PF
 *     of up to 12%, so a wage keeps about 50% or more.
 *   - Large pre-tax salary sacrifice can lower take-home further, but not below 30% of the pre-sacrifice gross.
 *   So a net under 30% of gross cannot be explained by tax: it means mixed periods, a partial period, or a typo.
 *   Net ABOVE gross is impossible for a wage and is flagged too.
 *
 * Only WAGE-like records are tested (employment salary, bonus, commission, overtime, or anything imported from a
 * payslip). Rental, business and capital-gains "net" figures are after costs or tax by the user's own definition and
 * can legitimately be a small share of gross.
 */

export const MIN_PLAUSIBLE_NET_TO_GROSS = 0.3;

export type NetToGrossAssessment = 'ok' | 'net_far_below_gross' | 'net_above_gross';

/** Both amounts must be on the SAME basis (e.g. both monthly in the reporting currency). */
export function assessNetToGross(gross: number, net: number): NetToGrossAssessment {
  if (!(gross > 0) || !Number.isFinite(gross) || !Number.isFinite(net)) return 'ok';
  if (net > gross * 1.0001 + 0.01) return 'net_above_gross';
  // Round the ratio so "exactly 30%" is allowed whatever the floating-point residue.
  if (Math.round((net / gross) * 10000) / 10000 < MIN_PLAUSIBLE_NET_TO_GROSS) return 'net_far_below_gross';
  return 'ok';
}

const WAGE_MASTER_ITEM_KEYS: ReadonlySet<string> = new Set(['employment_salary', 'bonus', 'commission', 'overtime']);

/** Whether the net-to-gross test applies to this income record. */
export function isWageLikeIncome(masterItemKey: string | null | undefined, sourceType: string | null | undefined): boolean {
  return sourceType === 'payslip_import' || (masterItemKey != null && WAGE_MASTER_ITEM_KEYS.has(masterItemKey));
}

/** One wage record whose take-home is implausible against its gross (monthly, reporting currency). */
export interface NetPlausibilityFlag {
  name: string;
  kind: Exclude<NetToGrossAssessment, 'ok'>;
  grossMonthly: number;
  netMonthly: number;
  /** net / gross */
  netToGross: number;
}

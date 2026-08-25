import { isGoodDebt, isCreditCardDebt } from './dashboard';
import { CONSUMER_DEBT_MASTER_ITEMS, type LinkType } from '@/lib/validation/propertyLiabilityLink';

export interface PropertyLiabilityLinkLite {
  liability_id: string;
  link_type: string;
  is_active: boolean;
  allocation_percent: number;
}

export interface LiabilityLite {
  id: string;
  debt_type: string;
  master_item_key: string | null;
  balance: number;
  currency_code: string;
}

// Canonical, per-liability debt-purpose classification (spec s.27-31,
// s.64 DNA-P01..P04). The relationship is the PREFERRED evidence source --
// only when a liability carries no active link does this fall back to the
// existing, already-approved label-based inference (isGoodDebt /
// isCreditCardDebt, lib/engines/dashboard.ts), unchanged. This function
// introduces NO new scoring thresholds -- it is a classification, not a
// score, and financialDna.ts's PROFILE_DEFINITIONS are untouched by it
// (spec s.27: "feed it improved classification", not a redesign).
export type PropertyDebtPurpose =
  | 'owner_occupied'
  | 'investment_property'
  | 'commercial_property'
  | 'smsf_property'
  | 'property_secured_other'
  | 'consumer'
  | 'unclassified';

const LINK_TYPE_TO_PURPOSE: Record<LinkType, PropertyDebtPurpose> = {
  owner_occupied_mortgage: 'owner_occupied',
  investment_property_loan: 'investment_property',
  commercial_property_loan: 'commercial_property',
  smsf_property_loan: 'smsf_property',
  property_secured_other: 'property_secured_other',
  cross_collateralised: 'property_secured_other',
};

export function classifyLiabilityDebtPurpose(
  liability: LiabilityLite,
  links: PropertyLiabilityLinkLite[]
): PropertyDebtPurpose {
  const activeLinks = links.filter((l) => l.liability_id === liability.id && l.is_active);

  if (activeLinks.length > 0) {
    // Relationship evidence is preferred (spec s.27). If every active link
    // on this liability agrees on a purpose, use it directly; a liability
    // cross-collateralised or otherwise linked to properties of genuinely
    // different purposes collapses to the generic property-secured bucket
    // rather than guessing which purpose "wins" (never blended into a
    // separate, un-categorised total -- spec s.64 DNA-P04 -- it still
    // reads as property-secured debt, just not a single specific purpose).
    const purposes = new Set(activeLinks.map((l) => LINK_TYPE_TO_PURPOSE[l.link_type as LinkType] ?? 'property_secured_other'));
    if (purposes.size === 1) return [...purposes][0];
    return 'property_secured_other';
  }

  // No active relationship -- fall back to the existing approved label
  // inference (spec s.27: "unless other evidence proves otherwise").
  if (isCreditCardDebt(liability.debt_type, liability.master_item_key)) return 'consumer';
  if (liability.master_item_key && CONSUMER_DEBT_MASTER_ITEMS.has(liability.master_item_key)) return 'consumer';
  if (['credit_card', 'personal_loan', 'auto_loan', 'student_loan'].includes(liability.debt_type)) return 'consumer';
  if (isGoodDebt(liability.debt_type, liability.master_item_key)) {
    return liability.master_item_key === 'home_loan' || liability.debt_type === 'mortgage'
      ? 'owner_occupied'
      : 'property_secured_other';
  }
  return 'unclassified';
}

export interface PropertyDebtSummary {
  purpose: PropertyDebtPurpose;
  currencyCode: string;
  liabilityCount: number;
  totalBalance: number;
}

// Household-level breakdown, never blended into one undifferentiated total
// (spec s.64 DNA-P04: "classified separately, never blended into generic
// total debt for debt-purpose analytics") AND never blended across
// currencies (spec s.26: "preserve both original currencies ... use
// existing FX architecture for base-currency analysis" -- this function
// deliberately does NOT convert or sum across currency_code, since doing so
// silently here would double as an uncontrolled, undocumented FX
// conversion; that conversion, if ever needed for a single base-currency
// figure, belongs to the existing reportingValue()/FX architecture in
// lib/engines/dashboard.ts, not to this classification engine). Each
// liability contributes its full balance, in its own currency, to exactly
// one (purpose, currency) bucket.
export function summarizePropertyDebtByPurpose(
  liabilities: LiabilityLite[],
  links: PropertyLiabilityLinkLite[]
): PropertyDebtSummary[] {
  const buckets = new Map<string, PropertyDebtSummary>();
  for (const liability of liabilities) {
    const purpose = classifyLiabilityDebtPurpose(liability, links);
    const key = `${purpose}:${liability.currency_code}`;
    const existing = buckets.get(key);
    if (existing) {
      existing.liabilityCount += 1;
      existing.totalBalance += liability.balance;
    } else {
      buckets.set(key, { purpose, currencyCode: liability.currency_code, liabilityCount: 1, totalBalance: liability.balance });
    }
  }
  return Array.from(buckets.values());
}

// Whether a liability is cross-collateralised (financing more than one
// property) -- context for UI/reports, never a second debt total (spec
// s.32-36: "property link provides context only, never a second debt
// forecast").
export function isCrossCollateralised(liabilityId: string, links: PropertyLiabilityLinkLite[]): boolean {
  const activePropertyLinks = links.filter((l) => l.liability_id === liabilityId && l.is_active);
  return activePropertyLinks.length > 1;
}

export interface PropertyEquity {
  grossValue: number;
  linkedLiabilityBalance: number;
  netEquity: number;
}

// Equity is CALCULATED at render time from the two canonical values, never
// persisted as a second independent amount (spec s.65). allocation_percent
// scales only the portion of a cross-collateralised liability attributed to
// THIS property for a report line -- it never changes the liability's own
// canonical balance.
export function computePropertyEquity(
  propertyValue: number,
  activeLinks: { balance: number; allocation_percent: number }[]
): PropertyEquity {
  const linkedLiabilityBalance = activeLinks.reduce((sum, l) => sum + l.balance * (l.allocation_percent / 100), 0);
  return {
    grossValue: propertyValue,
    linkedLiabilityBalance,
    netEquity: propertyValue - linkedLiabilityBalance,
  };
}

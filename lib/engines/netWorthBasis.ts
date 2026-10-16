/**
 * PERSONAL BASIS for personal-facing figures (PO decision 16-10-2026).
 *
 * The PO's ruling: an amount held by an ENTITY (the SMSF fund's own amounts, a family trust, a company)
 * is not part of any PERSONAL net worth figure and is never any member's balance. It belongs in the
 * entity block and in the CONSOLIDATED FAMILY net worth only (netWorthLevels.ts).
 *
 * This module is the ONE definition of "which register rows are personal". It is pure (no I/O, no
 * imports) so the Dashboard loader, the Twin, the forecast loaders, the register grid and the tests all
 * apply the same rule. It is deliberately identical to netWorthLevels.ts's entityKindOfOwner():
 * `netWorthBasis.test.ts` proves the two cannot drift.
 *
 *   entity-held (NOT personal): owner = 'smsf' | 'family_trust' | 'company'
 *                               the SMSF FUND ROW: the retirement_accounts row the SMSF section creates
 *                               (master_item_key = 'smsf'; it is owned by a person by construction, but it
 *                               is the fund's own net balance, not a member balance)
 *                               a liability linked to an SMSF fund as its property loan (the fund's debt)
 *                               every registered Company / Family Trust / HUF (business_entities)
 *   personal:                   everything else, including genuine personal pension / super accounts
 *                               (owner self / spouse / joint, not the SMSF fund row).
 */

/** The master item key the SMSF section gives its fund row (lib/import-bridge/adapters/retirementAdapter.ts). */
export const SMSF_FUND_MASTER_ITEM_KEY = 'smsf';

export const ENTITY_OWNER_TAGS: ReadonlySet<string> = new Set(['smsf', 'family_trust', 'company']);

/** True for a register-row owner tag that denotes an entity (SMSF, family trust, company). */
export function isEntityOwnerTag(owner: string | null | undefined): boolean {
  return owner !== null && owner !== undefined && ENTITY_OWNER_TAGS.has(owner);
}

/**
 * True when a register row belongs in PERSONAL figures. A liability that is linked to an SMSF fund as
 * its property loan is the fund's debt whatever its owner tag says (LR-12R), so it is not personal.
 * Null / unknown owners are personal (the existing fail-safe direction: never hide a household item).
 */
export function isPersonalBasisRow(
  row: { owner?: string | null; master_item_key?: string | null; masterItemKey?: string | null },
  options: { smsfLinkedLoan?: boolean } = {},
): boolean {
  if (options.smsfLinkedLoan) return false;
  if (isSmsfFundRow(row)) return false;
  return !isEntityOwnerTag(row.owner);
}

/** True for the SMSF section's fund row (master_item_key = 'smsf', either spelling of the field). */
export function isSmsfFundRow(row: { master_item_key?: string | null; masterItemKey?: string | null }): boolean {
  return (row.master_item_key ?? row.masterItemKey) === SMSF_FUND_MASTER_ITEM_KEY;
}

/** Filters a register to its personal rows (same references, order preserved). */
export function personalBasisRows<T extends { owner?: string | null }>(rows: readonly T[]): T[] {
  return rows.filter((r) => isPersonalBasisRow(r));
}

/**
 * The basis the STORED monthly history (financial_snapshots) is kept on. History is deliberately NOT
 * rewritten: it stays on the figure net worth was reported as before this decision, which counts every
 * entity amount ('family_incl_entities'). A live personal figure may only be compared with it when the
 * two coincide for the household.
 */
export type NetWorthHistoryBasis = 'family_incl_entities';

export interface NetWorthBasisInfo {
  /** What summary.netWorth / totalAssets / totalLiabilities / totalRetirement now mean. */
  basis: 'personal';
  /** Entity-held amounts excluded from the personal figures (all in the reporting currency). */
  entityHeld: {
    assets: number;
    investments: number;
    retirement: number;
    liabilities: number;
    registeredEntityValue: number;
    /** Net effect on net worth: what the entity-held amounts added to the previous figure. */
    net: number;
  };
  /** Net worth on the basis stored history is kept on (the figure reported before this decision). */
  history: {
    basis: NetWorthHistoryBasis;
    netWorth: number;
    totalAssets: number;
    totalLiabilities: number;
    /**
     * true when the personal figures equal the history-basis figures (no entity-held amounts), so stored
     * months can be compared with the live personal figure. false = movement is shown on the history
     * basis and labelled, never mixed with the personal figure.
     */
    comparableToPersonal: boolean;
  };
}

/** Plain-language note shown wherever a month-on-month change is not on the personal basis. */
export const NET_WORTH_HISTORY_BASIS_NOTE =
  'Month-on-month history is kept on the basis net worth was reported before 16-10-2026, which includes your SMSF, trust and company amounts. The change shown is on that family basis; it is not compared with the personal figure.';

const near = (a: number, b: number): boolean => Math.abs(a - b) < 0.005;

export function buildNetWorthBasisInfo(
  personal: { netWorth: number; totalAssets: number; totalInvestments: number; totalRetirement: number; totalLiabilities: number; businessEntityOwnershipValue: number },
  history: { netWorth: number; totalAssets: number; totalInvestments: number; totalRetirement: number; totalLiabilities: number; businessEntityOwnershipValue: number },
): NetWorthBasisInfo {
  const historyAssetsTotal = history.totalAssets + history.totalInvestments + history.totalRetirement;
  const personalAssetsTotal = personal.totalAssets + personal.totalInvestments + personal.totalRetirement;
  const comparable =
    near(history.netWorth, personal.netWorth) &&
    near(historyAssetsTotal, personalAssetsTotal) &&
    near(history.totalLiabilities, personal.totalLiabilities) &&
    near(history.businessEntityOwnershipValue, personal.businessEntityOwnershipValue);
  return {
    basis: 'personal',
    entityHeld: {
      assets: history.totalAssets - personal.totalAssets,
      investments: history.totalInvestments - personal.totalInvestments,
      retirement: history.totalRetirement - personal.totalRetirement,
      liabilities: history.totalLiabilities - personal.totalLiabilities,
      registeredEntityValue: history.businessEntityOwnershipValue - personal.businessEntityOwnershipValue,
      net: history.netWorth - personal.netWorth,
    },
    history: {
      basis: 'family_incl_entities',
      netWorth: history.netWorth,
      totalAssets: historyAssetsTotal,
      totalLiabilities: history.totalLiabilities,
      comparableToPersonal: comparable,
    },
  };
}

/**
 * The live net worth figure to put beside STORED history (month-on-month change, history charts, trend
 * metrics). Stored months are on the history basis, so the comparison uses the live figure on the SAME
 * basis. For an entity-free household that is the personal figure itself; for a household with entity
 * amounts it is the family-incl-entities figure and the caller must say so (basis + note).
 */
export function netWorthForHistoryComparison(d: { netWorth: number; netWorthBasis?: Pick<NetWorthBasisInfo, 'history'> }): {
  value: number;
  basis: 'personal' | NetWorthHistoryBasis;
  note: string | null;
} {
  const h = d.netWorthBasis?.history;
  if (!h || h.comparableToPersonal) return { value: d.netWorth, basis: 'personal', note: null };
  return { value: h.netWorth, basis: h.basis, note: NET_WORTH_HISTORY_BASIS_NOTE };
}

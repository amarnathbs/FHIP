/**
 * EntityBalanceSheet: the ONE shape the consolidated family view reads for an entity that records its own assets and liabilities
 * (PO decision 17-10-2026). Today it is built for an SMSF fund from smsf_funds + smsf_holdings + smsf_liabilities (migrations 0289, 0290);
 * Company / Family Trust / HUF follow with the same shape.
 *
 * EITHER-OR, NEVER BOTH. A fund is recorded one of two ways and the sheet reads exactly one of them:
 *   itemised   (smsf_funds.mode = detailed): assets (holdings) and liabilities (the fund's own debts, plus any personal loan still linked as
 *              the fund's property loan, each counted once). The net is DERIVED: assets minus liabilities. A typed net, if a legacy row still
 *              carries one, is IGNORED here (it is reported by the data-quality check, never added).
 *   net_only   (mode = summary): one typed net. Any stray itemised line is IGNORED here.
 *
 * The net may be NEGATIVE (a fund that owes more than it owns). Nothing is clamped: the Retirement-register mirror is floored at zero in the
 * database (a CHECK there forbids negatives), so this sheet, not the mirror, is the family view's source.
 *
 * MISSING != ZERO: a line in a currency that cannot be converted is left out of every figure and counted in `unconvertedCount`.
 *
 * PURE: no I/O. Loader: lib/services/entityBalanceSheetData.ts. Consumer: lib/engines/netWorthLevels.ts.
 */

export type EntitySheetMode = 'itemised' | 'net_only';

export interface SheetLine {
  id: string;
  name: string;
  /** Asset class / liability type label key (for grouping on a statement), or null. */
  kind: string | null;
  lender: string | null;
  amountNative: number;
  currency: string;
  /** Reporting-currency amount; null = cannot be converted (left out, counted). */
  amountReporting: number | null;
  /** Where the line is stored: the fund itself, or a personal liability still linked as the fund's property loan. */
  origin: 'fund' | 'linked_personal_loan';
}

export interface EntityBalanceSheet {
  schemaVersion: 1;
  kind: 'smsf';
  /** smsf_funds.id */
  id: string;
  name: string;
  mode: EntitySheetMode;
  entityCurrency: string;
  reportingCurrency: string;
  assets: SheetLine[];
  liabilities: SheetLine[];
  assetsTotal: number;
  liabilitiesTotal: number;
  /** The typed net in the reporting currency (net_only), else null. */
  typedNet: number | null;
  /** assets minus liabilities (itemised) or the typed net (net_only). Never clamped. */
  net: number;
  unconvertedCount: number;
  /** The fund record's row id in the Retirement register (the database mirrors the net there, floored at zero). */
  retirementRowId: string;
}

export interface SmsfSheetInput {
  fund: {
    id: string;
    name: string;
    mode: 'detailed' | 'summary';
    currency: string;
    retirementAccountId: string;
    /** Typed net in the reporting currency; null when absent or not convertible. */
    typedNetReporting: number | null;
    typedNetPresent: boolean;
  };
  reportingCurrency: string;
  holdings: readonly { id: string; name: string; holdingType: string | null; value: number; currency: string; valueReporting: number | null }[];
  liabilities: readonly { id: string; name: string; type: string | null; lender: string | null; balance: number; currency: string; balanceReporting: number | null }[];
  /** Personal liabilities still linked to this fund as its property loan (legacy; counted once, here). */
  linkedLoans: readonly { id: string; name: string; lender: string | null; balance: number; currency: string; balanceReporting: number | null }[];
}

const cents = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
const finite = (n: number | null): n is number => n !== null && Number.isFinite(n);

export function buildSmsfBalanceSheet(input: SmsfSheetInput): EntityBalanceSheet {
  const { fund } = input;
  const itemised = fund.mode === 'detailed';
  let unconvertedCount = 0;

  let assets: SheetLine[] = [];
  let liabilities: SheetLine[] = [];
  let typedNet: number | null = null;

  if (itemised) {
    assets = input.holdings.map((h) => ({
      id: h.id,
      name: h.name,
      kind: h.holdingType,
      lender: null,
      amountNative: h.value,
      currency: h.currency,
      amountReporting: h.valueReporting,
      origin: 'fund' as const,
    }));
    liabilities = [
      ...input.liabilities.map((l) => ({
        id: l.id,
        name: l.name,
        kind: l.type,
        lender: l.lender,
        amountNative: l.balance,
        currency: l.currency,
        amountReporting: l.balanceReporting,
        origin: 'fund' as const,
      })),
      ...input.linkedLoans.map((l) => ({
        id: l.id,
        name: l.name,
        kind: 'property_loan',
        lender: l.lender,
        amountNative: l.balance,
        currency: l.currency,
        amountReporting: l.balanceReporting,
        origin: 'linked_personal_loan' as const,
      })),
    ];
    for (const line of [...assets, ...liabilities]) if (!finite(line.amountReporting)) unconvertedCount += 1;
  } else {
    // Net value only: the typed net is the whole figure. A missing or unconvertible typed value is counted, not zeroed silently.
    if (finite(fund.typedNetReporting)) typedNet = fund.typedNetReporting;
    else if (fund.typedNetPresent) unconvertedCount += 1;
  }

  const sum = (lines: readonly SheetLine[]) => cents(lines.reduce((s, l) => s + (finite(l.amountReporting) ? l.amountReporting : 0), 0));
  const assetsTotal = itemised ? sum(assets) : 0;
  const liabilitiesTotal = itemised ? sum(liabilities) : 0;
  const net = itemised ? cents(assetsTotal - liabilitiesTotal) : cents(typedNet ?? 0);

  return {
    schemaVersion: 1,
    kind: 'smsf',
    id: fund.id,
    name: fund.name,
    mode: itemised ? 'itemised' : 'net_only',
    entityCurrency: fund.currency,
    reportingCurrency: input.reportingCurrency,
    assets,
    liabilities,
    assetsTotal,
    liabilitiesTotal,
    typedNet: itemised ? null : typedNet,
    net,
    unconvertedCount,
    retirementRowId: fund.retirementAccountId,
  };
}

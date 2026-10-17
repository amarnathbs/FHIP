/**
 * Entity-in-personal-register diagnostics (design slice, 16-10-2026).
 *
 * READ-ONLY and PURE. Looks at the rows a household has entered in the personal registers (Retirement,
 * Liabilities) and reports where SMSF money may be recorded twice, or where a debt that belongs to the
 * SMSF sits among personal liabilities. It changes nothing, hides nothing and decides nothing: every
 * finding is a plain-language prompt to check the entry.
 *
 * WHY (PO household, AUD): the SMSF section holds a fund value of 503,000 AND the Retirement grid holds an
 * "Other Retirement Assets" row of 133,000 owned by the SMSF. Both count in the family net worth
 * (636,000), the SMSF's 370,000 property loan is nowhere, and the real net position is 133,000.
 * Design: docs/architecture/ENTITY_LEVEL_ASSETS_AND_LIABILITIES_DESIGN_2026-10-16.md.
 *
 * Deliberately independent of lib/engines/netWorthLevels.ts / netWorthBasis.ts (another branch is
 * changing those): it only reads raw register rows and adds nothing to any figure.
 */
import { formatMoneyCode } from '@/lib/engines/money';

export interface DiagRetirementRow {
  id: string;
  name: string;
  owner: string | null;
  masterItemKey: string | null;
  balance: number;
  currency: string;
  isActive: boolean;
}

export interface DiagSmsfFund {
  id: string;
  retirementAccountId: string;
  mode: 'summary' | 'detailed';
  isActive: boolean;
  /** The typed net value stored on the fund (smsf_funds.summary_balance), if any. */
  typedNet?: number | null;
  currency?: string;
}

export interface DiagLiabilityRow {
  id: string;
  name: string;
  owner: string | null;
  balance: number;
  currency: string;
  isActive: boolean;
}

export interface EntityRegisterDiagnosticsInput {
  retirement: readonly DiagRetirementRow[];
  funds: readonly DiagSmsfFund[];
  liabilities: readonly DiagLiabilityRow[];
  /** Liability ids linked to an SMSF fund as its property loan (property_liability_links, smsf_property_loan). */
  smsfLinkedLiabilityIds: readonly string[];
}

export type EntityRegisterFindingCode = 'smsf_recorded_twice' | 'smsf_debt_in_personal_liabilities' | 'smsf_itemised_with_typed_net';

export interface EntityRegisterFinding {
  code: EntityRegisterFindingCode;
  /** Which page the finding is most relevant to. */
  pages: readonly ('retirement' | 'liabilities')[];
  title: string;
  message: string;
  rowIds: string[];
  currency: string | null;
  /** Amounts in `currency`; null when the rows are in more than one currency (never added together). */
  amounts: { fundValue?: number; smsfOwnedRows?: number; combined?: number; debts?: number; typedNet?: number } | null;
}

const sum = (xs: readonly number[]): number => Math.round(xs.reduce((a, b) => a + b, 0) * 100) / 100;

function singleCurrency(items: readonly { currency: string }[]): string | null {
  const set = new Set(items.map((i) => i.currency));
  return set.size === 1 ? [...set][0] : null;
}

const money = (amount: number, currency: string): string => formatMoneyCode(amount, currency);

export function diagnoseEntityRegisters(input: EntityRegisterDiagnosticsInput): EntityRegisterFinding[] {
  const findings: EntityRegisterFinding[] = [];

  // ---- 1. The SMSF is recorded in two places in Retirement ----------------------------------------
  // The fund row is the one the SMSF section manages (master item 'smsf'); "SMSF-owned rows" are plain grid
  // rows whose owner is SMSF. Zero balances are ignored: an emptied row is not a duplicate.
  const activeFundRetirementIds = new Set(input.funds.filter((f) => f.isActive).map((f) => f.retirementAccountId));
  const fundRows = input.retirement.filter(
    (r) => r.isActive && r.balance > 0 && (r.masterItemKey === 'smsf' || activeFundRetirementIds.has(r.id)),
  );
  const fundRowIds = new Set(fundRows.map((r) => r.id));
  const ownedRows = input.retirement.filter((r) => r.isActive && r.balance > 0 && r.owner === 'smsf' && !fundRowIds.has(r.id));
  if (fundRows.length > 0 && ownedRows.length > 0) {
    const all = [...fundRows, ...ownedRows];
    const currency = singleCurrency(all);
    const fundValue = currency ? sum(fundRows.map((r) => r.balance)) : undefined;
    const owned = currency ? sum(ownedRows.map((r) => r.balance)) : undefined;
    const combined = currency && fundValue !== undefined && owned !== undefined ? sum([fundValue, owned]) : undefined;
    findings.push({
      code: 'smsf_recorded_twice',
      pages: ['retirement'],
      title: 'Your SMSF is recorded in more than one place',
      message:
        currency && fundValue !== undefined && owned !== undefined && combined !== undefined
          ? `Retirement holds the SMSF fund (${money(fundValue, currency)}) and also ${ownedRows.length === 1 ? 'a row' : `${ownedRows.length} rows`} owned by the SMSF worth ${money(owned, currency)}: ${money(combined, currency)} recorded for what may be one fund. Your family net worth counts the fund's own figures (its assets and liabilities, or its net value) and does NOT add ${ownedRows.length === 1 ? 'that row' : 'those rows'}, which ${ownedRows.length === 1 ? 'is' : 'are'} listed but not counted. Once you have checked the fund's figures, archive ${ownedRows.length === 1 ? 'the row' : 'the rows'} so the fund is recorded once.`
          : `Retirement holds the SMSF fund and also ${ownedRows.length === 1 ? 'a row' : `${ownedRows.length} rows`} owned by the SMSF, in more than one currency. Your family net worth counts the fund's own figures and does NOT add ${ownedRows.length === 1 ? 'that row' : 'those rows'}. Once you have checked the fund, archive ${ownedRows.length === 1 ? 'it' : 'them'} so the fund is recorded once.`,
      rowIds: all.map((r) => r.id),
      currency,
      amounts: currency ? { fundValue, smsfOwnedRows: owned, combined } : null,
    });
  }

  // ---- 2. An SMSF debt among the personal liabilities --------------------------------------------
  const linked = new Set(input.smsfLinkedLiabilityIds);
  const debts = input.liabilities.filter((l) => l.isActive && l.balance > 0 && (l.owner === 'smsf' || linked.has(l.id)));
  if (debts.length > 0) {
    const currency = singleCurrency(debts);
    const total = currency ? sum(debts.map((d) => d.balance)) : undefined;
    const names = debts.map((d) => d.name).join(', ');
    findings.push({
      code: 'smsf_debt_in_personal_liabilities',
      pages: ['liabilities', 'retirement'],
      title: 'An SMSF debt is listed among your liabilities',
      message:
        `${debts.length === 1 ? 'This debt is' : 'These debts are'} marked as belonging to your SMSF but ${debts.length === 1 ? 'is' : 'are'} recorded here with your personal liabilities: ${names}${currency && total !== undefined ? ` (${money(total, currency)})` : ''}. ` +
        `${debts.length === 1 ? 'It belongs' : 'They belong'} to the SMSF, not to you personally, so ${debts.length === 1 ? 'it is' : 'they are'} not part of your personal net worth. ` +
        `Record ${debts.length === 1 ? 'it' : 'them'} on the SMSF itself, under the fund's Liabilities, so the fund's net position is right: a debt that is linked to the fund has a Move into the fund button, and any other debt can be added there and then removed here.`,
      rowIds: debts.map((d) => d.id),
      currency,
      amounts: currency && total !== undefined ? { debts: total } : null,
    });
  }

  // ---- 3. An itemised fund that still carries a typed net value ----------------------------------------------
  for (const f of input.funds) {
    if (f.isActive && f.mode === 'detailed' && f.typedNet !== null && f.typedNet !== undefined) {
      const cur = f.currency ?? 'AUD';
      findings.push({
        code: 'smsf_itemised_with_typed_net',
        pages: ['retirement'],
        title: 'Your SMSF holds a net value and itemised figures',
        message: `The SMSF is recorded as itemised (assets and liabilities), and a net value of ${money(f.typedNet, cur)} typed earlier is still stored on it. Only the itemised figures are counted, so the typed value changes nothing, but a fund should be recorded one way only. Retire the typed value in the SMSF section below (it stays in your history).`,
        rowIds: [f.id],
        currency: cur,
        amounts: { typedNet: f.typedNet },
      });
    }
  }

  return findings;
}

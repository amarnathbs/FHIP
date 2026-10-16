/**
 * How an income record's NET (take-home) figure is arrived at - PO decision 16-10-2026, which deliberately REVERSES
 * the earlier GAP-09 rule ("a blank take-home is unknown and contributes nothing to net income").
 *
 * Order of authority, per record, on the record's OWN pay period (gross, take-home and tax all share the record's
 * `frequency`, so the three can never sit on different period bases):
 *   1. 'entered'           take-home pay typed or imported by the user (net_amount).
 *   2. 'derived_from_tax'  no take-home, but a tax amount per period was entered: net = gross - tax.
 *   3. 'assumed_gross'     neither was provided: the GROSS is treated as take-home (no tax deducted) so every
 *                          calculation can proceed. This is an assumption and is disclosed everywhere it applies
 *                          (Dashboard notice, Income page, Monthly Report) with the names of the sources.
 *
 * Pure, so the read model, the registers-only engine path and the tests all use the one rule.
 */

export type NetBasis = 'entered' | 'derived_from_tax' | 'assumed_gross';

const isAmount = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;

export function resolveNetBasis(
  amount: number,
  netAmount: number | null | undefined,
  taxAmount: number | null | undefined,
): { net: number; basis: NetBasis } {
  const gross = Number(amount);
  const net = netAmount == null ? null : Number(netAmount);
  const tax = taxAmount == null ? null : Number(taxAmount);
  if (net !== null && isAmount(net)) return { net, basis: 'entered' };
  // A tax above the gross (or negative) is invalid input; it is ignored rather than producing a negative net.
  if (tax !== null && isAmount(tax) && tax <= gross) return { net: Math.round((gross - tax) * 100) / 100, basis: 'derived_from_tax' };
  return { net: gross, basis: 'assumed_gross' };
}

export const NET_BASIS_LABELS: Record<NetBasis, string> = {
  entered: 'Take-home pay entered',
  derived_from_tax: 'Take-home worked out as gross minus the tax you entered',
  assumed_gross: 'Gross treated as take-home: no tax deducted',
};

/** One income source whose take-home is the assumed gross (monthly, reporting currency). */
export interface AssumedNetSource {
  name: string;
  grossMonthly: number;
}

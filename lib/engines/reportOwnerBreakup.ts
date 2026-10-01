/**
 * Premium report: owner-class breakup text (2026-10-01, PO decision).
 *
 * "Show everything, in a separate breakup per owner class, with a consolidated line only as a
 * macro summary; entity-owned data is never silently summed into personal totals."
 *
 * The four Investment Intelligence chapters (performance, SIP, X-Ray, tax) are run on the
 * household's NON-ENTITY accounts only when the user has trust / HUF / company holdings
 * (reportSnapshotResolver + ownerClassScope: the certified loaders and engines run unchanged on
 * those accounts' rows). This module writes the sentences that say so and lists every owner
 * class as its own item, followed by the explicit macro line. PURE and presentational: it formats
 * numbers the owner-class breakup already computed; no engine formula is touched.
 */
import { formatMoneyCode } from '@/lib/engines/money';
import type { OwnerBreakup, OwnerClassRow } from '@/lib/services/investment-intelligence/ownerClass';

/** True when at least one trust / HUF / company class exists (so the entity data was kept out of the chapters). */
export function hasEntityClasses(breakup: OwnerBreakup | null | undefined): boolean {
  return !!breakup && breakup.classes.some((c) => c.info.kind === 'entity' || c.info.kind === 'entity_shared');
}

const money = (vs: { currencyCode: string; totalValue: number }[]) => (vs.length === 0 ? 'no positions' : vs.map((v) => formatMoneyCode(v.totalValue, v.currencyCode)).join(' + '));

function classLine(c: OwnerClassRow): string {
  const label = c.info.detail ? `${c.info.label} (${c.info.detail})` : c.info.label;
  const parts = c.ownerAttribution ? ` [${c.ownerAttribution.map((o) => `${o.ownerLabel} ${money(o.valueByCurrency)}`).join(', ')}]` : '';
  const tail = c.info.kind === 'entity' || c.info.kind === 'entity_shared' ? ' (kept separate; not part of your personal figures)' : '';
  return `${label}: ${money(c.valueByCurrency)}${parts}${tail}`;
}

/** The owner-class breakup as one readable paragraph, or null when there is nothing to separate. */
export function ownerBreakupNarrative(breakup: OwnerBreakup | null | undefined): string | null {
  if (!breakup || breakup.classes.length < 2) return null;
  const lines = breakup.classes.map(classLine).join('; ');
  const macro = `${breakup.consolidated.label}: ${money(breakup.consolidated.valueByCurrency)} across ${breakup.consolidated.positionCount} position${breakup.consolidated.positionCount === 1 ? '' : 's'} (each counted once; it is not your personal total)`;
  const scope = hasEntityClasses(breakup) ? ' The performance, recurring-investment, X-Ray and tax chapters of this report cover your personal and joint holdings only.' : '';
  return `Holdings by owner class (each class is complete on its own and is not added to the others): ${lines}. ${macro}.${scope}`;
}

/** One sentence for the SIP / X-Ray / tax / performance limitation text when entity holdings were left out. */
export function entityExclusionNote(breakup: OwnerBreakup | null | undefined): string | null {
  return hasEntityClasses(breakup) ? 'Trust, HUF and company holdings are not included in this chapter; they are listed separately in the owner-class breakup under Investment performance.' : null;
}

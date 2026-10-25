// Document2 (4) WP-B2 (25-10-2026) -- the honest, specific result of Re-evaluate for a position whose rebuilt units do not match the
// statement closing balance (the PO's FTI036 Franklin India Mid Cap case).
//
// PURE. Re-evaluate re-runs the check on the data already held; it cannot add missing history. So the result must say, in numbers:
// what was rebuilt, what the statement says, how far apart they are, where the missing history lies, what will fix it, and that
// there is NO way to accept the gap (a unit mismatch is never downgraded to a warning: certification.ts), rather than leaving a
// one-line message that looks like nothing happened.

export const UPLOAD_SECTION_ID = 'ii-upload-section';

export interface UnitVarianceFacts {
  /** Units rebuilt from the transactions (ii_portfolio_truth_status.reconciled_closing_units). */
  rebuiltUnits: number | string | null;
  /** Units printed on the statement (statement_closing_units). */
  statementUnits: number | string | null;
  /** rebuilt - statement (unit_variance). */
  variance: number | string | null;
  /** Earliest transaction date held for this position (yyyy-mm-dd), or null. */
  earliestTransactionDate: string | null;
  /** Statement date of the closing balance (yyyy-mm-dd), or null. */
  statementAsOf?: string | null;
}

export interface UnitVarianceGuidance {
  /** 'short': fewer units rebuilt than the statement shows (earlier purchases are missing). 'over': more (a sale or switch-out is missing). */
  direction: 'short' | 'over' | 'unknown';
  headline: string;
  /** Plain sentences, in order: the numbers, the missing history, what fixes it, what cannot be done. */
  lines: string[];
  cta: { label: string; targetId: string };
}

const toNumber = (v: number | string | null | undefined): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Units to at most 3 decimals, thousands-separated, trailing zeros trimmed: 70.754, 1,250. */
export function formatUnits(v: number | string | null | undefined): string {
  const n = toNumber(v);
  if (n === null) return 'unknown';
  const fixed = n.toFixed(3).replace(/\.?0+$/, '');
  const [int, frac] = fixed.split('.');
  return `${Number(int).toLocaleString('en-IN')}${frac ? `.${frac}` : ''}`;
}

export function describeUnitVariance(facts: UnitVarianceFacts, date: (iso: string) => string): UnitVarianceGuidance {
  const rebuilt = toNumber(facts.rebuiltUnits);
  const statement = toNumber(facts.statementUnits);
  const variance = toNumber(facts.variance) ?? (rebuilt !== null && statement !== null ? rebuilt - statement : null);
  const direction: UnitVarianceGuidance['direction'] = variance === null ? 'unknown' : variance < 0 ? 'short' : variance > 0 ? 'over' : 'unknown';
  const earliest = facts.earliestTransactionDate ? date(facts.earliestTransactionDate) : null;

  const numbers =
    rebuilt !== null && statement !== null
      ? `Still needs review: the units rebuilt from the transactions (${formatUnits(rebuilt)}) do not match the statement closing balance (${formatUnits(statement)})`
      : 'Still needs review: the units rebuilt from the transactions do not match the statement closing balance';
  const gap = variance === null ? '' : direction === 'short' ? `; ${formatUnits(Math.abs(variance))} units are missing.` : direction === 'over' ? `; the transactions add up to ${formatUnits(Math.abs(variance))} units more than the statement shows.` : '.';

  const lines: string[] = [];
  if (direction === 'short') {
    lines.push(
      earliest
        ? `The earliest transaction held for this position is dated ${earliest}, so the missing history is from before ${earliest}: purchases made earlier are not in the statements uploaded so far.`
        : 'No transaction is held for this position, so its whole history is missing.',
    );
  } else if (direction === 'over') {
    lines.push('A redemption, switch-out or transfer out that reduced the holding is probably missing from the statements uploaded so far.');
  } else {
    lines.push(earliest ? `The earliest transaction held for this position is dated ${earliest}.` : 'No transaction date is held for this position.');
  }
  lines.push('What will fix it: upload a CAMS or KFintech consolidated statement that covers the whole history, from the first investment in this fund to today.');
  lines.push('Re-evaluating only re-runs the check on the data already held; it cannot add missing history, so the result stays the same until that statement is uploaded.');
  lines.push('There is no way to accept this gap: a unit mismatch is never downgraded to a warning, so this position cannot be published until the history is complete.');

  return {
    direction,
    headline: `${numbers}${gap}`,
    lines,
    cta: { label: 'Upload statement', targetId: UPLOAD_SECTION_ID },
  };
}

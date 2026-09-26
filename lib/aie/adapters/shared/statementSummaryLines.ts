/**
 * Statement summary lines that are NOT transactions.
 *
 * Production, 2026-09-26: GPT-4o mini read a bank statement's "Brought
 * forward" row (the opening balance, printed in the transaction table) as a
 * 2,000.00 credit, although the prompt already excluded opening-balance and
 * carried-forward lines. The balance rollforward caught it, but the draft the
 * user saw was wrong. This is the deterministic safety net behind the prompt:
 * a row whose WHOLE description is one of these phrases is a balance or
 * summary line, never money moving.
 *
 * Deliberately anchored to the full description, so real payees that merely
 * contain a word ("Total Energies", "Opening Hours Cafe", "Forward Freight")
 * are never dropped.
 */
const SUMMARY_LINE = new RegExp(
  '^(?:' +
    [
      '(?:balance\\s+)?(?:brought|carried)\\s+(?:forward|fwd)',
      'balance\\s+[bc]\\s*/\\s*f',
      '[bc]\\s*/\\s*f(?:wd)?',
      '(?:opening|closing|previous|starting|ending|new)\\s+balance',
      'balance\\s+(?:at\\s+)?(?:start|end|beginning)(?:\\s+of\\s+(?:period|statement))?',
      'totals?(?:\\s+(?:at|for)\\s+.*)?',
      'sub-?totals?',
    ].join('|') +
    ')[\\s.:]*$',
  'i',
);

export function isStatementSummaryLine(description: string | null | undefined): boolean {
  if (!description) return false;
  return SUMMARY_LINE.test(description.trim());
}

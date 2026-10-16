import { formatMoneyWhole } from '@/lib/engines/money';
import type { DashboardSummary } from '@/lib/engines/dashboard';

/**
 * The Net Worth headline card (PO decision 16-10-2026): INDIVIDUAL-first, with the consolidated family
 * figure beside it. The personal figure is the headline because entity assets are kept separate from
 * the individuals' own figures; the family figure is always one line below, clearly labelled.
 *
 * When the two-level model is unavailable (a balance-sheet section could not be read) this falls back
 * to the single previously reported figure with its original label, never to a guessed number.
 */
export function netWorthHeadline(summary: DashboardSummary): { label: string; value: number; sub: string | null } {
  const levels = summary.netWorthLevels;
  if (!levels) return { label: 'Net Worth', value: summary.netWorth, sub: null };
  const family = formatMoneyWhole(levels.family.net, summary.currency);
  return {
    label: 'Net Worth (personal)',
    value: levels.personal.total.net,
    sub: levels.hasEntities ? `Family level incl. SMSF, trusts and companies: ${family}` : `Family level: ${family} (no entities recorded)`,
  };
}

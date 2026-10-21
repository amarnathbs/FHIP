import '@/lib/serverOnly';
import type { SupabaseClient } from '@supabase/supabase-js';
import { buildCanonicalFinancialSnapshot } from '@/lib/read-models/snapshot';
import { toReporting, type FxContext } from '@/lib/read-models/core/currency';
import { loadSmsfBalanceSheets } from '@/lib/services/entityBalanceSheetData';
import { listSmsfContributionDestinations } from '@/lib/services/smsfContributionDestination';
import { governedBuckets, resolveAccountRates } from '@/lib/retirement-contributions/runRate';
import { listLedgerRows, mapLedgerRow } from '@/lib/retirement-contributions/service';
import type { LedgerRow } from '@/lib/retirement-contributions/types';
import type { FamilySmsfComponentInput, FamilySmsfFund, SmsfContributionSource } from '@/lib/engines/forecast/familyRetirement';

/**
 * Loads the SMSF component of the Family Retirement Forecast (PO-D24-01). See lib/engines/forecast/familyRetirement.ts for the rules.
 *
 * VALUE. The fund's one canonical net, read through the SAME loader the Dashboard family level uses (loadSmsfBalanceSheets ->
 * buildSmsfBalanceSheet): itemised = assets less liabilities (the derived Detailed value, equal to smsf_fund_counted_net), net value
 * only = the typed net. Converted ONCE with the forecast's own FX context (the same one the personal part is converted with).
 *
 * FLOW. The destinations come from the WP-C interface (listSmsfContributionDestinations). Each fund account's contributions are the
 * contribution ledger rows whose destination is smsf and whose status is active, resolved by the SAME series rules (resolveAccountRates)
 * that derive the fund account's own contribution figures, so a payslip repeated every fortnight is one contribution. For a kind of
 * contribution (employer, personal) the ledger holds nothing for, the account's own figure is used. A kind the ledger governs is never
 * also read from the account columns: one flow, one source (LR-FI-3).
 */
export async function loadFamilySmsfComponent(userId: string, client: SupabaseClient, fx: FxContext): Promise<FamilySmsfComponentInput | null> {
  const destinations = await listSmsfContributionDestinations(userId, client);
  if (destinations.length === 0) return null;

  const snapshot = await buildCanonicalFinancialSnapshot(userId, { client: client as never, fx });
  if (snapshot.status !== 'ok') throw new Error('The family retirement position could not be worked out because your financial data could not be read. Try again in a moment.');
  const sheetResult = await loadSmsfBalanceSheets({ userId, supabase: client, snapshot });
  if (sheetResult.sheets === null) throw new Error('The family retirement position could not be worked out because your SMSF records could not be read. Try again in a moment.');
  const sheetByFund = new Map(sheetResult.sheets.map((s) => [s.id, s] as const));

  // The contribution ledger exists only once WP-D's migration is applied. When it is not there, the fund accounts' own figures are used.
  let ledger: LedgerRow[] | null = null;
  try {
    ledger = (await listLedgerRows(userId, client)).map(mapLedgerRow);
  } catch {
    ledger = null;
  }

  const retirementLines = snapshot.retirement.status === 'ok' ? snapshot.retirement.lines : [];
  let unknownFrequencyCount = 0;
  let anyFlow = false;
  const funds: FamilySmsfFund[] = [];
  let unconvertedCount = 0;

  for (const d of destinations) {
    const sheet = sheetByFund.get(d.fundId);
    if (!sheet) continue; // an inactive fund has no sheet: it is not part of the family position
    unconvertedCount += sheet.unconvertedCount;

    const rows = (ledger ?? []).filter((r) => r.retirementAccountId === d.retirementAccountId && r.destinationKind === 'smsf');
    const rate = resolveAccountRates(rows).get(d.retirementAccountId);
    const governed = governedBuckets(rows, d.retirementAccountId);
    const line = retirementLines.find((l) => l.id === d.retirementAccountId);

    const bucket = (kind: 'employer' | 'personal'): number => {
      if (governed.has(kind)) {
        const monthly = kind === 'employer' ? rate?.employerMonthly ?? 0 : rate?.personalMonthly ?? 0;
        return toReporting(monthly, d.currency, fx) ?? 0;
      }
      const figure = kind === 'employer' ? line?.employerContribution : line?.personalContribution;
      if (!figure || figure.amountNative === 0) return 0;
      if (!figure.frequencyKnown) {
        unknownFrequencyCount += 1;
        return 0;
      }
      return figure.monthlyReporting ?? 0;
    };

    unknownFrequencyCount += rate ? rate.excluded.filter((e) => e.reason === 'unknown_frequency').length : 0;
    const monthlyContribution = Math.round((bucket('employer') + bucket('personal') + Number.EPSILON) * 100) / 100;
    if (monthlyContribution !== 0) anyFlow = true;
    funds.push({ id: d.fundId, name: d.fundName, recording: sheet.mode, netReporting: sheet.net, monthlyContribution });
  }

  if (funds.length === 0) return null;
  const contributionSource: SmsfContributionSource = !anyFlow ? 'none' : ledger === null ? 'account_only' : 'ledger_and_account';
  return { funds, unconvertedCount, unknownFrequencyCount, contributionSource };
}

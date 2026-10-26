import type { SupabaseClient } from '@supabase/supabase-js';
import type { CanonicalFinancialSnapshot } from '@/lib/read-models/snapshot';
import { convertToReportingCurrency } from '@/lib/engines/fx';
import { buildSmsfBalanceSheet, type EntityBalanceSheet } from '@/lib/engines/entityBalanceSheet';

/**
 * Loader for the entity balance sheets the consolidated family view reads (PO decision 17-10-2026): an SMSF fund's own assets
 * (smsf_holdings) and liabilities (smsf_liabilities, migration 0289), or its typed net when it is recorded as a net value only.
 *
 * Every amount is converted ONCE at the household's single rate; a line in a currency that cannot be converted is left out and counted
 * (never zeroed). A failed read returns { sheets: null }: the caller then falls back to the register-row path and says so in
 * dataStatus.unavailable, it never reports a figure with a hole in it.
 */

type Client = SupabaseClient;

async function readAll<T>(factory: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>): Promise<{ data: T[]; failed: boolean }> {
  const PAGE = 1000;
  const all: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await factory(from, from + PAGE - 1);
    if (error) return { data: [], failed: true };
    const page = data ?? [];
    all.push(...page);
    if (page.length < PAGE) break;
  }
  return { data: all, failed: false };
}

const supported = (c: string): c is 'AUD' | 'INR' => c === 'AUD' || c === 'INR';

export async function loadSmsfBalanceSheets(args: {
  userId: string;
  supabase: Client;
  snapshot: CanonicalFinancialSnapshot;
}): Promise<{ sheets: EntityBalanceSheet[] | null }> {
  const { userId, supabase, snapshot } = args;
  const reporting = snapshot.fx.reportingCurrency as 'AUD' | 'INR';
  const rate = snapshot.fx.fxRateAudInr;
  const toReporting = (amount: number, currency: string): number | null => (supported(currency) ? convertToReportingCurrency(amount, currency, reporting, rate) : null);

  const funds = await readAll<{ id: string; fund_name: string; mode: 'detailed' | 'summary'; summary_balance: number | string | null; currency_code: string; retirement_account_id: string }>((from, to) =>
    supabase.from('smsf_funds').select('id, fund_name, mode, summary_balance, currency_code, retirement_account_id').eq('user_id', userId).eq('is_active', true).range(from, to),
  );
  if (funds.failed) return { sheets: null };
  if (funds.data.length === 0) return { sheets: [] };

  const [holdings, liabilities, links] = await Promise.all([
    readAll<{ id: string; smsf_fund_id: string; holding_name: string; holding_type: string | null; value: number | string; currency_code: string }>((from, to) =>
      supabase.from('smsf_holdings').select('id, smsf_fund_id, holding_name, holding_type, value, currency_code').eq('user_id', userId).eq('is_active', true).range(from, to),
    ),
    readAll<{ id: string; smsf_fund_id: string; liability_name: string; liability_type: string | null; lender: string | null; balance: number | string; currency_code: string }>((from, to) =>
      supabase.from('smsf_liabilities').select('id, smsf_fund_id, liability_name, liability_type, lender, balance, currency_code').eq('user_id', userId).eq('is_active', true).range(from, to),
    ),
    readAll<{ liability_id: string; linked_retirement_id: string | null }>((from, to) =>
      supabase.from('property_liability_links').select('liability_id, linked_retirement_id').eq('user_id', userId).eq('link_type', 'smsf_property_loan').eq('is_active', true).range(from, to),
    ),
  ]);
  if (holdings.failed || liabilities.failed || links.failed) return { sheets: null };

  const personalLines = new Map(snapshot.liabilities.status === 'ok' ? snapshot.liabilities.lines.map((l) => [l.id, l] as const) : []);

  const sheets = funds.data.map((f) => {
    const typed = f.summary_balance === null || f.summary_balance === undefined ? null : Number(f.summary_balance);
    const linkedIds = links.data.filter((l) => l.linked_retirement_id === f.retirement_account_id).map((l) => l.liability_id);
    return buildSmsfBalanceSheet({
      fund: {
        id: f.id,
        name: f.fund_name,
        mode: f.mode,
        currency: f.currency_code,
        retirementAccountId: f.retirement_account_id,
        typedNetReporting: typed === null ? null : toReporting(typed, f.currency_code),
        typedNetPresent: typed !== null,
      },
      reportingCurrency: reporting,
      holdings: holdings.data
        .filter((h) => h.smsf_fund_id === f.id)
        .map((h) => ({ id: h.id, name: h.holding_name, holdingType: h.holding_type, value: Number(h.value), currency: h.currency_code, valueReporting: toReporting(Number(h.value), h.currency_code) })),
      liabilities: liabilities.data
        .filter((l) => l.smsf_fund_id === f.id)
        .map((l) => ({ id: l.id, name: l.liability_name, type: l.liability_type, lender: l.lender, balance: Number(l.balance), currency: l.currency_code, balanceReporting: toReporting(Number(l.balance), l.currency_code) })),
      linkedLoans: linkedIds
        .map((id) => personalLines.get(id))
        .filter((l): l is NonNullable<typeof l> => Boolean(l))
        .map((l) => ({ id: l.id, name: l.name, lender: null, balance: l.balance.amountNative, currency: l.balance.currency, balanceReporting: l.balance.amountReporting })),
    });
  });
  return { sheets };
}

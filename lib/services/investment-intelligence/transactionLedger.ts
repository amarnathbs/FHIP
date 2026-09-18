// Investment Intelligence — Performance tab Holdings drilldown (2026-09-17).
//
// Builds the full chronological transaction ledger for ONE (account,
// instrument) position, matching the shape of the Product Owner's own
// reference workbook's per-scheme "TX_<code>" tabs: Date, Transaction
// Details, Amount, Units, NAV/Price, running Unit Balance, XIRR Cash Flow,
// then a final "Closing market value" row and the resulting XIRR.
//
// Two things this module deliberately does NOT re-derive from scratch,
// per the task's own instruction to reuse rather than rebuild:
//
//   1. Running-balance sign convention — uses reconciliation.ts's
//      `unitDeltaForTransaction`, the SAME function documentProcessing.ts's
//      certification path already uses to decide whether a position
//      reconciles. A reversal, switch, transfer etc. therefore gets exactly
//      the same signed treatment here as it does in the certified
//      reconciliation engine — never a second, independently-guessed sign
//      rule that could quietly disagree with it.
//
//   2. XIRR cash-flow sign convention and the XIRR calculation itself —
//      uses analyticsRepository.ts's own exported OUTFLOW_TYPES/INFLOW_TYPES
//      classification and engines/investment-intelligence/xirr.ts's `xirr()`
//      directly, the same engine already live on this tab's scheme-level
//      "Your return (XIRR)" column. Given the same DB rows, this produces
//      a bit-identical number to what SchemeTable already shows — the modal
//      is a detail view of that same number, never a second, competing one.

import type { SupabaseClient } from '@supabase/supabase-js';
import { OUTFLOW_TYPES, INFLOW_TYPES } from './analyticsRepository';
import { unitDeltaForTransaction, type ReconciliationTransactionInput } from './reconciliation';
import { xirr, type CashFlow, type XirrResult } from '@/lib/engines/investment-intelligence/xirr';
import type { IiTransactionType } from './types';

export interface LedgerRow {
  transactionId: string;
  date: string; // ISO YYYY-MM-DD
  description: string; // source_description, verbatim (truncated defensively at parse time)
  transactionType: IiTransactionType;
  amount: number; // signed per source convention (as stored — not the XIRR cash-flow sign)
  units: number | null; // magnitude as parsed for direction-known types, pre-signed for passthrough types (see reconciliation.ts)
  navPrice: number | null;
  unitBalanceAfter: number; // running balance after this line, replayed from the opening balance
  xirrCashFlow: number | null; // null for cash-only events (fee/tax/non-reinvested dividend do still get a value — see below), signed per xirr.ts convention
  status: string; // 'parsed' | 'reconciled' | 'corrected' | 'reversed' | 'review_required'
  excludedFromXirr: boolean; // true for 'reversed'/'review_required' rows, matching analyticsRepository's own exclusion
}

export interface TerminalRow {
  date: string;
  description: string; // 'Closing market value'
  amount: number; // positive terminal flow
}

export interface LedgerResult {
  accountId: string;
  instrumentId: string;
  instrumentName: string;
  folioNumber: string | null;
  currencyCode: string;
  openingUnitsScaled: string | null; // decimal string, for display/debugging only
  rows: LedgerRow[];
  terminal: TerminalRow | null;
  investorXirr: XirrResult;
  methodologyNote: string;
}

/** Matches the Notes tab's own wording exactly, per the task brief. */
export const XIRR_METHODOLOGY_NOTE =
  'Transaction amounts are treated as negative cash flows, including reversals as positive flows when shown in brackets. Closing market value is the positive terminal cash flow on the NAV date.';

interface TxRow {
  id: string;
  transaction_type: string;
  transaction_date: string;
  gross_amount: number;
  units: number | null;
  price_per_unit: number | null;
  source_description: string | null;
  status: string;
}

function toCashFlowAmount(type: string, amount: number): number | null {
  const abs = Math.abs(amount);
  if (OUTFLOW_TYPES.has(type)) return -abs;
  if (INFLOW_TYPES.has(type)) return abs;
  return null; // transfer/merger/adjustment/reversal/unclassified/etc — no investor cash impact (see analyticsRepository.ts)
}

/**
 * Loads and replays the full transaction history for one (account,
 * instrument) position. `userId` MUST come from the authenticated session —
 * the caller's Supabase client is the RLS-respecting request client, so a
 * mismatched accountId/instrumentId simply yields zero rows rather than
 * another user's data.
 */
export async function buildTransactionLedger(
  supabase: SupabaseClient,
  userId: string,
  accountId: string,
  instrumentId: string
): Promise<LedgerResult | null> {
  const { data: account } = await supabase
    .from('ii_accounts')
    .select('id, folio_number, currency_code')
    .eq('id', accountId)
    .eq('user_id', userId)
    .maybeSingle();
  if (!account) return null;

  const { data: instrument } = await supabase
    .from('ii_instruments')
    .select('id, instrument_name')
    .eq('id', instrumentId)
    .maybeSingle();
  if (!instrument) return null;

  const { data: txRows, error: txErr } = await supabase
    .from('ii_transactions')
    .select('id, transaction_type, transaction_date, gross_amount, units, price_per_unit, source_description, status')
    .eq('user_id', userId)
    .eq('account_id', accountId)
    .eq('instrument_id', instrumentId)
    .order('transaction_date', { ascending: true })
    .order('id', { ascending: true });
  if (txErr) throw new Error(`Failed to load transaction ledger: ${txErr.message}`);

  const { data: latestSnapshot } = await supabase
    .from('ii_holding_snapshots')
    .select('as_of_date, units, value')
    .eq('user_id', userId)
    .eq('account_id', accountId)
    .eq('instrument_id', instrumentId)
    .order('as_of_date', { ascending: false })
    .limit(1)
    .maybeSingle();

  let runningBalance = 0;
  const rows: LedgerRow[] = [];
  const cashFlows: CashFlow[] = [];

  for (const t of (txRows ?? []) as TxRow[]) {
    const canonicalType = t.transaction_type as IiTransactionType;
    const unitsNum = t.units === null ? null : Number(t.units);
    const reconciliationInput: ReconciliationTransactionInput = {
      canonicalType,
      unitsScaled: unitsNum === null ? null : BigInt(Math.round(unitsNum * 1_000_000)), // scale matches decimal.ts's 6dp convention; only the sign/magnitude relationship matters here, not absolute precision beyond display
    };
    const deltaScaled = unitDeltaForTransaction(reconciliationInput);
    const delta = Number(deltaScaled) / 1_000_000;
    runningBalance += delta;

    const excluded = t.status === 'reversed' || t.status === 'review_required';
    const cfAmount = toCashFlowAmount(canonicalType, Number(t.gross_amount));
    const date = new Date(`${t.transaction_date}T00:00:00.000Z`);
    if (!excluded && cfAmount !== null) {
      cashFlows.push({ date, amount: cfAmount });
    }

    rows.push({
      transactionId: t.id,
      date: t.transaction_date,
      description: t.source_description ?? '',
      transactionType: canonicalType,
      amount: Number(t.gross_amount),
      units: unitsNum,
      navPrice: t.price_per_unit === null ? null : Number(t.price_per_unit),
      unitBalanceAfter: runningBalance,
      xirrCashFlow: excluded ? null : cfAmount,
      status: t.status,
      excludedFromXirr: excluded,
    });
  }

  let terminal: TerminalRow | null = null;
  if (latestSnapshot && Number(latestSnapshot.value) > 0) {
    const terminalDate = new Date(`${latestSnapshot.as_of_date}T00:00:00.000Z`);
    cashFlows.push({ date: terminalDate, amount: Number(latestSnapshot.value) });
    terminal = {
      date: latestSnapshot.as_of_date as string,
      description: 'Closing market value',
      amount: Number(latestSnapshot.value),
    };
  }

  const investorXirr = xirr(cashFlows);

  return {
    accountId,
    instrumentId,
    instrumentName: instrument.instrument_name as string,
    folioNumber: (account.folio_number as string | null) ?? null,
    currencyCode: account.currency_code as string,
    openingUnitsScaled: null,
    rows,
    terminal,
    investorXirr,
    methodologyNote: XIRR_METHODOLOGY_NOTE,
  };
}

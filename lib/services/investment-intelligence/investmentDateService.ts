// Investment date for a holdings-only position (Document2 defect D-3, PO
// decision 2026-10-03) -- the I/O half of lib/investment-intelligence/investmentDate.ts.
//
// WHAT HAPPENS WHEN THE USER ANSWERS
//   1. The account must be the caller's, and the position must really be
//      holdings-only (a holding, no usable transaction).
//   2. The date is validated (real, day-first, not future, not before the
//      fund's first known NAV, not after the statement date).
//   3. The answer is recorded in ii_investment_date_inputs with provenance
//      'user_supplied' (migration 0250). Changing the date SUPERSEDES the old
//      row; the old derived purchase is reversed (soft, never deleted).
//   4. The NAV on / just before that date is read from ii_prices_nav -- the
//      same table the report and performance use. If there is one, ONE
//      'purchase' row (units = the units held, price = that NAV) is written to
//      ii_transactions with source_reference USER_INVESTMENT_DATE:<id>, so
//      every existing reader computes exactly as if a statement had carried
//      the date. If there is none yet the input waits as 'awaiting_nav'.
//   5. One 'user_correction' audit event (kind investment_date_supplied).
//
// NO PARALLEL NAV PIPELINE. This module fetches nothing from any provider. The
// scheduled selective hydration job (migration 0193) already treats every
// held instrument as needing its history from inception (migration 0189), so
// the fund's NAV for the date arrives through that existing path; a position
// waiting on it is completed by applyPendingInvestmentDates() the next time
// the list is read. (A user-triggered immediate fetch is deliberately not
// built; see the report's open questions.)
//
// OWNERSHIP IS UNTOUCHED: the derived row hangs off the same account, and
// nothing here reads or writes ii_ownership_allocation / owner columns.
//
// Every query is filtered by user_id; the caller passes the service-role
// client (ii_transactions and the new table have no authenticated write
// policy), so that filter IS the tenancy boundary.

import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase/admin';
import { fetchAllRows } from './pagination';
import { emitAuditEvent } from './audit';
import {
  NAV_MAX_STALE_DAYS,
  USER_INVESTMENT_DATE_PROVENANCE,
  deriveInvestmentDatePurchase,
  isUserSuppliedInvestmentDateReference,
  needsInvestmentDate,
  pickNavForInvestmentDate,
  userInvestmentDateReference,
  validateInvestmentDate,
  type InvestmentDateErrorCode,
  type InvestmentDateItemState,
} from '@/lib/investment-intelligence/investmentDate';

type Db = Pick<SupabaseClient, 'from'>;

export interface InvestmentDateItem {
  accountId: string;
  instrumentId: string;
  schemeName: string;
  isin: string | null;
  /** Masked: an identifier is never printed in full on a summary screen. */
  maskedFolio: string | null;
  institutionName: string | null;
  currencyCode: string;
  units: number;
  statementAsOfDate: string;
  /** Value on the statement date, shown for orientation only. Never used as the cost. */
  statementValue: number | null;
  state: InvestmentDateItemState;
  /** ISO. Null while the state is 'needs_date'. */
  investmentDate: string | null;
  inputId: string | null;
  navPrice: number | null;
  navDate: string | null;
  /** Earliest NAV the product has for this fund (ISO), when confirmed. Shown as a hint, used for validation. */
  earliestKnownNavDate: string | null;
}

export type SubmitInvestmentDateResult =
  | { ok: true; state: 'applied' | 'awaiting_nav'; inputId: string; investmentDate: string; unchanged: boolean }
  | { ok: false; status: 404 | 409 | 422 | 500; code: InvestmentDateErrorCode | 'account_not_found' | 'no_holding' | 'not_holdings_only' | 'write_failed'; message: string };

function maskFolioForDisplay(folio: string | null): string | null {
  if (!folio) return null;
  const chars = Array.from(folio);
  if (chars.length <= 4) return `${'*'.repeat(Math.max(chars.length - 1, 0))}${chars[chars.length - 1] ?? ''}`;
  return `${'*'.repeat(chars.length - 4)}${chars.slice(-4).join('')}`;
}

function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

interface InputRow {
  id: string;
  user_id: string;
  account_id: string;
  instrument_id: string;
  investment_date: string;
  status: 'awaiting_nav' | 'applied' | 'superseded';
  units_at_capture: number | string;
  nav_price: number | string | null;
  nav_date: string | null;
  derived_transaction_id: string | null;
}

async function loadActiveInputs(db: Db, userId: string): Promise<InputRow[]> {
  const { data, error } = await db
    .from('ii_investment_date_inputs')
    .select('id, user_id, account_id, instrument_id, investment_date, status, units_at_capture, nav_price, nav_date, derived_transaction_id')
    .eq('user_id', userId)
    .in('status', ['awaiting_nav', 'applied']);
  if (error) throw new Error(`ii_investment_date_inputs: ${error.message}`);
  return (data ?? []) as unknown as InputRow[];
}

async function loadNavForDate(db: Db, instrumentId: string, dateIso: string) {
  const { data, error } = await db
    .from('ii_prices_nav')
    .select('price_date, price')
    .eq('instrument_id', instrumentId)
    .lte('price_date', dateIso)
    .gte('price_date', addDaysIso(dateIso, -NAV_MAX_STALE_DAYS))
    .neq('quality_status', 'superseded')
    .order('price_date', { ascending: false })
    .limit(3);
  if (error) throw new Error(`ii_prices_nav: ${error.message}`);
  const rows = (data ?? []) as unknown as Array<{ price_date: string; price: number | string }>;
  return pickNavForInvestmentDate(rows.map((r) => ({ date: r.price_date, price: Number(r.price) })), dateIso);
}

async function loadEarliestKnownNavDate(db: Db, instrumentId: string): Promise<string | null> {
  const { data } = await db.from('ii_nav_history_floors').select('floor_date').eq('instrument_id', instrumentId).maybeSingle();
  return ((data as { floor_date?: string } | null)?.floor_date as string | undefined) ?? null;
}

/**
 * Turn a saved date into the derived purchase, once a NAV for it is on file.
 * Idempotent: an existing row carrying this input's marker is linked, never
 * duplicated, so a retry after a half-finished attempt cannot double count.
 */
async function applyInput(db: Db, userId: string, input: InputRow, currencyCode: string): Promise<'applied' | 'awaiting_nav' | 'failed'> {
  const nav = await loadNavForDate(db, input.instrument_id, input.investment_date);
  if (!nav) return 'awaiting_nav';
  const units = Number(input.units_at_capture);
  const purchase = deriveInvestmentDatePurchase({ units, navPrice: nav.price });
  if (!purchase) return 'failed';

  const reference = userInvestmentDateReference(input.id);
  let transactionId: string | null = input.derived_transaction_id;
  if (!transactionId) {
    const { data: existing } = await db
      .from('ii_transactions')
      .select('id')
      .eq('user_id', userId)
      .eq('account_id', input.account_id)
      .eq('source_reference', reference)
      .maybeSingle();
    transactionId = (existing as { id?: string } | null)?.id ?? null;
  }
  if (!transactionId) {
    transactionId = randomUUID();
    const { error } = await db.from('ii_transactions').insert({
      id: transactionId,
      user_id: userId,
      account_id: input.account_id,
      instrument_id: input.instrument_id,
      source_document_id: null,
      currency_code: currencyCode,
      status: 'parsed',
      transaction_type: 'purchase',
      transaction_date: input.investment_date,
      units: purchase.units,
      price_per_unit: purchase.pricePerUnit,
      gross_amount: purchase.grossAmount,
      source_reference: reference,
      parser_code: 'user_supplied_investment_date',
      source_description: 'Investment date supplied by the user; the amount is the units held multiplied by the fund price on that date, not a statement line.',
    });
    if (error) return 'failed';
  }
  const { error: linkError } = await db
    .from('ii_investment_date_inputs')
    .update({ status: 'applied', derived_transaction_id: transactionId, nav_price: nav.price, nav_date: nav.date, updated_at: new Date().toISOString() })
    .eq('id', input.id)
    .eq('user_id', userId);
  return linkError ? 'failed' : 'applied';
}

/** Complete every saved date that was waiting for price history. Safe to call on every read. */
export async function applyPendingInvestmentDates(userId: string, db: Db = createAdminClient()): Promise<{ applied: number; stillWaiting: number }> {
  const waiting = (await loadActiveInputs(db, userId)).filter((r) => r.status === 'awaiting_nav');
  let applied = 0;
  let stillWaiting = 0;
  for (const input of waiting) {
    const { data: account } = await db.from('ii_accounts').select('currency_code').eq('id', input.account_id).eq('user_id', userId).maybeSingle();
    const currency = (account as { currency_code?: string } | null)?.currency_code;
    if (!currency) {
      stillWaiting++;
      continue;
    }
    const outcome = await applyInput(db, userId, input, currency);
    if (outcome === 'applied') applied++;
    else stillWaiting++;
  }
  return { applied, stillWaiting };
}

/** Holdings-only positions (and ones the user already answered), for the call-to-action panel. */
export async function listInvestmentDateItems(userId: string, db: Db = createAdminClient()): Promise<InvestmentDateItem[]> {
  await applyPendingInvestmentDates(userId, db);

  const accounts = await fetchAllRows<{ id: string; folio_number: string | null; institution_name: string | null; currency_code: string }>(() =>
    db.from('ii_accounts').select('id, folio_number, institution_name, currency_code').eq('user_id', userId).order('id', { ascending: true }) as never
  );
  if (accounts.length === 0) return [];
  const accountById = new Map(accounts.map((a) => [a.id, a]));

  const snapshotRows = await fetchAllRows<{ id: string; account_id: string; instrument_id: string; as_of_date: string; units: number | string; value: number | string | null }>(() =>
    db.from('ii_holding_snapshots').select('id, account_id, instrument_id, as_of_date, units, value').eq('user_id', userId).order('as_of_date', { ascending: true }).order('id', { ascending: true }) as never
  );
  const latest = new Map<string, (typeof snapshotRows)[number]>();
  for (const s of snapshotRows) {
    if (!accountById.has(s.account_id)) continue;
    latest.set(`${s.account_id}:${s.instrument_id}`, s); // ascending order: the last one wins
  }
  if (latest.size === 0) return [];

  const txRows = await fetchAllRows<{ account_id: string; instrument_id: string; transaction_type: string; status: string; source_reference: string | null }>(() =>
    db.from('ii_transactions').select('account_id, instrument_id, transaction_type, status, source_reference').eq('user_id', userId).order('id', { ascending: true }) as never
  );
  const txByPosition = new Map<string, Array<{ type: string; status: string; sourceReference: string | null }>>();
  for (const t of txRows) {
    const key = `${t.account_id}:${t.instrument_id}`;
    if (!latest.has(key)) continue;
    const list = txByPosition.get(key) ?? [];
    list.push({ type: t.transaction_type, status: t.status, sourceReference: t.source_reference });
    txByPosition.set(key, list);
  }

  const inputs = await loadActiveInputs(db, userId);
  const inputByPosition = new Map(inputs.map((i) => [`${i.account_id}:${i.instrument_id}`, i]));

  const instrumentIds = [...new Set([...latest.values()].map((s) => s.instrument_id))];
  const { data: instrumentData, error: instrumentError } = await db.from('ii_instruments').select('id, instrument_name, isin, instrument_class').in('id', instrumentIds);
  if (instrumentError) throw new Error(`ii_instruments: ${instrumentError.message}`);
  const instruments = new Map(((instrumentData ?? []) as unknown as Array<{ id: string; instrument_name: string; isin: string | null; instrument_class: string }>).map((i) => [i.id, i]));
  const { data: masterData } = await db.from('ii_scheme_master').select('instrument_id, scheme_name').in('instrument_id', instrumentIds).is('effective_to', null);
  const canonicalName = new Map(((masterData ?? []) as unknown as Array<{ instrument_id: string; scheme_name: string }>).map((r) => [r.instrument_id, r.scheme_name]));

  const items: InvestmentDateItem[] = [];
  for (const [key, snap] of latest) {
    const instrument = instruments.get(snap.instrument_id);
    if (!instrument || instrument.instrument_class !== 'mutual_fund') continue;
    const input = inputByPosition.get(key) ?? null;
    const account = accountById.get(snap.account_id)!;
    const txns = txByPosition.get(key) ?? [];
    // The derived purchase row is the product's own doing: it must not stop
    // the position being recognised as the holdings-only one it is.
    const statementTxns = txns.filter((t) => !isUserSuppliedInvestmentDateReference(t.sourceReference));
    const holdingsOnly = needsInvestmentDate({ snapshotUnits: Number(snap.units), transactions: statementTxns, hasActiveInput: false });
    if (!holdingsOnly) continue;

    const state: InvestmentDateItemState = !input ? 'needs_date' : input.status === 'applied' ? 'applied' : 'awaiting_nav';
    items.push({
      accountId: snap.account_id,
      instrumentId: snap.instrument_id,
      schemeName: canonicalName.get(snap.instrument_id) ?? instrument.instrument_name,
      isin: instrument.isin,
      maskedFolio: maskFolioForDisplay(account.folio_number),
      institutionName: account.institution_name,
      currencyCode: account.currency_code,
      units: Number(snap.units),
      statementAsOfDate: snap.as_of_date,
      statementValue: snap.value === null || snap.value === undefined ? null : Number(snap.value),
      state,
      investmentDate: input ? input.investment_date : null,
      inputId: input ? input.id : null,
      navPrice: input && input.nav_price !== null ? Number(input.nav_price) : null,
      navDate: input ? input.nav_date : null,
      earliestKnownNavDate: await loadEarliestKnownNavDate(db, snap.instrument_id),
    });
  }
  items.sort((a, b) => a.schemeName.localeCompare(b.schemeName));
  return items;
}

export async function submitInvestmentDate(args: {
  userId: string;
  accountId: string;
  instrumentId: string;
  dateText: string | null | undefined;
  todayIso: string;
  db?: Db;
}): Promise<SubmitInvestmentDateResult> {
  const db = args.db ?? createAdminClient();
  const { userId, accountId, instrumentId } = args;

  const { data: account } = await db.from('ii_accounts').select('id, currency_code').eq('id', accountId).eq('user_id', userId).maybeSingle();
  if (!account) return { ok: false, status: 404, code: 'account_not_found', message: 'That investment could not be found.' };
  const currencyCode = (account as { currency_code: string }).currency_code;

  const { data: snapshot } = await db
    .from('ii_holding_snapshots')
    .select('id, as_of_date, units')
    .eq('user_id', userId)
    .eq('account_id', accountId)
    .eq('instrument_id', instrumentId)
    .order('as_of_date', { ascending: false })
    .limit(1)
    .maybeSingle();
  const snap = snapshot as { id: string; as_of_date: string; units: number | string } | null;
  if (!snap || !(Number(snap.units) > 0)) return { ok: false, status: 422, code: 'no_holding', message: 'There is no holding on record for this investment.' };

  const txRows = await fetchAllRows<{ transaction_type: string; status: string; source_reference: string | null }>(() =>
    db.from('ii_transactions').select('transaction_type, status, source_reference').eq('user_id', userId).eq('account_id', accountId).eq('instrument_id', instrumentId).order('id', { ascending: true }) as never
  );
  const statementTxns = txRows.filter((t) => !isUserSuppliedInvestmentDateReference(t.source_reference)).map((t) => ({ type: t.transaction_type, status: t.status, sourceReference: t.source_reference }));
  if (!needsInvestmentDate({ snapshotUnits: Number(snap.units), transactions: statementTxns, hasActiveInput: false })) {
    return { ok: false, status: 409, code: 'not_holdings_only', message: 'This investment already has transactions from a statement, so it does not need an investment date.' };
  }

  const inceptionIso = await loadEarliestKnownNavDate(db, instrumentId);
  const validation = validateInvestmentDate({ text: args.dateText, todayIso: args.todayIso, inceptionIso, statementAsOfIso: snap.as_of_date });
  if (!validation.ok) return { ok: false, status: 422, code: validation.code, message: validation.message };

  const active = (await loadActiveInputs(db, userId)).find((i) => i.account_id === accountId && i.instrument_id === instrumentId) ?? null;
  if (active && active.investment_date === validation.iso) {
    // Same answer again: nothing to change; finish it if it was waiting.
    const state = active.status === 'applied' ? 'applied' : await applyInput(db, userId, active, currencyCode);
    return { ok: true, state: state === 'applied' ? 'applied' : 'awaiting_nav', inputId: active.id, investmentDate: active.investment_date, unchanged: true };
  }

  const nowIso = new Date().toISOString();
  if (active) {
    // Fail safe: take the old purchase OUT of the analysis first. If a later
    // step fails the position simply asks again, it can never count twice.
    if (active.derived_transaction_id) {
      const { error } = await db.from('ii_transactions').update({ status: 'reversed' }).eq('id', active.derived_transaction_id).eq('user_id', userId);
      if (error) return { ok: false, status: 500, code: 'write_failed', message: 'Could not change the date. Nothing was changed.' };
    }
    const { error } = await db
      .from('ii_investment_date_inputs')
      .update({ status: 'superseded', supersede_reason: 'user_changed_date', updated_at: nowIso })
      .eq('id', active.id)
      .eq('user_id', userId);
    if (error) return { ok: false, status: 500, code: 'write_failed', message: 'Could not change the date. Nothing was changed.' };
  }

  const inputId = randomUUID();
  const { error: insertError } = await db.from('ii_investment_date_inputs').insert({
    id: inputId,
    user_id: userId,
    account_id: accountId,
    instrument_id: instrumentId,
    investment_date: validation.iso,
    provenance: USER_INVESTMENT_DATE_PROVENANCE,
    status: 'awaiting_nav',
    units_at_capture: Number(snap.units),
    snapshot_id: snap.id,
    snapshot_as_of_date: snap.as_of_date,
    created_by: userId,
  });
  if (insertError) return { ok: false, status: 500, code: 'write_failed', message: 'Could not save the date. Please try again.' };

  const created: InputRow = {
    id: inputId,
    user_id: userId,
    account_id: accountId,
    instrument_id: instrumentId,
    investment_date: validation.iso,
    status: 'awaiting_nav',
    units_at_capture: Number(snap.units),
    nav_price: null,
    nav_date: null,
    derived_transaction_id: null,
  };
  const outcome = await applyInput(db, userId, created, currencyCode);

  await emitAuditEvent({
    userId,
    eventType: 'user_correction',
    subjectType: 'ii_investment_date_inputs',
    subjectId: inputId,
    actorType: 'user',
    actorId: userId,
    metadata: {
      kind: 'investment_date_supplied',
      provenance: USER_INVESTMENT_DATE_PROVENANCE,
      accountId,
      instrumentId,
      investmentDate: validation.iso,
      previousInvestmentDate: active ? active.investment_date : null,
      state: outcome === 'applied' ? 'applied' : 'awaiting_nav',
    },
  });

  return { ok: true, state: outcome === 'applied' ? 'applied' : 'awaiting_nav', inputId, investmentDate: validation.iso, unchanged: false };
}

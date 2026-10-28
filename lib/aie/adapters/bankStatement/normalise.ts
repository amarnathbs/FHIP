/**
 * AIE bank-statement AI-fallback adapter -- the deterministic step between "the provider answered" and "the strict schema decides"
 * (28-10-2026, production defect: 16 `schema_rejected` outcomes on a real 10-page NAB statement, every one on a money field the
 * model had copied in the statement's own printed shape, e.g. "1,234.56 CR").
 *
 * WHAT IS NORMALISED, AND HOW STRICTLY.
 *   - `transactions[].balanceAfter`, `declaredOpeningBalance.value`, `declaredClosingBalance.value` are VERIFICATION data (they
 *     check that the lines add up; they are never a transaction). A printed shape is converted (`normalisePrintedMoney`, kind
 *     'balance'); a figure that is STILL not a clean decimal afterwards becomes null (and is COUNTED, so the import lands in review
 *     with a plain reason) instead of discarding the whole billed part and the lines that were read correctly.
 *   - `transactions[].amount` is the money that is booked. A printed shape is converted (kind 'amount', direction-checked), but an
 *     amount that is still not clean is LEFT AS IT IS, so the strict schema rejects the part exactly as before: never a silent wrong
 *     amount, never a guessed one.
 *   - Dates, descriptions, directions and structure are not touched here: they stay strict.
 *
 * NOTHING IS INVENTED. This file never computes, rounds or fills a figure. Whatever it emits is a re-spelling of digits the model
 * already returned; the caller still runs the "figures must be printed" check against the source text afterwards
 * (`keepOnlyPrintedBankFigures`), so a figure the page does not print is dropped no matter how clean it looks.
 */

import { normalisePrintedMoney, isNotPrintedPlaceholder } from '../shared/printedMoney';

export interface BankFactsNormalisationNotes {
  /** 1-based positions (in the model's `transactions` array) whose running balance was present but unreadable and was set to null. */
  balanceLinesNotRead: number[];
  declaredOpeningNotRead: boolean;
  declaredClosingNotRead: boolean;
  /** How many money values were re-spelled (evidence only: counts, never values). */
  respelled: number;
}

export function emptyBankFactsNotes(): BankFactsNormalisationNotes {
  return { balanceLinesNotRead: [], declaredOpeningNotRead: false, declaredClosingNotRead: false, respelled: 0 };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Returns a normalised COPY of the provider's parsed object plus the notes. Never throws; a value of an unexpected shape is
 * returned untouched so the strict schema reports it.
 */
export function normaliseBankStatementRawFacts(raw: unknown): { data: unknown; notes: BankFactsNormalisationNotes } {
  const notes = emptyBankFactsNotes();
  if (!isRecord(raw)) return { data: raw, notes };
  const out: Record<string, unknown> = { ...raw };

  const declared = (key: 'declaredOpeningBalance' | 'declaredClosingBalance', flag: 'declaredOpeningNotRead' | 'declaredClosingNotRead') => {
    const field = raw[key];
    if (!isRecord(field) || typeof field.value !== 'string') return;
    const r = normalisePrintedMoney(field.value, 'balance');
    if (r.ok) {
      if (r.changed) notes.respelled += 1;
      out[key] = { ...field, value: r.value };
      return;
    }
    if (isNotPrintedPlaceholder(field.value)) {
      // "N/A" / "-" : the statement prints no figure here. A typed reason is required with a null value.
      out[key] = { ...field, value: null, missingReasonCode: field.missingReasonCode ?? 'not_present_on_document' };
      return;
    }
    notes[flag] = true;
    out[key] = { ...field, value: null, missingReasonCode: 'illegible' };
  };
  declared('declaredOpeningBalance', 'declaredOpeningNotRead');
  declared('declaredClosingBalance', 'declaredClosingNotRead');

  if (Array.isArray(raw.transactions)) {
    out.transactions = raw.transactions.map((t, i) => {
      if (!isRecord(t)) return t;
      const row: Record<string, unknown> = { ...t };
      const direction = t.creditDebit === 'credit' || t.creditDebit === 'debit' ? t.creditDebit : undefined;
      if (typeof t.amount === 'string') {
        const a = normalisePrintedMoney(t.amount, 'amount', direction);
        if (a.ok) {
          if (a.changed) notes.respelled += 1;
          row.amount = a.value;
        }
        // not ok: left untouched on purpose -- the strict schema rejects the part (a bad amount is never papered over).
      }
      if (typeof t.balanceAfter === 'string') {
        const b = normalisePrintedMoney(t.balanceAfter, 'balance');
        if (b.ok) {
          if (b.changed) notes.respelled += 1;
          row.balanceAfter = b.value;
        } else {
          row.balanceAfter = null;
          if (!isNotPrintedPlaceholder(t.balanceAfter)) notes.balanceLinesNotRead.push(i + 1);
        }
      }
      return row;
    });
  }
  return { data: out, notes };
}

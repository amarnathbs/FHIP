// Investment Intelligence R2 — deterministic transaction fingerprinting
// (spec section 21).
//
// Design (documented, per spec's explicit instruction): SHA-256 hex digest
// over a canonical, deterministic string built from EXACT decimal-string
// representations (never floats) of every field the spec names:
//   source (parser's supportedSource, e.g. "cams"/"kfintech")
//   folio/account (the resolved ii_accounts.id — not the raw folio string,
//     so the SAME real-world account always fingerprints identically even
//     if a later statement prints the folio with different formatting)
//   scheme/instrument (the resolved ii_instruments.id)
//   transaction date (ISO)
//   transaction type (canonical)
//   amount (exact decimal string)
//   units (exact decimal string, or the literal string "null")
//   NAV (exact decimal string, or the literal string "null")
//   source transaction identifier, where present (or the literal string
//     "null" — a MISSING reference is still part of the fingerprint input,
//     not skipped, so two truly-anonymous same-day/same-amount rows are
//     NOT silently treated as identical to each other by omission; they
//     will only collide if every other field is also identical, which
//     R2_TRANSACTION_NORMALISATION.md documents as an accepted, narrow,
//     low-probability edge case for RTAs that provide no stable per-line
//     reference at all)
//
// account_id/instrument_id are used here (post-resolution canonical ids),
// NOT the raw folio/scheme text — this is a deliberate design decision:
// fingerprinting on resolved ids means the SAME real transaction observed
// via two differently-worded statements (e.g. a scheme rename mid-year)
// still fingerprints identically once both resolve to the same canonical
// instrument, which is exactly the DEDUP-003/DEDUP-004 behaviour spec
// requires.

import { createHash } from 'crypto';
import { scaledToDecimalString } from './decimal';
import type { IiTransactionType } from './types';

export interface FingerprintInput {
  sourceKey: string;
  accountId: string;
  instrumentId: string;
  transactionDateIso: string;
  transactionType: IiTransactionType;
  amountScaled: bigint;
  unitsScaled: bigint | null;
  navScaled: bigint | null;
  sourceReference: string | null;
}

export function computeTransactionFingerprint(input: FingerprintInput): string {
  const parts = [
    input.sourceKey,
    input.accountId,
    input.instrumentId,
    input.transactionDateIso,
    input.transactionType,
    scaledToDecimalString(input.amountScaled),
    input.unitsScaled === null ? 'null' : scaledToDecimalString(input.unitsScaled),
    input.navScaled === null ? 'null' : scaledToDecimalString(input.navScaled),
    input.sourceReference ?? 'null',
  ];
  return createHash('sha256').update(parts.join('|')).digest('hex');
}

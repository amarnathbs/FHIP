/**
 * The generic SHAPE of a bank narrative (28-10-2026 coverage work): which payment rail wrote it. Pure, literal word checks over the
 * upper-cased narrative; never a regex built from data.
 *
 * Why this matters: the free text AFTER the rail words on a person-to-person payment is a payee name and a payer-typed reference
 * ("Osko From J SMITH Ref-KFC"), not a merchant. A merchant name inside it must never decide a category.
 */

import { containsPhrase } from './textMatch';

const PERSON_TO_PERSON_PHRASES = ['OSKO', 'PAYID', 'FAST PAYMENT', 'PAY ANYONE', 'TRANSFER TO', 'TRANSFER FROM', 'TFR TO', 'TFR FROM', 'TRF TO', 'TRF FROM', 'RECEIVED FROM'];

/** True when the narrative is an Osko / PayID / bank-transfer line: the payee is a person or business account, not a card merchant. */
export function isPersonToPersonRail(haystackUpper: string): boolean {
  return PERSON_TO_PERSON_PHRASES.some((p) => containsPhrase(haystackUpper, p));
}

/** True when the narrative is a card or EFTPOS PURCHASE ("VISA-<merchant> ...", "POS #123-<merchant>", "EFTPOS <merchant>"). A purchase is never
 * the settlement of a credit-card bill. */
export function isCardPurchaseShape(haystackUpper: string): boolean {
  return /^(VISA|MASTERCARD|EFTPOS|POS|CARD PURCHASE|PURCHASE)\b/.test(haystackUpper.trim())
    || containsPhrase(haystackUpper, 'CARD PURCHASE')
    || containsPhrase(haystackUpper, 'APPLE PAY')
    || containsPhrase(haystackUpper, 'GOOGLE PAY');
}

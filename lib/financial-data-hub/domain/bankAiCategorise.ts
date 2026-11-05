/**
 * AI categorisation as a LAST RESORT -- the pure rules (29-10-2026).
 *
 * PURE, NO DATABASE, NO NETWORK. Decides which unresolved lines may be offered to the AI step at all, what text is shown for them, how identical
 * payees collapse to one question, and how an answer is accepted. The caller (services/bankAiCategoriseService.ts) does the I/O.
 *
 * SAFETY RULES ENCODED HERE (each has a named test):
 *  - only lines the rules could not classify, only money OUT, only business-style narratives. A person-to-person line (Osko / PayID / transfer)
 *    carries a private individual's name and is NEVER sent; it stays a question, grouped by payee;
 *  - the text shown is the narrative with every digit run replaced, URLs/e-mails dropped and the card/POS wrapper removed, so a reference
 *    number, an account number or a store number never leaves; the shared masking gate then runs over it as well;
 *  - the model may only name a category from the closed list this module builds (spending, fee and tax categories: never income, transfer,
 *    loan, retirement, investment, cash or refund -- those need evidence of whose money moved, which a payee string cannot give);
 *  - an answer outside the list, "unknown", a missing item, a duplicated key with different answers, or confidence "low" stays UNKNOWN;
 *  - an accepted answer is a PROPOSAL (method 'ai', confidence capped at the MEDIUM bucket): never HIGH, never approved.
 */
import { isPersonToPersonRail } from '../classification/paymentShape';
import { toMatchText } from '../classification/textMatch';
import { AIE_BANK_CATEGORISE_MAX_PAYEES_PER_CALL, type BankCategoriseAnswer } from '@/lib/aie/adapters/bankCategorise/schema';

export interface AiCandidateLine {
  id: string;
  description: string | null;
  direction: 'in' | 'out';
  reason: string;
  currentCategoryId: string | null;
  /** A category the review already suggests for the line (e.g. own-account transfer wording): such a line is not an AI question. */
  suggestedCategoryId: string | null;
}

/** Categories the AI may propose: what was BOUGHT. */
export const AI_PROPOSABLE_ECONOMIC_TYPES: readonly string[] = ['expense', 'fee', 'tax'];
export const AI_EXCLUDED_CATEGORY_KEYS: readonly string[] = ['unknown'];

export interface AiCategoryOption {
  id: string;
  key: string;
  label: string;
  economicType: string;
}

export function allowedAiCategories(
  categories: ReadonlyArray<{ id: string; category_key: string; display_name: string; economic_type: string; active?: boolean }>,
): AiCategoryOption[] {
  return categories
    .filter((c) => c.active !== false && AI_PROPOSABLE_ECONOMIC_TYPES.includes(c.economic_type) && !AI_EXCLUDED_CATEGORY_KEYS.includes(c.category_key))
    .map((c) => ({ id: c.id, key: c.category_key, label: c.display_name, economicType: c.economic_type }));
}

/** A bank-transfer word that is not an Osko / PayID rail ("INTERNET TRANSFER FUNDS TRNS"): the other side is an account, often a person's. */
const TRANSFER_WORD = /\b(TRANSFER|TRNS|TRF|TFR)\b/;
/** Words that make a name-shaped narrative a BUSINESS, so it is not treated as a person. */
const BUSINESS_WORDS = new Set([
  'PTY', 'LTD', 'LIMITED', 'INC', 'CO', 'GROUP', 'CAFE', 'RESTAURANT', 'STORE', 'SHOP', 'MARKET', 'BAKERY', 'HOTEL', 'PHARMACY', 'CHEMIST', 'SERVICES',
  'LAWYERS', 'SOLICITORS', 'CLUB', 'AIRPORT', 'PARKING', 'PETROL', 'FUEL', 'KITCHEN', 'BAR', 'PUB', 'GYM', 'BANK', 'INSURANCE', 'COUNCIL', 'ATO', 'EXPRESS',
  'DESIGNS', 'CENTRE', 'CENTER', 'MOTORS', 'AUTO', 'TAXI', 'ENERGY', 'WATER', 'TELSTRA', 'OPTUS', 'VODAFONE', 'TRADING', 'HOLDINGS', 'SUPERMARKET',
]);
const TITLES = new Set(['MR', 'MRS', 'MS', 'MISS', 'DR']);

/** A card or EFTPOS purchase: the payee is a merchant, never a person (NAB prints a bare "V " for a Visa debit purchase). */
function isCardLike(upper: string): boolean {
  return /^(V|VISA|MASTERCARD|MC|EFTPOS|POS|CARD PURCHASE|PURCHASE|DEBIT CARD)\b/.test(upper) || /\b(APPLE PAY|GOOGLE PAY|CARD PURCHASE)\b/.test(upper);
}

/**
 * True when a NON-card narrative reads like a person's name: letters only, two to six words, no business word, and a one-letter initial or a title
 * ("STEFANIE ZAJAKOVSKI V", "U RANASINGHE C", "AMARNATH SURENDRA BE A", "MR VIPIN BHATIA R LUNCH"). The masking only hides names that follow a label
 * such as "Name:", so a name inside a bank line would reach the provider verbatim: these lines are never sent.
 */
export function looksLikePersonName(upper: string): boolean {
  if (isCardLike(upper)) return false;
  const tokens = upper.replace(/\d+/g, ' ').split(/\s+/).filter(Boolean);
  if (tokens.length < 2 || tokens.length > 6) return false;
  if (!tokens.every((t) => /^[A-Z'-]+$/.test(t))) return false;
  if (tokens.some((t) => BUSINESS_WORDS.has(t))) return false;
  return tokens.some((t) => t.length === 1) || TITLES.has(tokens[0]);
}

/** The payee text shown to the AI for a narrative, or null when the line must not be sent. */
export function payeeTextForAi(description: string | null | undefined): string | null {
  const upper = toMatchText(description);
  if (upper.length === 0 || isPersonToPersonRail(upper) || TRANSFER_WORD.test(upper) || looksLikePersonName(upper)) return null;
  const text = upper
    .replace(/\S+@\S+/g, ' ') // e-mail addresses
    .replace(/HTTPS?:\/\/\S+|WWW\.\S+/g, ' ')
    .replace(/\bAU#\S*/g, ' ')
    .replace(/\(REF\.\S*\)/g, ' ')
    .replace(/\bREF[#:.-]?\S*/g, ' ')
    .replace(/\bAPPLE PAY\b|\bGOOGLE PAY\b/g, ' ')
    .replace(/^(VISA|MASTERCARD|EFTPOS|POS)\b[\s#-]*/, '')
    .replace(/\d+/g, ' ') // every digit run: store, reference, account, phone numbers
    .replace(/[^A-Z&' -]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[^A-Z]+/, '')
    .slice(0, 80)
    .trim();
  return text.replace(/[^A-Z]/g, '').length >= 3 ? text : null;
}

export function isAiCandidate(line: AiCandidateLine): boolean {
  return line.direction === 'out' && line.reason === 'uncategorised' && !line.currentCategoryId && !line.suggestedCategoryId && payeeTextForAi(line.description) !== null;
}

export interface AiBatch {
  /** key (p1, p2, ...) -> the payee text shown. */
  payees: Array<{ key: string; text: string }>;
  /** payee text -> every line id with that payee (identical payees cost ONE question). */
  idsByText: Map<string, string[]>;
}

/** Collapses identical payees, then splits into batches of at most `perCall` distinct payees. */
export function buildAiBatches(lines: readonly AiCandidateLine[], perCall = AIE_BANK_CATEGORISE_MAX_PAYEES_PER_CALL): AiBatch[] {
  const idsByText = new Map<string, string[]>();
  for (const l of lines) {
    if (!isAiCandidate(l)) continue;
    const text = payeeTextForAi(l.description)!;
    idsByText.set(text, [...(idsByText.get(text) ?? []), l.id]);
  }
  // Most repeated payees first: if a per-request cap stops the run, the answers that cover the most lines were bought first.
  const texts = [...idsByText.entries()].sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1)).map(([t]) => t);
  const batches: AiBatch[] = [];
  for (let i = 0; i < texts.length; i += perCall) {
    const slice = texts.slice(i, i + perCall);
    batches.push({
      payees: slice.map((text, n) => ({ key: `p${n + 1}`, text })),
      idsByText: new Map(slice.map((t) => [t, idsByText.get(t)!])),
    });
  }
  return batches;
}

export function evidenceTextForBatch(batch: AiBatch): string {
  return batch.payees.map((p) => `${p.key}: ${p.text}`).join('\n');
}

export type AiRejectionReason = 'not_in_list' | 'unknown_answer' | 'low_confidence' | 'missing' | 'conflicting_duplicate';

export interface AiResolution {
  /** payee text -> accepted category. */
  accepted: Map<string, AiCategoryOption>;
  /** payee text -> why it stays unknown. */
  rejected: Map<string, AiRejectionReason>;
  /**
   * BEST-GUESS MODE ONLY (Premium automatic categorisation, PO 05-11-2026): payees the model answered "unknown" for. They are filed as Other spending
   * (a counted, visible group) instead of being parked as a question. Always empty outside best-guess mode.
   */
  otherSpending: Set<string>;
  /** Payees whose accepted answer was a low-confidence guess (best-guess mode only; counted for the banner). */
  guessed: Set<string>;
}

export interface ResolveOptions {
  /**
   * The Premium automatic mode: a LOW-confidence answer from the list is accepted as a guess, and "unknown" becomes Other spending. Everything that
   * signals a misbehaving model (a key we did not show, a category outside the list, a missing item, two different answers for one payee) is still
   * left unresolved, in either mode.
   */
  bestGuess?: boolean;
}

/** Applies the safety rules to a provider answer. Anything not explicitly acceptable is unknown. */
export function resolveAiAnswer(answer: BankCategoriseAnswer, batch: AiBatch, allowed: readonly AiCategoryOption[], opts: ResolveOptions = {}): AiResolution {
  const byKey = new Map(allowed.map((c) => [c.key, c] as const));
  // A model sometimes answers with the category's DISPLAY NAME ("Food & Dining") instead of its key (`food`). An answer that is exactly one of the
  // offered names, ignoring case and spacing, is that category; anything else is still "not in the list".
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const byLabel = new Map(allowed.map((c) => [norm(c.label), c] as const));
  const shown = new Map(batch.payees.map((p) => [p.key, p.text] as const));
  const answersByKey = new Map<string, Array<BankCategoriseAnswer['items'][number]>>();
  for (const item of answer.items) {
    if (!shown.has(item.key)) continue; // a key we never showed is ignored
    answersByKey.set(item.key, [...(answersByKey.get(item.key) ?? []), item]);
  }
  const accepted = new Map<string, AiCategoryOption>();
  const rejected = new Map<string, AiRejectionReason>();
  const otherSpending = new Set<string>();
  const guessed = new Set<string>();
  for (const [key, text] of shown) {
    const given = answersByKey.get(key);
    if (!given) {
      rejected.set(text, 'missing');
      continue;
    }
    if (new Set(given.map((g) => `${g.categoryKey}|${g.confidence}`)).size > 1) {
      rejected.set(text, 'conflicting_duplicate');
      continue;
    }
    const item = given[0];
    if (item.categoryKey === 'unknown') {
      if (opts.bestGuess) otherSpending.add(text);
      else rejected.set(text, 'unknown_answer');
      continue;
    }
    const category = byKey.get(item.categoryKey) ?? byLabel.get(norm(item.categoryKey));
    if (!category) {
      rejected.set(text, 'not_in_list');
      continue;
    }
    if (item.confidence === 'low') {
      if (!opts.bestGuess) {
        rejected.set(text, 'low_confidence');
        continue;
      }
      guessed.add(text);
    }
    accepted.set(text, category);
  }
  return { accepted, rejected, otherSpending, guessed };
}

/** Published price list for the one permitted model class (gpt-4o-mini), USD per million tokens. Used ONLY for the estimate shown to the person. */
export const AI_ESTIMATE_USD_PER_MILLION = { input: 0.15, output: 0.6 } as const;
export function estimateAiCostUsd(inputTokens: number, outputTokens: number): number {
  return (inputTokens * AI_ESTIMATE_USD_PER_MILLION.input + outputTokens * AI_ESTIMATE_USD_PER_MILLION.output) / 1_000_000;
}

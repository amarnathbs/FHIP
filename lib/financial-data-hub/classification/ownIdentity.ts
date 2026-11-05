/**
 * Own-account transfer evidence (28-10-2026 coverage work): does a bank narrative name the account holder or a member of the household,
 * or one of the account holder's own accounts?
 *
 * PURE. The caller (`transactionClassificationService`) loads the signed-in user's profile name, their active household members and the
 * last digits of their imported accounts, and hands them in as an `OwnIdentity`. Nothing here reads a database or a network.
 *
 * THE RULE (same discipline as the investment owner matcher, lib/aie/adapters/investment-intelligence/ownerMatching.ts): no fuzzy match.
 *  - names are compared after the same cautious normalisation (case, punctuation, honorifics, accents folded away);
 *  - a person matches only when EVERY name token of at least two letters is present as a whole word of the narrative, and the name has
 *    at least two such tokens (a first name alone never matches, so "ANN" never matches "ANNABEL SMITH" and a lone "SMITH" never matches);
 *  - initials never match;
 *  - an account number matches only when a run of at least six digits in the narrative ends in the same last four digits as one of the
 *    user's own accounts AND the narrative is a transfer.
 * A match is EVIDENCE for a PROPOSED category ("Own-account transfer"); it is never an approval, and the person can always change it.
 *
 * PRIVACY. Names live only in memory for the length of one classification run; nothing here logs, stores or returns them. The explanation
 * text the engine writes says "your name" / "a member of your household", never the name itself.
 */

const HONORIFICS = new Set(['mr', 'mrs', 'ms', 'miss', 'mstr', 'master', 'dr', 'prof', 'shri', 'sri', 'smt', 'kumari', 'kum', 'late', 'jr', 'sr', 'ii', 'iii']);

/** The tokens of a person's name: upper-case, accents folded, honorifics and one-letter initials dropped. */
export function nameTokens(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toUpperCase()
    .replace(/['’‘`´]+/g, '')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((t) => t.length >= 2 && !HONORIFICS.has(t.toLowerCase()));
}

export interface OwnPerson {
  /** `self` for the signed-in user, `household` for another active household member. */
  kind: 'self' | 'household';
  tokens: string[];
}

export interface OwnIdentity {
  people: OwnPerson[];
  /** Last four digits of each of the user's own imported accounts. */
  accountLastFour: string[];
  /** Masked member-number prefixes learned from the user's own transfer lines (see `learnOwnMaskPrefixes`). */
  maskedMemberPrefixes: string[];
}

export const EMPTY_OWN_IDENTITY: OwnIdentity = { people: [], accountLastFour: [], maskedMemberPrefixes: [] };

/** Builds the identity from raw names and masked account identifiers. Names with fewer than two usable tokens are dropped (they could never match). */
export function buildOwnIdentity(input: {
  selfName?: string | null;
  householdNames?: ReadonlyArray<string | null | undefined>;
  accountIdentifiers?: ReadonlyArray<string | null | undefined>;
  /** The user's own narratives, used only to learn the masked member prefix their transfers carry. */
  narratives?: ReadonlyArray<string | null | undefined>;
}): OwnIdentity {
  const people: OwnPerson[] = [];
  const seen = new Set<string>();
  const add = (kind: OwnPerson['kind'], name: string | null | undefined) => {
    const tokens = nameTokens(name);
    if (tokens.length < 2) return;
    const key = [...tokens].sort().join(' ');
    if (seen.has(key)) return;
    seen.add(key);
    people.push({ kind, tokens });
  };
  add('self', input.selfName);
  for (const n of input.householdNames ?? []) add('household', n);
  const accountLastFour = [
    ...new Set(
      (input.accountIdentifiers ?? [])
        .map((a) => (a ?? '').replace(/\D+/g, ''))
        .filter((d) => d.length >= 4)
        .map((d) => d.slice(-4)),
    ),
  ];
  return { people, accountLastFour, maskedMemberPrefixes: learnOwnMaskPrefixes(input.narratives ?? []) };
}

const MASKED_ACCOUNT_RE = /(?:TFR|TRF|TRANSFER) (?:TO|FROM) \*{3,}(\d{2,6})([A-Z])(\d+)/g;

/**
 * Some credit unions print an internal transfer as "TFR TO ***91S31.3": a masked member number, then the account (S = share/savings,
 * L = loan). Every transfer between the account holder's OWN accounts carries the same masked member number, and a payment to somebody else's
 * account carries a different one. So the prefix that dominates the user's transfer lines (at least 5 of them, and at least 70 percent of all
 * masked transfer lines) is the user's own; one-off prefixes are not. Deterministic and explainable ("most of your transfers carry this member
 * number"); returns at most one prefix, and none when no prefix clearly dominates.
 */
export function learnOwnMaskPrefixes(narratives: ReadonlyArray<string | null | undefined>): string[] {
  const counts = new Map<string, number>();
  let total = 0;
  for (const n of narratives) {
    const text = (n ?? '').toUpperCase();
    MASKED_ACCOUNT_RE.lastIndex = 0;
    const m = MASKED_ACCOUNT_RE.exec(text);
    if (!m) continue;
    total += 1;
    counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (!top || top[1] < 5 || top[1] / total < 0.7) return [];
  return [top[0]];
}

/** A masked internal-transfer reference on the narrative, when its member prefix is the user's own. */
export function ownMaskedAccountKind(haystackUpper: string, identity: OwnIdentity): 'share' | 'loan' | null {
  if (identity.maskedMemberPrefixes.length === 0) return null;
  MASKED_ACCOUNT_RE.lastIndex = 0;
  const m = MASKED_ACCOUNT_RE.exec(haystackUpper);
  if (!m || !identity.maskedMemberPrefixes.includes(m[1])) return null;
  return m[2] === 'L' ? 'loan' : 'share';
}

function wordsOf(haystackUpper: string): Set<string> {
  return new Set(
    haystackUpper
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .replace(/['’‘`´]+/g, '')
      .replace(/[^A-Z0-9]+/g, ' ')
      .trim()
      .split(' ')
      .filter(Boolean),
  );
}

/** Which kind of own person (if any) is named in the narrative: the user wins over a household member when both match. */
export function matchOwnPerson(haystackUpper: string, identity: OwnIdentity): 'self' | 'household' | null {
  if (identity.people.length === 0) return null;
  const words = wordsOf(haystackUpper);
  let found: 'self' | 'household' | null = null;
  for (const p of identity.people) {
    if (p.tokens.every((t) => words.has(t))) {
      if (p.kind === 'self') return 'self';
      found = 'household';
    }
  }
  return found;
}

const NAME_ONLY_CODE_WORDS = new Set(['OTHER']);
/** Words that make a "name" a business, a trust or a fund, not a person. */
const NOT_A_PERSON_WORDS = new Set([
  'PTY', 'LTD', 'LIMITED', 'INC', 'TRUST', 'FUND', 'SUPER', 'SMSF', 'SERVICES', 'GROUP', 'HOLDINGS', 'ENTERPRISES', 'INVESTMENTS', 'PROPERTIES',
  'CONSULTING', 'CAFE', 'RESTAURANT', 'STORE', 'SHOP', 'PHARMACY', 'MEDICAL', 'DENTAL', 'LEGAL', 'LAW', 'BANK', 'INSURANCE', 'ENERGY', 'TRANSPORT',
]);

/**
 * A narrative that is ONLY a person's name plus codes, with no transfer word (NAB prints "Amarnath S Bekal", "A and S Bekal", "Samay Bekal 123").
 * The PO's own AI-categorised reference (05-11-2026) files these as moves between own accounts, a joint account, and payments to family.
 *
 * Deliberately narrow, because a wrong automatic answer is worse than a question and the result is only ever a PROPOSAL the person approves by total:
 *  - the narrative must carry the account holder's SURNAME, and nothing else that is a word of three or more letters except names;
 *  - 'self'   : the holder's first name (and surname) and nothing else, e.g. "AMARNATH S BEKAL 123";
 *  - 'joint'  : the surname plus a connector (AND / &) and only the holder's own name or initials, e.g. "A AND S BEKAL", "AMARNATH BEKAL AND";
 *  - 'family' : the surname plus one or two OTHER first names, no connector, no business word, e.g. "SAMAY BEKAL" (the caller decides what a family
 *               payment means; this function never says "own account" for it);
 *  - 'self'   also: the holder's own name CUT OFF by the bank's name field ("AMARNATH SURENDRA BE" + one reference letter), see isTruncatedOwnName;
 *  - a lone initial plus the surname, any other truncated name, a business word, or any other extra word returns null (a question, not a guess).
 * Initials alone still never prove a person: 'joint' needs the holder's first initial AND a connector AND the surname.
 */
/** The width of the name field on a bank statement line: a longer name is cut off there (NAB prints 20 characters). */
const BANK_NAME_FIELD_WIDTH = 18;

/**
 * The holder's own name CUT OFF by the bank's name field ("AMARNATH SURENDRA BE" for Amarnath Surendra Bekal, optionally followed by one reference
 * letter). Deliberately narrow, so it is a bank's truncation and not a guess: the first name in full, the text before the reference no shorter than
 * the field width, and a last word that is a SHORTER start of the surname ("BE" of BEKAL, never "BEDI", never the surname's own first letter alone).
 */
function isTruncatedOwnName(haystackUpper: string, first: string, surname: string): boolean {
  const tokens = haystackUpper.split(/\d/)[0].trim().split(/\s+/).filter(Boolean);
  if (tokens.length > 1 && tokens[tokens.length - 1].length === 1) tokens.pop(); // the one-letter reference the bank appends
  if (tokens.length < 2 || tokens.length > 4 || tokens.join(' ').length < BANK_NAME_FIELD_WIDTH) return false;
  if (!tokens.every((t) => /^[A-Z'-]+$/.test(t) && !NOT_A_PERSON_WORDS.has(t))) return false;
  const last = tokens[tokens.length - 1];
  return tokens[0] === first && last.length >= 2 && last.length < surname.length && surname.startsWith(last);
}

export function nameOnlyNarrativeKind(haystackUpper: string, identity: OwnIdentity): 'self' | 'joint' | 'family' | null {
  const self = identity.people.find((p) => p.kind === 'self');
  if (!self || self.tokens.length < 2) return null;
  const first = self.tokens[0];
  const surname = self.tokens[self.tokens.length - 1];
  const words = wordsOf(haystackUpper);
  if (!words.has(surname)) return isTruncatedOwnName(haystackUpper, first, surname) ? 'self' : null;
  const hasConnector = words.has('AND') || /(^|\s)&(\s|$)/.test(haystackUpper);
  const alpha = [...words].filter((w) => /^[A-Z]+$/.test(w));
  const initials = alpha.filter((w) => w.length === 1);
  const others = alpha.filter((w) => w.length >= 3 && w !== 'AND' && w !== surname && !NAME_ONLY_CODE_WORDS.has(w));
  if (others.some((w) => NOT_A_PERSON_WORDS.has(w))) return null;
  const hasFirst = words.has(first);
  const rest = others.filter((w) => w !== first);

  if (hasFirst) {
    if (rest.length === 0) return hasConnector ? 'joint' : 'self';
    return hasConnector && rest.length <= 2 ? 'joint' : null;
  }
  if (rest.length === 0 && hasConnector && initials.includes(first[0])) return 'joint';
  if (rest.length >= 1 && rest.length <= 2 && !hasConnector) return 'family';
  return null;
}

/** True when every alphabetic word of three or more letters in `text` is one of the household's own name tokens (or there is none). Used for the
 * title printed after "SAV <digits>": a title made only of the household's own names (or of initials) is an own account. */
export function onlyOwnNameWords(text: string, identity: OwnIdentity): boolean {
  const own = new Set(identity.people.flatMap((p) => p.tokens));
  for (const w of wordsOf(text.toUpperCase())) {
    if (/^[A-Z]{3,}$/.test(w) && !own.has(w)) return false;
  }
  return true;
}

/** True when a run of at least six digits in the narrative ends in the last four digits of one of the user's own accounts. */
export function mentionsOwnAccount(haystackUpper: string, identity: OwnIdentity): boolean {
  if (identity.accountLastFour.length === 0) return false;
  const runs = haystackUpper.match(/\d{6,}/g) ?? [];
  return runs.some((r) => identity.accountLastFour.includes(r.slice(-4)));
}

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

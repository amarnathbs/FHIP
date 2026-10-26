/**
 * Which retirement destination does a payslip's employer super line name? (Document2 (4) F25)
 *
 * PO rule: "SMSF if the fund/member evidence matches an SMSF, another retirement fund if it matches, otherwise ask the user to
 * choose. Never a weak fuzzy match."
 *
 * What counts as a match, and nothing else:
 *   - the destination's own name has at least one DISTINCTIVE word (not a generic word such as "super", "fund", "industry",
 *     "pension", "trustee", a legal suffix or a payroll abbreviation); AND
 *   - EVERY distinctive word of that name appears, as a whole word, in the payslip line; AND
 *   - the payslip's own employer-name words are not allowed to supply the match (an employer called "Bekal Pty Ltd" must not
 *     route a line to "Bekal Super Fund" on the employer's name alone); AND
 *   - the destination belongs to the payslip's own person (Self or Spouse), or is joint; AND
 *   - exactly ONE destination matches. Two matches is "ask", never "pick the first".
 * There is no edit distance, no substring-inside-a-word match, no "closest name", no default to the only fund, no amount match.
 *
 * Pure: no database, no clock. The SMSF side is a small interface (SmsfDestinationProvider in service.ts) so the SMSF module can
 * supply its own fund list; this file only sees candidates.
 */

export interface DestinationCandidate {
  accountId: string;
  kind: 'retirement_account' | 'smsf';
  name: string;
  /** 'self' | 'spouse' | 'joint' | null when the account carries no owner. */
  ownerRole: string | null;
  memberId: string | null;
  currency: string;
  /** smsf_funds.id for an SMSF destination. */
  fundId?: string | null;
}

export type RoutingAskReason = 'no_destinations' | 'no_name_match' | 'ambiguous' | 'no_fund_evidence_on_payslip';

export type RoutingResult =
  | { kind: 'matched'; candidate: DestinationCandidate; matchedWords: string[] }
  | { kind: 'ask'; reason: RoutingAskReason; /** The destinations the person may choose from (their own, never another person's). */ choices: DestinationCandidate[]; tied: DestinationCandidate[] };

/** Words that carry no identity: they appear in almost every fund name or every payroll line. */
const GENERIC_WORDS = new Set([
  'the', 'trustee', 'trustees', 'for', 'of', 'and', 'as', 'ata', 'atf', 'a', 'c', 'no', 'number', 'on', 'behalf',
  'super', 'superannuation', 'fund', 'funds', 'pty', 'ltd', 'limited', 'pvt', 'private', 'smsf', 'self', 'managed',
  'sgc', 'sg', 'employer', 'employee', 'cont', 'contribution', 'contributions', 'guarantee', 'sacrifice', 'salary',
  'mr', 'mrs', 'ms', 'dr', 'family',
  'industry', 'retail', 'personal', 'member', 'account', 'accumulation', 'pension', 'choice', 'balanced', 'growth', 'option',
  'retirement', 'savings', 'other', 'assets', 'defined', 'benefit', 'epf', 'ppf', 'nps', 'pf',
]);

export function wordsOf(text: string | null | undefined): string[] {
  if (!text) return [];
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
}

/** The distinctive words of a destination name: not generic, at least 3 characters, not a bare number. */
export function distinctiveWords(name: string | null | undefined): string[] {
  const out: string[] = [];
  for (const w of wordsOf(name)) {
    if (w.length < 3) continue;
    if (/^\d+$/.test(w)) continue;
    if (GENERIC_WORDS.has(w)) continue;
    if (!out.includes(w)) out.push(w);
  }
  return out;
}

function ownerAllowed(candidateOwner: string | null, payslipOwner: 'self' | 'spouse' | null): boolean {
  if (payslipOwner === null) return true;
  if (candidateOwner === null) return true;
  return candidateOwner === payslipOwner || candidateOwner === 'joint';
}

export interface RoutePayslipContributionInput {
  /** The raw payslip line label(s) of the employer super contribution (non-year-to-date), as printed. */
  contributionLabels: readonly string[];
  /** The payslip's employer name, whose words must not supply the match. */
  employerName: string | null;
  /** Whose payslip this is (approve step), or null when not recorded. */
  payslipOwner: 'self' | 'spouse' | null;
  candidates: readonly DestinationCandidate[];
}

export function routePayslipContribution(input: RoutePayslipContributionInput): RoutingResult {
  const eligible = input.candidates.filter((c) => ownerAllowed(c.ownerRole, input.payslipOwner));
  if (eligible.length === 0) return { kind: 'ask', reason: 'no_destinations', choices: [], tied: [] };

  const employerWords = new Set(wordsOf(input.employerName));
  const labelWords = new Set(input.contributionLabels.flatMap((l) => wordsOf(l)).filter((w) => !employerWords.has(w)));
  const labelHasEvidence = [...labelWords].some((w) => w.length >= 3 && !GENERIC_WORDS.has(w) && !/^\d+$/.test(w));
  if (!labelHasEvidence) return { kind: 'ask', reason: 'no_fund_evidence_on_payslip', choices: [...eligible], tied: [] };

  const matches: Array<{ candidate: DestinationCandidate; words: string[] }> = [];
  for (const candidate of eligible) {
    const words = distinctiveWords(candidate.name);
    if (words.length === 0) continue;
    if (words.every((w) => labelWords.has(w))) matches.push({ candidate, words });
  }
  if (matches.length === 1) return { kind: 'matched', candidate: matches[0].candidate, matchedWords: matches[0].words };
  if (matches.length > 1) return { kind: 'ask', reason: 'ambiguous', choices: [...eligible], tied: matches.map((m) => m.candidate) };
  return { kind: 'ask', reason: 'no_name_match', choices: [...eligible], tied: [] };
}

/** Plain-words reason for the person, never an internal key. */
export function routingAskText(reason: RoutingAskReason): string {
  switch (reason) {
    case 'no_destinations': return 'You have no retirement account or SMSF to receive this yet. Add the account first, then choose it here.';
    case 'ambiguous': return 'The fund named on the payslip matches more than one of your accounts, so FHIP has not guessed. Choose where it goes.';
    case 'no_fund_evidence_on_payslip': return 'The payslip line does not name a fund, so FHIP cannot tell where this super goes. Choose where it goes.';
    default: return 'The fund named on the payslip does not match any of your accounts by name, so FHIP has not guessed. Choose where it goes.';
  }
}

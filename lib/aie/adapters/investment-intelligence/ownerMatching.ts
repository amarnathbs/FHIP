/**
 * PC5 (M4) — K.4 / K.7: statement-owner matching, and the mismatch signal
 * that did not previously exist anywhere.
 *
 * WHY THIS PC5 CAPABILITY LIVES IN THE AIE INVESTMENT-INTELLIGENCE ADAPTER
 * DIRECTORY RATHER THAN IN `lib/pc5/`. PC5 owns the owner-matching
 * *capability* (K.4 assigns it, and PC4-INV-12 names PC5 as "the natural
 * owner of `holderName`"), but the DEPENDENCY DIRECTION is fixed by
 * AIE-1.0's binding boundary contract: PC5 consumes AIE, never the reverse.
 * The comparison has to run inside `dispatch.ts` — that is the only place
 * the parsed owner evidence exists at the moment an unresolved item must be
 * raised — so putting the module under `lib/pc5/` would have made an AIE
 * adapter import PC5 and inverted that contract for the sake of a folder
 * name. It also reads `ParsedAccountRecord`, an Investment Intelligence
 * parser type, which is where it naturally belongs. `lib/pc5/` imports it
 * to RE-CHECK a match at resolution time, so exactly one implementation
 * decides what a match is.
 *
 * WHY THIS FILE IS NEW RATHER THAN AN EXTENSION.
 * `ParsedAccountRecord.holderName` has been parsed by the CAMS, CAMS-Folio
 * and KFintech parsers since R2 (`parsers/types.ts:40`, populated at
 * `camsParser.ts:651`, `camsFolioStatementParser.ts:314`,
 * `kfintechParser.ts:156`) and has had ZERO consumers outside tests ever
 * since. PC4's own post-closure regression contract records this as
 * `PC4-INV-12`'s unenforced half, in terms this file is the direct answer
 * to: *"There is no comparison of the statement's printed holder name or
 * PAN against household members... A statement belonging to a different
 * person, uploaded with any ownerMemberId set, is ingested with no mismatch
 * signal at all. There is no test, because there is no code."* What existed
 * was only owner-UNRESOLVED detection (`documentProcessing.ts:377`
 * `const ownerUnresolved = !doc.owner_member_id`, and the AIE adapter's
 * `unresolvedItemForOwnerUnresolved`), which fires when the user said
 * NOTHING — never when the user said something WRONG.
 *
 * THE ONE RULE THIS FILE IS BUILT AROUND (K.4, verbatim): *"no fuzzy
 * auto-match that can assign another person's financial data."* Every
 * comparison below is deterministic and exact-after-normalisation. There is
 * no edit distance, no similarity score, no threshold, no "close enough"
 * anywhere in this module, and adding one later would be a defect rather
 * than an improvement: the cost of a false positive here is attributing a
 * stranger's portfolio to a household member, silently, inside net worth.
 *
 * WHAT "CAUTIOUS NORMALISATION" MEANS HERE, AND WHERE IT STOPS.
 * K.4 permits normalising whitespace, punctuation, and "ordering where
 * deterministic", plus "known initials only if policy permits". So:
 *   - whitespace, case, diacritics and punctuation ARE normalised away;
 *   - honorifics (MR/MRS/SHRI/SMT/DR/...) ARE stripped, because they are a
 *     printing convention of the registrar, not part of a person's name;
 *   - token ORDER is normalised by sorting, because "SHARMA ANIL" and
 *     "ANIL SHARMA" are the same deterministic token multiset and Indian
 *     registrars genuinely print both — this is reordering, not guessing;
 *   - INITIALS ARE NOT A MATCH. `A B SHARMA` against `Anil Bhaskar Sharma`
 *     is reported as `initials_consistent`, which this module maps to
 *     **AMBIGUOUS, never MATCHED** — it is a prompt for the user to
 *     confirm, not a decision the system may take. It is additionally
 *     behind an explicit policy flag that defaults OFF, so the default
 *     behaviour is the strictest one.
 *
 * PRIVACY. A holder name is another person's PII printed on a document.
 * This module NEVER returns or persists the raw extracted name. It returns
 * `maskHolderName()`'s irreversible partial form ("A***** S*****"), which
 * is the same discipline Insurance's own parser already applies to
 * `policyNumberMasked` ("already irreversibly partial-masked at the
 * source", `lib/aie/review/projection.ts`'s header). This deliberately does
 * NOT use `lib/aie/masking/identifierToken.ts`: that module requires
 * `AIE_MASK_TOKEN_ENCRYPTION_KEY`, which is unset in every environment as
 * of this phase, and a masking scheme that throws when a key is missing is
 * the wrong dependency for a display hint that must always render. It also
 * does not need to be: there is nothing to reverse here by design, and
 * after the Product Owner's 2026-09-15 one-way-HMAC decision there is no
 * reveal path to reverse it WITH.
 */

/** Registrar/honorific prefixes stripped before comparison. Lower-cased,
 * already punctuation-free by the time they are matched. */
const HONORIFICS = new Set([
  'mr', 'mrs', 'ms', 'miss', 'mstr', 'master',
  'dr', 'prof', 'er', 'capt', 'col', 'maj', 'lt',
  'shri', 'sri', 'smt', 'kumari', 'kum', 'late',
  'm/s', 'ms.', 'messrs',
]);

/** Suffixes that are titles rather than name parts. */
const NAME_SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv']);

/**
 * Deterministic, lossy-but-reproducible normalisation. Exported because the
 * exact normal form is the thing under test — a change to it changes what
 * counts as a match, so it must be assertable directly rather than only
 * through the comparison's verdict.
 */
export function normaliseHolderName(raw: string | null | undefined): string {
  if (!raw) return '';
  const stripped = raw
    // NFKD + combining-mark removal folds "Ānand" to "Anand" without a
    // locale-specific table.
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    // Punctuation a registrar uses decoratively: dots in initials, commas
    // between surname and given name, apostrophes, hyphens, slashes.
    .replace(/[.,''`´\-_/\\()[\]{}]+/g, ' ')
    // Anything else non-alphanumeric collapses too (keeps digits: some
    // registrars append a numeric qualifier).
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!stripped) return '';

  const tokens = stripped.split(' ').filter((t) => t.length > 0 && !HONORIFICS.has(t) && !NAME_SUFFIXES.has(t));
  if (tokens.length === 0) return '';
  // Ordering normalised by sort — see this module's header on why this is
  // reordering rather than guessing.
  return tokens.slice().sort().join(' ');
}

/** The token multiset of a normalised name, for the initials check. */
function tokensOf(normalised: string): string[] {
  return normalised ? normalised.split(' ') : [];
}

/**
 * True when `abbreviated` could be an initialised rendering of `full` —
 * every token of `abbreviated` is either a whole token of `full` or a
 * single letter that is the first letter of some unused token of `full`,
 * and every multi-letter token of `full` is accounted for.
 *
 * THIS IS NOT A MATCH. Its only caller maps a true result to AMBIGUOUS.
 * "A SHARMA" is initials-consistent with BOTH "Anil Sharma" and "Asha
 * Sharma"; treating that as identification is precisely the failure mode
 * K.4 prohibits.
 */
export function isInitialsConsistent(abbreviated: string, full: string): boolean {
  const abbrev = tokensOf(abbreviated);
  const fullTokens = tokensOf(full);
  if (abbrev.length === 0 || fullTokens.length === 0) return false;
  if (abbrev.length !== fullTokens.length) return false;

  const remaining = fullTokens.slice();
  for (const token of abbrev) {
    if (token.length === 1) {
      const idx = remaining.findIndex((f) => f.startsWith(token));
      if (idx === -1) return false;
      remaining.splice(idx, 1);
    } else {
      const idx = remaining.indexOf(token);
      if (idx === -1) return false;
      remaining.splice(idx, 1);
    }
  }
  return remaining.length === 0;
}

/**
 * Irreversible partial mask for display. "Anil Sharma" -> "A**** S*****".
 * A single-character token is left as the character (there is nothing to
 * hide). Returns null for empty input so a caller can render "not printed
 * on this statement" rather than an empty mask that looks like a bug.
 */
export function maskHolderName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const parts = raw.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  return parts
    .map((p) => {
      const first = Array.from(p)[0];
      const restLength = Array.from(p).length - 1;
      return restLength > 0 ? `${first}${'*'.repeat(restLength)}` : first;
    })
    .join(' ');
}

export interface Pc5HouseholdMemberForMatching {
  id: string;
  fullName: string;
  relationship: string;
  isActive: boolean;
}

/** The owner evidence a parser genuinely produces for one account block. */
export interface Pc5OwnerEvidence {
  holderName: string | null;
  jointHolders: string[];
  /** 'SI' (single), 'JO' (joint), 'AS' (anyone or survivor)... verbatim as
   * printed. Used only to decide whether JOINT is the expected shape; never
   * to pick a person. */
  holdingModeRaw: string | null;
}

export type Pc5OwnerMatchOutcome =
  /** The statement prints no holder at all. Not a mismatch — an absence.
   * The pre-existing `ii_adapter:owner_unresolved` path already covers
   * "the USER supplied nobody"; this covers "the DOCUMENT names nobody". */
  | { kind: 'no_owner_evidence' }
  /** Exactly one active household member's normalised name equals the
   * statement's normalised holder name. */
  | { kind: 'exact_match'; memberId: string; maskedHolderName: string }
  /** The statement names someone, and NO household member's normalised name
   * equals it. This is K.7's blocking case. */
  | { kind: 'mismatch'; maskedHolderName: string; maskedJointHolders: string[]; candidateMemberIds: string[] }
  /** More than one household member normalises to the same name, or the
   * only relationship found is initials-consistency. Never auto-assigned. */
  | { kind: 'ambiguous'; maskedHolderName: string; candidateMemberIds: string[]; reason: 'duplicate_member_names' | 'initials_only' }
  /** The statement prints a joint holding with more than one named holder.
   * A single owner cannot be asserted; K.6's allocation flow applies. */
  | { kind: 'joint_holding'; maskedHolderName: string; maskedJointHolders: string[]; matchedMemberIds: string[] };

export interface Pc5OwnerMatchPolicy {
  /** K.4's "known initials only if policy permits". Default OFF. Even when
   * ON, an initials-only relationship yields AMBIGUOUS, never a match. */
  allowInitialsConsistency: boolean;
}

export const PC5_DEFAULT_OWNER_MATCH_POLICY: Pc5OwnerMatchPolicy = {
  allowInitialsConsistency: false,
};

/** Holding-mode codes that positively indicate a joint holding. Matched on
 * the normalised (upper, alphanumeric) form because registrars print
 * 'JO', 'J/O', 'Joint' and 'AS' (anyone or survivor). */
const JOINT_HOLDING_MODES = new Set(['JO', 'JOINT', 'AS', 'ANYONEORSURVIVOR', 'EOS', 'EITHERORSURVIVOR']);

export function isJointHoldingMode(holdingModeRaw: string | null | undefined): boolean {
  if (!holdingModeRaw) return false;
  return JOINT_HOLDING_MODES.has(holdingModeRaw.toUpperCase().replace(/[^A-Z]/g, ''));
}

/**
 * The comparison itself. PURE — no database access, no clock, no
 * randomness — so every branch is directly unit-testable and so the same
 * function can be called both at dispatch time (to raise the item) and at
 * resolution time (to re-check it) without two implementations drifting.
 *
 * ORDER OF DETERMINATION, and why:
 *   1. No printed holder at all -> `no_owner_evidence`. Decided FIRST so a
 *      blank field can never be read as "matches nobody" and escalated to
 *      a mismatch.
 *   2. Joint holding (mode says joint, or more than one holder is named)
 *      -> `joint_holding`, carrying whichever members DID match so the
 *      allocation step can pre-fill. Decided BEFORE single-owner matching
 *      because a joint folio genuinely has no single owner, and reporting
 *      "matched Anil" for a folio held by Anil AND Priya would be a
 *      quietly wrong answer rather than an obviously missing one.
 *   3. Exactly one exact normalised match -> `exact_match`.
 *   4. More than one exact match (two household members with the same
 *      normalised name) -> `ambiguous`. Deliberately NOT "pick the first".
 *   5. Initials-consistency, if policy permits -> `ambiguous`.
 *   6. Otherwise -> `mismatch`.
 */
export function matchStatementOwner(
  evidence: Pc5OwnerEvidence,
  members: readonly Pc5HouseholdMemberForMatching[],
  policy: Pc5OwnerMatchPolicy = PC5_DEFAULT_OWNER_MATCH_POLICY,
): Pc5OwnerMatchOutcome {
  const activeMembers = members.filter((m) => m.isActive);
  const normalisedHolder = normaliseHolderName(evidence.holderName);
  const namedJointHolders = evidence.jointHolders.filter((j) => normaliseHolderName(j).length > 0);

  if (normalisedHolder.length === 0 && namedJointHolders.length === 0) {
    return { kind: 'no_owner_evidence' };
  }

  const maskedHolder = maskHolderName(evidence.holderName) ?? '(not printed)';
  const exactMatchIds = (normalised: string): string[] =>
    activeMembers.filter((m) => normaliseHolderName(m.fullName) === normalised && normalised.length > 0).map((m) => m.id);

  const jointLooking = isJointHoldingMode(evidence.holdingModeRaw) || namedJointHolders.length > 0;
  if (jointLooking) {
    const matchedMemberIds = [
      ...exactMatchIds(normalisedHolder),
      ...namedJointHolders.flatMap((j) => exactMatchIds(normaliseHolderName(j))),
    ];
    return {
      kind: 'joint_holding',
      maskedHolderName: maskedHolder,
      maskedJointHolders: namedJointHolders.map((j) => maskHolderName(j) ?? '(not printed)'),
      // De-duplicated, order-stable: the same person can be printed as both
      // primary and joint holder on a malformed block.
      matchedMemberIds: [...new Set(matchedMemberIds)],
    };
  }

  const exact = exactMatchIds(normalisedHolder);
  if (exact.length === 1) {
    return { kind: 'exact_match', memberId: exact[0], maskedHolderName: maskedHolder };
  }
  if (exact.length > 1) {
    return { kind: 'ambiguous', maskedHolderName: maskedHolder, candidateMemberIds: exact, reason: 'duplicate_member_names' };
  }

  if (policy.allowInitialsConsistency) {
    const initialsCandidates = activeMembers
      .filter((m) => isInitialsConsistent(normalisedHolder, normaliseHolderName(m.fullName)))
      .map((m) => m.id);
    if (initialsCandidates.length > 0) {
      return { kind: 'ambiguous', maskedHolderName: maskedHolder, candidateMemberIds: initialsCandidates, reason: 'initials_only' };
    }
  }

  return {
    kind: 'mismatch',
    maskedHolderName: maskedHolder,
    maskedJointHolders: [],
    // Every active member is a legitimate destination for a user's own
    // correction — the mismatch says "not automatically", not "not
    // possible". An empty household yields an empty list and the UI then
    // offers only reprocess/discard.
    candidateMemberIds: activeMembers.map((m) => m.id),
  };
}

/**
 * K.7's gate, as a single predicate so the acceptance path and the UI can
 * never disagree about what blocks: an owner mismatch (and an ambiguous
 * match, which is a mismatch the system merely cannot characterise) must
 * BLOCK unquestioned publication as "self". A joint holding blocks too —
 * not because it is wrong, but because it cannot be published as a single
 * owner without an allocation decision (K.6).
 */
export function ownerOutcomeBlocksAcceptance(outcome: Pc5OwnerMatchOutcome): boolean {
  switch (outcome.kind) {
    case 'mismatch':
    case 'ambiguous':
    case 'joint_holding':
      return true;
    case 'exact_match':
      return false;
    case 'no_owner_evidence':
      // The document naming nobody is not, by itself, a reason to block:
      // AIE's pre-existing `ii_adapter:owner_unresolved` item already
      // blocks when the USER has named nobody, and double-blocking the
      // same condition from two places would produce two items for one
      // problem — exactly the divergent counting K.3 forbids.
      return false;
    default: {
      const exhaustive: never = outcome;
      throw new Error(`ownerOutcomeBlocksAcceptance: unhandled outcome ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** The reason code PC5 raises for a blocking owner mismatch. Namespaced
 * into AIE-1.2's own `ii_adapter:` family deliberately — it is produced by
 * the Investment Intelligence adapter's dispatch, travels through AIE's
 * own `createUnresolvedItems`, and is resolved through AIE's own decision
 * path. A `pc5:` namespace would imply a second exception system. */
export const PC5_OWNER_MISMATCH_REASON_CODE = 'ii_adapter:owner_mismatch';
export const PC5_OWNER_JOINT_REASON_CODE = 'ii_adapter:owner_joint_allocation_required';

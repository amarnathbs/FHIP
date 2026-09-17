/**
 * PC5 (M4) — K.4 / K.7: statement-owner matching.
 *
 * These tests exist because there was previously NO CODE to test. PC4's own
 * post-closure regression contract records `PC4-INV-12`'s unenforced half in
 * terms this file answers directly: "There is no comparison of the
 * statement's printed holder name or PAN against household members...
 * There is no test, because there is no code."
 *
 * The negative cases matter more than the positive ones here. A matcher
 * that says "yes" too readily attributes a stranger's portfolio to a
 * household member, silently, inside net worth — so most of what follows
 * asserts that the matcher REFUSES.
 */
import { describe, it, expect } from 'vitest';
import {
  isInitialsConsistent,
  isJointHoldingMode,
  maskHolderName,
  matchStatementOwner,
  normaliseHolderName,
  ownerOutcomeBlocksAcceptance,
  PC5_DEFAULT_OWNER_MATCH_POLICY,
  PC5_OWNER_JOINT_REASON_CODE,
  PC5_OWNER_MISMATCH_REASON_CODE,
  type Pc5HouseholdMemberForMatching,
} from '@/lib/aie/adapters/investment-intelligence/ownerMatching';
import { unresolvedItemForOwnerMismatch } from '@/lib/aie/adapters/investment-intelligence/unresolvedItems';
import { collapseOwnerEvidence } from '@/lib/aie/adapters/investment-intelligence/householdContext';

function member(id: string, fullName: string, overrides: Partial<Pc5HouseholdMemberForMatching> = {}): Pc5HouseholdMemberForMatching {
  return { id, fullName, relationship: 'self', isActive: true, ...overrides };
}

const NO_EVIDENCE = { holderName: null, jointHolders: [], holdingModeRaw: null };

describe('PC5 K.4 — normaliseHolderName', () => {
  it('folds case, whitespace and decorative punctuation', () => {
    expect(normaliseHolderName('  ANIL   SHARMA ')).toBe(normaliseHolderName('Anil Sharma'));
    expect(normaliseHolderName('Anil-Kumar Sharma')).toBe(normaliseHolderName('Anil Kumar Sharma'));
    expect(normaliseHolderName("O'Brien, Sean")).toBe(normaliseHolderName('Sean OBrien'));
  });

  it('folds diacritics without a locale table', () => {
    expect(normaliseHolderName('Ānand Iyer')).toBe(normaliseHolderName('Anand Iyer'));
    expect(normaliseHolderName('José Silva')).toBe(normaliseHolderName('Jose Silva'));
  });

  it('strips registrar honorifics, which are a printing convention rather than part of a name', () => {
    expect(normaliseHolderName('MR ANIL SHARMA')).toBe(normaliseHolderName('Anil Sharma'));
    expect(normaliseHolderName('Smt. Priya Sharma')).toBe(normaliseHolderName('Priya Sharma'));
    expect(normaliseHolderName('Late Shri Ram Iyer')).toBe(normaliseHolderName('Ram Iyer'));
  });

  it('normalises token ORDER, because Indian registrars genuinely print surname-first and given-name-first', () => {
    expect(normaliseHolderName('SHARMA ANIL')).toBe(normaliseHolderName('Anil Sharma'));
  });

  it('returns the empty string for absent or honorific-only input, so "nothing printed" can never look like a name', () => {
    expect(normaliseHolderName(null)).toBe('');
    expect(normaliseHolderName('')).toBe('');
    expect(normaliseHolderName('   ')).toBe('');
    expect(normaliseHolderName('Mr.')).toBe('');
  });

  it('DOES NOT collapse genuinely different names — the whole point is that near-misses stay different', () => {
    expect(normaliseHolderName('Anil Sharma')).not.toBe(normaliseHolderName('Anil Sharman'));
    expect(normaliseHolderName('Anil Sharma')).not.toBe(normaliseHolderName('Anita Sharma'));
    // One token missing is a different name, not a typo to forgive.
    expect(normaliseHolderName('Anil Kumar Sharma')).not.toBe(normaliseHolderName('Anil Sharma'));
  });
});

describe('PC5 K.4 — maskHolderName is irreversible and always renders', () => {
  it('keeps only the first character of each token', () => {
    expect(maskHolderName('Anil Sharma')).toBe('A*** S*****');
  });
  it('leaves a single-character token alone (there is nothing to hide)', () => {
    expect(maskHolderName('A Sharma')).toBe('A S*****');
  });
  it('returns null rather than an empty mask for absent input', () => {
    expect(maskHolderName(null)).toBeNull();
    expect(maskHolderName('   ')).toBeNull();
  });
  it('is not reversible: the mask retains only length and initials, so distinct names collide', () => {
    // Same initials AND same token lengths -> identical mask. That
    // collision is the property, not a defect: it is what makes the mask
    // safe to persist in `evidence_ref` and to render on screen.
    expect(maskHolderName('Anil Sharma')).toBe(maskHolderName('Amit Sharma'));
    expect(maskHolderName('Rohan Mehta')).toBe(maskHolderName('Rajiv Mehra'));
    // Different initials DO separate — the mask is lossy, not blank.
    expect(maskHolderName('Rohan Mehta')).not.toBe(maskHolderName('Rohan Desai'));
  });
});

describe('PC5 K.4 — initials consistency is NEVER a match', () => {
  it('recognises an initialised rendering', () => {
    expect(isInitialsConsistent(normaliseHolderName('A B Sharma'), normaliseHolderName('Anil Bhaskar Sharma'))).toBe(true);
  });
  it('rejects a different token count', () => {
    expect(isInitialsConsistent(normaliseHolderName('A Sharma'), normaliseHolderName('Anil Bhaskar Sharma'))).toBe(false);
  });
  it('rejects a wrong initial', () => {
    expect(isInitialsConsistent(normaliseHolderName('A C Sharma'), normaliseHolderName('Anil Bhaskar Sharma'))).toBe(false);
  });

  it('is OFF by default, so the strictest behaviour is the one you get without configuring anything', () => {
    expect(PC5_DEFAULT_OWNER_MATCH_POLICY.allowInitialsConsistency).toBe(false);
    const outcome = matchStatementOwner({ holderName: 'A B SHARMA', jointHolders: [], holdingModeRaw: 'SI' }, [member('m1', 'Anil Bhaskar Sharma')]);
    expect(outcome.kind).toBe('mismatch');
  });

  it('EVEN WHEN ENABLED it yields AMBIGUOUS, never exact_match — "A Sharma" fits both Anil and Asha', () => {
    const outcome = matchStatementOwner(
      { holderName: 'A B SHARMA', jointHolders: [], holdingModeRaw: 'SI' },
      [member('m1', 'Anil Bhaskar Sharma')],
      { allowInitialsConsistency: true },
    );
    expect(outcome.kind).toBe('ambiguous');
    if (outcome.kind === 'ambiguous') {
      expect(outcome.reason).toBe('initials_only');
      expect(outcome.candidateMemberIds).toEqual(['m1']);
    }
  });
});

describe('PC5 K.4/K.7 — matchStatementOwner outcomes', () => {
  it('no_owner_evidence when the statement names nobody — decided FIRST so a blank can never escalate to a mismatch', () => {
    expect(matchStatementOwner(NO_EVIDENCE, [member('m1', 'Anil Sharma')]).kind).toBe('no_owner_evidence');
    expect(matchStatementOwner({ holderName: '   ', jointHolders: [], holdingModeRaw: null }, [member('m1', 'Anil Sharma')]).kind).toBe('no_owner_evidence');
  });

  it('exact_match on exactly one active member', () => {
    const outcome = matchStatementOwner({ holderName: 'MR. ANIL SHARMA', jointHolders: [], holdingModeRaw: 'SI' }, [
      member('m1', 'Anil Sharma'),
      member('m2', 'Priya Sharma', { relationship: 'spouse' }),
    ]);
    expect(outcome.kind).toBe('exact_match');
    if (outcome.kind === 'exact_match') {
      expect(outcome.memberId).toBe('m1');
      // The honorific survives into the MASK even though it is stripped
      // before COMPARISON — the mask is a display hint reflecting what the
      // statement printed, not a normalised key.
      expect(outcome.maskedHolderName).toBe('M** A*** S*****');
    }
  });

  it('mismatch when the statement names somebody no active member matches — K.7\'s blocking case', () => {
    const outcome = matchStatementOwner({ holderName: 'Rohan Mehta', jointHolders: [], holdingModeRaw: 'SI' }, [
      member('m1', 'Anil Sharma'),
      member('m2', 'Priya Sharma', { relationship: 'spouse' }),
    ]);
    expect(outcome.kind).toBe('mismatch');
    if (outcome.kind === 'mismatch') {
      // Every active member remains a legitimate destination for the
      // USER's own correction — a mismatch says "not automatically", not
      // "not possible".
      expect(outcome.candidateMemberIds).toEqual(['m1', 'm2']);
      expect(outcome.maskedHolderName).toBe('R**** M****');
    }
  });

  it('an INACTIVE member is not matchable — filing a new statement against a deactivated member would resurrect them implicitly', () => {
    const outcome = matchStatementOwner({ holderName: 'Anil Sharma', jointHolders: [], holdingModeRaw: 'SI' }, [
      member('m1', 'Anil Sharma', { isActive: false }),
    ]);
    expect(outcome.kind).toBe('mismatch');
  });

  it('ambiguous — two members normalising to the SAME name is never resolved by "pick the first"', () => {
    const outcome = matchStatementOwner({ holderName: 'Anil Sharma', jointHolders: [], holdingModeRaw: 'SI' }, [
      member('m1', 'Anil Sharma'),
      member('m2', 'SHARMA ANIL'),
    ]);
    expect(outcome.kind).toBe('ambiguous');
    if (outcome.kind === 'ambiguous') {
      expect(outcome.reason).toBe('duplicate_member_names');
      expect(outcome.candidateMemberIds.sort()).toEqual(['m1', 'm2']);
    }
  });

  it('joint_holding is decided BEFORE single-owner matching, so a joint folio never reports one owner', () => {
    const outcome = matchStatementOwner({ holderName: 'Anil Sharma', jointHolders: ['Priya Sharma'], holdingModeRaw: 'JO' }, [
      member('m1', 'Anil Sharma'),
      member('m2', 'Priya Sharma', { relationship: 'spouse' }),
    ]);
    expect(outcome.kind).toBe('joint_holding');
    if (outcome.kind === 'joint_holding') {
      expect(outcome.matchedMemberIds).toEqual(['m1', 'm2']);
      expect(outcome.maskedJointHolders).toEqual(['P**** S*****']);
    }
  });

  it('the holding MODE alone makes it joint, even with one printed holder', () => {
    const outcome = matchStatementOwner({ holderName: 'Anil Sharma', jointHolders: [], holdingModeRaw: 'AS' }, [member('m1', 'Anil Sharma')]);
    expect(outcome.kind).toBe('joint_holding');
  });

  it('de-duplicates a person printed as both primary and joint holder on a malformed block', () => {
    const outcome = matchStatementOwner({ holderName: 'Anil Sharma', jointHolders: ['ANIL SHARMA'], holdingModeRaw: 'JO' }, [member('m1', 'Anil Sharma')]);
    expect(outcome.kind).toBe('joint_holding');
    if (outcome.kind === 'joint_holding') expect(outcome.matchedMemberIds).toEqual(['m1']);
  });

  it('an EMPTY household produces a mismatch with no candidates rather than a crash or a silent pass', () => {
    const outcome = matchStatementOwner({ holderName: 'Anil Sharma', jointHolders: [], holdingModeRaw: 'SI' }, []);
    expect(outcome.kind).toBe('mismatch');
    if (outcome.kind === 'mismatch') expect(outcome.candidateMemberIds).toEqual([]);
  });
});

describe('PC5 — isJointHoldingMode', () => {
  it.each(['JO', 'J/O', 'Joint', 'AS', 'anyone or survivor', 'EOS'])('treats %s as joint', (mode) => {
    expect(isJointHoldingMode(mode)).toBe(true);
  });
  it.each(['SI', 'Single', null, undefined, ''])('treats %s as not joint', (mode) => {
    expect(isJointHoldingMode(mode as string | null)).toBe(false);
  });
});

describe('PC5 K.7 — ownerOutcomeBlocksAcceptance', () => {
  it('blocks a mismatch, an ambiguity and a joint holding', () => {
    expect(ownerOutcomeBlocksAcceptance({ kind: 'mismatch', maskedHolderName: 'X', maskedJointHolders: [], candidateMemberIds: [] })).toBe(true);
    expect(ownerOutcomeBlocksAcceptance({ kind: 'ambiguous', maskedHolderName: 'X', candidateMemberIds: [], reason: 'initials_only' })).toBe(true);
    expect(ownerOutcomeBlocksAcceptance({ kind: 'joint_holding', maskedHolderName: 'X', maskedJointHolders: [], matchedMemberIds: [] })).toBe(true);
  });

  it('does NOT block an exact match', () => {
    expect(ownerOutcomeBlocksAcceptance({ kind: 'exact_match', memberId: 'm1', maskedHolderName: 'X' })).toBe(false);
  });

  it('does NOT block "the document names nobody" — that would be two items for the one condition owner_unresolved already covers', () => {
    expect(ownerOutcomeBlocksAcceptance({ kind: 'no_owner_evidence' })).toBe(false);
  });
});

describe('PC5 K.4 — the unresolved items raised from a match outcome', () => {
  it('a mismatch raises a blocking item whose evidence carries ONLY the masked name, and says so', () => {
    const items = unresolvedItemForOwnerMismatch(
      { kind: 'mismatch', maskedHolderName: 'R**** M****', maskedJointHolders: [], candidateMemberIds: ['m1'] },
      'm1',
    );
    expect(items).toHaveLength(1);
    expect(items[0].reasonCode).toBe(PC5_OWNER_MISMATCH_REASON_CODE);
    expect(items[0].severity).toBe('blocking');
    expect(items[0].evidenceRef).toMatchObject({ maskedHolderName: 'R**** M****', originalValueRecoverable: false });
    // The persisted permission bound must actually allow the choice PC5
    // offers, or the decision service would refuse its own UI's action.
    expect(items[0].permittedActionTypes).toContain('choose_value');
  });

  it('PRIVACY: no raw holder name reaches the evidence payload under any outcome', () => {
    const outcomes = [
      { kind: 'mismatch' as const, maskedHolderName: 'R**** M****', maskedJointHolders: [], candidateMemberIds: [] },
      { kind: 'ambiguous' as const, maskedHolderName: 'A*** S*****', candidateMemberIds: [], reason: 'initials_only' as const },
      { kind: 'joint_holding' as const, maskedHolderName: 'A*** S*****', maskedJointHolders: ['P**** S*****'], matchedMemberIds: [] },
    ];
    for (const outcome of outcomes) {
      const [item] = unresolvedItemForOwnerMismatch(outcome, null);
      const serialised = JSON.stringify(item);
      expect(serialised).not.toMatch(/Rohan|Mehta|Anil|Sharma|Priya/i);
      expect(serialised).toContain('*');
    }
  });

  it('a joint holding raises the ALLOCATION item, not the mismatch item', () => {
    const items = unresolvedItemForOwnerMismatch(
      { kind: 'joint_holding', maskedHolderName: 'A*** S*****', maskedJointHolders: ['P**** S*****'], matchedMemberIds: ['m1', 'm2'] },
      'm1',
    );
    expect(items[0].reasonCode).toBe(PC5_OWNER_JOINT_REASON_CODE);
  });

  it('an exact match and an absent holder raise NOTHING', () => {
    expect(unresolvedItemForOwnerMismatch({ kind: 'exact_match', memberId: 'm1', maskedHolderName: 'X' }, 'm1')).toEqual([]);
    expect(unresolvedItemForOwnerMismatch({ kind: 'no_owner_evidence' }, 'm1')).toEqual([]);
  });
});

describe('PC5 K.4 — collapseOwnerEvidence', () => {
  it('takes the first block that actually names a holder, so one investor with many folios raises ONE item', () => {
    const collapsed = collapseOwnerEvidence([
      { holderName: null, jointHolders: [], holdingModeRaw: null },
      { holderName: 'Anil Sharma', jointHolders: ['Priya Sharma'], holdingModeRaw: 'JO' },
      { holderName: 'Anil Sharma', jointHolders: ['Priya Sharma'], holdingModeRaw: 'JO' },
    ]);
    expect(collapsed.holderName).toBe('Anil Sharma');
    expect(collapsed.holdingModeRaw).toBe('JO');
  });

  it('unions joint holders across blocks without duplicating them', () => {
    const collapsed = collapseOwnerEvidence([
      { holderName: 'Anil Sharma', jointHolders: ['Priya Sharma'], holdingModeRaw: 'JO' },
      { holderName: 'Anil Sharma', jointHolders: ['Priya Sharma', 'Ravi Sharma'], holdingModeRaw: 'JO' },
    ]);
    expect(collapsed.jointHolders).toEqual(['Priya Sharma', 'Ravi Sharma']);
  });

  it('returns a null holder for a document that names nobody anywhere', () => {
    expect(collapseOwnerEvidence([{ holderName: null, jointHolders: [], holdingModeRaw: null }]).holderName).toBeNull();
    expect(collapseOwnerEvidence([]).holderName).toBeNull();
  });
});

/**
 * Investment Intelligence — joint-holding detection on an OWNER-UNRESOLVED
 * statement (2026-09-29 fix).
 *
 * REAL GAP FOUND: `documentProcessing.ts`'s `ownerUnresolved` branch (the
 * user declared NO household member for this statement at upload time)
 * opened 'owner_unmatched' unconditionally, with no check at all of the
 * statement's own printed holder evidence. The sibling branch below it (the
 * user DID declare an owner) already used `matchStatementOwner` to detect a
 * joint holding and correctly escalate to `joint_holding_allocation_required`
 * instead — but that check only ever ran when an owner was declared. A
 * genuinely joint-held CAMS folio uploaded with no declared owner was
 * silently treated as an ordinary single-owner gap, so a later "assign to
 * yourself" resolution (one click, or a bulk operation across many accounts)
 * could assert 100% sole economic ownership the statement itself never
 * claimed.
 *
 * This matters in practice, not just in theory: confirmed by reading
 * `camsParser.ts`'s `parseAccounts()` that the real parser's `jointHolders`
 * array is ALWAYS empty (`jointHolders: []`, hardcoded — never populated
 * from statement text), so `holdingModeRaw` alone (e.g. "Joint", "JO", "AS")
 * is the ONLY real-world signal `matchStatementOwner` ever gets for a real
 * CAMS statement — and that alone is sufficient to trigger `joint_holding`
 * (`ownerMatching.ts`'s `isJointHoldingMode`).
 *
 * This test does not re-test `matchStatementOwner` itself (already
 * exhaustively covered by `pc5OwnerMatching.test.ts`). It proves the exact
 * classification input/output the fixed `ownerUnresolved` branch now relies
 * on, using the same hand-built `ParsedAccountRecord` pattern already
 * established in this file area (see `iiPc1AccountIdentity.test.ts`) rather
 * than mocking the full `processSourceDocument` pipeline.
 */
import { describe, it, expect } from 'vitest';
import { matchStatementOwner, type Pc5HouseholdMemberForMatching } from '@/lib/aie/adapters/investment-intelligence/ownerMatching';
import type { ParsedAccountRecord } from '@/lib/services/investment-intelligence/parsers/types';

function account(overrides: Partial<ParsedAccountRecord> = {}): ParsedAccountRecord {
  return {
    folioNumber: 'FOLIO-A',
    accountNumberMasked: null,
    amcName: '',
    holderName: null,
    panMasked: null,
    jointHolders: [],
    holdingModeRaw: null,
    raw: '',
    ...overrides,
  };
}

/** The EXACT extraction shape `documentProcessing.ts` builds from a
 * `ParsedAccountRecord` before calling `matchStatementOwner`, in both the
 * owner-unresolved branch (this fix) and the owner-declared branch (K.7). */
function evidenceFrom(acc: ParsedAccountRecord) {
  return { holderName: acc.holderName, jointHolders: acc.jointHolders, holdingModeRaw: acc.holdingModeRaw };
}

const NO_HOUSEHOLD_MEMBERS: Pc5HouseholdMemberForMatching[] = [];

describe('Joint-holding detection on an owner-unresolved statement (2026-09-29 fix)', () => {
  it('a real CAMS-shaped joint folio (Holding Mode = Joint, no declared owner) classifies as joint_holding, not owner_unmatched', () => {
    // Reproduces the real-world shape confirmed in camsParser.ts: jointHolders
    // is always [], holdingModeRaw carries the printed "Holding Mode" value.
    const jointFolio = account({ holderName: 'Anil Sharma', jointHolders: [], holdingModeRaw: 'Joint' });
    const outcome = matchStatementOwner(evidenceFrom(jointFolio), NO_HOUSEHOLD_MEMBERS);
    expect(outcome.kind).toBe('joint_holding');
  });

  it('the "Anyone or Survivor" mode (AS) is also joint, matching the real registrar convention', () => {
    const folio = account({ holderName: 'Anil Sharma', holdingModeRaw: 'AS' });
    expect(matchStatementOwner(evidenceFrom(folio), NO_HOUSEHOLD_MEMBERS).kind).toBe('joint_holding');
  });

  it('a genuinely single-holder folio (Holding Mode = SI, no declared owner) still correctly falls through to owner_unmatched territory', () => {
    // NOT joint_holding -- this is the negative control proving the fix does
    // not over-fire and reclassify every ordinary unowned statement.
    const soleFolio = account({ holderName: 'Anil Sharma', holdingModeRaw: 'SI' });
    const outcome = matchStatementOwner(evidenceFrom(soleFolio), NO_HOUSEHOLD_MEMBERS);
    expect(outcome.kind).not.toBe('joint_holding');
  });

  it('a statement that prints no holder evidence at all is unchanged: no_owner_evidence, still correctly owner_unmatched', () => {
    const silentFolio = account(); // holderName: null, jointHolders: [], holdingModeRaw: null
    const outcome = matchStatementOwner(evidenceFrom(silentFolio), NO_HOUSEHOLD_MEMBERS);
    expect(outcome.kind).toBe('no_owner_evidence');
  });

  it('joint_holding still fires even when one of the printed holders exactly matches an existing household member -- a match does not resolve a joint folio to a single owner', () => {
    const members: Pc5HouseholdMemberForMatching[] = [{ id: 'm1', fullName: 'Anil Sharma', relationship: 'self', isActive: true }];
    const jointFolio = account({ holderName: 'Anil Sharma', holdingModeRaw: 'Joint' });
    const outcome = matchStatementOwner(evidenceFrom(jointFolio), members);
    expect(outcome.kind).toBe('joint_holding');
    if (outcome.kind === 'joint_holding') {
      // matchedMemberIds pre-fills the allocation step -- it does NOT mean
      // "resolved to this one member", per ownerMatching.ts's own header.
      expect(outcome.matchedMemberIds).toEqual(['m1']);
    }
  });
});

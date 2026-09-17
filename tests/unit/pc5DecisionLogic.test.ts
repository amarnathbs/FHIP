/**
 * PC5 (M4) — the pure decision logic: which `decision_type` a PC5 action
 * records, and what a user's answer changes in the re-check (K.5, K.9,
 * K.10, K.19).
 *
 * `overridesForDecision` is the hinge between "what the user answered" and
 * "what changes in the re-reconciliation", so it is tested directly rather
 * than only through the service — a mapping bug here would silently apply
 * the wrong override and the run would simply keep failing, with no error
 * anywhere to notice.
 */
import { describe, it, expect } from 'vitest';
import { decisionTypeFor, overridesForDecision } from '@/lib/pc5/decide';
import { PC5_RESOLUTION_ACTIONS, PC5_OPTION_SOURCES, PC5_RESOLUTION_STATUSES } from '@/lib/pc5/types';
import { PC5_DECISION_ACKNOWLEDGE, PC5_DECISION_CHOOSE, PC5_DECISION_DISMISS, candidateIdsFromEvidence, isCurrentlyDismissed } from '@/lib/pc5/projection';
import { PC5_JOINT_OPTION_VALUE } from '@/lib/pc5/optionSets';
import type { AieDecisionHistoryRow } from '@/lib/aie/db/repository';

describe('PC5 — decisionTypeFor is total and namespaced', () => {
  it('maps every PC5 action without throwing', () => {
    for (const action of PC5_RESOLUTION_ACTIONS) {
      expect(() => decisionTypeFor(action)).not.toThrow();
    }
  });

  it('every PC5 decision_type is pc5_-prefixed, so the trail distinguishes PC5 from AIE\'s own and from its system actors', () => {
    for (const action of PC5_RESOLUTION_ACTIONS) {
      expect(decisionTypeFor(action)).toMatch(/^pc5_/);
    }
  });

  it('does not collide with AIE\'s own decision types', () => {
    const aieOwn = ['correct', 'not_present', 'defer', 'auto_resolved_by_revalidation', 'superseded_by_revalidation'];
    const pc5 = PC5_RESOLUTION_ACTIONS.map(decisionTypeFor);
    for (const t of pc5) expect(aieOwn).not.toContain(t);
  });

  it('uses the same constants the projection reads back', () => {
    expect(decisionTypeFor('choose_value')).toBe(PC5_DECISION_CHOOSE);
    expect(decisionTypeFor('acknowledge')).toBe(PC5_DECISION_ACKNOWLEDGE);
    expect(decisionTypeFor('dismiss')).toBe(PC5_DECISION_DISMISS);
  });
});

describe('PC5 K.19 — overridesForDecision', () => {
  it('an owner choice becomes the owner override', () => {
    const o = overridesForDecision({ reasonCode: 'ii_adapter:owner_mismatch', chosenValue: 'm2', evidenceRef: null, existingOwnerMemberId: 'm1' });
    expect(o.ownerMemberId).toBe('m2');
  });

  it('the JOINT sentinel is NOT treated as a member id — a joint answer must not assert a single owner', () => {
    const o = overridesForDecision({
      reasonCode: 'ii_adapter:owner_joint_allocation_required',
      chosenValue: PC5_JOINT_OPTION_VALUE,
      evidenceRef: null,
      existingOwnerMemberId: 'm1',
    });
    expect(o.ownerMemberId).toBeNull();
  });

  it('owner_unresolved is handled by the same branch as owner_mismatch', () => {
    const o = overridesForDecision({ reasonCode: 'ii_adapter:owner_unresolved', chosenValue: 'm3', evidenceRef: null, existingOwnerMemberId: null });
    expect(o.ownerMemberId).toBe('m3');
  });

  it('an account choice becomes a keyed account override built from the same two fields the resolution key uses', () => {
    const o = overridesForDecision({
      reasonCode: 'ii_adapter:ambiguous_account',
      chosenValue: 'acc-2',
      evidenceRef: { folioNumber: '1122334455', amcName: 'Prime Mutual Fund' },
      existingOwnerMemberId: 'm1',
    });
    expect(o.resolvedAccountIdByKey).toEqual({ '1122334455|Prime Mutual Fund': 'acc-2' });
    // The existing owner is carried through unchanged — an account answer
    // must not silently clear a previously-chosen owner.
    expect(o.ownerMemberId).toBe('m1');
  });

  it('a duplicate answer becomes the duplicate override, and only for the three permitted literals', () => {
    for (const value of ['same_economic_event', 'separate_genuine_events', 'wrong_statement_or_source'] as const) {
      const o = overridesForDecision({ reasonCode: 'ii_adapter_duplicate_overlap', chosenValue: value, evidenceRef: null, existingOwnerMemberId: null });
      expect(o.duplicateResolution).toBe(value);
    }
    const bogus = overridesForDecision({ reasonCode: 'ii_adapter_duplicate_overlap', chosenValue: 'whatever', evidenceRef: null, existingOwnerMemberId: null });
    expect(bogus.duplicateResolution).toBeUndefined();
  });

  it('no chosen value leaves the existing owner in place and changes nothing else', () => {
    const o = overridesForDecision({ reasonCode: 'ii_adapter:owner_mismatch', chosenValue: undefined, evidenceRef: null, existingOwnerMemberId: 'm1' });
    expect(o).toEqual({ ownerMemberId: 'm1' });
  });

  it('an unrecognised reason code produces NO override rather than a guessed one', () => {
    const o = overridesForDecision({ reasonCode: 'ii_adapter:something_new', chosenValue: 'x', evidenceRef: null, existingOwnerMemberId: 'm1' });
    expect(o).toEqual({ ownerMemberId: 'm1' });
  });
});

describe('PC5 K.13 — dismissal is derived from the decision trail, not from a status column', () => {
  const at = (n: number) => new Date(2026, 0, n).toISOString();
  function decision(type: string, day: number): AieDecisionHistoryRow {
    return {
      id: `d-${day}`,
      itemId: 'item-1',
      decisionType: type,
      rationale: null,
      actorId: 'u1',
      itemVersionAtDecision: day,
      correctionFieldName: null,
      correctionValueRaw: null,
      correctionValueNormalized: null,
      originalValueAtDecision: null,
      parserVersionAtDecision: null,
      resultingReconciliationAt: null,
      createdAt: at(day),
    };
  }

  it('no decisions means not dismissed', () => {
    expect(isCurrentlyDismissed([])).toBe(false);
  });

  it('a dismiss dismisses', () => {
    expect(isCurrentlyDismissed([decision(PC5_DECISION_DISMISS, 1)])).toBe(true);
  });

  it('ANY later decision un-dismisses — last writer wins', () => {
    expect(isCurrentlyDismissed([decision(PC5_DECISION_DISMISS, 1), decision(PC5_DECISION_ACKNOWLEDGE, 2)])).toBe(false);
    expect(isCurrentlyDismissed([decision(PC5_DECISION_DISMISS, 1), decision(PC5_DECISION_CHOOSE, 2)])).toBe(false);
  });

  it('a re-dismiss after an acknowledge dismisses again', () => {
    expect(isCurrentlyDismissed([decision(PC5_DECISION_DISMISS, 1), decision(PC5_DECISION_ACKNOWLEDGE, 2), decision(PC5_DECISION_DISMISS, 3)])).toBe(true);
  });
});

describe('PC5 — candidateIdsFromEvidence never widens an option set', () => {
  it('reads the account candidates AIE itself recorded', () => {
    expect(candidateIdsFromEvidence({ candidateAccountIds: ['a', 'b'] }, 'account_match_candidates')).toEqual(['a', 'b']);
  });

  it('reads both owner candidate shapes an owner item can carry', () => {
    expect(candidateIdsFromEvidence({ candidateMemberIds: ['m1'], matchedMemberIds: ['m2'] }, 'household_owner')).toEqual(['m1', 'm2']);
  });

  it('returns [] for a closed-vocabulary source, which has no per-user candidates at all', () => {
    expect(candidateIdsFromEvidence({ anything: ['x'] }, 'duplicate_resolution')).toEqual([]);
    expect(candidateIdsFromEvidence({ anything: ['x'] }, 'summary_mismatch_resolution')).toEqual([]);
  });

  it('ignores non-string and non-array junk rather than propagating it', () => {
    expect(candidateIdsFromEvidence({ candidateAccountIds: 'not-an-array' }, 'account_match_candidates')).toEqual([]);
    expect(candidateIdsFromEvidence({ candidateAccountIds: [1, 2, 'ok'] }, 'account_match_candidates')).toEqual(['ok']);
    expect(candidateIdsFromEvidence(null, 'account_match_candidates')).toEqual([]);
  });
});

describe('PC5 — the vocabularies are closed and small', () => {
  it('there are exactly four PC5 actions, and confirm_duplicate is NOT one (K.10 is a choose_value)', () => {
    expect([...PC5_RESOLUTION_ACTIONS]).toEqual(['choose_value', 'acknowledge', 'dismiss', 'discard_statement']);
  });
  it('there are exactly five option sources', () => {
    expect([...PC5_OPTION_SOURCES]).toEqual([
      'household_owner',
      'account_match_candidates',
      'instrument_match_candidates',
      'duplicate_resolution',
      'summary_mismatch_resolution',
    ]);
  });
  it('the five PC5 statuses are presentation only — none of them is writable to aie_unresolved_item', () => {
    expect([...PC5_RESOLUTION_STATUSES]).toEqual(['open', 'acknowledged', 'resolved', 'dismissed', 'superseded']);
    // 'acknowledged' and 'dismissed' are NOT AIE statuses — which is the
    // point: they cannot be persisted, so they cannot unblock anything.
    const aieStatuses = ['open', 'in_review', 'resolved', 'rejected', 'deferred', 'superseded'];
    expect(aieStatuses).not.toContain('acknowledged');
    expect(aieStatuses).not.toContain('dismissed');
  });
});

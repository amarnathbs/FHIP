/**
 * PC5 (M4) — K.13 Review Centre semantics, K.16 exception-only default,
 * and the identity-pair de-duplication.
 *
 * The property these tests exist to protect: ACKNOWLEDGE AND DISMISS CAN
 * NEVER MEAN RESOLVED. It is asserted three ways here — through the status
 * mapping, through the blocking predicate, and through the permitted-action
 * set — because a single assertion could be satisfied by a UI that lies
 * politely.
 */
import { describe, it, expect } from 'vitest';
import {
  II_IDENTITY_RECONCILIATION_RULE_PREFIX,
  PC5_LIVE_ITEM_STATUSES,
  PC5_TERMINAL_ITEM_STATUSES,
  dropIdentityMirrors,
  isIdentityMirrorRuleId,
  isMaterialForDefaultView,
  itemStillBlocks,
  permittedPc5Actions,
  reasonCodeBehindIdentityMirror,
  toPc5Status,
} from '@/lib/pc5/reviewStatus';
import { AIE_UNRESOLVED_ITEM_STATUSES, type AieUnresolvedItemStatus } from '@/lib/aie/types';

describe('PC5 K.13 — toPc5Status is total over every AIE status', () => {
  it('maps every value of AIE_UNRESOLVED_ITEM_STATUSES without throwing', () => {
    for (const status of AIE_UNRESOLVED_ITEM_STATUSES) {
      expect(() => toPc5Status(status, false)).not.toThrow();
    }
  });

  it('in_review means ACKNOWLEDGED — the condition still exists', () => {
    expect(toPc5Status('in_review', false)).toBe('acknowledged');
  });

  it('DEFERRED reports as OPEN, not as its own quiet state — it still blocks acceptance', () => {
    expect(toPc5Status('deferred', false)).toBe('open');
  });

  it('only a genuinely resolved AIE item reports as resolved', () => {
    expect(toPc5Status('resolved', false)).toBe('resolved');
    expect(toPc5Status('open', false)).toBe('open');
    expect(toPc5Status('superseded', false)).toBe('superseded');
    // A declined document is superseded, never "resolved" — nothing was
    // fixed.
    expect(toPc5Status('rejected', false)).toBe('superseded');
  });

  it('NO live status can be mapped to "resolved" by dismissing it', () => {
    for (const status of PC5_LIVE_ITEM_STATUSES) {
      expect(toPc5Status(status, true)).toBe('dismissed');
      expect(toPc5Status(status, true)).not.toBe('resolved');
    }
  });
});

describe('PC5 K.13 — itemStillBlocks mirrors countItemsBlockingAcceptanceForRun exactly', () => {
  it('a blocking item blocks in every live status, including deferred and acknowledged', () => {
    expect(itemStillBlocks('blocking', 'open')).toBe(true);
    expect(itemStillBlocks('blocking', 'in_review')).toBe(true);
    expect(itemStillBlocks('blocking', 'deferred')).toBe(true);
  });

  it('a blocking item stops blocking only once genuinely resolved/superseded/rejected', () => {
    for (const status of PC5_TERMINAL_ITEM_STATUSES) {
      expect(itemStillBlocks('blocking', status)).toBe(false);
    }
  });

  it('a warning never blocks, whatever its status', () => {
    for (const status of AIE_UNRESOLVED_ITEM_STATUSES) {
      expect(itemStillBlocks('warning', status)).toBe(false);
    }
  });

  it('the live set INCLUDES deferred — the set PC5 shows and the set the gate counts are the same set', () => {
    expect([...PC5_LIVE_ITEM_STATUSES].sort()).toEqual(['deferred', 'in_review', 'open']);
  });

  it('live and terminal partition every AIE status with no overlap and no gap', () => {
    const union = [...PC5_LIVE_ITEM_STATUSES, ...PC5_TERMINAL_ITEM_STATUSES].sort();
    expect(union).toEqual([...AIE_UNRESOLVED_ITEM_STATUSES].sort());
    expect(new Set(union).size).toBe(union.length);
  });
});

describe('PC5 K.16 — exception-only default view', () => {
  it('a live blocking item is always material', () => {
    for (const status of PC5_LIVE_ITEM_STATUSES) {
      expect(isMaterialForDefaultView('blocking', status)).toBe(true);
    }
  });
  it('a warning is material only while it is untouched', () => {
    expect(isMaterialForDefaultView('warning', 'open')).toBe(true);
    expect(isMaterialForDefaultView('warning', 'in_review')).toBe(false);
    expect(isMaterialForDefaultView('warning', 'resolved')).toBe(false);
  });
  it('a resolved blocking item is not material', () => {
    expect(isMaterialForDefaultView('blocking', 'resolved')).toBe(false);
  });
});

describe('PC5 — the identity exception is recorded TWICE by AIE and must be counted ONCE', () => {
  it('recognises the mirror rule-id prefix the II dispatch writes', () => {
    expect(II_IDENTITY_RECONCILIATION_RULE_PREFIX).toBe('ii_adapter_identity:');
    expect(isIdentityMirrorRuleId('ii_adapter_identity:ii_adapter:owner_mismatch')).toBe(true);
    expect(isIdentityMirrorRuleId('ii_adapter_roll_forward:acc:inst')).toBe(false);
  });

  it('recovers the typed item\'s reason code from the mirror rule id', () => {
    expect(reasonCodeBehindIdentityMirror('ii_adapter_identity:ii_adapter:owner_mismatch')).toBe('ii_adapter:owner_mismatch');
    expect(reasonCodeBehindIdentityMirror('ii_adapter_duplicate_overlap')).toBeNull();
  });

  it('drops the mirror when its typed partner is present — one problem, one row', () => {
    const findings = [
      { ruleId: 'ii_adapter_identity:ii_adapter:owner_mismatch' },
      { ruleId: 'ii_adapter_roll_forward:acc-1:inst-1' },
    ];
    const kept = dropIdentityMirrors(findings, new Set(['ii_adapter:owner_mismatch']));
    expect(kept.map((f) => f.ruleId)).toEqual(['ii_adapter_roll_forward:acc-1:inst-1']);
  });

  it('KEEPS an orphaned mirror — hiding the only remaining evidence of a real blocking condition would be far worse', () => {
    const findings = [{ ruleId: 'ii_adapter_identity:ii_adapter:owner_mismatch' }];
    expect(dropIdentityMirrors(findings, new Set())).toHaveLength(1);
  });
});

describe('PC5 K.13 — permittedPc5Actions', () => {
  const base = {
    severity: 'blocking' as const,
    aieStatus: 'open' as AieUnresolvedItemStatus,
    persistedPermittedActionTypes: ['choose_value', 'reject_document'],
    hasChoiceField: true,
    alreadyDismissed: false,
  };

  it('offers a choice only when the ROW permits it AND a resolvable option set exists', () => {
    expect(permittedPc5Actions(base)).toContain('choose_value');
    // The row does not permit it — offered nowhere, even though the
    // registry declares a choosable field.
    expect(permittedPc5Actions({ ...base, persistedPermittedActionTypes: ['reject_document'] })).not.toContain('choose_value');
    // The row permits it but no option resolved (e.g. an empty household).
    expect(permittedPc5Actions({ ...base, hasChoiceField: false })).not.toContain('choose_value');
  });

  it('NEVER offers dismiss for a BLOCKING item — suppressing a blocker from view is never "where allowed"', () => {
    expect(permittedPc5Actions(base)).not.toContain('dismiss');
    for (const status of PC5_LIVE_ITEM_STATUSES) {
      expect(permittedPc5Actions({ ...base, aieStatus: status })).not.toContain('dismiss');
    }
  });

  it('offers dismiss for a WARNING that is not already dismissed', () => {
    expect(permittedPc5Actions({ ...base, severity: 'warning' })).toContain('dismiss');
    expect(permittedPc5Actions({ ...base, severity: 'warning', alreadyDismissed: true })).not.toContain('dismiss');
  });

  it('offers acknowledge on an un-acknowledged live item, and not twice', () => {
    expect(permittedPc5Actions(base)).toContain('acknowledge');
    expect(permittedPc5Actions({ ...base, aieStatus: 'in_review' })).not.toContain('acknowledge');
  });

  it('always offers discard on a live item — "this is not my document" must never be a dead end', () => {
    for (const status of PC5_LIVE_ITEM_STATUSES) {
      expect(permittedPc5Actions({ ...base, aieStatus: status })).toContain('discard_statement');
    }
  });

  it('offers NOTHING on a terminal item', () => {
    for (const status of PC5_TERMINAL_ITEM_STATUSES) {
      expect(permittedPc5Actions({ ...base, aieStatus: status })).toEqual([]);
    }
  });

  it('the persisted column is an OUTER BOUND — it can narrow, never widen', () => {
    // An empty bound means no choice is offered no matter what the registry
    // says. This is the check that makes `permitted_action_types` real
    // rather than the write-only column it was before PC5.
    const actions = permittedPc5Actions({ ...base, persistedPermittedActionTypes: [] });
    expect(actions).not.toContain('choose_value');
    // Acknowledge/discard remain: neither asserts anything financial, and
    // neither can unblock anything.
    expect(actions).toEqual(['acknowledge', 'discard_statement']);
  });
});

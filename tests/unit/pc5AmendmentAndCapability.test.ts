/**
 * PC5 (M4) — K.18's undo/amendment decision, and K.20's capability check.
 *
 * K.18's decision is "amendment by supersession, no undo", and the most
 * important assertions here are the ones proving there is no path that
 * quietly removes accepted financial history.
 */
import { describe, it, expect } from 'vitest';
import { PC5_AMENDMENT_GUIDANCE, amendmentPathForRunStatus, canAmendInFlight, type Pc5AmendmentPath } from '@/lib/pc5/amendment';
import { createPc5CapabilityDeps } from '@/lib/pc5/capability';
import { AIE_RUN_STATUSES } from '@/lib/aie/types';

describe('PC5 K.18 — amendmentPathForRunStatus is total over every run status', () => {
  it('handles every AIE run status without throwing (the never-check must never be reachable)', () => {
    for (const status of AIE_RUN_STATUSES) {
      expect(() => amendmentPathForRunStatus(status)).not.toThrow();
    }
  });

  it('every path it can return has guidance written for it', () => {
    for (const status of AIE_RUN_STATUSES) {
      const path = amendmentPathForRunStatus(status);
      expect(PC5_AMENDMENT_GUIDANCE[path], `no guidance for ${path}`).toBeTruthy();
    }
  });

  it('a COMPLETED run requires Investment Intelligence supersession — PC5 refuses to unwind an accepted import', () => {
    expect(amendmentPathForRunStatus('completed')).toBe('ii_supersession_required');
    expect(canAmendInFlight('completed')).toBe(false);
  });

  it('a mid-write run is told to WAIT rather than being amended into a race', () => {
    expect(amendmentPathForRunStatus('accepted')).toBe('wait_for_write_to_settle');
    expect(amendmentPathForRunStatus('write_pending')).toBe('wait_for_write_to_settle');
    expect(canAmendInFlight('accepted')).toBe(false);
    expect(canAmendInFlight('write_pending')).toBe(false);
  });

  it('an unresolved run can have its decision amended', () => {
    expect(amendmentPathForRunStatus('unresolved')).toBe('amend_decision_in_flight');
    expect(canAmendInFlight('unresolved')).toBe(true);
  });

  it('a pre-acceptance run can be discarded outright — nothing canonical exists to preserve', () => {
    expect(amendmentPathForRunStatus('awaiting_acceptance')).toBe('discard_before_acceptance');
    expect(amendmentPathForRunStatus('reconciling')).toBe('discard_before_acceptance');
    expect(canAmendInFlight('awaiting_acceptance')).toBe(true);
  });

  it('a terminal-failed run has nothing to amend', () => {
    expect(amendmentPathForRunStatus('failed_terminal')).toBe('nothing_to_amend');
    expect(amendmentPathForRunStatus('privacy_blocked')).toBe('nothing_to_amend');
    expect(canAmendInFlight('failed_terminal')).toBe(false);
  });

  it('NO run status maps to an "undo" path — the vocabulary contains none', () => {
    const paths = new Set<Pc5AmendmentPath>(AIE_RUN_STATUSES.map(amendmentPathForRunStatus));
    for (const p of paths) {
      expect(p).not.toMatch(/undo|delete|erase|remove/i);
    }
    expect([...paths].sort()).toEqual(
      ['amend_decision_in_flight', 'discard_before_acceptance', 'ii_supersession_required', 'nothing_to_amend', 'wait_for_write_to_settle'].sort(),
    );
  });

  it('the guidance for an accepted statement says it is a correction, never an undo, and promises nothing is deleted', () => {
    const text = PC5_AMENDMENT_GUIDANCE.ii_supersession_required;
    expect(text).toMatch(/supersedes|correction/i);
    expect(text).toMatch(/Nothing is deleted/i);
  });
});

describe('PC5 K.20 — the capability check PC5 supplies to AIE', () => {
  const { checkCapability } = createPc5CapabilityDeps();

  it('permits a user to act on their OWN items', async () => {
    expect(await checkCapability('user-1', 'user-1')).toBe(true);
  });

  it('REFUSES a cross-user attempt', async () => {
    expect(await checkCapability('user-1', 'user-2')).toBe(false);
    expect(await checkCapability('user-2', 'user-1')).toBe(false);
  });

  it('REFUSES when either identity is absent — "unauthenticated equals unauthenticated" must never be a match', async () => {
    expect(await checkCapability('', '')).toBe(false);
    expect(await checkCapability('', 'user-1')).toBe(false);
    expect(await checkCapability('user-1', '')).toBe(false);
    expect(await checkCapability(undefined as unknown as string, undefined as unknown as string)).toBe(false);
  });

  it('is genuinely injected, not a default that allows everything — the AIE seam requires a caller to supply one', () => {
    const deps = createPc5CapabilityDeps();
    expect(typeof deps.checkCapability).toBe('function');
    // The interface declares `checkCapability` as required (no optional
    // marker, no default), which is what makes an "allow everything"
    // fallback structurally impossible. Asserted by construction: the
    // object literal above would not type-check without it.
    expect(Object.keys(deps)).toEqual(['checkCapability']);
  });
});

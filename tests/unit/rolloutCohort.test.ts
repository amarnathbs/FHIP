import { describe, it, expect, afterEach } from 'vitest';
import {
  resolveRolloutDecision,
  isRolloutPermitted,
  __setRolloutConfigForTests,
} from '@/lib/services/rolloutCohort';

const KEY = 'TEST_FEATURE';

function setEnv(vars: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

afterEach(() => {
  __setRolloutConfigForTests(KEY, undefined);
  setEnv({
    [`ROLLOUT_${KEY}_ENABLED`]: undefined,
    [`ROLLOUT_${KEY}_VERSION`]: undefined,
    [`ROLLOUT_${KEY}_PERCENTAGE`]: undefined,
    [`ROLLOUT_${KEY}_ALLOWLIST`]: undefined,
    [`ROLLOUT_${KEY}_DENYLIST`]: undefined,
  });
});

describe('rolloutCohort — kill switch and fail-closed configuration', () => {
  it('is OFF for every subject when the kill switch env var is entirely unset', () => {
    const d = resolveRolloutDecision(KEY, 'user-1');
    expect(d.permitted).toBe(false);
    expect(d.reason).toBe('KILL_SWITCH_OFF');
  });

  it('is OFF for any ENABLED value other than the exact string "true"', () => {
    for (const value of ['TRUE', '1', 'yes', '']) {
      setEnv({ [`ROLLOUT_${KEY}_ENABLED`]: value });
      expect(resolveRolloutDecision(KEY, 'user-1').permitted, `ENABLED=${JSON.stringify(value)}`).toBe(false);
    }
  });

  it('fails closed (never throws, never defaults to 100%) when VERSION is missing', () => {
    setEnv({ [`ROLLOUT_${KEY}_ENABLED`]: 'true', [`ROLLOUT_${KEY}_PERCENTAGE`]: '100' });
    const d = resolveRolloutDecision(KEY, 'user-1');
    expect(d.permitted).toBe(false);
    expect(d.reason).toBe('MALFORMED_CONFIG');
  });

  it('fails closed when PERCENTAGE is missing, non-numeric, negative, >100, or non-integer', () => {
    for (const pct of [undefined, 'abc', '-1', '101', '50.5', '']) {
      setEnv({
        [`ROLLOUT_${KEY}_ENABLED`]: 'true',
        [`ROLLOUT_${KEY}_VERSION`]: 'v1',
        [`ROLLOUT_${KEY}_PERCENTAGE`]: pct,
      });
      const d = resolveRolloutDecision(KEY, 'user-1');
      expect(d.permitted, `PERCENTAGE=${JSON.stringify(pct)}`).toBe(false);
      expect(d.reason, `PERCENTAGE=${JSON.stringify(pct)}`).toBe('MALFORMED_CONFIG');
    }
  });

  it('PERCENTAGE=0 with valid config permits nobody (not an error, a genuine 0% cohort)', () => {
    setEnv({ [`ROLLOUT_${KEY}_ENABLED`]: 'true', [`ROLLOUT_${KEY}_VERSION`]: 'v1', [`ROLLOUT_${KEY}_PERCENTAGE`]: '0' });
    for (const subject of ['user-1', 'user-2', 'user-3', 'user-4', 'user-5']) {
      const d = resolveRolloutDecision(KEY, subject);
      expect(d.permitted, subject).toBe(false);
      expect(d.reason, subject).toBe('PERCENTAGE_EXCLUDED');
    }
  });

  it('PERCENTAGE=100 with valid config permits everybody', () => {
    setEnv({ [`ROLLOUT_${KEY}_ENABLED`]: 'true', [`ROLLOUT_${KEY}_VERSION`]: 'v1', [`ROLLOUT_${KEY}_PERCENTAGE`]: '100' });
    for (const subject of ['user-1', 'user-2', 'user-3', 'user-4', 'user-5']) {
      expect(resolveRolloutDecision(KEY, subject).permitted, subject).toBe(true);
    }
  });
});

describe('rolloutCohort — deny/allow list precedence', () => {
  it('a denylisted subject is excluded even at PERCENTAGE=100', () => {
    setEnv({
      [`ROLLOUT_${KEY}_ENABLED`]: 'true',
      [`ROLLOUT_${KEY}_VERSION`]: 'v1',
      [`ROLLOUT_${KEY}_PERCENTAGE`]: '100',
      [`ROLLOUT_${KEY}_DENYLIST`]: 'user-blocked',
    });
    const d = resolveRolloutDecision(KEY, 'user-blocked');
    expect(d.permitted).toBe(false);
    expect(d.reason).toBe('DENYLISTED');
  });

  it('denylist takes precedence over allowlist for the same subject', () => {
    setEnv({
      [`ROLLOUT_${KEY}_ENABLED`]: 'true',
      [`ROLLOUT_${KEY}_VERSION`]: 'v1',
      [`ROLLOUT_${KEY}_PERCENTAGE`]: '0',
      [`ROLLOUT_${KEY}_ALLOWLIST`]: 'user-x',
      [`ROLLOUT_${KEY}_DENYLIST`]: 'user-x',
    });
    const d = resolveRolloutDecision(KEY, 'user-x');
    expect(d.permitted).toBe(false);
    expect(d.reason).toBe('DENYLISTED');
  });

  it('an allowlisted subject is included even at PERCENTAGE=0', () => {
    setEnv({
      [`ROLLOUT_${KEY}_ENABLED`]: 'true',
      [`ROLLOUT_${KEY}_VERSION`]: 'v1',
      [`ROLLOUT_${KEY}_PERCENTAGE`]: '0',
      [`ROLLOUT_${KEY}_ALLOWLIST`]: 'qa-cert-user',
    });
    const d = resolveRolloutDecision(KEY, 'qa-cert-user');
    expect(d.permitted).toBe(true);
    expect(d.reason).toBe('ALLOWLISTED');
    // A non-allowlisted subject in the same config is still excluded.
    expect(resolveRolloutDecision(KEY, 'ordinary-user').permitted).toBe(false);
  });
});

describe('rolloutCohort — stable, non-client-controlled, expanding allocation', () => {
  it('the SAME subject + key + version always resolves to the same bucket, across repeated calls', () => {
    setEnv({ [`ROLLOUT_${KEY}_ENABLED`]: 'true', [`ROLLOUT_${KEY}_VERSION`]: 'v1', [`ROLLOUT_${KEY}_PERCENTAGE`]: '50' });
    const first = resolveRolloutDecision(KEY, 'stable-subject');
    for (let i = 0; i < 20; i++) {
      const again = resolveRolloutDecision(KEY, 'stable-subject');
      expect(again.permitted).toBe(first.permitted);
      expect(again.bucket).toBe(first.bucket);
    }
  });

  it('raising the percentage (version unchanged) only ever ADDS subjects — never removes one already included (expanding cohort, not a reshuffle)', () => {
    const subjects = Array.from({ length: 300 }, (_, i) => `subject-${i}`);
    function includedAt(pct: number): Set<string> {
      setEnv({ [`ROLLOUT_${KEY}_ENABLED`]: 'true', [`ROLLOUT_${KEY}_VERSION`]: 'v1', [`ROLLOUT_${KEY}_PERCENTAGE`]: String(pct) });
      return new Set(subjects.filter((s) => resolveRolloutDecision(KEY, s).permitted));
    }
    const at10 = includedAt(10);
    const at30 = includedAt(30);
    const at70 = includedAt(70);
    for (const s of at10) expect(at30.has(s), `${s} included at 10% must remain included at 30%`).toBe(true);
    for (const s of at30) expect(at70.has(s), `${s} included at 30% must remain included at 70%`).toBe(true);
    // Sanity: the sets actually differ in size (this isn't a degenerate
    // all-or-nothing hash) — with 300 subjects, 10/30/70% should visibly grow.
    expect(at30.size).toBeGreaterThan(at10.size);
    expect(at70.size).toBeGreaterThan(at30.size);
  });

  it('changing ONLY the version reshuffles allocation (a deliberate re-bucket, distinct from a percentage change)', () => {
    setEnv({ [`ROLLOUT_${KEY}_ENABLED`]: 'true', [`ROLLOUT_${KEY}_VERSION`]: 'v1', [`ROLLOUT_${KEY}_PERCENTAGE`]: '50' });
    const subjects = Array.from({ length: 200 }, (_, i) => `subj-${i}`);
    const v1 = new Set(subjects.filter((s) => resolveRolloutDecision(KEY, s).permitted));
    setEnv({ [`ROLLOUT_${KEY}_VERSION`]: 'v2' });
    const v2 = new Set(subjects.filter((s) => resolveRolloutDecision(KEY, s).permitted));
    // Same percentage, different version -> not the identical membership set
    // (a version bump is the intended way to re-shuffle; this is not a
    // strict superset/subset relationship, unlike the percentage-only case).
    const identical = subjects.every((s) => v1.has(s) === v2.has(s));
    expect(identical, 'a version change should visibly reshuffle at least some subjects').toBe(false);
  });

  it('the roughly-uniform distribution check: ~50% of a large subject pool is permitted at PERCENTAGE=50 (within a generous tolerance)', () => {
    setEnv({ [`ROLLOUT_${KEY}_ENABLED`]: 'true', [`ROLLOUT_${KEY}_VERSION`]: 'uniformity-check', [`ROLLOUT_${KEY}_PERCENTAGE`]: '50' });
    const subjects = Array.from({ length: 2000 }, (_, i) => `uniform-subject-${i}`);
    const includedCount = subjects.filter((s) => resolveRolloutDecision(KEY, s).permitted).length;
    const fraction = includedCount / subjects.length;
    expect(fraction).toBeGreaterThan(0.4);
    expect(fraction).toBeLessThan(0.6);
  });

  it('isRolloutPermitted() convenience wrapper matches resolveRolloutDecision().permitted', () => {
    setEnv({ [`ROLLOUT_${KEY}_ENABLED`]: 'true', [`ROLLOUT_${KEY}_VERSION`]: 'v1', [`ROLLOUT_${KEY}_PERCENTAGE`]: '100' });
    expect(isRolloutPermitted(KEY, 'anyone')).toBe(resolveRolloutDecision(KEY, 'anyone').permitted);
  });
});

describe('rolloutCohort — test override seam (does not leak across process.env)', () => {
  it('the deterministic test override takes precedence over process.env, in both directions', () => {
    setEnv({ [`ROLLOUT_${KEY}_ENABLED`]: 'true', [`ROLLOUT_${KEY}_VERSION`]: 'v1', [`ROLLOUT_${KEY}_PERCENTAGE`]: '100' });
    __setRolloutConfigForTests(KEY, { enabled: true, version: 'override-v1', percentage: 0 });
    expect(resolveRolloutDecision(KEY, 'anyone').permitted).toBe(false);

    __setRolloutConfigForTests(KEY, undefined);
    expect(resolveRolloutDecision(KEY, 'anyone').permitted).toBe(true); // falls back to the (still-set) env config
  });

  it('an explicit undefined override with no env config still fails closed', () => {
    __setRolloutConfigForTests(KEY, undefined);
    expect(resolveRolloutDecision(KEY, 'anyone').permitted).toBe(false);
  });
});

describe('rolloutCohort — no jurisdiction/currency coupling in the module surface', () => {
  it('resolveRolloutDecision/isRolloutPermitted accept only (key, subjectId) — no country or currency parameter exists to accidentally derive jurisdiction from', () => {
    expect(resolveRolloutDecision.length).toBe(2);
    expect(isRolloutPermitted.length).toBe(2);
  });
});

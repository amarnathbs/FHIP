/**
 * PC5 (M4) — K.5's ownership vocabulary, K.9/K.10's closed answer sets,
 * and K.14's deep links.
 *
 * The K.9 assertion is the sharp one: the summary-mismatch option set must
 * contain NO free-form value, because K.9 forbids letting a user type a
 * balancing number into canonical truth. A test is the right place for that
 * because it is the kind of affordance that gets added back later "just for
 * this one case".
 */
import { describe, it, expect } from 'vitest';
import {
  PC5_DUPLICATE_RESOLUTION_OPTIONS,
  PC5_JOINT_OPTION_VALUE,
  PC5_PERMITTED_OWNER_ROLES,
  PC5_SUMMARY_MISMATCH_OPTIONS,
  isPermittedChoice,
} from '@/lib/pc5/optionSets';
import { OWNER_VALUES } from '@/lib/constants';
import {
  PC5_RESOLUTIONS_BASE,
  aieRunReviewHref,
  pc5ItemHref,
  pc5PasswordUnlockEndpoint,
  pc5PasswordUnlockHref,
  pc5RunHref,
} from '@/lib/pc5/deepLinks';
import { II_WORKSPACE_NAV } from '@/lib/investment-intelligence/workspaceNav';
import { existsSync } from 'fs';
import { join } from 'path';

describe('PC5 K.5 — PC5 introduces no new ownership vocabulary', () => {
  it('the permitted owner roles ARE the canonical eight, unchanged', () => {
    expect([...PC5_PERMITTED_OWNER_ROLES]).toEqual([...OWNER_VALUES]);
    expect(PC5_PERMITTED_OWNER_ROLES).toHaveLength(8);
  });

  it('HUF IS NOT AN OWNERSHIP VALUE ANYWHERE — K.5 asked for it, this repository does not model it, and PC5 refuses to invent it', () => {
    // Recorded as an executable assertion rather than only as prose,
    // because the tempting "fix" is to add a ninth enum value with no
    // valuation, consolidation or net-worth semantics behind it — exactly
    // what `'company'`/`'family_trust'` already are, and exactly why they
    // had to be retired into LEGACY_ENTITY_OWNER_RESTRICTIONS.
    expect(PC5_PERMITTED_OWNER_ROLES).not.toContain('huf');
    expect(PC5_PERMITTED_OWNER_ROLES.some((r) => r.toLowerCase().includes('huf'))).toBe(false);
  });

  it('the joint sentinel is not a uuid and so can never collide with a member or entity id', () => {
    expect(PC5_JOINT_OPTION_VALUE).toBe('joint');
    expect(PC5_JOINT_OPTION_VALUE).not.toMatch(/^[0-9a-f]{8}-/i);
  });
});

describe('PC5 K.10 — duplicate resolution is a closed three-option set matching K.10\'s own three questions', () => {
  it('offers exactly the three answers K.10 enumerates', () => {
    expect(PC5_DUPLICATE_RESOLUTION_OPTIONS.map((o) => o.value)).toEqual([
      'same_economic_event',
      'separate_genuine_events',
      'wrong_statement_or_source',
    ]);
  });

  it('every option explains its consequence, so a user is not guessing what their answer does', () => {
    for (const o of PC5_DUPLICATE_RESOLUTION_OPTIONS) {
      expect(o.label.length).toBeGreaterThan(10);
      expect(o.detail, `no consequence stated for ${o.value}`).toBeTruthy();
    }
  });

  it('none of them requires an allocation', () => {
    for (const o of PC5_DUPLICATE_RESOLUTION_OPTIONS) expect(o.requiresAllocation).toBeUndefined();
  });
});

describe('PC5 K.9 — a summary mismatch can NEVER be answered with a typed number', () => {
  it('every option is a closed-vocabulary token, not a value', () => {
    for (const o of PC5_SUMMARY_MISMATCH_OPTIONS) {
      expect(o.value).toMatch(/^[a-z_]+$/);
      // No numeric value can hide in a token made only of lowercase
      // letters and underscores.
      expect(o.value).not.toMatch(/\d/);
    }
  });

  it('offers only: trust the statement, trust the transactions, or discard — never "enter the correct balance"', () => {
    expect(PC5_SUMMARY_MISMATCH_OPTIONS.map((o) => o.value)).toEqual([
      'trust_statement_summary',
      'trust_reconstructed_transactions',
      'wrong_statement_or_source',
    ]);
  });

  it('the "trust the transactions" option does not promise the exception will clear — it says the check re-runs', () => {
    const option = PC5_SUMMARY_MISMATCH_OPTIONS.find((o) => o.value === 'trust_reconstructed_transactions')!;
    expect(option.detail).toMatch(/still do not reconcile|stays open/i);
  });
});

describe('PC5 — isPermittedChoice is the authorisation boundary', () => {
  const options = [{ value: 'm1', label: 'A' }, { value: 'm2', label: 'B' }];

  it('accepts a value in the set', () => {
    expect(isPermittedChoice(options, 'm1')).toBe(true);
  });

  it('REFUSES a value outside the set — this is what defeats a forged owner/account id', () => {
    expect(isPermittedChoice(options, 'm999')).toBe(false);
    expect(isPermittedChoice(options, '')).toBe(false);
  });

  it('REFUSES everything when the set is empty', () => {
    expect(isPermittedChoice([], 'm1')).toBe(false);
  });

  it('does not match on prefix, suffix or case', () => {
    expect(isPermittedChoice(options, 'M1')).toBe(false);
    expect(isPermittedChoice(options, 'm1 ')).toBe(false);
    expect(isPermittedChoice(options, 'm')).toBe(false);
  });
});

describe('PC5 K.14 — deep links point at the exact case, and at pages that exist', () => {
  it('an item link addresses ONE item, not a list', () => {
    expect(pc5ItemHref('abc-123')).toBe('/investment-intelligence/resolutions/abc-123');
    expect(pc5ItemHref('abc-123')).not.toBe(PC5_RESOLUTIONS_BASE);
  });

  it('ids are URL-encoded, so a crafted id cannot break out of the path', () => {
    expect(pc5ItemHref('a/b?c=d')).toBe('/investment-intelligence/resolutions/a%2Fb%3Fc%3Dd');
    expect(pc5RunHref('a&b')).toBe('/investment-intelligence/resolutions?run=a%26b');
  });

  it('every link is a PATH, never an absolute URL — an absolute one would break previews and be an open-redirect shape', () => {
    const links = [PC5_RESOLUTIONS_BASE, pc5ItemHref('x'), pc5RunHref('x'), aieRunReviewHref('x'), pc5PasswordUnlockHref('x'), pc5PasswordUnlockEndpoint('x')];
    for (const l of links) {
      expect(l.startsWith('/')).toBe(true);
      expect(l).not.toMatch(/^https?:/);
      expect(l).not.toMatch(/^\/\//);
    }
  });

  it('the pages these links target actually exist on disk', () => {
    const root = process.cwd();
    expect(existsSync(join(root, 'app', '(app)', 'investment-intelligence', 'resolutions', 'page.tsx'))).toBe(true);
    expect(existsSync(join(root, 'app', '(app)', 'investment-intelligence', 'resolutions', '[itemId]', 'page.tsx'))).toBe(true);
    expect(existsSync(join(root, 'app', '(app)', 'aie-review', 'page.tsx'))).toBe(true);
  });

  it('K.8: the password-unlock endpoint is the REAL route that exists, not a request_reprocessing action that does not', () => {
    expect(pc5PasswordUnlockEndpoint('intake-1')).toBe('/api/aie/investment-intelligence/intake/intake-1/process');
    expect(
      existsSync(join(process.cwd(), 'app', 'api', 'aie', 'investment-intelligence', 'intake', '[intakeId]', 'process', 'route.ts')),
    ).toBe(true);
  });

  it('the resolutions surface is reachable from the workspace nav', () => {
    const item = II_WORKSPACE_NAV.find((i) => i.href === PC5_RESOLUTIONS_BASE);
    expect(item, 'PC5 must be reachable from the II workspace nav, not only by deep link').toBeDefined();
    expect(item!.key).toBe('resolutions');
  });
});

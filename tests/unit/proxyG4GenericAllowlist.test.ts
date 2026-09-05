import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// G4 (dispatch section 8): proxy.ts's middleware-level generic-experience
// allowlist must widen to include the six newly-certified-universal page
// routes (Income/Expenses/Insurance/Scores/DNA/Resilience) ONLY while the G4
// flag is on, and must stay byte-identical to the pre-G4 regex when off.
//
// Extracted from the real source (same convention as
// tests/unit/countryGateAccessMatrix.test.ts's isAppRoute regex test) rather
// than hand-duplicated, so this test breaks instead of silently drifting if
// proxy.ts's construction is ever rewritten.
describe('proxy.ts — G4 generic-experience allowlist widening', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../proxy.ts'), 'utf8');

  it('the flag-off branch is the exact literal pre-G4 regex, unchanged', () => {
    // Matches the exact literal text of the `: /^\/(...)/ .test(pathname);`
    // ternary's else-branch.
    const match = src.match(/:\s*\/\^\\\/\(([^)]+)\)\/\.test\(pathname\);/);
    expect(match).not.toBeNull();
    const legacyRegex = new RegExp(`^/(${match![1]})`);
    expect(legacyRegex.test('/global-setup')).toBe(true);
    expect(legacyRegex.test('/profile')).toBe(true);
    expect(legacyRegex.test('/confirm-country')).toBe(true);
    expect(legacyRegex.test('/onboarding')).toBe(true);
    // The load-bearing negative controls: none of the six newly-certified
    // routes are reachable when the flag is off.
    for (const blocked of ['/income', '/expenses', '/insurance', '/score', '/dna', '/resilience']) {
      expect(legacyRegex.test(blocked), blocked).toBe(false);
    }
    // And every still-unavailable-for-GENERIC module stays blocked too.
    for (const blocked of ['/dashboard', '/assets', '/liabilities', '/investments', '/goals', '/retirement', '/forecast']) {
      expect(legacyRegex.test(blocked), blocked).toBe(false);
    }
  });

  it('the flag-on widened prefix list names exactly the six G4-certified-universal page routes', () => {
    const match = src.match(/const G4_NEWLY_ENABLED_ROUTE_PREFIXES = '([^']+)';/);
    expect(match).not.toBeNull();
    expect(match![1].split('|').sort()).toEqual(['dna', 'expenses', 'income', 'insurance', 'resilience', 'score']);
  });

  it('the flag-on regex construction template includes the base G3 allowlist AND the widened-prefixes interpolation', () => {
    expect(src).toContain(
      '? new RegExp(`^\\\\/(global-setup|profile|confirm-country|onboarding|${G4_NEWLY_ENABLED_ROUTE_PREFIXES})`).test(pathname)'
    );
  });

  it('isGenericAllowedRoute is switched by isG4CapabilityLayerEnabled(), not a client-supplied value', () => {
    expect(src).toContain('const isGenericAllowedRoute = isG4CapabilityLayerEnabled()');
  });
});

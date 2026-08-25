// Investment Intelligence R11 — the actual independent professional-
// security-oracle-vs-production diff (spec sections 96-97). Maps each
// oracle scenario (scripts/r11_professional_security_oracle.mjs, which
// never imports production code) onto real RelationshipRecord/
// ScopeGrantRecord inputs and calls the REAL checkProfessionalAccess().
import { describe, it, expect } from 'vitest';
import { SCENARIOS } from '../../scripts/r11_professional_security_oracle.mjs';
import { checkProfessionalAccess, type ProfessionalScope, type RelationshipRecord, type ScopeGrantRecord } from '@/lib/services/professional-access/permissions';

interface OracleScenario {
  id: string;
  name: string;
  scenario: {
    relationshipExists: boolean;
    sameClientProfessionalPair: boolean;
    status: string;
    expiresAt: number | null;
    now: number;
    professionalActive: boolean;
    grantedScope: string;
    scopeRevoked: boolean;
    requestedScope: string;
  };
  expected: 'ALLOW' | 'DENY';
}

function toDate(epochLikeMs: number): string {
  // The oracle uses small integer "epoch-like" units for readability
  // (T0=1000000); mapped onto real millisecond timestamps here so the
  // production function's actual Date arithmetic is exercised, not just
  // the oracle's simplified integer comparison.
  return new Date(epochLikeMs).toISOString();
}

describe('R11 independent professional-security oracle vs production code', () => {
  const scenarios = SCENARIOS as OracleScenario[];

  it('the oracle scenario corpus is non-trivial (at least 20 distinct scenarios)', () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(20);
  });

  for (const s of scenarios) {
    it(`${s.id}: ${s.name}`, () => {
      const CLIENT = 'client-oracle';
      const PRO = 'pro-oracle';
      const relationship: RelationshipRecord | null = s.scenario.relationshipExists
        ? {
            id: 'rel-oracle',
            clientUserId: CLIENT,
            professionalUserId: PRO,
            status: s.scenario.status as RelationshipRecord['status'],
            expiresAt: s.scenario.expiresAt === null ? null : toDate(s.scenario.expiresAt),
            professionalIsActive: s.scenario.professionalActive,
          }
        : null;
      const scopeGrants: ScopeGrantRecord[] = s.scenario.relationshipExists
        ? [{ relationshipId: 'rel-oracle', scope: s.scenario.grantedScope as ProfessionalScope, revokedAt: s.scenario.scopeRevoked ? toDate(s.scenario.now) : null }]
        : [];

      const result = checkProfessionalAccess({
        now: new Date(toDate(s.scenario.now)),
        relationship,
        requestedClientUserId: s.scenario.sameClientProfessionalPair ? CLIENT : 'someone-else-entirely',
        requestedProfessionalUserId: PRO,
        scope: s.scenario.requestedScope as ProfessionalScope,
        liveScopeGrants: scopeGrants,
      });

      const actual = result.allow ? 'ALLOW' : 'DENY';
      expect(actual, `oracle expected ${s.expected} but production returned ${actual} (reason: ${result.reason}) for ${s.id}`).toBe(s.expected);
    });
  }

  it('summary: 0 discrepancies between independent permission oracle and production across the full corpus', () => {
    const CLIENT = 'client-oracle';
    const PRO = 'pro-oracle';
    const mismatches = scenarios.filter((s) => {
      const relationship: RelationshipRecord | null = s.scenario.relationshipExists
        ? {
            id: 'rel-oracle',
            clientUserId: CLIENT,
            professionalUserId: PRO,
            status: s.scenario.status as RelationshipRecord['status'],
            expiresAt: s.scenario.expiresAt === null ? null : toDate(s.scenario.expiresAt),
            professionalIsActive: s.scenario.professionalActive,
          }
        : null;
      const scopeGrants: ScopeGrantRecord[] = s.scenario.relationshipExists
        ? [{ relationshipId: 'rel-oracle', scope: s.scenario.grantedScope as ProfessionalScope, revokedAt: s.scenario.scopeRevoked ? toDate(s.scenario.now) : null }]
        : [];
      const result = checkProfessionalAccess({
        now: new Date(toDate(s.scenario.now)),
        relationship,
        requestedClientUserId: s.scenario.sameClientProfessionalPair ? CLIENT : 'someone-else-entirely',
        requestedProfessionalUserId: PRO,
        scope: s.scenario.requestedScope as ProfessionalScope,
        liveScopeGrants: scopeGrants,
      });
      const actual = result.allow ? 'ALLOW' : 'DENY';
      return actual !== s.expected;
    });
    expect(mismatches.map((m) => m.id)).toEqual([]);
  });
});

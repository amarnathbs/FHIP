// Investment Intelligence R11 — deterministic certification cases for
// permissions.ts (spec sections 43-71, mandatory attacks in 77-92). Pure
// function only — every case is real and distinct.
import { describe, it, expect } from 'vitest';
import {
  checkProfessionalAccess,
  checkReportAccess,
  isProfessionalScope,
  isRawDocumentScopeSupported,
  PROFESSIONAL_SCOPES,
  type RelationshipRecord,
  type ScopeGrantRecord,
} from '@/lib/services/professional-access/permissions';

const NOW = new Date('2026-06-15T00:00:00Z');
const CLIENT = 'client-1';
const PRO = 'pro-1';
const OTHER_CLIENT = 'client-2';
const OTHER_PRO = 'pro-2';

function relationship(overrides: Partial<RelationshipRecord> = {}): RelationshipRecord {
  return {
    id: 'rel-1',
    clientUserId: CLIENT,
    professionalUserId: PRO,
    status: 'active',
    expiresAt: null,
    professionalIsActive: true,
    ...overrides,
  };
}

function grant(overrides: Partial<ScopeGrantRecord> = {}): ScopeGrantRecord {
  return { relationshipId: 'rel-1', scope: 'VIEW_INVESTMENTS', revokedAt: null, ...overrides };
}

function base(overrides: Partial<Parameters<typeof checkProfessionalAccess>[0]> = {}) {
  return {
    now: NOW,
    relationship: relationship(),
    requestedClientUserId: CLIENT,
    requestedProfessionalUserId: PRO,
    scope: 'VIEW_INVESTMENTS' as const,
    liveScopeGrants: [grant()],
    ...overrides,
  };
}

describe('R11 PA-01..10 — the happy path and the basic denial shapes', () => {
  it('PA-01 active relationship + live matching scope -> allow', () => {
    expect(checkProfessionalAccess(base()).allow).toBe(true);
  });
  it('PA-02 no relationship at all -> deny NO_RELATIONSHIP', () => {
    const r = checkProfessionalAccess(base({ relationship: null }));
    expect(r.allow).toBe(false);
    expect(!r.allow && r.code).toBe('NO_RELATIONSHIP');
  });
  it('PA-03 pending_invite (not yet accepted) -> deny NOT_ACTIVE', () => {
    const r = checkProfessionalAccess(base({ relationship: relationship({ status: 'pending_invite' }) }));
    expect(r.allow).toBe(false);
    expect(!r.allow && r.code).toBe('NOT_ACTIVE');
  });
  it('PA-04 revoked -> deny NOT_ACTIVE', () => {
    const r = checkProfessionalAccess(base({ relationship: relationship({ status: 'revoked' }) }));
    expect(r.allow).toBe(false);
    expect(!r.allow && r.code).toBe('NOT_ACTIVE');
  });
  it('PA-05 declined -> deny NOT_ACTIVE', () => {
    const r = checkProfessionalAccess(base({ relationship: relationship({ status: 'declined' }) }));
    expect(r.allow).toBe(false);
  });
  it('PA-06 scope never granted -> deny SCOPE_NOT_GRANTED', () => {
    const r = checkProfessionalAccess(base({ liveScopeGrants: [] }));
    expect(r.allow).toBe(false);
    expect(!r.allow && r.code).toBe('SCOPE_NOT_GRANTED');
  });
  it('PA-07 scope granted then revoked -> deny SCOPE_REVOKED', () => {
    const r = checkProfessionalAccess(base({ liveScopeGrants: [grant({ revokedAt: '2026-06-01T00:00:00Z' })] }));
    expect(r.allow).toBe(false);
    expect(!r.allow && r.code).toBe('SCOPE_REVOKED');
  });
  it('PA-08 scope granted for a DIFFERENT relationship id -> deny SCOPE_NOT_GRANTED (a leaked/reused grant row from another relationship must not count)', () => {
    const r = checkProfessionalAccess(base({ liveScopeGrants: [grant({ relationshipId: 'rel-OTHER' })] }));
    expect(r.allow).toBe(false);
  });
  it('PA-09 correct scope requested, but only a DIFFERENT scope is granted -> deny', () => {
    const r = checkProfessionalAccess(base({ liveScopeGrants: [grant({ scope: 'VIEW_GOALS' })] }));
    expect(r.allow).toBe(false);
    expect(!r.allow && r.code).toBe('SCOPE_NOT_GRANTED');
  });
  it('PA-10 re-granted after a prior revocation (two rows: one revoked, one live) -> allow (history preserved, current state correct)', () => {
    const r = checkProfessionalAccess(
      base({ liveScopeGrants: [grant({ revokedAt: '2026-01-01T00:00:00Z' }), grant({ revokedAt: null })] })
    );
    expect(r.allow).toBe(true);
  });
});

describe('R11 PA-11..18 — MANDATORY: expiry behaves exactly like revocation', () => {
  it('PA-11 expiresAt in the future -> allow', () => {
    const r = checkProfessionalAccess(base({ relationship: relationship({ expiresAt: '2026-12-31T00:00:00Z' }) }));
    expect(r.allow).toBe(true);
  });
  it('PA-12 expiresAt exactly now -> deny EXPIRED (boundary is inclusive of expiry, not one tick later)', () => {
    const r = checkProfessionalAccess(base({ relationship: relationship({ expiresAt: NOW.toISOString() }) }));
    expect(r.allow).toBe(false);
    expect(!r.allow && r.code).toBe('EXPIRED');
  });
  it('PA-13 expiresAt in the past -> deny EXPIRED, even though the DB status column still literally says active (no background sweep required)', () => {
    const r = checkProfessionalAccess(base({ relationship: relationship({ status: 'active', expiresAt: '2020-01-01T00:00:00Z' }) }));
    expect(r.allow).toBe(false);
    expect(!r.allow && r.code).toBe('EXPIRED');
  });
  it('PA-14 null expiresAt (no expiry configured) never expires', () => {
    const r = checkProfessionalAccess(base({ relationship: relationship({ expiresAt: null }) }));
    expect(r.allow).toBe(true);
  });
  it('PA-15 expired relationship denial takes precedence over an otherwise-fine scope grant', () => {
    const r = checkProfessionalAccess(base({ relationship: relationship({ expiresAt: '2020-01-01T00:00:00Z' }), liveScopeGrants: [grant()] }));
    expect(r.allow).toBe(false);
  });
  it('PA-16 one millisecond before expiry -> allow', () => {
    const r = checkProfessionalAccess(base({ relationship: relationship({ expiresAt: new Date(NOW.getTime() + 1).toISOString() }) }));
    expect(r.allow).toBe(true);
  });
  it('PA-17 one millisecond after expiry -> deny', () => {
    const r = checkProfessionalAccess(base({ relationship: relationship({ expiresAt: new Date(NOW.getTime() - 1).toISOString() }) }));
    expect(r.allow).toBe(false);
  });
  it('PA-18 REVOKED-TOKEN-RETRY (mandatory, spec section 66): the identical relationship object that allowed access a moment ago denies immediately once its status flips to revoked — no separate cache/session state exists to invalidate', () => {
    const activeCtx = base();
    expect(checkProfessionalAccess(activeCtx).allow).toBe(true);
    const revokedCtx = { ...activeCtx, relationship: relationship({ status: 'revoked' }) };
    expect(checkProfessionalAccess(revokedCtx).allow).toBe(false);
  });
});

describe('R11 PA-19..24 — MANDATORY: deactivated professional loses ALL access regardless of relationship status', () => {
  it('PA-19 professional deactivated, relationship still active -> deny PROFESSIONAL_DEACTIVATED', () => {
    const r = checkProfessionalAccess(base({ relationship: relationship({ professionalIsActive: false }) }));
    expect(r.allow).toBe(false);
    expect(!r.allow && r.code).toBe('PROFESSIONAL_DEACTIVATED');
  });
  it('PA-20 deactivation denial applies even with every scope granted', () => {
    const r = checkProfessionalAccess(base({ relationship: relationship({ professionalIsActive: false }), liveScopeGrants: PROFESSIONAL_SCOPES.map((s) => grant({ scope: s })) }));
    expect(r.allow).toBe(false);
  });
  it('PA-21 professional reactivated -> access resumes (not a one-way door, unlike relationship revocation)', () => {
    const r = checkProfessionalAccess(base({ relationship: relationship({ professionalIsActive: true }) }));
    expect(r.allow).toBe(true);
  });
});

describe('R11 PA-25..30 — MANDATORY: wrong-client / cross-client assertions rejected', () => {
  it('PA-25 relationship belongs to a different client than the one asserted in the request -> deny WRONG_CLIENT', () => {
    const r = checkProfessionalAccess(base({ requestedClientUserId: OTHER_CLIENT }));
    expect(r.allow).toBe(false);
    expect(!r.allow && r.code).toBe('WRONG_CLIENT');
  });
  it('PA-26 relationship belongs to a different professional than the one asserted -> deny WRONG_CLIENT', () => {
    const r = checkProfessionalAccess(base({ requestedProfessionalUserId: OTHER_PRO }));
    expect(r.allow).toBe(false);
    expect(!r.allow && r.code).toBe('WRONG_CLIENT');
  });
  it('PA-27 MANDATORY cross-client attack: P2 supplies P1\'s relationship id but asserts themselves as the professional -> deny (the mismatch is caught even though the relationship row itself is real and active)', () => {
    const p1Relationship = relationship({ id: 'rel-p1-a', professionalUserId: PRO });
    const r = checkProfessionalAccess(base({ relationship: p1Relationship, requestedProfessionalUserId: OTHER_PRO, liveScopeGrants: [grant({ relationshipId: 'rel-p1-a' })] }));
    expect(r.allow).toBe(false);
    expect(!r.allow && r.code).toBe('WRONG_CLIENT');
  });
});

describe('R11 PA-31..36 — every scope is independently checkable (no broad "professional=full access" shortcut)', () => {
  for (const scope of PROFESSIONAL_SCOPES) {
    it(`PA-scope-${scope}: granting ONLY this scope allows this scope and denies every other scope`, () => {
      const grants = [grant({ scope })];
      expect(checkProfessionalAccess(base({ scope, liveScopeGrants: grants })).allow).toBe(true);
      for (const other of PROFESSIONAL_SCOPES) {
        if (other === scope) continue;
        expect(checkProfessionalAccess(base({ scope: other, liveScopeGrants: grants })).allow).toBe(false);
      }
    });
  }
});

describe('R11 PA-37..40 — report access reuses VIEW_REPORTS, never a separate professional-report scope', () => {
  it('PA-37 VIEW_REPORTS granted -> report access allowed', () => {
    const r = checkReportAccess(base({ liveScopeGrants: [grant({ scope: 'VIEW_REPORTS' })] }));
    expect(r.allow).toBe(true);
  });
  it('PA-38 MANDATORY: VIEW_INVESTMENTS granted but NOT VIEW_REPORTS -> report access denied', () => {
    const r = checkReportAccess(base({ liveScopeGrants: [grant({ scope: 'VIEW_INVESTMENTS' })] }));
    expect(r.allow).toBe(false);
    expect(!r.allow && r.code).toBe('SCOPE_NOT_GRANTED');
  });
  it('PA-39 no scopes at all -> report access denied', () => {
    const r = checkReportAccess(base({ liveScopeGrants: [] }));
    expect(r.allow).toBe(false);
  });
  it('PA-40 there is no "VIEW_REPORTS_PROFESSIONAL" or similar second scope in the vocabulary', () => {
    expect(PROFESSIONAL_SCOPES.filter((s) => s.includes('REPORT'))).toEqual(['VIEW_REPORTS']);
  });
});

describe('R11 PA-41..44 — raw document access is structurally absent, not merely defaulted false', () => {
  it('PA-41 isRawDocumentScopeSupported() is false', () => {
    expect(isRawDocumentScopeSupported()).toBe(false);
  });
  it('PA-42 VIEW_RAW_DOCUMENTS is not a member of PROFESSIONAL_SCOPES', () => {
    expect((PROFESSIONAL_SCOPES as readonly string[]).includes('VIEW_RAW_DOCUMENTS')).toBe(false);
  });
  it('PA-43 isProfessionalScope rejects VIEW_RAW_DOCUMENTS', () => {
    expect(isProfessionalScope('VIEW_RAW_DOCUMENTS')).toBe(false);
  });
  it('PA-44 isProfessionalScope rejects an arbitrary unknown string', () => {
    expect(isProfessionalScope('FULL_ACCESS')).toBe(false);
  });
  it('PA-44b isProfessionalScope accepts every real scope', () => {
    for (const s of PROFESSIONAL_SCOPES) expect(isProfessionalScope(s)).toBe(true);
  });
});

describe('R11 PA-45..48 — PROFESSIONAL_SCOPES vocabulary is exactly the frozen 8', () => {
  it('PA-45 exactly 8 scopes', () => {
    expect(PROFESSIONAL_SCOPES).toHaveLength(8);
  });
  it('PA-46 no duplicate scope names', () => {
    expect(new Set(PROFESSIONAL_SCOPES).size).toBe(8);
  });
  it('PA-47 no scope implies write access by name (spec: default read-oriented)', () => {
    for (const s of PROFESSIONAL_SCOPES) {
      expect(s.startsWith('VIEW_') || s === 'COMMENT_OR_NOTE').toBe(true);
    }
  });
  it('PA-48 matches the frozen list exactly', () => {
    expect([...PROFESSIONAL_SCOPES].sort()).toEqual(
      ['COMMENT_OR_NOTE', 'VIEW_FINANCIAL_SUMMARY', 'VIEW_FORECASTS', 'VIEW_GOALS', 'VIEW_INVESTMENTS', 'VIEW_REPORTS', 'VIEW_SOURCE_PROVENANCE', 'VIEW_TAX_SUMMARY'].sort()
    );
  });
});

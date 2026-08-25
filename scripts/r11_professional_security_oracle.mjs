#!/usr/bin/env node
// Investment Intelligence R11 — independent professional permission-matrix
// oracle (spec sections 96-97). Deliberately does NOT import
// lib/services/professional-access/permissions.ts. For every
// (actor/scope/relationship-state) combination below, the expected
// ALLOW/DENY verdict is computed by this file's OWN independent rules
// (independentDecide), re-derived directly from the plain-English spec
// text (sections 43-71), not from the production source.
//
// Standalone: `node scripts/r11_professional_security_oracle.mjs` runs the
// self-check only (zero production imports). The actual oracle-vs-
// production diff is tests/unit/r11ProfessionalSecurityOracleComparison.test.ts.

// Independent rule set — written from the spec, not from permissions.ts.
function independentDecide(scenario) {
  const { relationshipExists, sameClientProfessionalPair, status, expiresAt, now, professionalActive, grantedScope, scopeRevoked, requestedScope } = scenario;

  if (!relationshipExists) return 'DENY';
  if (!sameClientProfessionalPair) return 'DENY'; // cross-client assertion mismatch
  if (status === 'revoked' || status === 'declined' || status === 'expired') return 'DENY';
  if (status === 'pending_invite') return 'DENY';
  if (expiresAt !== null && expiresAt <= now) return 'DENY'; // expiry acts identically to revocation, evaluated live
  if (status !== 'active') return 'DENY';
  if (!professionalActive) return 'DENY';
  if (grantedScope !== requestedScope) return 'DENY'; // no broad "professional access" — must be the EXACT scope
  if (scopeRevoked) return 'DENY';
  return 'ALLOW';
}

export const SCENARIOS = [];
let n = 1;
function add(name, scenario, expected) {
  SCENARIOS.push({ id: `PSO-${String(n++).padStart(3, '0')}`, name, scenario, expected });
}

const T0 = 1000000; // arbitrary epoch reference for "now"
function scn(overrides = {}) {
  return {
    relationshipExists: true,
    sameClientProfessionalPair: true,
    status: 'active',
    expiresAt: null,
    now: T0,
    professionalActive: true,
    grantedScope: 'VIEW_INVESTMENTS',
    scopeRevoked: false,
    requestedScope: 'VIEW_INVESTMENTS',
    ...overrides,
  };
}

add('happy path: active, matching scope, no expiry', scn(), 'ALLOW');
add('no relationship at all', scn({ relationshipExists: false }), 'DENY');
add('cross-client: relationship real but does not match asserted pair', scn({ sameClientProfessionalPair: false }), 'DENY');
add('pending invitation, not yet accepted', scn({ status: 'pending_invite' }), 'DENY');
add('revoked', scn({ status: 'revoked' }), 'DENY');
add('declined', scn({ status: 'declined' }), 'DENY');
add('expired status', scn({ status: 'expired' }), 'DENY');
add('expiresAt in the past even though status column still says active', scn({ expiresAt: T0 - 1 }), 'DENY');
add('expiresAt exactly now (inclusive boundary)', scn({ expiresAt: T0 }), 'DENY');
add('expiresAt in the future', scn({ expiresAt: T0 + 1 }), 'ALLOW');
add('professional deactivated, relationship otherwise fine', scn({ professionalActive: false }), 'DENY');
add('scope granted is a different scope than requested', scn({ grantedScope: 'VIEW_GOALS', requestedScope: 'VIEW_INVESTMENTS' }), 'DENY');
add('scope was granted then revoked', scn({ scopeRevoked: true }), 'DENY');
add('REVOKED-TOKEN-RETRY: identical scenario, only status flips to revoked', scn({ status: 'revoked' }), 'DENY');
add('professional full-access attempt: active relationship, but requested scope was never granted at all', scn({ grantedScope: 'VIEW_REPORTS', requestedScope: 'VIEW_TAX_SUMMARY' }), 'DENY');
add('report access: VIEW_REPORTS granted and requested', scn({ grantedScope: 'VIEW_REPORTS', requestedScope: 'VIEW_REPORTS' }), 'ALLOW');
add('report access denied: only VIEW_INVESTMENTS granted, VIEW_REPORTS requested', scn({ grantedScope: 'VIEW_INVESTMENTS', requestedScope: 'VIEW_REPORTS' }), 'DENY');
add('COMMENT_OR_NOTE granted and requested', scn({ grantedScope: 'COMMENT_OR_NOTE', requestedScope: 'COMMENT_OR_NOTE' }), 'ALLOW');
add('VIEW_SOURCE_PROVENANCE granted and requested', scn({ grantedScope: 'VIEW_SOURCE_PROVENANCE', requestedScope: 'VIEW_SOURCE_PROVENANCE' }), 'ALLOW');
add('VIEW_TAX_SUMMARY not granted, requested', scn({ grantedScope: 'VIEW_INVESTMENTS', requestedScope: 'VIEW_TAX_SUMMARY' }), 'DENY');
add('deactivated professional cannot use even a correctly-granted, non-expired, active-relationship scope', scn({ professionalActive: false, grantedScope: 'VIEW_INVESTMENTS', requestedScope: 'VIEW_INVESTMENTS' }), 'DENY');
add('every condition satisfied simultaneously with a far-future expiry', scn({ expiresAt: T0 + 100000000 }), 'ALLOW');

for (const s of SCENARIOS) {
  const check = independentDecide(s.scenario);
  if (check !== s.expected) {
    console.error(`ORACLE SELF-CHECK FAILURE ${s.id} (${s.name}): rule computed ${check}, author expected ${s.expected}`);
    process.exit(2);
  }
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('r11_professional_security_oracle.mjs')) {
  console.log(`R11 PROFESSIONAL SECURITY ORACLE — standalone self-check: ${SCENARIOS.length} scenarios, all internally consistent.`);
  console.log('Run `npx vitest run tests/unit/r11ProfessionalSecurityOracleComparison.test.ts` for the actual oracle-vs-production-code diff.');
  process.exit(0);
}

export { independentDecide };

// Investment Intelligence R11 — Professional Access permission model
// (spec sections 43-71). Pure, DB-free decision logic only — no Supabase
// client, no I/O — mirroring the discipline of publicationLogic.ts (R3)
// and reconciliation.ts (R2): the single most security-critical invariant
// in this release (least privilege + immediate revocation) is proven with
// fast, deterministic unit tests, independent of the sandbox's DB-
// migration-application constraint. The DB-touching orchestration
// (lib/services/professional-access/access.ts) is a thin layer on top —
// every API route calls checkAccess() FRESH against live relationship/
// scope rows on every single request; nothing is cached, nothing is
// derived from a JWT claim set at login time. That is the entire
// mechanism behind "revocation must take effect immediately, not at next
// login" (spec section 66) — there is no session-level access cache to
// invalidate, because none exists.

export const PROFESSIONAL_SCOPES = [
  'VIEW_FINANCIAL_SUMMARY',
  'VIEW_INVESTMENTS',
  'VIEW_GOALS',
  'VIEW_FORECASTS',
  'VIEW_REPORTS',
  'VIEW_TAX_SUMMARY',
  'VIEW_SOURCE_PROVENANCE',
  'COMMENT_OR_NOTE',
] as const;

export type ProfessionalScope = (typeof PROFESSIONAL_SCOPES)[number];

export function isProfessionalScope(value: string): value is ProfessionalScope {
  return (PROFESSIONAL_SCOPES as readonly string[]).includes(value);
}

export type RelationshipStatus = 'pending_invite' | 'active' | 'revoked' | 'expired' | 'declined';

export interface RelationshipRecord {
  id: string;
  clientUserId: string;
  professionalUserId: string;
  status: RelationshipStatus;
  expiresAt: string | null; // ISO timestamp, null = no expiry
  professionalIsActive: boolean; // professional_profiles.is_active for professionalUserId — a deactivated professional loses all access (spec section 68) even if the relationship row itself still says 'active'
}

export interface ScopeGrantRecord {
  relationshipId: string;
  scope: ProfessionalScope;
  revokedAt: string | null; // null = currently live
}

export type AccessDecision =
  | { allow: true; reason: string }
  | { allow: false; reason: string; code: AccessDenialCode };

export type AccessDenialCode =
  | 'NO_RELATIONSHIP'
  | 'NOT_ACTIVE'
  | 'EXPIRED'
  | 'PROFESSIONAL_DEACTIVATED'
  | 'SCOPE_NOT_GRANTED'
  | 'SCOPE_REVOKED'
  | 'WRONG_CLIENT';

/**
 * The single function every API route must call before returning any
 * client data to a professional. Deliberately takes freshly-fetched rows
 * (never a cached decision) as arguments — the caller (access.ts) is
 * responsible for fetching them fresh on every call.
 */
export function checkProfessionalAccess(input: {
  now: Date;
  relationship: RelationshipRecord | null;
  requestedClientUserId: string;
  requestedProfessionalUserId: string;
  scope: ProfessionalScope;
  liveScopeGrants: ScopeGrantRecord[]; // all scope grant rows for this relationship, revoked or not — the function itself determines "live"
}): AccessDecision {
  const { relationship, requestedClientUserId, requestedProfessionalUserId, scope, liveScopeGrants, now } = input;

  if (!relationship) {
    return { allow: false, reason: 'No relationship exists between this client and this professional.', code: 'NO_RELATIONSHIP' };
  }
  if (relationship.clientUserId !== requestedClientUserId || relationship.professionalUserId !== requestedProfessionalUserId) {
    // Cross-client / cross-professional attack: the relationship fetched
    // does not actually belong to the (client, professional) pair being
    // asserted — never trust the caller's own claim of who they are
    // relative to whom.
    return { allow: false, reason: 'The supplied relationship does not match the requesting client/professional pair.', code: 'WRONG_CLIENT' };
  }
  if (relationship.status === 'revoked' || relationship.status === 'declined') {
    return { allow: false, reason: `Relationship status is '${relationship.status}' — access denied.`, code: 'NOT_ACTIVE' };
  }
  if (relationship.status === 'pending_invite') {
    return { allow: false, reason: 'Relationship has not yet been accepted by the professional.', code: 'NOT_ACTIVE' };
  }
  // Expired time-limited access must behave EXACTLY like revoked access
  // (spec section 67), evaluated fresh against wall-clock time on every
  // call — never a status the DB needs a background sweep to have already
  // flipped.
  if (relationship.expiresAt !== null && new Date(relationship.expiresAt).getTime() <= now.getTime()) {
    return { allow: false, reason: `Relationship expired at ${relationship.expiresAt}.`, code: 'EXPIRED' };
  }
  if (relationship.status !== 'active') {
    return { allow: false, reason: `Relationship status is '${relationship.status}', not 'active'.`, code: 'NOT_ACTIVE' };
  }
  if (!relationship.professionalIsActive) {
    return { allow: false, reason: 'The professional account has been deactivated — all delegated access is revoked.', code: 'PROFESSIONAL_DEACTIVATED' };
  }

  const grantsForScope = liveScopeGrants.filter((g) => g.relationshipId === relationship.id && g.scope === scope);
  if (grantsForScope.length === 0) {
    return { allow: false, reason: `Scope '${scope}' was never granted on this relationship.`, code: 'SCOPE_NOT_GRANTED' };
  }
  const isLive = grantsForScope.some((g) => g.revokedAt === null);
  if (!isLive) {
    return { allow: false, reason: `Scope '${scope}' was granted but has since been revoked.`, code: 'SCOPE_REVOKED' };
  }

  return { allow: true, reason: `Relationship active, not expired, professional active, scope '${scope}' currently granted.` };
}

/**
 * Report access is a distinct check (spec section 65): it reuses
 * VIEW_REPORTS specifically — professionals never get a separate
 * "professional report" scope or engine, they get gated access to the
 * SAME R10 report snapshot rows the client owns.
 */
export function checkReportAccess(input: Parameters<typeof checkProfessionalAccess>[0]): AccessDecision {
  return checkProfessionalAccess({ ...input, scope: 'VIEW_REPORTS' });
}

/**
 * Raw document access is a hard NO in R11 — the VIEW_RAW_DOCUMENTS scope
 * does not exist in PROFESSIONAL_SCOPES at all (spec section 7, 51). This
 * function exists purely so the mandatory NC7/attack-scenario tests have
 * a single, obviously-correct assertion point rather than relying on
 * "the scope string isn't in the list" being re-derived ad hoc at each
 * call site.
 */
export function isRawDocumentScopeSupported(): boolean {
  return false;
}

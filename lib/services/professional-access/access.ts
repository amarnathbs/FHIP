// Investment Intelligence R11 — Professional Access DB orchestration.
// Thin layer over permissions.ts's pure checkProfessionalAccess(): fetches
// FRESH relationship/scope/profile rows on every call (no caching layer
// anywhere in this file — that absence IS the immediate-revocation
// guarantee, spec section 66) and uses the service-role admin client for
// every write, since professional_relationships/professional_permission_
// scopes intentionally carry no authenticated-role write RLS policy
// (migration 0083) — every mutation is authorised here, in TypeScript,
// after verifying the caller's own session identity, never trusted from
// client-supplied fields.

import { createAdminClient } from '@/lib/supabase/admin';
import {
  checkProfessionalAccess,
  isProfessionalScope,
  type AccessDecision,
  type ProfessionalScope,
  type RelationshipRecord,
  type ScopeGrantRecord,
} from './permissions';

export interface AccessContext {
  relationship: RelationshipRecord | null;
  scopeGrants: ScopeGrantRecord[];
}

/** Always reads live from the DB — never cache the result across requests. */
export async function fetchAccessContext(clientUserId: string, professionalUserId: string): Promise<AccessContext> {
  const admin = createAdminClient();
  const { data: relRow } = await admin
    .from('professional_relationships')
    .select('id, client_user_id, professional_user_id, status, expires_at')
    .eq('client_user_id', clientUserId)
    .eq('professional_user_id', professionalUserId)
    .in('status', ['pending_invite', 'active', 'revoked', 'expired', 'declined'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!relRow) return { relationship: null, scopeGrants: [] };

  const { data: profRow } = await admin.from('professional_profiles').select('is_active').eq('user_id', professionalUserId).maybeSingle();

  const { data: scopeRows } = await admin.from('professional_permission_scopes').select('relationship_id, scope, revoked_at').eq('relationship_id', relRow.id as string);

  const relationship: RelationshipRecord = {
    id: relRow.id as string,
    clientUserId: relRow.client_user_id as string,
    professionalUserId: relRow.professional_user_id as string,
    status: relRow.status as RelationshipRecord['status'],
    expiresAt: (relRow.expires_at as string | null) ?? null,
    professionalIsActive: (profRow?.is_active as boolean | undefined) ?? false,
  };
  const scopeGrants: ScopeGrantRecord[] = (scopeRows ?? []).map((r) => ({
    relationshipId: r.relationship_id as string,
    scope: r.scope as ProfessionalScope,
    revokedAt: (r.revoked_at as string | null) ?? null,
  }));
  return { relationship, scopeGrants };
}

export async function checkAccessLive(clientUserId: string, professionalUserId: string, scope: ProfessionalScope): Promise<AccessDecision> {
  const ctx = await fetchAccessContext(clientUserId, professionalUserId);
  return checkProfessionalAccess({
    now: new Date(),
    relationship: ctx.relationship,
    requestedClientUserId: clientUserId,
    requestedProfessionalUserId: professionalUserId,
    scope,
    liveScopeGrants: ctx.scopeGrants,
  });
}

export interface CreateInvitationResult {
  relationshipId: string | null;
  error: string | null;
}

/** Client invites a professional (by the professional's existing user id — no arbitrary-user search surface, spec section 62). */
export async function createInvitation(clientUserId: string, professionalUserId: string, purpose: string | null, initialScopes: ProfessionalScope[]): Promise<CreateInvitationResult> {
  if (clientUserId === professionalUserId) return { relationshipId: null, error: 'A user cannot delegate access to themselves.' };
  const admin = createAdminClient();

  const { data: profExists } = await admin.from('professional_profiles').select('user_id, is_active').eq('user_id', professionalUserId).maybeSingle();
  if (!profExists) return { relationshipId: null, error: 'No professional profile exists for that user.' };
  if (!profExists.is_active) return { relationshipId: null, error: 'That professional account is deactivated.' };

  const invalidScope = initialScopes.find((s) => !isProfessionalScope(s));
  if (invalidScope) return { relationshipId: null, error: `Unknown scope: ${invalidScope}` };

  const { data: created, error } = await admin
    .from('professional_relationships')
    .insert({ client_user_id: clientUserId, professional_user_id: professionalUserId, status: 'pending_invite', invited_by: 'client', purpose })
    .select('id')
    .single();
  if (error || !created) return { relationshipId: null, error: error?.message ?? 'Failed to create invitation.' };

  if (initialScopes.length > 0) {
    const { error: scopeErr } = await admin
      .from('professional_permission_scopes')
      .insert(initialScopes.map((scope) => ({ relationship_id: created.id as string, scope, granted_by: 'client' as const })));
    if (scopeErr) return { relationshipId: created.id as string, error: `Relationship created but scopes failed: ${scopeErr.message}` };
  }
  return { relationshipId: created.id as string, error: null };
}

export async function acceptInvitation(relationshipId: string, professionalUserId: string): Promise<{ ok: boolean; error: string | null }> {
  const admin = createAdminClient();
  const { data: rel } = await admin.from('professional_relationships').select('id, professional_user_id, status').eq('id', relationshipId).maybeSingle();
  if (!rel) return { ok: false, error: 'Relationship not found.' };
  if (rel.professional_user_id !== professionalUserId) return { ok: false, error: 'This invitation was not sent to you.' };
  if (rel.status !== 'pending_invite') return { ok: false, error: `Cannot accept a relationship in status '${rel.status}'.` };
  const { error } = await admin.from('professional_relationships').update({ status: 'active', accepted_at: new Date().toISOString() }).eq('id', relationshipId);
  return { ok: !error, error: error?.message ?? null };
}

export async function declineInvitation(relationshipId: string, professionalUserId: string): Promise<{ ok: boolean; error: string | null }> {
  const admin = createAdminClient();
  const { data: rel } = await admin.from('professional_relationships').select('id, professional_user_id, status').eq('id', relationshipId).maybeSingle();
  if (!rel) return { ok: false, error: 'Relationship not found.' };
  if (rel.professional_user_id !== professionalUserId) return { ok: false, error: 'This invitation was not sent to you.' };
  if (rel.status !== 'pending_invite') return { ok: false, error: `Cannot decline a relationship in status '${rel.status}'.` };
  const { error } = await admin.from('professional_relationships').update({ status: 'declined' }).eq('id', relationshipId);
  return { ok: !error, error: error?.message ?? null };
}

/** Only the CLIENT may revoke (spec section 66 — mandatory, must take effect immediately: since checkAccessLive re-reads on every call, the very next request after this write is denied). */
export async function revokeRelationship(relationshipId: string, clientUserId: string): Promise<{ ok: boolean; error: string | null }> {
  const admin = createAdminClient();
  const { data: rel } = await admin.from('professional_relationships').select('id, client_user_id, status').eq('id', relationshipId).maybeSingle();
  if (!rel) return { ok: false, error: 'Relationship not found.' };
  if (rel.client_user_id !== clientUserId) return { ok: false, error: 'Only the client who owns this relationship may revoke it.' };
  if (rel.status !== 'active' && rel.status !== 'pending_invite') return { ok: false, error: `Cannot revoke a relationship already in status '${rel.status}'.` };
  const { error } = await admin.from('professional_relationships').update({ status: 'revoked', revoked_at: new Date().toISOString(), revoked_by: 'client' }).eq('id', relationshipId);
  return { ok: !error, error: error?.message ?? null };
}

export async function grantScope(relationshipId: string, clientUserId: string, scope: ProfessionalScope): Promise<{ ok: boolean; error: string | null }> {
  if (!isProfessionalScope(scope)) return { ok: false, error: `Unknown scope: ${scope}` };
  const admin = createAdminClient();
  const { data: rel } = await admin.from('professional_relationships').select('id, client_user_id, status').eq('id', relationshipId).maybeSingle();
  if (!rel) return { ok: false, error: 'Relationship not found.' };
  if (rel.client_user_id !== clientUserId) return { ok: false, error: 'Only the client who owns this relationship may grant scopes.' };
  if (rel.status !== 'active') return { ok: false, error: `Cannot grant a scope on a relationship in status '${rel.status}'.` };
  const { error } = await admin.from('professional_permission_scopes').insert({ relationship_id: relationshipId, scope, granted_by: 'client' });
  // A live grant for this exact (relationship, scope) already existing is
  // the partial-unique-index conflict — treated as a benign no-op, not an
  // error, so a double-click can't fail the request.
  if (error && !error.message.includes('duplicate key')) return { ok: false, error: error.message };
  return { ok: true, error: null };
}

/** Scope reduction (spec section 49) — must immediately remove that API access; since every check re-reads live, it does. */
export async function revokeScope(relationshipId: string, clientUserId: string, scope: ProfessionalScope): Promise<{ ok: boolean; error: string | null }> {
  const admin = createAdminClient();
  const { data: rel } = await admin.from('professional_relationships').select('id, client_user_id').eq('id', relationshipId).maybeSingle();
  if (!rel) return { ok: false, error: 'Relationship not found.' };
  if (rel.client_user_id !== clientUserId) return { ok: false, error: 'Only the client who owns this relationship may revoke scopes.' };
  const { error } = await admin
    .from('professional_permission_scopes')
    .update({ revoked_at: new Date().toISOString(), revoked_by: 'client' })
    .eq('relationship_id', relationshipId)
    .eq('scope', scope)
    .is('revoked_at', null);
  return { ok: !error, error: error?.message ?? null };
}

export interface ClientListEntry {
  relationshipId: string;
  clientUserId: string;
  status: string;
  scopes: string[];
}

/** Professional's own client list — strictly the professional's own active/pending relationships, never a directory search (spec section 62). */
export async function listClientsForProfessional(professionalUserId: string): Promise<ClientListEntry[]> {
  const admin = createAdminClient();
  const { data: rels } = await admin
    .from('professional_relationships')
    .select('id, client_user_id, status')
    .eq('professional_user_id', professionalUserId)
    .in('status', ['active', 'pending_invite'])
    .order('created_at', { ascending: true });
  const relationships = rels ?? [];
  if (relationships.length === 0) return [];
  const ids = relationships.map((r) => r.id as string);
  const { data: scopeRows } = await admin.from('professional_permission_scopes').select('relationship_id, scope, revoked_at').in('relationship_id', ids).is('revoked_at', null);
  return relationships.map((r) => ({
    relationshipId: r.id as string,
    clientUserId: r.client_user_id as string,
    status: r.status as string,
    scopes: (scopeRows ?? []).filter((s) => s.relationship_id === r.id).map((s) => s.scope as string),
  }));
}

export async function recordReportAccess(relationshipId: string, professionalUserId: string, clientUserId: string, reportId: string, action: 'view' | 'download'): Promise<void> {
  const admin = createAdminClient();
  await admin.from('professional_report_access_log').insert({ relationship_id: relationshipId, professional_user_id: professionalUserId, client_user_id: clientUserId, report_id: reportId, action });
}

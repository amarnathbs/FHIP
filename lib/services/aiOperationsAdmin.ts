// Module 11 remediation R4 — capability guards for the Admin AI Operations
// surface (Admin Architecture Standard §2, §4, §5, §13).
//
// Two separately named capabilities, each with its own API-layer and
// page-layer guard, following lib/services/investment-intelligence/pc6/
// referenceDataAdmin.ts exactly (the PC6 precedent), never bare
// requireAdmin() (§2 prohibits a coarse admin flag as the sole basis for a
// new surface).
//
//   AI_OPERATIONS_VIEW_CAPABILITY   = admin_users.can_view_ai_operations
//   AI_OPERATIONS_MANAGE_CAPABILITY = admin_users.can_manage_ai_operations
//
// §4 layers: 1 (database) — every table the screen reads is RLS-enabled with
// zero policies, readable only by the service-role client behind these
// guards; 2 (API) — requireAiOperationsViewer()/Manager(); 3 (page) —
// requireAiOperationsViewerPage() redirects; 4 (nav) — lib/admin/adminNav.ts.
//
// §13: any resolution failure (no session, no row, missing column because
// migration 0177 is not applied, DB error) resolves to DENY, never to a
// default grant.

import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { bad } from '@/lib/api';
import { countryConfirmationBlockResponse } from '@/lib/services/countryGate';
import type { User } from '@supabase/supabase-js';

export const AI_OPERATIONS_VIEW_CAPABILITY = 'can_view_ai_operations' as const;
export const AI_OPERATIONS_MANAGE_CAPABILITY = 'can_manage_ai_operations' as const;

type Capability = typeof AI_OPERATIONS_VIEW_CAPABILITY | typeof AI_OPERATIONS_MANAGE_CAPABILITY;

async function holdsCapability(capability: Capability): Promise<{ user: User | null; holds: boolean; supabase: Awaited<ReturnType<typeof createClient>> | null }> {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { user: null, holds: false, supabase };
    const { data: adminRow, error } = await supabase.from('admin_users').select(capability).eq('user_id', user.id).maybeSingle();
    if (error) return { user, holds: false, supabase }; // §13: a DB error (incl. an unapplied 0177 column) is a denial
    return { user, holds: (adminRow as Record<string, unknown> | null)?.[capability] === true, supabase };
  } catch {
    return { user: null, holds: false, supabase: null };
  }
}

async function requireCapability(capability: Capability, denyMessage: string): Promise<{ user: User | null; forbidden: Response | null }> {
  const { user, holds, supabase } = await holdsCapability(capability);
  if (!user) return { user: null, forbidden: bad('unauthenticated', 401) };
  // §4: deny with an explicit 403, never a 200 carrying an empty dashboard.
  if (!holds || !supabase) return { user: null, forbidden: bad(denyMessage, 403) };
  const countryBlock = await countryConfirmationBlockResponse(supabase, user.id);
  if (countryBlock) return { user: null, forbidden: countryBlock };
  return { user, forbidden: null };
}

/** API-layer guard for the read-only surface. */
export function requireAiOperationsViewer() {
  return requireCapability(AI_OPERATIONS_VIEW_CAPABILITY, 'AI operations access required');
}

/** API-layer guard for guarded controls (manual scheduler runs etc.). */
export function requireAiOperationsManager() {
  return requireCapability(AI_OPERATIONS_MANAGE_CAPABILITY, 'AI operations management access required');
}

/** Page-layer guard (§4 layer 3): a disallowed direct navigation is redirected, never rendered empty. */
export async function requireAiOperationsViewerPage(): Promise<User> {
  const { user, holds } = await holdsCapability(AI_OPERATIONS_VIEW_CAPABILITY);
  if (!user) redirect('/login');
  if (!holds) redirect('/dashboard');
  return user;
}

/** Fail-closed capability read for /api/admin/me (never throws). */
export async function readAiOperationsCapabilities(): Promise<{ aiOperations: boolean; aiOperationsManage: boolean }> {
  const [view, manage] = await Promise.all([holdsCapability(AI_OPERATIONS_VIEW_CAPABILITY), holdsCapability(AI_OPERATIONS_MANAGE_CAPABILITY)]);
  return { aiOperations: view.holds, aiOperationsManage: manage.holds };
}

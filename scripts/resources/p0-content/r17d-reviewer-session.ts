// R1.7D-FINAL §27/§33/§34 — establish a REAL authenticated session for the
// authorised Product Owner reviewer account and expose it to the workflow
// scripts. Never uses the service-role key to perform a transition:
// public.transition_resource_post_status raises 'Not authenticated' when
// auth.uid() is null, which is exactly what a service-role call produces.
import { readFileSync } from 'node:fs';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { assertDevProject } from '../lib/env';

export type ReviewerCreds = { email: string; password: string; user_id: string; role: string };

export function loadReviewerCreds(): ReviewerCreds {
  return JSON.parse(readFileSync('.r17d-reviewer-credentials.local.json', 'utf8')) as ReviewerCreds;
}

/** Sign in as the real reviewer via the ANON client -> genuine auth.uid(). */
export async function reviewerClient(): Promise<{ client: SupabaseClient; userId: string; email: string }> {
  const creds = assertDevProject();
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!anonKey) { console.error('FATAL: NEXT_PUBLIC_SUPABASE_ANON_KEY not set'); process.exit(1); }
  const rev = loadReviewerCreds();
  const client = createClient(creds.url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data, error } = await client.auth.signInWithPassword({ email: rev.email, password: rev.password });
  if (error || !data.session || !data.user) {
    console.error('FATAL: reviewer sign-in failed:', error?.message);
    process.exit(1);
  }
  if (data.user.id !== rev.user_id) {
    console.error(`FATAL: signed-in user id ${data.user.id} != expected ${rev.user_id}`);
    process.exit(1);
  }
  return { client, userId: data.user.id, email: rev.email };
}

async function main() {
  const creds = assertDevProject();
  const svc = createClient(creds.url, creds.serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const rev = loadReviewerCreds();

  // 1. Account really exists in auth.users
  const { data: au, error: auErr } = await svc.auth.admin.getUserById(rev.user_id);
  console.log('auth.users lookup:', auErr ? `ERROR ${auErr.message}` : `found id=${au.user?.id} confirmed=${!!au.user?.email_confirmed_at} created=${au.user?.created_at}`);

  // 2. Role really granted
  const { data: roles, error: rolesErr } = await svc.from('resource_user_roles').select('role,is_active,assigned_at').eq('user_id', rev.user_id);
  if (rolesErr) { console.error('FATAL: role lookup failed:', rolesErr.message); process.exit(1); }
  console.log('resource_user_roles:', JSON.stringify(roles));
  if (!(roles ?? []).some((r) => r.role === 'resource_admin' && r.is_active)) {
    console.error('FATAL: reviewer does not hold an active resource_admin role.'); process.exit(1);
  }

  // 3. Is it also a super admin? (we want to prove the role, not an accidental super-admin bypass)
  const { data: adminRow } = await svc.from('admin_users').select('user_id').eq('user_id', rev.user_id).maybeSingle();
  console.log('admin_users (super admin) row present:', !!adminRow);

  // 4. Genuine session
  const { client, userId } = await reviewerClient();
  console.log('signed-in auth.uid() =', userId);

  // 5. Prove the permission predicates evaluate true for this actor, via a
  //    real authenticated call (not service-role).
  const { data: probe, error: probeErr } = await client.rpc('transition_resource_post_status', {
    p_post_id: '00000000-0000-0000-0000-000000000000', p_to_status: 'draft', p_reason: 'permission probe', p_notes: null,
  });
  console.log('probe (expect "not found", proving auth passed):', probeErr?.message ?? JSON.stringify(probe));

  // 6. Negative control: service-role must be rejected as unauthenticated.
  const { error: svcErr } = await svc.rpc('transition_resource_post_status', {
    p_post_id: '00000000-0000-0000-0000-000000000000', p_to_status: 'draft', p_reason: 'service-role negative control', p_notes: null,
  });
  console.log('service-role negative control (expect "Not authenticated"):', svcErr?.message);
}

if (process.argv[1] && process.argv[1].includes('r17d-reviewer-session')) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

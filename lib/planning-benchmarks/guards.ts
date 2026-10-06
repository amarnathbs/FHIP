// Capability guards for the Planning Benchmarks upload (F5). Admin Architecture Standard sections 2, 4, 13.
//
// Two SEPARATELY NAMED capabilities, each backed by its own admin_users column (migration 0270), each read
// fresh on every call from the caller's OWN session (never the service-role client):
//
//   upload    can_upload_planning_benchmarks    stage, preview, discard a batch the caller staged
//   activate  can_activate_planning_benchmarks  activate a staged batch, discard any batch
//   view      either of the above (read only: previews and history)
//
// Neither implies the other, and neither is implied by Super Admin (an admin_users row) or by any Market
// Index capability. The database enforces each again (is_planning_benchmark_uploader / _activator inside
// every RPC), so this API guard is the second of four layers, not the only one.
//
// FAIL CLOSED (section 13): a logged-out caller is 401, an admin without the capability is 403, and a role
// read that fails or hits a missing column (migration not applied) is an explicit 503, never a grant and
// never an empty success.
import { redirect } from 'next/navigation';
import type { User } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { bad } from '@/lib/api';
import { requireAdmin } from '@/lib/services/adminAuth';

export const PLANNING_BENCHMARK_CAPABILITY_COLUMNS = {
  upload: 'can_upload_planning_benchmarks',
  activate: 'can_activate_planning_benchmarks',
} as const;

export type PlanningBenchmarkCapability = 'view' | keyof typeof PLANNING_BENCHMARK_CAPABILITY_COLUMNS;
export type PlanningBenchmarkFlags = Record<PlanningBenchmarkCapability, boolean>;

export const NO_PLANNING_BENCHMARK_CAPABILITIES: PlanningBenchmarkFlags = Object.freeze({ view: false, upload: false, activate: false });

/** Pure: anything but a literal `true` is false. `view` is the union of READ access only. */
export function planningBenchmarkFlagsFromRow(row: Record<string, unknown> | null | undefined): PlanningBenchmarkFlags {
  if (!row) return { ...NO_PLANNING_BENCHMARK_CAPABILITIES };
  const upload = row[PLANNING_BENCHMARK_CAPABILITY_COLUMNS.upload] === true;
  const activate = row[PLANNING_BENCHMARK_CAPABILITY_COLUMNS.activate] === true;
  return { upload, activate, view: upload || activate };
}

type ReadOutcome = { kind: 'ok'; flags: PlanningBenchmarkFlags } | { kind: 'unavailable' } | { kind: 'none' };

async function readFlags(userId: string): Promise<ReadOutcome> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('admin_users')
    .select(Object.values(PLANNING_BENCHMARK_CAPABILITY_COLUMNS).join(', '))
    .eq('user_id', userId)
    .maybeSingle();
  if (error) return { kind: 'unavailable' };
  if (!data) return { kind: 'none' };
  return { kind: 'ok', flags: planningBenchmarkFlagsFromRow(data as unknown as Record<string, unknown>) };
}

/** API layer (Standard section 4, layer 2). Returns a Response to send, or null when authorised. */
export async function requirePlanningBenchmarkCapability(cap: PlanningBenchmarkCapability): Promise<{ user: User | null; flags: PlanningBenchmarkFlags; forbidden: Response | null }> {
  const none = { ...NO_PLANNING_BENCHMARK_CAPABILITIES };
  // requireAdmin: 401 when logged out, 403 when not an admin, the country gate, all fail closed.
  const base = await requireAdmin();
  if (base.forbidden || !base.user) return { user: null, flags: none, forbidden: base.forbidden ?? bad('unauthenticated', 401) };
  const read = await readFlags(base.user.id);
  if (read.kind === 'unavailable') {
    return { user: null, flags: none, forbidden: Response.json({ error: 'Planning benchmark upload permissions cannot be read right now, or the upload feature is not installed on this database. Nothing was changed.', code: 'DEPENDENCY_UNAVAILABLE' }, { status: 503 }) };
  }
  if (read.kind === 'none' || read.flags[cap] !== true) {
    return { user: null, flags: none, forbidden: bad(`Planning benchmark upload ${cap === 'view' ? 'view' : cap} permission required`, 403) };
  }
  return { user: base.user, flags: read.flags, forbidden: null };
}

/** Page layer (Standard section 4, layer 3): a disallowed direct navigation is redirected, never rendered empty. */
export async function requirePlanningBenchmarkPage(cap: PlanningBenchmarkCapability = 'view'): Promise<{ user: User; flags: PlanningBenchmarkFlags }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');
  const { data: adminRow } = await supabase.from('admin_users').select('user_id').eq('user_id', (user as User).id).maybeSingle();
  if (!adminRow) redirect('/dashboard');
  const read = await readFlags((user as User).id);
  if (read.kind !== 'ok' || read.flags[cap] !== true) redirect('/dashboard');
  return { user: user as User, flags: (read as { kind: 'ok'; flags: PlanningBenchmarkFlags }).flags };
}

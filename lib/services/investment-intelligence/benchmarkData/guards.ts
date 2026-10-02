// Capability guards for the Benchmark Data Admin surface (BENCH-1 Phase 2).
//
// ADMIN ARCHITECTURE STANDARD SECTIONS 2 and 4. Six SEPARATELY NAMED
// capabilities, each backed by its own admin_users column (never a shared
// boolean), each read fresh on every call from the caller's OWN session:
//
//   view                 any of the five below OR PC6 can_view_reference_data_quality
//                        (read-only; sees jobs, previews, ingestion state)
//   upload               can_upload_market_index_data      (0232) stage + validate
//   publish              can_publish_benchmark_data        (0239) approve + publish NEW history
//   correct              can_correct_benchmark_data        (0239) publish CORRECTIONS, roll back
//   catalogue            can_manage_benchmark_catalogue    (0239) catalogue, mappings, DRAFT entitlements
//   entitlementApprove   can_approve_benchmark_entitlements (0239) approve / revoke entitlements
//
// None implies another (Standard section 2): a publisher cannot stage, an
// uploader cannot publish, a corrector cannot publish new history, a
// catalogue admin cannot approve an entitlement. The database enforces each
// again (is_benchmark_publisher(), is_benchmark_corrector(), ...), so the API
// guard below is the second of the four layers, not the only one.
//
// FAIL CLOSED (section 13): a read error, a missing row, or a missing column
// (migration not applied) is a denial - never a grant.
import { redirect } from 'next/navigation';
import type { User } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { bad } from '@/lib/api';
import { countryConfirmationBlockResponse } from '@/lib/services/countryGate';

export const BENCHMARK_CAPABILITY_COLUMNS = {
  upload: 'can_upload_market_index_data',
  publish: 'can_publish_benchmark_data',
  correct: 'can_correct_benchmark_data',
  catalogue: 'can_manage_benchmark_catalogue',
  entitlementApprove: 'can_approve_benchmark_entitlements',
} as const;
/** PC6's read-only capability, reused as the VIEW capability. */
export const BENCHMARK_VIEW_COLUMN = 'can_view_reference_data_quality' as const;

export type BenchmarkCapability = 'view' | keyof typeof BENCHMARK_CAPABILITY_COLUMNS;

const ALL_COLUMNS = [BENCHMARK_VIEW_COLUMN, ...Object.values(BENCHMARK_CAPABILITY_COLUMNS)];

export type BenchmarkCapabilityFlags = Record<BenchmarkCapability, boolean>;

export const NO_BENCHMARK_CAPABILITIES: BenchmarkCapabilityFlags = Object.freeze({
  view: false,
  upload: false,
  publish: false,
  correct: false,
  catalogue: false,
  entitlementApprove: false,
});

/** Pure: derive the six flags from an admin_users row. Anything but literal `true` is false. */
export function flagsFromAdminRow(row: Record<string, unknown> | null | undefined): BenchmarkCapabilityFlags {
  if (!row) return { ...NO_BENCHMARK_CAPABILITIES };
  const t = (k: string) => row[k] === true;
  const upload = t(BENCHMARK_CAPABILITY_COLUMNS.upload);
  const publish = t(BENCHMARK_CAPABILITY_COLUMNS.publish);
  const correct = t(BENCHMARK_CAPABILITY_COLUMNS.correct);
  const catalogue = t(BENCHMARK_CAPABILITY_COLUMNS.catalogue);
  const entitlementApprove = t(BENCHMARK_CAPABILITY_COLUMNS.entitlementApprove);
  return {
    upload,
    publish,
    correct,
    catalogue,
    entitlementApprove,
    // VIEW is the only capability that is a union - and only of read access.
    view: t(BENCHMARK_VIEW_COLUMN) || upload || publish || correct || catalogue || entitlementApprove,
  };
}

async function readFlags(): Promise<{ user: User | null; flags: BenchmarkCapabilityFlags; unauthenticated: boolean }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { user: null, flags: { ...NO_BENCHMARK_CAPABILITIES }, unauthenticated: true };
  const { data, error } = await supabase.from('admin_users').select(ALL_COLUMNS.join(', ')).eq('user_id', user.id).maybeSingle();
  if (error || !data) return { user, flags: { ...NO_BENCHMARK_CAPABILITIES }, unauthenticated: false };
  return { user, flags: flagsFromAdminRow(data as unknown as Record<string, unknown>), unauthenticated: false };
}

/** API layer (Standard section 4, layer 2). Returns a Response to send, or null when authorised. */
export async function requireBenchmarkCapability(cap: BenchmarkCapability): Promise<{ user: User | null; flags: BenchmarkCapabilityFlags; forbidden: Response | null }> {
  const { user, flags, unauthenticated } = await readFlags();
  if (unauthenticated || !user) return { user: null, flags, forbidden: bad('unauthenticated', 401) };
  if (flags[cap] !== true) return { user: null, flags, forbidden: bad(`Benchmark data ${cap} access required`, 403) };
  const supabase = await createClient();
  const countryBlock = await countryConfirmationBlockResponse(supabase, user.id);
  if (countryBlock) return { user: null, flags, forbidden: countryBlock };
  return { user, flags, forbidden: null };
}

/** Page layer (Standard section 4, layer 3): a disallowed direct navigation is redirected, never rendered empty. */
export async function requireBenchmarkPage(cap: BenchmarkCapability = 'view'): Promise<{ user: User; flags: BenchmarkCapabilityFlags }> {
  const { user, flags, unauthenticated } = await readFlags();
  if (unauthenticated || !user) redirect('/login');
  if (flags[cap] !== true) redirect('/dashboard');
  return { user: user as User, flags };
}

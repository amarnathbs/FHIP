/**
 * Existing-fixture sessions for the Resources Bulk Upload DEV harnesses (re-certification 15-10-2026).
 *
 * PO rule: use EXISTING fixture users only; never create a user with a password, never ask for or type anybody's
 * password, never print a secret. So this helper:
 *   - picks an existing DEV user that holds exactly the wanted role (see pickFixture), never the Product Owner's own
 *     account and never anything outside the reserved test domains;
 *   - mints a session for that user WITHOUT a password: the service role asks Supabase Auth for a one-time magic-link
 *     token (generateLink, nothing is emailed) and verifies it (verifyOtp), exactly what a user clicking the link does;
 *   - creates no user. The only things it ever writes on a fixture are the three profile columns the mandatory country
 *     gate and the onboarding gate read (country_of_residence, country_confirmed_at, onboarding_completed), and only
 *     when the fixture does not already pass the gate. The ORIGINAL values are first saved to a snapshot file outside the
 *     repository and are written back by restoreBorrowedProfiles() (always called in the harness's finally block); the
 *     snapshot file is the recovery path if a run is killed (see restoreFromSnapshotFile).
 * DEV only: the caller has already refused any other project.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export interface FixtureSession {
  id: string;
  /** Kept in memory for the run only. Never log it unmasked. */
  email: string;
  label: string;
  /** Raw session JSON as returned by Supabase Auth (access_token, refresh_token, ...). */
  session: Record<string, unknown>;
  /** `Cookie` header value for HTTP clients. */
  cookie: string;
  /** Cookie chunks for Playwright's addCookies. */
  parts: { name: string; value: string }[];
}

export type Want = { kind: 'role'; role: string } | { kind: 'superAdmin' } | { kind: 'customer' };

export interface Candidate {
  id: string;
  email: string;
  roles: string[];
  superAdmin: boolean;
  hasProfile: boolean;
  passesGate: boolean;
}

const PO_MARKERS = ['amarnath', 'gmail.com'];
const PREFERRED_DOMAINS = ['@test.fhip.invalid', '@fhip-test.invalid', '@example.com'];

export const maskEmail = (e: string) => e.replace(/^(.{2}).*(@.*)$/, '$1***$2');

let cache: Candidate[] | null = null;
export async function loadCandidates(admin: SupabaseClient): Promise<Candidate[]> {
  if (cache) return cache;
  const users: { id: string; email?: string }[] = [];
  for (let page = 1; page <= 10; page++) {
    const r = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    const batch = r.data?.users ?? [];
    users.push(...batch);
    if (batch.length < 1000) break;
  }
  const roles = (await admin.from('resource_user_roles').select('user_id, role, is_active').eq('is_active', true)).data ?? [];
  const admins = new Set(((await admin.from('admin_users').select('user_id')).data ?? []).map((a) => a.user_id as string));
  const roleMap = new Map<string, string[]>();
  for (const r of roles) roleMap.set(r.user_id as string, [...(roleMap.get(r.user_id as string) ?? []), r.role as string]);
  const profiles = (await admin.from('user_profiles').select('user_id, country_of_residence, country_confirmed_at, onboarding_completed').limit(5000)).data ?? [];
  const profileIds = new Set(profiles.map((p) => p.user_id as string));
  const passes = new Set(profiles.filter((p) => p.country_of_residence && p.country_confirmed_at && p.onboarding_completed).map((p) => p.user_id as string));
  cache = users
    .filter((u) => !!u.email)
    .map((u) => ({ id: u.id, email: u.email as string, roles: roleMap.get(u.id) ?? [], superAdmin: admins.has(u.id), hasProfile: profileIds.has(u.id), passesGate: passes.has(u.id) }));
  return cache;
}

const rank = (c: Candidate) => {
  const i = PREFERRED_DOMAINS.findIndex((d) => c.email.toLowerCase().endsWith(d));
  return i === -1 ? 99 : i;
};

/** Deterministic pick: the same fixture is chosen on every run, so the evidence is reproducible. `skip` removes already-used ids. */
export function pickFixture(all: Candidate[], want: Want, skip: Set<string>): Candidate | null {
  const ok = all.filter((c) => {
    if (skip.has(c.id) || !c.hasProfile) return false;
    const lower = c.email.toLowerCase();
    if (PO_MARKERS.some((m) => lower.includes(m))) return false;
    if (rank(c) === 99) return false;
    if (want.kind === 'superAdmin') return c.superAdmin;
    if (c.superAdmin) return false;
    if (want.kind === 'customer') return c.roles.length === 0;
    return c.roles.length === 1 && c.roles[0] === want.role;
  });
  // fixtures that already pass the gate first (nothing to borrow), then by preferred domain, then by address
  ok.sort((a, b) => Number(b.passesGate) - Number(a.passesGate) || rank(a) - rank(b) || a.email.localeCompare(b.email));
  return ok[0] ?? null;
}

// ---- reversible profile borrow ------------------------------------------------------------------------------------
interface Original {
  user_id: string;
  country_of_residence: string | null;
  country_confirmed_at: string | null;
  onboarding_completed: boolean | null;
}
const borrowed = new Map<string, Original>();
export const SNAPSHOT_FILE = path.join(os.tmpdir(), `fhip_bulk_fixture_profile_snapshot_${process.pid}.json`);

export async function borrowProfile(admin: SupabaseClient, id: string): Promise<boolean> {
  if (borrowed.has(id)) return false;
  const cur = await admin.from('user_profiles').select('user_id, country_of_residence, country_confirmed_at, onboarding_completed').eq('user_id', id).maybeSingle();
  if (cur.error || !cur.data) throw new Error('fixture profile unreadable');
  const o = cur.data as Original;
  if (o.country_of_residence && o.country_confirmed_at && o.onboarding_completed) return false;
  borrowed.set(id, o);
  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify([...borrowed.values()], null, 1)); // BEFORE the write: the recovery path
  const up = await admin.from('user_profiles').update({ country_of_residence: o.country_of_residence ?? 'AU', country_confirmed_at: o.country_confirmed_at ?? new Date().toISOString(), onboarding_completed: true }).eq('user_id', id);
  if (up.error) throw new Error(`could not borrow fixture profile: ${up.error.message}`);
  return true;
}

/** Writes every borrowed profile back to exactly its original values. Returns how many were restored and how many differ afterwards (must be 0). */
export async function restoreBorrowedProfiles(admin: SupabaseClient): Promise<{ restored: number; stillDifferent: number }> {
  let restored = 0;
  let stillDifferent = 0;
  for (const o of borrowed.values()) {
    await admin.from('user_profiles').update({ country_of_residence: o.country_of_residence, country_confirmed_at: o.country_confirmed_at, onboarding_completed: o.onboarding_completed }).eq('user_id', o.user_id);
    const back = (await admin.from('user_profiles').select('country_of_residence, country_confirmed_at, onboarding_completed').eq('user_id', o.user_id).maybeSingle()).data;
    if (back && back.country_of_residence === o.country_of_residence && back.country_confirmed_at === o.country_confirmed_at && back.onboarding_completed === o.onboarding_completed) restored += 1;
    else stillDifferent += 1;
  }
  if (stillDifferent === 0) {
    borrowed.clear();
    fs.rmSync(SNAPSHOT_FILE, { force: true });
  }
  return { restored, stillDifferent };
}

/** Recovery for a killed run: node -e or tsx calling this with the snapshot path. */
export async function restoreFromSnapshotFile(admin: SupabaseClient, file: string): Promise<number> {
  const list = JSON.parse(fs.readFileSync(file, 'utf8')) as Original[];
  for (const o of list) await admin.from('user_profiles').update({ country_of_residence: o.country_of_residence, country_confirmed_at: o.country_confirmed_at, onboarding_completed: o.onboarding_completed }).eq('user_id', o.user_id);
  return list.length;
}

export async function mintSession(admin: SupabaseClient, anonKey: string, url: string, ref: string, email: string, label: string, id: string): Promise<FixtureSession> {
  const link = await admin.auth.admin.generateLink({ type: 'magiclink', email });
  const hashed = link.data?.properties?.hashed_token;
  if (link.error || !hashed) throw new Error(`generateLink failed for ${label}: ${link.error?.message ?? 'no token'}`);
  const anon = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const v = await anon.auth.verifyOtp({ token_hash: hashed, type: 'magiclink' });
  const s = v.data?.session;
  if (v.error || !s) throw new Error(`verifyOtp failed for ${label}: ${v.error?.message ?? 'no session'}`);
  const session = s as unknown as Record<string, unknown>;
  const value = 'base64-' + Buffer.from(JSON.stringify(session)).toString('base64url');
  const CHUNK = 3180;
  const parts =
    value.length <= CHUNK
      ? [{ name: `sb-${ref}-auth-token`, value }]
      : Array.from({ length: Math.ceil(value.length / CHUNK) }, (_, i) => ({ name: `sb-${ref}-auth-token.${i}`, value: value.slice(i * CHUNK, (i + 1) * CHUNK) }));
  return { id, email, label, session, parts, cookie: parts.map((p) => `${p.name}=${p.value}`).join('; ') };
}

/** Pick (never creating anything) and sign in the next unused fixture for `want`. Borrows the gate columns reversibly when needed. */
export async function fixtureSession(
  admin: SupabaseClient,
  anonKey: string,
  url: string,
  ref: string,
  label: string,
  want: Want,
  used: Set<string>,
): Promise<FixtureSession> {
  const all = await loadCandidates(admin);
  const c = pickFixture(all, want, used);
  if (!c) throw new Error(`no existing fixture user for ${label} (${JSON.stringify(want)})`);
  used.add(c.id);
  await borrowProfile(admin, c.id);
  return mintSession(admin, anonKey, url, ref, c.email, label, c.id);
}

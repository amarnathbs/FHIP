import { createClient as createSupabaseClient } from '@supabase/supabase-js';

// Service-role client for server-only, cross-user operations (the scheduled
// report-generation job iterating over every household). Bypasses RLS —
// never expose this client to a request path that hasn't independently
// verified the caller (e.g. the cron-secret check in the cron route).
//
// The underlying @supabase/supabase-js createClient() throws synchronously
// if either argument is falsy, with a generic "supabaseUrl/supabaseKey is
// required" message that gives no hint about *which* env var is missing in
// which deployment environment. Checking explicitly here turns a silent,
// uncaught-crash-shaped failure (empty body, opaque 500) into a message
// that actually says what's wrong — callers still need to catch this (see
// adminRoute() in lib/services/adminAuth.ts), this just makes the thrown
// error worth catching.
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) throw new Error('Server misconfiguration: NEXT_PUBLIC_SUPABASE_URL is not set in this environment.');
  if (!key) throw new Error('Server misconfiguration: SUPABASE_SERVICE_ROLE_KEY is not set in this environment.');
  return createSupabaseClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

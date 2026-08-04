import { createClient as createSupabaseClient } from '@supabase/supabase-js';

// Service-role client for server-only, cross-user operations (the scheduled
// report-generation job iterating over every household). Bypasses RLS —
// never expose this client to a request path that hasn't independently
// verified the caller (e.g. the cron-secret check in the cron route).
export function createAdminClient() {
  return createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

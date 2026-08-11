import { requireAdmin, adminRoute } from '@/lib/services/adminAuth';
import { ok } from '@/lib/api';

// Temporary diagnostic route — not linked from any UI, admin-gated. Exists
// only to answer one question directly instead of guessing further:
// exactly what does the running server process see in process.env for the
// Supabase-related variables? Never returns full secret values — only
// presence, length, and a short prefix (enough to tell two candidate
// values apart without exposing anything usable). Delete once the
// SUPABASE_SERVICE_ROLE_KEY / Amplify Secrets vs Environment Variables
// question is resolved.
export const GET = adminRoute(async () => {
  const { forbidden } = await requireAdmin();
  if (forbidden) return forbidden;

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;

  const describe = (v: string | undefined) =>
    v ? { present: true, length: v.length, prefix: v.slice(0, 12), suffix: v.slice(-4) } : { present: false };

  // Names only (no values) for anything that might be a differently-cased
  // or differently-prefixed variant of what we expect — e.g. if Amplify
  // Secrets inject as "amplify_SUPABASE_SERVICE_ROLE_KEY" or similar.
  const relevantKeyNames = Object.keys(process.env)
    .filter((k) => /SUPABASE|SERVICE_ROLE|AMPLIFY_SECRET|_AMPLIFY_/i.test(k))
    .sort();

  return ok({
    NODE_ENV: process.env.NODE_ENV,
    SUPABASE_SERVICE_ROLE_KEY: describe(serviceKey),
    NEXT_PUBLIC_SUPABASE_ANON_KEY: describe(anonKey),
    NEXT_PUBLIC_SUPABASE_URL: url ?? null,
    relevantKeyNames,
    totalEnvVarCount: Object.keys(process.env).length,
  });
});

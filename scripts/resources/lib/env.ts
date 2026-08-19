// R1.7 — mandatory environment guard (spec §2/§69). Every script that can
// write to the database imports this FIRST and calls assertDevProject()
// before doing anything else. Production is twwpnltizhtjxhamyoxt and must
// never be touched, not even read, by this import tooling.

export const DEV_PROJECT_REF = 'vqycarelcoijzwlpkpcz';
export const PROD_PROJECT_REF = 'twwpnltizhtjxhamyoxt';

export function getSupabaseCredentials(): { url: string; serviceRoleKey: string; projectRef: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) {
    console.error('FATAL: NEXT_PUBLIC_SUPABASE_URL is not set. Refusing to run.');
    process.exit(1);
  }
  if (!serviceRoleKey) {
    console.error('FATAL: SUPABASE_SERVICE_ROLE_KEY is not set. Refusing to run.');
    process.exit(1);
  }
  const match = /^https:\/\/([a-z0-9]+)\.supabase\.co/.exec(url);
  const projectRef = match ? match[1] : '';
  return { url, serviceRoleKey, projectRef };
}

/** Hard exit (no writes, no reads) if the resolved project ref is not the confirmed DEV project. */
export function assertDevProject(): { url: string; serviceRoleKey: string; projectRef: string } {
  const creds = getSupabaseCredentials();
  if (creds.projectRef === PROD_PROJECT_REF) {
    console.error(`FATAL: NEXT_PUBLIC_SUPABASE_URL resolves to the PRODUCTION project (${PROD_PROJECT_REF}). This importer refuses to run against production under any circumstances.`);
    process.exit(1);
  }
  if (creds.projectRef !== DEV_PROJECT_REF) {
    console.error(`FATAL: NEXT_PUBLIC_SUPABASE_URL resolves to project "${creds.projectRef}", not the confirmed DEV project "${DEV_PROJECT_REF}". Refusing to run.`);
    process.exit(1);
  }
  return creds;
}

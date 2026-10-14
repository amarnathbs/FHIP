// Stand-in for the Supabase browser client in the accessibility harness: no network, no credentials.
export const createClient = () => ({ auth: { signOut: async () => {} } });

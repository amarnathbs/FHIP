import { createClient } from '@/lib/supabase/server';

export const ok = (data: unknown) => Response.json({ data });
export const bad = (msg: string, code = 400) => Response.json({ error: msg }, { status: code });

export async function requireUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { user: null, unauthenticated: bad('unauthenticated', 401) };
  return { user, unauthenticated: null };
}

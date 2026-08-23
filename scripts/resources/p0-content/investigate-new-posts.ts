import { createClient } from '@supabase/supabase-js';
import { assertDevProject } from '../lib/env';

async function main() {
  const creds = assertDevProject();
  const supa = createClient(creds.url, creds.serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data } = await supa
    .from('resource_posts')
    .select('id,content_id,title,status,created_at,created_by')
    .order('created_at', { ascending: false })
    .limit(10);
  for (const row of data ?? []) {
    console.log(row.created_at, '|', row.content_id, '|', row.title, '|', row.status, '|', row.id);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

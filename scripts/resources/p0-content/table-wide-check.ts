import { createClient } from '@supabase/supabase-js';
import { assertDevProject } from '../lib/env';

async function main() {
  const creds = assertDevProject();
  const supa = createClient(creds.url, creds.serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { count: videoCount } = await supa.from('resource_videos').select('*', { count: 'exact', head: true });
  const { count: ctaCount } = await supa.from('resource_ctas').select('*', { count: 'exact', head: true });
  const { count: totalPosts } = await supa.from('resource_posts').select('*', { count: 'exact', head: true });
  const { count: relatedCount } = await supa.from('resource_related_content').select('*', { count: 'exact', head: true });
  console.log(JSON.stringify({ resource_videos_total: videoCount, resource_ctas_total: ctaCount, resource_posts_total: totalPosts, resource_related_content_total: relatedCount }, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });

import { createClient } from '@supabase/supabase-js';
import { assertDevProject } from '../lib/env';

async function main() {
  const creds = assertDevProject();
  const supa = createClient(creds.url, creds.serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const targets = ['RAU-002', 'RIN-001', 'VID-001', 'VID-002', 'VID-003', 'VID-004', 'VID-005', 'VID-006', 'VID-007', 'VID-008'];
  const { data } = await supa.from('resource_posts').select('content_id,content_blocks').in('content_id', targets);
  const leakPhrases = ['should open the', 'should embed the', 'without turning the video'];
  let leaks = 0;
  for (const row of data ?? []) {
    const serialized = JSON.stringify(row.content_blocks).toLowerCase();
    for (const p of leakPhrases) {
      if (serialized.includes(p)) {
        leaks++;
        console.log(`STILL LEAKING: ${row.content_id} contains "${p}"`);
      }
    }
  }
  console.log(`Checked ${data?.length} records, remaining leaks: ${leaks}`);
}
main().catch((e) => { console.error(e); process.exit(1); });

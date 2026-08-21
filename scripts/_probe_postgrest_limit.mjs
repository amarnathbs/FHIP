import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
let env = null;
for (const p of [path.join(repoRoot, '.env.local'), path.resolve(repoRoot, '..', '..', '..', '.env.local')]) {
  if (fs.existsSync(p)) {
    env = {};
    for (const l of fs.readFileSync(p, 'utf8').split('\n')) {
      const m = l.match(/^([A-Z_]+)=(.*)$/);
      if (m) env[m[1]] = m[2].trim();
    }
    break;
  }
}
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL;
const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY };

for (const t of ['recommendations_library', 'report_content_library', 'master_financial_items', 'resources_content', 'ii_prices_nav', 'ii_transactions']) {
  const r = await fetch(`${URL_}/rest/v1/${t}?select=id`, { headers: { ...H, Prefer: 'count=exact' } });
  const txt = await r.text();
  let n = 'err';
  try { n = JSON.parse(txt).length; } catch { /* */ }
  console.log(`${t}: HTTP ${r.status} returned=${n} content-range=${r.headers.get('content-range')}`);
}

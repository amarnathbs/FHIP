// Mission part 4, section 15 -- one additional, freshly-run confirmation
// (cheap: no document/journey setup needed) beyond the 6-surface upload scan
// already re-run this session (aie1_final_accessibility_live_dev.ts): the
// AIE review inbox's EMPTY state, gated behind AIE_REVIEW_UI_ENABLED (off by
// default, and per this session's own research, never set in production
// today -- so this page is not reachable by any real production user right
// now; this check is DEV-only, proving the code itself is accessible when
// the flag is eventually turned on, not a production claim).
//
// The heavier "unresolved / awaiting_acceptance / completed / failed" run-
// detail states were NOT re-exercised this session (would need a full
// document->AI-fallback->exception journey); those states' component code
// (components/aie/review/RunReviewPanel.tsx) was independently confirmed
// this session (grep) to still contain the two real fixes a prior session
// made (the failed-state render branch and the non-empty live-region text
// check) -- reused evidence, explicitly disclosed as such, not re-proven
// fresh.
//
// Run: npx tsx scripts/aie1_p4_section15_review_inbox_a11y.mjs http://localhost:3994
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';

const APP = process.argv[2] ?? 'http://localhost:3994';
const repoRoot = path.resolve(import.meta.dirname, '..');
function loadEnv(file) {
  const env = {};
  for (const line of fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^"|"$/g, '');
  }
  return env;
}
const env = loadEnv(path.join(repoRoot, '.env.local'));
const DEV_HOST = 'vqycarelcoijzwlpkpcz.supabase.co';
const BASE = env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
if (new URL(BASE).host !== DEV_HOST) throw new Error('refusing: not DEV');

const manifestPath = 'C:/Users/user/AppData/Local/Temp/claude/D--FHIP--claude-worktrees-audit-lr-2026-09-21/e1468c38-4b9f-45c2-b862-ab8725ccd725/scratchpad/aie1_p4_synthetic_manifest.jsonl';
function recordArtefact(entry) {
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.appendFileSync(manifestPath, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
}

async function main() {
  const stamp = Date.now();
  const email = `aie1-p4-inbox-a11y-${stamp}@fhip-synthetic.test`;
  const password = `Fhip!Synth${stamp}Zz9`;
  const createRes = await fetch(`${BASE}/auth/v1/admin/users`, {
    method: 'POST', headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  const created = await createRes.json();
  const userId = created.id;
  if (!userId) throw new Error(`could not create user: ${JSON.stringify(created)}`);
  recordArtefact({ kind: 'auth_user', id: userId, email, run: 'section15-review-inbox' });

  await fetch(`${BASE}/rest/v1/user_profiles?user_id=eq.${userId}`, {
    method: 'PATCH', headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify({ country_of_residence: 'AU', country_confirmed_at: new Date().toISOString(), country_source: 'USER_CONFIRMED', onboarding_completed: true }),
  });

  const signInRes = await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const session = await signInRes.json();
  if (!session.access_token) throw new Error(`sign-in failed: ${JSON.stringify(session)}`);

  const ref = new URL(BASE).host.split('.')[0];
  const cookieValue = 'base64-' + Buffer.from(JSON.stringify(session)).toString('base64url');
  const CHUNK = 3180;
  const parts = cookieValue.length <= CHUNK
    ? [{ name: `sb-${ref}-auth-token`, value: cookieValue }]
    : Array.from({ length: Math.ceil(cookieValue.length / CHUNK) }, (_, i) => ({ name: `sb-${ref}-auth-token.${i}`, value: cookieValue.slice(i * CHUNK, (i + 1) * CHUNK) }));

  const browser = await chromium.launch();
  const context = await browser.newContext();
  const host = new URL(APP).hostname;
  await context.addCookies(parts.map((p) => ({ ...p, domain: host, path: '/' })));
  const page = await context.newPage();
  const res = await page.goto(`${APP}/aie-review`, { waitUntil: 'networkidle', timeout: 60_000 }).catch(() => null);
  await page.waitForTimeout(1000);
  const scan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  console.log('HTTP status:', res?.status(), 'final URL:', page.url());
  console.log('violations:', scan.violations.length, JSON.stringify(scan.violations.map((v) => ({ id: v.id, impact: v.impact }))));
  console.log('passes:', scan.passes.length);

  // Basic keyboard-focus check: tab through and confirm at least one element
  // receives visible focus (document.activeElement changes from body).
  await page.keyboard.press('Tab');
  const afterFirstTab = await page.evaluate(() => document.activeElement?.tagName);
  console.log('first Tab moves focus to:', afterFirstTab, '(body means nothing is focusable/tab-reachable)');

  await browser.close();
  const delRes = await fetch(`${BASE}/auth/v1/admin/users/${userId}`, { method: 'DELETE', headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } });
  recordArtefact({ kind: 'cleanup', userId, deleted: delRes.ok, run: 'section15-review-inbox' });
  console.log('cleanup (immediate, in-script):', delRes.ok);
  process.exit(scan.violations.length === 0 ? 0 : 1);
}
main().catch((e) => { console.error('FATAL', e); process.exit(2); });

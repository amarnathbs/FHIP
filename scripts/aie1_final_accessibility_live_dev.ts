/**
 * AIE-1 final production completion (2026-09-25) -- automated accessibility
 * scan (axe-core, WCAG 2.0/2.1 A + AA rules) of every document-upload surface
 * AIE touches, rendered by the real app against DEV for a synthetic user.
 *
 * AUTOMATED ONLY. axe finds roughly a third of WCAG failures; it does not
 * replace the manual screen-reader protocol in the release register.
 *
 * Run (server up): npx tsx scripts/aie1_final_accessibility_live_dev.ts http://localhost:3961
 */
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { devFetch, BASE, ANON, assertDev, recordArtefact, makeChecker } from './aie1_final_dev_harness.mjs';

const APP = process.argv[2] ?? 'http://localhost:3961';
const { check, summary } = makeChecker('AIE1-A11Y');
const PAGES = [
  { path: '/income', surface: 'Payslip upload + AI review (PayslipImportPanel)' },
  { path: '/expenses', surface: 'Bank statement PDF/CSV upload (BankStatementImportPanel)' },
  { path: '/liabilities', surface: 'Liability statement upload' },
  { path: '/retirement', surface: 'Retirement statement upload' },
  { path: '/investments', surface: 'AU investment statement upload' },
  { path: '/investment-intelligence/data', surface: 'Investment Intelligence CAS upload + scan wait' },
];

async function main() {
  const email = `aie1-final-a11y-${Date.now()}@fhip-test.invalid`;
  const password = `Aie1Final!${Date.now()}Zz9`;
  const created = await devFetch('/auth/v1/admin/users', { method: 'POST', body: { email, password, email_confirm: true } });
  const id = created.json?.id as string;
  recordArtefact({ kind: 'auth_user', id, email, tag: 'a11y' });
  await devFetch(`/rest/v1/user_profiles?user_id=eq.${id}`, { method: 'PATCH', body: { country_of_residence: 'AU', country_confirmed_at: new Date().toISOString(), country_source: 'USER_CONFIRMED', onboarding_completed: true } });
  assertDev(BASE);
  const session = await (await fetch(`${BASE}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) })).json();
  const ref = new URL(BASE).host.split('.')[0];
  const value = 'base64-' + Buffer.from(JSON.stringify(session)).toString('base64url');

  const browser = await chromium.launch();
  const context = await browser.newContext();
  const host = new URL(APP).hostname;
  const CHUNK = 3180;
  const parts = value.length <= CHUNK ? [{ name: `sb-${ref}-auth-token`, value }] : Array.from({ length: Math.ceil(value.length / CHUNK) }, (_, i) => ({ name: `sb-${ref}-auth-token.${i}`, value: value.slice(i * CHUNK, (i + 1) * CHUNK) }));
  await context.addCookies(parts.map((p) => ({ ...p, domain: host, path: '/' })));
  const page = await context.newPage();
  const results: Array<Record<string, unknown>> = [];
  for (const p of PAGES) {
    const res = await page.goto(`${APP}${p.path}`, { waitUntil: 'networkidle', timeout: 120_000 }).catch(() => null);
    const finalPath = new URL(page.url()).pathname;
    const scan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    const serious = scan.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    results.push({ path: p.path, finalPath, http: res?.status(), violations: scan.violations.map((v) => `${v.id}(${v.impact}) x${v.nodes.length}`), passes: scan.passes.length });
    check(`${p.surface}: page renders for the synthetic user and has no serious/critical axe violations`, finalPath === p.path && serious.length === 0,
      JSON.stringify({ http: res?.status(), finalPath, violations: scan.violations.map((v) => `${v.id}(${v.impact}) x${v.nodes.length}`) }));
  }
  await browser.close();
  await devFetch(`/auth/v1/admin/users/${id}`, { method: 'DELETE' });
  recordArtefact({ kind: 'cleanup', userId: id, deleted: true });
  console.log(JSON.stringify(results));
  process.exit(summary() === 0 ? 0 : 1);
}
main().catch((e) => { console.error('FATAL', e instanceof Error ? e.message : e); process.exit(2); });

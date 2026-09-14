/**
 * FHIP Country Programme — Complete Remaining Work mission, section 6:
 * "Complete the missing two-visitor DEV test." The prior G8 report
 * explicitly disclosed this as NOT done ("structural inference only, not
 * a live multi-session proof"). Closes it for real: two independent real
 * Playwright browser CONTEXTS (separate cookie jars, matching two real
 * visitors), real interaction with the actual <select> country selector
 * component (not a direct fetch/pure-function call), against an isolated
 * local dev server with G2_LANDING_LOCALISATION_ENABLED=true.
 *
 * Run: npx tsx scripts/g2_two_visitor_isolation_live_dev_check.ts [baseUrl]
 * Requires: an isolated dev server for this worktree with
 * G2_LANDING_LOCALISATION_ENABLED=true (never the shared hosted DEV
 * deployment's own config).
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';

const repoRoot = path.resolve(__dirname, '..');
const BASE = process.argv[2] ?? 'http://localhost:3903';

function loadEnv() {
  const raw = fs.readFileSync(path.join(repoRoot, '.env.local'), 'utf8').replace(/^﻿/, '');
  const env: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}
const env = loadEnv();
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

let passed = 0, failed = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`PASS: ${label}`); }
  else { failed++; console.log(`FAIL: ${label}` + (detail !== undefined ? ` -- ${JSON.stringify(detail).slice(0, 800)}` : '')); }
}

const LABEL_TO_CODE: Record<'Australia' | 'India' | 'Global', string> = { Australia: 'AU', India: 'IN', Global: 'GLOBAL' };

async function selectExperience(page: import('playwright').Page, label: 'Australia' | 'India' | 'Global') {
  const combo = page.getByRole('combobox', { name: 'Experience' });
  await combo.selectOption({ label });
  // The component's onChange handler POSTs, then calls router.refresh() once
  // the response resolves -- a fixed waitForResponse()/networkidle() pairing
  // races the actual fetch on a fast local server (the response can land
  // before the listener attaches). Poll the REAL rendered <select> value
  // instead -- the actual end-user-observable state this whole test cares
  // about -- until it reflects the selection or a bounded timeout elapses.
  const expected = LABEL_TO_CODE[label];
  await page.waitForFunction(
    (exp) => {
      const el = document.querySelector('select[aria-labelledby]') as HTMLSelectElement | null;
      return el?.value === exp;
    },
    expected,
    { timeout: 10_000 },
  );
}

async function currentSelectorValue(page: import('playwright').Page): Promise<string> {
  const combo = page.getByRole('combobox', { name: 'Experience' });
  return combo.inputValue();
}

async function main() {
  const browser = await chromium.launch();
  try {
    // --- Two independent real visitor contexts (separate cookie jars) ---
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    await pageA.goto(`${BASE}/`);
    await pageB.goto(`${BASE}/`);

    const initialA = await currentSelectorValue(pageA);
    const initialB = await currentSelectorValue(pageB);
    check('fresh visitor A starts unresolved (neutral prompt, no preselection)', initialA === '__UNRESOLVED__', initialA);
    check('fresh visitor B starts unresolved (neutral prompt, no preselection)', initialB === '__UNRESOLVED__', initialB);

    // --- Visitor A selects AU via the REAL selector UI -----------------
    await selectExperience(pageA, 'Australia');
    check('visitor A: selector now shows AU after selection', (await currentSelectorValue(pageA)) === 'AU');
    const bodyA1 = await pageA.locator('body').innerText();
    // The pricing card shows the currency SYMBOL ("A$"), not the 3-letter
    // code -- confirmed by reading lib/config/landingPricing.ts directly
    // (LANDING_MARKETING_PRICES.AU.symbol === 'A$') rather than assuming.
    check('visitor A: page content reflects the AU price ("A$9.99", real rendered evidence, not just the selector value)', bodyA1.includes('A$9.99'), bodyA1.length);

    // --- Visitor B selects India via the REAL selector UI --------------
    await selectExperience(pageB, 'India');
    check('visitor B: selector now shows IN after selection', (await currentSelectorValue(pageB)) === 'IN');
    const bodyB1 = await pageB.locator('body').innerText();
    check('visitor B: page content reflects the IN price ("₹99", real rendered evidence)', bodyB1.includes('₹99'), bodyB1.length);

    // --- CROSS-CONTAMINATION CHECK: A's selection did not leak to B, and vice versa ---
    check('ISOLATION: visitor A still shows AU (not contaminated by B\'s India selection)', (await currentSelectorValue(pageA)) === 'AU');
    check('ISOLATION: visitor B still shows IN (not contaminated by A\'s AU selection)', (await currentSelectorValue(pageB)) === 'IN');

    // --- Persistence across reload -------------------------------------
    await pageA.reload();
    await pageB.reload();
    check('PERSISTENCE: visitor A retains AU across a real page reload', (await currentSelectorValue(pageA)) === 'AU');
    check('PERSISTENCE: visitor B retains IN across a real page reload', (await currentSelectorValue(pageB)) === 'IN');

    // --- A changes to Global; B must be completely unaffected -----------
    await selectExperience(pageA, 'Global');
    check('visitor A: selector now shows GLOBAL', (await currentSelectorValue(pageA)) === 'GLOBAL');
    check('ISOLATION: visitor B is unaffected by A\'s change to Global (still IN)', (await currentSelectorValue(pageB)) === 'IN');

    // --- A brand-new (third) visitor does not inherit A's or B's selection ---
    const contextC = await browser.newContext();
    const pageC = await contextC.newPage();
    await pageC.goto(`${BASE}/`);
    const initialC = await currentSelectorValue(pageC);
    check('a brand-new THIRD visitor does not inherit either prior visitor\'s selection (starts unresolved)', initialC === '__UNRESOLVED__', initialC);
    await contextC.close();

    // --- Missing/malformed cookie fails safe -----------------------------
    const contextD = await browser.newContext();
    await contextD.addCookies([{ name: 'fhip_landing_country', value: 'not-a-valid-base64-payload!!!', domain: 'localhost', path: '/' }]);
    const pageD = await contextD.newPage();
    await pageD.goto(`${BASE}/`);
    const valueD = await currentSelectorValue(pageD);
    check('a malformed selection cookie fails safe (falls through to unresolved, no crash, no wrong country)', valueD === '__UNRESOLVED__', valueD);
    const statusD = (await pageD.goto(`${BASE}/`))?.status();
    check('the page itself still loads successfully (200) with a malformed cookie present', statusD === 200, statusD);
    await contextD.close();

    // --- Authenticated confirmed-country remains authoritative ----------
    const stamp = Date.now();
    const email = `g2-twovisitor-${stamp}@example.com`;
    const password = `Test-${Math.random().toString(36).slice(2)}-Aa1!`;
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (created.error || !created.data.user) throw new Error(`create user failed: ${created.error?.message}`);
    const userId = created.data.user.id;
    await admin.from('user_profiles').update({ country_of_residence: 'AU', country_confirmed_at: new Date().toISOString(), country_source: 'USER_CONFIRMED', onboarding_completed: true }).eq('user_id', userId);

    try {
      const contextE = await browser.newContext();
      const pageE = await contextE.newPage();
      // Select India as an ANONYMOUS visitor first...
      await pageE.goto(`${BASE}/`);
      await selectExperience(pageE, 'India');
      check('setup: anonymous selection of India recorded before login', (await currentSelectorValue(pageE)) === 'IN');

      // ...then log in as the AU-confirmed account and reload the landing page.
      await pageE.goto(`${BASE}/login`);
      await pageE.getByTestId('login-email').fill(email);
      await pageE.getByTestId('login-password').fill(password);
      await Promise.all([pageE.waitForURL(/\/(dashboard|onboarding)/, { timeout: 30_000 }), pageE.getByTestId('login-submit').click()]);
      await pageE.goto(`${BASE}/`);
      const bodyE = await pageE.locator('body').innerText();
      check(
        'AUTHENTICATED PRECEDENCE: a confirmed-AU account overrides a prior anonymous India selection on the SAME landing page (shows the AU price "A$9.99", not the India price "₹99")',
        bodyE.includes('A$9.99') && !bodyE.includes('₹99'),
        bodyE.length,
      );

      // Logout, then confirm the landing page does NOT still show the
      // authenticated account's presentation (no leaked personalised
      // content post-logout) -- and genuinely reverts to the anonymous
      // India selection made earlier in THIS SAME browser context, not
      // merely "doesn't show AU" (which a blank/broken page would also
      // satisfy vacuously).
      //
      // AppShell.tsx's own "Sign out" control only renders inside the
      // authenticated app shell (dashboard/etc.) -- NOT on the public
      // marketing landing page (`/`), which has no sidebar at all.
      // Confirmed by reading the component directly, and by an earlier
      // attempt in this exact script failing silently on `/` before this
      // fix. Sign-out is also a TWO-STEP flow: the sidebar button only
      // opens a ConfirmDialog whose own confirm button is ALSO labelled
      // "Sign out".
      await pageE.goto(`${BASE}/dashboard`);
      const signOutButton = pageE.getByRole('button', { name: /sign out/i }).first();
      await signOutButton.click();
      await pageE.waitForTimeout(500); // let the ConfirmDialog mount before locating its own button
      const confirmButton = pageE.getByRole('button', { name: /sign out/i }).last();
      await confirmButton.click();
      await pageE.waitForURL(/\/login/, { timeout: 15_000 });
      await pageE.goto(`${BASE}/`);
      const bodyAfterLogout = await pageE.locator('body').innerText();
      check(
        'POST-LOGOUT: the landing page no longer shows the authenticated account\'s AU presentation, and genuinely reverts to the earlier anonymous India selection ("₹99"), not a leaked account state',
        !bodyAfterLogout.includes('A$9.99') && bodyAfterLogout.includes('₹99'),
        bodyAfterLogout.length,
      );
      await contextE.close();
    } finally {
      await admin.auth.admin.deleteUser(userId);
      const residueUser = await admin.auth.admin.getUserById(userId);
      check('ZERO RESIDUE: authenticated test user gone', !residueUser.data.user);
    }

    await contextA.close();
    await contextB.close();
  } finally {
    await browser.close();
    console.log(`\n=== SUMMARY: ${passed}/${passed + failed} checks passed ===`);
    if (failed > 0) process.exitCode = 1;
  }
}

main();

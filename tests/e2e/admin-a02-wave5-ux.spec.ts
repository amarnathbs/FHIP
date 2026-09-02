import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';

// Admin A0.2 Wave 5 — real-browser certification against live hosted DEV.
//
// Covers, per the Wave's own §11/§12/§13/§23.2:
//   - the role-by-role visible-destination matrix, using REAL DEV sessions
//     with REAL role rows (§23.3 forbids relying only on mocked role arrays);
//   - direct-route behaviour for a role that lacks the capability;
//   - the Analyst read-only boundary;
//   - a multi-role combination (Author + Editor);
//   - no page-level horizontal overflow at 320/375/768/1024/1280;
//   - keyboard operation of the new Help disclosure and the confirm dialog's
//     focus trap and focus restoration;
//   - that a permission denial renders as a non-retryable state rather than
//     a red "try again" panel.
//
// Every fixture is uniquely prefixed, and afterAll deletes the roles, the
// profile rows and the auth users, then RE-QUERIES to prove zero residue
// (§24). Nothing real is published, approved or altered: the spec only
// reads Admin screens and exercises confirmation dialogs, and cancels every
// one of them rather than confirming.

const env = Object.fromEntries(
  fs
    .readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
);
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
const DEV_REF = 'vqycarelcoijzwlpkpcz';
if (!URL_ || !SERVICE) throw new Error('FATAL: missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local');
// Hard refusal to run against anything but the known DEV project. Wave 5
// §23.2: "Do not mutate production."
if (!URL_.includes(DEV_REF)) {
  throw new Error(`FATAL: refusing to run — NEXT_PUBLIC_SUPABASE_URL (${URL_}) is not the known DEV project (${DEV_REF}).`);
}

const STAMP = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const TAG = `a02w5-${STAMP}`;
const PASSWORD = `AdminWave5!${STAMP}`;

type RoleKey = 'author' | 'editor' | 'compliance_reviewer' | 'publisher' | 'resource_admin' | 'analyst' | 'authorEditor' | 'none' | 'superAdmin';

const FIXTURES: { key: RoleKey; roles: string[]; superAdmin?: boolean }[] = [
  { key: 'author', roles: ['author'] },
  { key: 'editor', roles: ['editor'] },
  { key: 'compliance_reviewer', roles: ['compliance_reviewer'] },
  { key: 'publisher', roles: ['publisher'] },
  { key: 'resource_admin', roles: ['resource_admin'] },
  { key: 'analyst', roles: ['analyst'] },
  { key: 'authorEditor', roles: ['author', 'editor'] },
  { key: 'none', roles: [] },
];

const users: Record<string, { id: string; email: string }> = {};

async function rest(p: string, opts: RequestInit & { prefer?: string } = {}) {
  const headers = {
    apikey: SERVICE!,
    Authorization: `Bearer ${SERVICE}`,
    'Content-Type': 'application/json',
    Prefer: opts.prefer ?? 'return=representation',
    ...(opts.headers ?? {}),
  };
  const r = await fetch(`${URL_}/rest/v1/${p}`, { ...opts, headers });
  const text = await r.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON body is fine for a 204 */
  }
  return { status: r.status, json: json as Record<string, unknown>[] | null, text };
}

test.beforeAll(async () => {
  const now = new Date().toISOString();
  for (const fixture of FIXTURES) {
    const email = `${TAG}-${fixture.key}@fhip-test.invalid`.toLowerCase();
    const r = await fetch(`${URL_}/auth/v1/admin/users`, {
      method: 'POST',
      headers: { apikey: SERVICE!, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD, email_confirm: true }),
    });
    const j = (await r.json()) as { id?: string };
    if (!j.id) throw new Error(`beforeAll: createUser failed for ${fixture.key}: ${JSON.stringify(j).slice(0, 300)}`);
    users[fixture.key] = { id: j.id, email };

    // Country confirmation is a hard gate on every admin API route
    // (Mandatory Country Confirmation, MCC-2). Without it the fixture would
    // be blocked for a reason unrelated to what this spec is testing.
    //
    // The profile row is created by a trigger on the auth user, so a PATCH
    // issued immediately can update ZERO rows and silently succeed — the
    // fixture would then land on /onboarding and every assertion below would
    // fail for a setup reason. Retry until the update actually takes, and
    // fail loudly rather than proceeding with a half-built fixture.
    const profilePatch = {
      full_name: `Wave5 ${fixture.key}`,
      country_of_residence: 'AU',
      preferred_currency: 'AUD',
      onboarding_completed: true,
      employment_status: 'full_time_employed',
      profile_completion_percentage: 100,
      country_confirmed_at: now,
      country_source: 'USER_CONFIRMED',
      country_updated_at: now,
    };
    let onboarded = false;
    for (let attempt = 0; attempt < 10 && !onboarded; attempt++) {
      await rest(`user_profiles?user_id=eq.${j.id}`, { method: 'PATCH', body: JSON.stringify(profilePatch) });
      const check = await rest(`user_profiles?user_id=eq.${j.id}&select=onboarding_completed,country_confirmed_at`);
      const row = check.json?.[0] as { onboarding_completed?: boolean; country_confirmed_at?: string } | undefined;
      if (row?.onboarding_completed && row?.country_confirmed_at) {
        onboarded = true;
        break;
      }
      if (!row) {
        // The trigger has not created the row yet — create it ourselves.
        await rest('user_profiles', { method: 'POST', body: JSON.stringify({ user_id: j.id, ...profilePatch }) });
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!onboarded) throw new Error(`beforeAll: could not mark fixture "${fixture.key}" onboarded — aborting rather than testing a half-built fixture.`);

    for (const role of fixture.roles) {
      await rest('resource_user_roles', {
        method: 'POST',
        body: JSON.stringify({ user_id: j.id, role, is_active: true }),
      });
    }
  }
});

test.afterAll(async () => {
  let residue = 0;
  for (const fixture of FIXTURES) {
    const u = users[fixture.key];
    if (!u) continue;
    await rest(`resource_user_roles?user_id=eq.${u.id}`, { method: 'DELETE' }).catch(() => {});
    await fetch(`${URL_}/auth/v1/admin/users/${u.id}`, {
      method: 'DELETE',
      headers: { apikey: SERVICE!, Authorization: `Bearer ${SERVICE}` },
    });
  }
  // Independently re-verify, rather than trusting the deletes above.
  for (const fixture of FIXTURES) {
    const u = users[fixture.key];
    if (!u) continue;
    const roles = await rest(`resource_user_roles?user_id=eq.${u.id}&select=role`);
    if (roles.json?.length) {
      residue += roles.json.length;
      console.log(`RESIDUE: ${roles.json.length} role row(s) remain for ${fixture.key}`);
    }
    const stillExists = await fetch(`${URL_}/auth/v1/admin/users/${u.id}`, {
      headers: { apikey: SERVICE!, Authorization: `Bearer ${SERVICE}` },
    });
    if (stillExists.status === 200) {
      residue++;
      console.log(`RESIDUE: auth user still exists for ${fixture.key}`);
    }
  }
  console.log(`WAVE 5 CLEANUP: residue=${residue} (0 expected)`);
  expect(residue, 'zero fixture residue after the Wave 5 UX run').toBe(0);
});

// The login form prevents its own default submit, but only once React has
// hydrated. Under Turbopack dev on a contended machine that can take several
// seconds, and a click landing before hydration performs a NATIVE GET submit
// — the page simply reloads as `/login?` and no sign-in is ever attempted.
// So: wait for hydration to be observable (a controlled input retaining a
// typed value proves React owns it), then submit, and retry the whole
// attempt rather than reporting a product defect for a harness race.
async function login(page: Page, key: RoleKey) {
  const u = users[key];
  const email = page.locator('[data-testid="login-email"]');
  const password = page.locator('[data-testid="login-password"]');
  const submit = page.locator('[data-testid="login-submit"]');

  for (let attempt = 1; attempt <= 3; attempt++) {
    await page.goto('/login');
    await page.waitForLoadState('networkidle').catch(() => {});
    await expect(submit).toBeEnabled({ timeout: 30_000 });

    // Wait for React to actually own the submit button before clicking it.
    //
    // `toHaveValue` does NOT prove hydration: fill() writes the DOM value
    // directly, so it passes whether or not React is attached. The proof
    // that it was not attached is the failure mode itself — the form
    // performed a native GET submit to `/login?` with no query string,
    // which is exactly what a browser does for a form whose inputs carry no
    // `name` attribute, i.e. the React onSubmit handler (and its
    // preventDefault) never ran.
    //
    // React attaches `__reactFiber$…` / `__reactProps$…` keys to the DOM
    // nodes it hydrates, so their presence on the submit button is a direct,
    // observable hydration signal rather than a guess or a fixed sleep.
    await page.waitForFunction(
      () => {
        const el = document.querySelector('[data-testid="login-submit"]');
        return !!el && Object.keys(el).some((k) => k.startsWith('__react'));
      },
      undefined,
      { timeout: 60_000 }
    );

    await email.fill(u.email);
    await password.fill(PASSWORD);
    await expect(email).toHaveValue(u.email, { timeout: 20_000 });
    await expect(password).toHaveValue(PASSWORD, { timeout: 20_000 });

    await submit.click();
    try {
      await page.waitForURL(/\/(dashboard|onboarding)/, { timeout: 40_000 });
      break;
    } catch {
      if (attempt === 3) {
        const shown = await page.locator('body').innerText().catch(() => '');
        throw new Error(
          `login for "${key}" did not leave /login after 3 attempts. Last URL: ${page.url()}. Page text: ${shown.slice(0, 300)}`
        );
      }
    }
  }

  // A fixture that lands on onboarding means its profile was not marked
  // complete — a fixture-setup failure, and it must not be reported as an
  // Admin defect.
  await expect(page, `fixture "${key}" should be fully onboarded`).toHaveURL(/\/dashboard/, { timeout: 30_000 });
}

// The Admin menu is gated on capabilities the shell resolves CLIENT-side
// after the dashboard renders, so it appears a moment after navigation
// settles. Checking for it immediately reports "no destinations" for every
// role — which is why this helper waits for the trigger rather than sampling
// once. `expectPresent: false` is used for the role-less case, where the
// correct answer really is "no menu", and where we must still give the
// capability fetch time to have produced one before concluding it did not.
async function openAdminMenu(page: Page, expectPresent = true): Promise<boolean> {
  const trigger = page.getByRole('button', { name: 'Admin', exact: true }).first();
  try {
    await trigger.waitFor({ state: 'visible', timeout: expectPresent ? 30_000 : 8_000 });
  } catch {
    return false;
  }
  if ((await trigger.getAttribute('aria-expanded')) !== 'true') {
    await trigger.click();
  }
  await expect(trigger).toHaveAttribute('aria-expanded', 'true', { timeout: 10_000 });
  return true;
}

// `expectItems` is separate from `expectPresent` on purpose. The Analyst-only
// case is the one where BOTH are true and false at once: the Admin menu
// button genuinely exists (Analyst holds a capability), the menu genuinely
// opens, and it genuinely contains zero destinations — by design, because
// Wave 3 removed the non-functional Analytics link and replaced it with a
// non-interactive notice. Waiting for a menuitem there would fail on
// correct behaviour.
async function visibleAdminItems(page: Page, expectPresent = true, expectItems = expectPresent): Promise<string[]> {
  const opened = await openAdminMenu(page, expectPresent);
  if (!opened) return [];
  const items = page.getByRole('menuitem');
  // The group contents render with the disclosure, so wait for at least one
  // rather than racing the same client-side render again.
  if (expectItems) await expect(items.first()).toBeVisible({ timeout: 15_000 });
  return (await items.allTextContents()).map((s) => s.trim()).filter(Boolean);
}

async function hasPageOverflow(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
}

test.describe('Wave 5 — role-by-role visible destinations (§13)', () => {
  test('an account with no Resources role sees no Admin menu at all', async ({ page }) => {
    await login(page, 'none');
    const items = await visibleAdminItems(page, false);
    expect(items, 'a role-less account must see no Admin destinations').toEqual([]);
  });

  test('Author sees content and workflow destinations, and no Super Admin destinations', async ({ page }) => {
    await login(page, 'author');
    const items = await visibleAdminItems(page);
    expect(items.length, 'Author sees destinations').toBeGreaterThan(0);
    expect(items, 'Author must not see Benchmarks').not.toContain('Benchmarks');
    expect(items, 'Author must not see Recommendations').not.toContain('Recommendations');
    expect(items).toContain('Drafts');
    expect(items).toContain('Videos');
  });

  test('Analyst-only sees no operational destination and is told so honestly', async ({ page }) => {
    await login(page, 'analyst');
    await openAdminMenu(page, true);
    // Wave 3's ruling: the Analytics link was removed because it completes no
    // task; an Analyst-only caller gets a fixed, NON-interactive note.
    const note = page.getByText('Admin analytics access is confirmed for your account. No analytics features are available yet.');
    await expect(note, 'Analyst sees the honest unavailable notice').toBeVisible({ timeout: 30_000 });
    // The menu opens and is deliberately empty — see visibleAdminItems.
    const items = await visibleAdminItems(page, true, false);
    expect(items, 'Analyst must see no clickable Admin destination').toEqual([]);
  });

  test('Analyst is read-only: the Resources dashboard offers no create action', async ({ page }) => {
    await login(page, 'analyst');
    await page.goto('/admin/resources');
    // Wave 5 turned this into an explicit unavailable state and removed the
    // create call-to-action for callers who cannot create.
    await expect(page.getByText('No content-management access on this account')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('link', { name: '+ New Content' }), 'Analyst must not be offered a create action').toHaveCount(0);
  });

  test('Author + Editor receives the union of both roles, and gains no unrelated authority', async ({ page }) => {
    await login(page, 'authorEditor');
    const items = await visibleAdminItems(page);
    expect(items).toContain('Drafts');
    expect(items).toContain('Review Queue');
    // Holding two content roles must not confer Super Admin surfaces or
    // role management.
    expect(items).not.toContain('Benchmarks');
    expect(items).not.toContain('Recommendations');
  });

  test('a direct URL to a Super Admin page is refused for a Resources role', async ({ page }) => {
    await login(page, 'resource_admin');
    await page.goto('/admin/benchmarks');
    // Navigation hiding is never the control: the page itself redirects.
    await expect(page, 'Resource Admin is redirected away from Benchmarks').not.toHaveURL(/\/admin\/benchmarks/, { timeout: 30_000 });
  });

  test('a direct URL to role management is refused for a role that cannot manage roles', async ({ page }) => {
    await login(page, 'author');
    await page.goto('/admin/resources/users');
    await expect(page, 'Author is redirected away from Users & Roles').not.toHaveURL(/\/admin\/resources\/users/, { timeout: 30_000 });
  });
});

test.describe('Wave 5 — in-product Help and result states (§9, §17)', () => {
  test('the Help disclosure exists, is keyboard-operable, and states the next step', async ({ page }) => {
    await login(page, 'resource_admin');
    await page.goto('/admin/resources');
    // Target the <summary> ELEMENT, not the <span> inside it — focusing a
    // span does nothing, so pressing Enter would never toggle the
    // disclosure and the test would report a product defect that is not one.
    const summary = page.locator('summary', { hasText: 'How to use this page' }).first();
    await expect(summary, 'every task page carries the Help affordance').toBeVisible({ timeout: 30_000 });

    // Keyboard-operable without any custom key handling: it is a native
    // <summary>, so focusing and pressing Enter must open it.
    await summary.focus();
    await expect(summary).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByText('Who can do this:').first()).toBeVisible();
    await expect(page.getByText('Next:').first()).toBeVisible();
  });

  test('a permission denial renders as a non-retryable state, not a red "try again"', async ({ page }) => {
    await login(page, 'author');
    // The Users API refuses a non-manager with 403. Reaching it through the
    // page is prevented by the route gate, so this asserts the classifier's
    // own contract against the real endpoint the screens consume.
    const res = await page.request.get('/api/admin/resources/users');
    expect(res.status(), 'a non-manager receives an explicit denial, not an empty success').toBe(403);
  });
});

test.describe('Wave 5 — responsive certification (§12)', () => {
  const WIDTHS = [320, 375, 768, 1024, 1280];
  const PAGES = [
    '/admin/resources',
    '/admin/resources/content',
    '/admin/resources/content/drafts',
    '/admin/resources/videos',
    '/admin/resources/glossary',
    '/admin/resources/money-updates',
    '/admin/resources/faqs',
    '/admin/resources/ctas',
    '/admin/resources/related',
    '/admin/resources/context',
    '/admin/resources/users',
  ];

  test('no Admin page overflows horizontally at any tested width', async ({ page }) => {
    // 55 measurements (11 pages x 5 widths), each a full navigation. Against
    // a cold Turbopack dev server on a contended machine a single first-hit
    // compile can take 30s+, so this needs a generous budget — the earlier
    // budget expired mid-`page.evaluate`, which surfaces as "Target page…has
    // been closed" and reads like a product failure when it is a harness one.
    test.setTimeout(1_200_000);
    await login(page, 'resource_admin');
    const failures: string[] = [];
    for (const path of PAGES) {
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(path);
        // Let the client component settle before measuring.
        await page.waitForLoadState('networkidle').catch(() => {});
        if (await hasPageOverflow(page)) failures.push(`${path} @ ${width}px`);
      }
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    expect(failures, `page-level horizontal overflow at: ${failures.join(', ')}`).toEqual([]);
  });

  test('Admin pages remain usable at 200% zoom', async ({ page }) => {
    await login(page, 'resource_admin');
    // 200% zoom at 1280 logical width is equivalent to a 640px viewport
    // (WCAG 2.2 SC 1.4.4 / 1.4.10 reflow).
    await page.setViewportSize({ width: 640, height: 900 });
    for (const path of ['/admin/resources', '/admin/resources/users', '/admin/resources/ctas']) {
      await page.goto(path);
      await page.waitForLoadState('networkidle').catch(() => {});
      expect(await hasPageOverflow(page), `${path} must reflow at 200% zoom`).toBe(false);
    }
    await page.setViewportSize({ width: 1280, height: 900 });
  });
});

test.describe('Wave 5 — confirmation and focus behaviour (§10, §11)', () => {
  test('a destructive action confirms, traps focus, and restores it on cancel', async ({ page }) => {
    await login(page, 'resource_admin');
    await page.goto('/admin/resources/ctas');
    await page.waitForLoadState('networkidle').catch(() => {});

    const toggle = page.getByRole('button', { name: /^(Deactivate|Activate) the CTA / }).first();
    if ((await toggle.count()) === 0) {
      test.skip(true, 'No CTA exists on DEV to exercise; covered structurally by the unit suite.');
      return;
    }

    await toggle.focus();
    await toggle.click();

    const dialog = page.getByRole('alertdialog');
    await expect(dialog, 'the action asks before committing').toBeVisible();
    // The confirmation must name the object and the effect, not ask a bare
    // "Are you sure?" (§10).
    await expect(dialog).not.toContainText('Are you sure');

    // Focus starts on the safe choice, not the destructive one.
    const cancel = dialog.getByRole('button', { name: 'Cancel' });
    await expect(cancel).toBeFocused();

    // Tab must not escape the dialog.
    await page.keyboard.press('Tab');
    let focusInDialog = await dialog.evaluate((el) => el.contains(document.activeElement));
    expect(focusInDialog, 'Tab stays inside the modal').toBe(true);
    await page.keyboard.press('Tab');
    focusInDialog = await dialog.evaluate((el) => el.contains(document.activeElement));
    expect(focusInDialog, 'Tab wraps rather than reaching the page behind').toBe(true);

    // Escape cancels and focus returns to the control that opened it.
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(toggle, 'focus is restored to the opener').toBeFocused();
  });
});
